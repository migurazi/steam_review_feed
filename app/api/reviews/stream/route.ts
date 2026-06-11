/**
 * SSE 리뷰 스트리밍 엔드포인트.
 * GET /api/reviews/stream?source=wishlist&language=koreana&...
 *
 * 게임 목록을 가져와 게임별로 리뷰를 수집하고,
 * SSE(Server-Sent Events)로 클라이언트에 점진적으로 전송한다.
 *
 * 기획서 5.4절(점진적 로딩)과 7.2절(리뷰 수집 로직) 구현.
 *
 * 성능 최적화:
 *   - STREAM_CONCURRENCY개의 게임을 동시에 병렬 처리한다.
 *   - checkIsFree + getAppDetails 중복 호출을 제거하여 불필요한 딜레이를 방지한다.
 *   - 클라이언트 연결 끊김 시 즉시 남은 작업을 취소한다.
 */

import { NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import {
  getWishlist,
  getOwnedGames,
  getAppDetails,
  getReviews,
} from "@/lib/steam/api";
import { cacheGet } from "@/lib/cache";
import { getAppMeta } from "@/lib/app-meta-cache";
import { sseEvent, sseResponse } from "@/lib/sse";
import { logEvent } from "@/lib/logger";
import { rateLimitResponse } from "@/lib/rate-limit";
import {
  PAGE_SIZE,
  MAX_REVIEWS_PER_GAME,
  REVIEW_RETRY_THRESHOLD,
  STREAM_CONCURRENCY,
  DEFAULT_FILTER_VALUES,
} from "@/lib/constants";
import { sortLibraryGames } from "@/lib/steam/sort";
import { applyPostFilters } from "@/lib/steam/filters";
import type {
  SteamWishlistItem,
  SteamOwnedGame,
  SteamReview,
  SteamAppDetails,
  SteamPriceOverview,
} from "@/lib/steam/types";

export const dynamic = "force-dynamic";

/** 쿼리 파라미터를 파싱하여 필터 설정을 반환한다. */
function parseFilters(params: URLSearchParams) {
  return {
    /** 단일 게임 조회 모드. 지정 시 source 무시하고 이 게임만 조회. */
    appId: params.get("appId") || null,
    source: (params.get("source") || DEFAULT_FILTER_VALUES.source) as
      | "wishlist"
      | "library"
      | "both",
    language: params.get("language") || DEFAULT_FILTER_VALUES.language,
    minPlaytime: parseInt(params.get("minPlaytime") || "0", 10),
    minLength: parseInt(params.get("minLength") || "0", 10),
    reviewType: (params.get("reviewType") || DEFAULT_FILTER_VALUES.reviewType) as
      | "all"
      | "positive"
      | "negative",
    dayRange: parseInt(params.get("dayRange") || "30", 10),
    excludeFree: params.get("excludeFree") !== "false",
    offset: parseInt(params.get("offset") || "0", 10),
  };
}

/**
 * 게임의 상세 정보(이름, 아이콘, 무료 여부)를 한 번의 API 호출로 가져온다.
 * 캐시 히트 시 API 호출 없이 즉시 반환한다.
 *
 * 기존 checkIsFree + getAppDetails 중복 호출 문제를 해결한다.
 *
 * @param appId Steam App ID
 * @returns 앱 상세 정보. 실패 시 null.
 */
async function getAppInfo(appId: number): Promise<SteamAppDetails | null> {
  // 캐시에서 먼저 확인
  const cached = cacheGet<SteamAppDetails>(`app:${appId}:info:KR`);
  if (cached) return cached.data;

  // 캐시 미스: appdetails 호출 (딜레이 포함)
  const details = await getAppDetails(appId);
  return details?.data ?? null;
}

export async function GET(request: NextRequest) {
  const limited = rateLimitResponse(request);
  if (limited) return limited;

  const filters = parseFilters(request.nextUrl.searchParams);

  // 단일 게임 모드(appId 지정)는 비로그인 접근 가능 (플로우 C)
  // 위시리스트/라이브러리 피드는 인증 필요
  const session = await getSession();
  if (!filters.appId && !session.steamId) {
    return new Response("Unauthorized", { status: 401 });
  }

  // 이벤트 로깅
  logEvent("feed_view", {
    steamId: session.steamId || "anonymous",
    source: filters.appId ? `game:${filters.appId}` : filters.source,
    filters,
  });

  // ReadableStream으로 SSE 스트림 생성
  let cancelled = false;
  const stream = new ReadableStream({
    async start(controller) {
      try {
        await streamReviews(controller, session.steamId || "", filters, () => cancelled);
      } catch (err) {
        // 클라이언트가 이미 연결을 끊은 경우 무시
        if (cancelled) return;
        console.error("[reviews/stream] Stream error:", err);
        try {
          controller.enqueue(
            sseEvent("error", { appId: 0, message: "스트리밍 중 오류가 발생했습니다." })
          );
        } catch { /* controller already closed */ }
      } finally {
        if (!cancelled) {
          try { controller.close(); } catch { /* already closed */ }
        }
      }
    },
    cancel() {
      cancelled = true;
    },
  });

  return sseResponse(stream);
}

/**
 * 메인 스트리밍 로직.
 *
 * 1. 게임 목록 수집 (위시리스트/라이브러리/both)
 * 2. STREAM_CONCURRENCY개씩 병렬로 리뷰 수집
 * 3. 각 게임의 결과를 SSE로 클라이언트에 전송
 *
 * @param controller ReadableStream 컨트롤러
 * @param steamId 로그인한 사용자의 Steam64 ID
 * @param filters 파싱된 필터 설정
 * @param isCancelled 클라이언트 연결 끊김 확인 함수
 */
async function streamReviews(
  controller: ReadableStreamDefaultController,
  steamId: string,
  filters: ReturnType<typeof parseFilters>,
  isCancelled: () => boolean = () => false
) {
  // --- 단일 게임 모드: appId가 지정되면 해당 게임만 조회 ---
  if (filters.appId) {
    const appIdNum = parseInt(filters.appId, 10);
    const details = await getAppInfo(appIdNum);
    const dbMeta = details ? null : getAppMeta(appIdNum);
    const gameName = details?.name || dbMeta?.name || `AppID ${filters.appId}`;
    const gameIcon = details?.header_image || dbMeta?.headerImage || "";
    const isFree = details?.is_free;
    const price = details?.price_overview;
    const comingSoon = details?.release_date?.coming_soon;
    const releaseDate = details?.release_date?.date;

    const reviewResult = await getReviews(
      appIdNum,
      filters.language,
      MAX_REVIEWS_PER_GAME,
      filters.dayRange
    );

    let reviews = reviewResult?.data ?? [];
    const noReviewsInLanguage = reviews.length === 0;

    if (reviews.length > 0) {
      reviews = applyPostFilters(reviews, filters);
    }

    controller.enqueue(
      sseEvent("game-reviews", {
        appId: appIdNum,
        gameName,
        gameIcon,
        reviews,
        noReviewsInLanguage,
        isFree,
        price,
        comingSoon,
        releaseDate,
      })
    );
    controller.enqueue(sseEvent("progress", { loaded: 1, total: 1 }));
    controller.enqueue(
      sseEvent("done", { totalGames: 1, totalReviews: reviews.length })
    );
    return;
  }

  // --- 피드 모드: 게임 목록을 수집하고 병렬로 리뷰 수집 ---

  // 1. 게임 목록 수집
  const games = await collectGameList(steamId, filters);
  if (games.length === 0) {
    controller.enqueue(sseEvent("done", { totalGames: 0, totalReviews: 0 }));
    return;
  }

  const total = games.length;
  let loaded = 0;
  let totalReviews = 0;

  // 2. STREAM_CONCURRENCY개씩 배치 병렬 처리
  //    각 배치 내의 게임들은 동시에 처리되어 대기 시간을 대폭 줄인다.
  for (let i = 0; i < games.length; i += STREAM_CONCURRENCY) {
    if (isCancelled()) return;

    const batch = games.slice(i, i + STREAM_CONCURRENCY);

    // 배치 내 게임들을 병렬 처리
    const results = await Promise.allSettled(
      batch.map((game) => processGame(game, filters, isCancelled))
    );

    // 각 결과를 순차적으로 SSE 전송 (순서 보장)
    for (const result of results) {
      if (isCancelled()) return;
      loaded++;

      if (result.status === "fulfilled" && result.value) {
        const { appId, gameName, gameIcon, reviews, noReviewsInLanguage, isFree, price, comingSoon, releaseDate } = result.value;
        totalReviews += reviews.length;

        controller.enqueue(
          sseEvent("game-reviews", {
            appId,
            gameName,
            gameIcon,
            reviews,
            noReviewsInLanguage,
            isFree,
            price,
            comingSoon,
            releaseDate,
          })
        );
      }

      controller.enqueue(sseEvent("progress", { loaded, total }));
    }
  }

  // 3. 완료
  controller.enqueue(
    sseEvent("done", { totalGames: total, totalReviews })
  );
}

/**
 * 단일 게임의 리뷰를 수집하는 처리 단위.
 * 병렬 실행을 위해 독립적으로 동작한다.
 *
 * 처리 순서:
 * 1. 무료 게임 필터 (excludeFree)
 * 2. 게임 이름/아이콘 확보 (getAppInfo 통합)
 * 3. 리뷰 조회 + 후처리 필터
 * 4. 필터 후 부족하면 재요청 (1회)
 *
 * @returns 게임별 리뷰 데이터. 건너뛰어야 할 경우 null.
 */
async function processGame(
  game: GameEntry,
  filters: ReturnType<typeof parseFilters>,
  isCancelled: () => boolean
): Promise<{
  appId: number;
  gameName: string;
  gameIcon: string;
  reviews: SteamReview[];
  noReviewsInLanguage: boolean;
  isFree?: boolean;
  price?: SteamPriceOverview;
  comingSoon?: boolean;
  releaseDate?: string;
} | null> {
  if (isCancelled()) return null;

  // 앱 정보를 한 번만 가져온다 (무료 여부 + 이름/아이콘)
  const appInfo = game.name ? null : await getAppInfo(game.appId);

  // 무료 게임 제외 필터
  // 라이브러리 게임(game.name 존재)은 appInfo를 부르지 않으므로 캐시만 확인.
  const cachedInfo = game.name
    ? cacheGet<SteamAppDetails>(`app:${game.appId}:info:KR`)?.data
    : null;

  if (filters.excludeFree) {
    const isFree = game.name
      ? (cachedInfo?.is_free ?? null)
      : (appInfo?.is_free ?? null);

    if (isFree === true) return null;
    // isFree === null (API 실패)이면 건너뛰지 않고 리뷰 조회 시도
  }

  // 게임 이름/아이콘 확보 — Steam API가 Rate Limit 등으로 실패하면 DB 영속
  // 메타를 마지막 fallback으로 시도. 그래도 없으면 "AppID 12345".
  //
  // dbMeta 조회는 동기 SQLite read라 hot path 비용이 미미하지만 0이 아니다.
  // 라이브러리 게임(game.name+game.icon 모두 있음)은 fallback 불필요 → 항상
  // skip. 위시리스트 게임은 game.name/icon이 없지만 appInfo가 성공했으면
  // appInfo.name이 fallback chain의 다음 자리를 채우므로 역시 DB 조회 불필요.
  // appInfo도 실패한 경우(API 장애)에만 DB lookup으로 마지막 fallback 시도.
  const hasFreshMeta = (game.name && game.icon) || (appInfo?.name && appInfo.header_image);
  const dbMeta = hasFreshMeta ? null : getAppMeta(game.appId);
  const gameName = game.name || appInfo?.name || dbMeta?.name || `AppID ${game.appId}`;
  const gameIcon = game.icon || appInfo?.header_image || dbMeta?.headerImage || "";

  // 가격/무료/출시 정보. 라이브러리 게임은 appInfo 호출을 피하기 위해 캐시만 사용.
  // 캐시 미스 시 가격 정보 없이 표시 (사용자가 다른 경로로 appdetails 호출 시 채워짐).
  const isFree = appInfo?.is_free ?? cachedInfo?.is_free;
  const price = appInfo?.price_overview ?? cachedInfo?.price_overview;
  const releaseInfo = appInfo?.release_date ?? cachedInfo?.release_date;
  const comingSoon = releaseInfo?.coming_soon;
  const releaseDate = releaseInfo?.date;

  if (isCancelled()) return null;

  // 리뷰 조회
  const reviewResult = await getReviews(
    game.appId,
    filters.language,
    10,
    filters.dayRange
  );

  let reviews: SteamReview[] = reviewResult?.data ?? [];
  let noReviewsInLanguage = false;

  if (reviews.length > 0) {
    // 서버 후처리 필터 적용
    reviews = applyPostFilters(reviews, filters);

    // 필터 후 부족하면 더 많은 리뷰로 재요청 (1회만)
    if (reviews.length < REVIEW_RETRY_THRESHOLD) {
      const retryResult = await getReviews(
        game.appId,
        filters.language,
        MAX_REVIEWS_PER_GAME,
        filters.dayRange
      );
      if (retryResult) {
        reviews = applyPostFilters(retryResult.data, filters);
      }
    }
  } else {
    noReviewsInLanguage = true;
  }

  return { appId: game.appId, gameName, gameIcon, reviews, noReviewsInLanguage, isFree, price, comingSoon, releaseDate };
}

// --- 게임 목록 수집 ---

/** 통합 게임 정보 (위시리스트와 라이브러리를 통일된 형태로) */
interface GameEntry {
  appId: number;
  /** 라이브러리 게임만 name 포함. 위시리스트 게임은 undefined. */
  name?: string;
  /** 라이브러리 게임만 icon URL 포함. */
  icon?: string;
}

/**
 * 소스(위시리스트/라이브러리/both)에 따라 게임 목록을 수집한다.
 * 정렬 및 상한(PAGE_SIZE개) 적용.
 *
 * 위시리스트: date_added 최신순 정렬
 * 라이브러리: 최근 2주 플레이 > 총 플레이타임 순 정렬
 *
 * @param steamId 사용자 Steam64 ID
 * @param filters 파싱된 필터 (source, offset 사용)
 * @returns 통합 게임 목록
 */
async function collectGameList(
  steamId: string,
  filters: ReturnType<typeof parseFilters>
): Promise<GameEntry[]> {
  const games: GameEntry[] = [];

  // source=both인 경우 각 소스 25개씩 (총 50개)
  const limitPerSource =
    filters.source === "both" ? Math.floor(PAGE_SIZE / 2) : PAGE_SIZE;

  if (filters.source === "wishlist" || filters.source === "both") {
    const result = await getWishlist(steamId);
    if (result) {
      const sorted = [...result.data].sort(
        (a, b) => b.date_added - a.date_added
      );
      const sliced = sorted.slice(filters.offset, filters.offset + limitPerSource);
      games.push(
        ...sliced.map(
          (item: SteamWishlistItem): GameEntry => ({
            appId: item.appid,
          })
        )
      );
    }
  }

  if (filters.source === "library" || filters.source === "both") {
    const result = await getOwnedGames(steamId);
    if (result) {
      const sorted = sortLibraryGames(result.data);
      const sliced = sorted.slice(filters.offset, filters.offset + limitPerSource);
      games.push(
        ...sliced.map(
          (game: SteamOwnedGame): GameEntry => ({
            appId: game.appid,
            name: game.name,
            icon: game.img_icon_url
              ? `https://media.steampowered.com/steamcommunity/public/images/apps/${game.appid}/${game.img_icon_url}.jpg`
              : undefined,
          })
        )
      );
    }
  }

  return games;
}

