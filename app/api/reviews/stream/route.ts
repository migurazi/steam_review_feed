/**
 * SSE 리뷰 스트리밍 엔드포인트.
 * GET /api/reviews/stream?source=wishlist&language=koreana&...
 *
 * 게임 목록을 가져와 게임별로 순차적으로 리뷰를 수집하고,
 * SSE(Server-Sent Events)로 클라이언트에 점진적으로 전송한다.
 *
 * 기획서 5.4절(점진적 로딩)과 7.2절(리뷰 수집 로직) 구현.
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
import { logEvent } from "@/lib/logger";
import { rateLimitResponse } from "@/lib/rate-limit";
import type {
  SteamWishlistItem,
  SteamOwnedGame,
  SteamReview,
  SteamAppDetails,
} from "@/lib/steam/types";

export const dynamic = "force-dynamic";

// --- 필터 기본값 (기획서 5.2절) ---
const DEFAULTS = {
  source: "wishlist" as const,
  language: "koreana",
  minPlaytime: 0,
  minLength: 0,
  reviewType: "all" as const,
  dayRange: 30,
  excludeFree: true,
  offset: 0,
};

const PAGE_SIZE = 50;
const MAX_REVIEWS_PER_GAME = 20;

/** 쿼리 파라미터를 파싱하여 필터 설정을 반환한다. */
function parseFilters(params: URLSearchParams) {
  return {
    /** 단일 게임 조회 모드. 지정 시 source 무시하고 이 게임만 조회. */
    appId: params.get("appId") || null,
    source: (params.get("source") || DEFAULTS.source) as
      | "wishlist"
      | "library"
      | "both",
    language: params.get("language") || DEFAULTS.language,
    minPlaytime: parseInt(params.get("minPlaytime") || "0", 10),
    minLength: parseInt(params.get("minLength") || "0", 10),
    reviewType: (params.get("reviewType") || DEFAULTS.reviewType) as
      | "all"
      | "positive"
      | "negative",
    dayRange: parseInt(params.get("dayRange") || "30", 10),
    excludeFree: params.get("excludeFree") !== "false",
    offset: parseInt(params.get("offset") || "0", 10),
  };
}

/** SSE 이벤트를 TextEncoder로 인코딩한다. */
function sseEvent(event: string, data: unknown): Uint8Array {
  const encoder = new TextEncoder();
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * 서버 후처리 필터: 리뷰 배열에 minPlaytime, minLength, reviewType 적용.
 * Steam API의 language, day_range는 서버 사이드에서 이미 적용됨.
 */
function applyPostFilters(
  reviews: SteamReview[],
  filters: { minPlaytime: number; minLength: number; reviewType: string }
): SteamReview[] {
  return reviews.filter((r) => {
    // 최소 플레이타임 (시간 → 분 변환)
    if (
      filters.minPlaytime > 0 &&
      r.author.playtime_at_review < filters.minPlaytime * 60
    ) {
      return false;
    }

    // 최소 글자수
    if (filters.minLength > 0 && r.review.length < filters.minLength) {
      return false;
    }

    // 추천/비추천 필터
    if (filters.reviewType === "positive" && !r.voted_up) return false;
    if (filters.reviewType === "negative" && r.voted_up) return false;

    return true;
  });
}

/**
 * 게임이 무료인지 확인한다.
 * 캐시에 is_free 정보가 있으면 사용, 없으면 appdetails 호출.
 *
 * @returns true=무료, false=유료, null=확인 불가(API 실패)
 */
async function checkIsFree(appId: number): Promise<boolean | null> {
  // 캐시에서 먼저 확인
  const cached = cacheGet<SteamAppDetails>(`app:${appId}:info`);
  if (cached) return cached.data.is_free;

  // 캐시 미스: appdetails 호출 (1초 딜레이 포함)
  const details = await getAppDetails(appId);
  if (!details) return null;
  return details.data.is_free;
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
  // 클라이언트가 연결을 끊으면 cancelled=true가 되어 enqueue를 중단한다.
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

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

/** 메인 스트리밍 로직: 게임 목록 → 게임별 리뷰 수집 → SSE 전송 */
async function streamReviews(
  controller: ReadableStreamDefaultController,
  steamId: string,
  filters: ReturnType<typeof parseFilters>,
  isCancelled: () => boolean = () => false
) {
  // 단일 게임 모드: appId가 지정되면 해당 게임만 조회
  if (filters.appId) {
    const appIdNum = parseInt(filters.appId, 10);
    const details = await getAppDetails(appIdNum);
    const gameName = details?.data.name || `AppID ${filters.appId}`;
    const gameIcon = details?.data.header_image || "";

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
      })
    );
    controller.enqueue(sseEvent("progress", { loaded: 1, total: 1 }));
    controller.enqueue(
      sseEvent("done", { totalGames: 1, totalReviews: reviews.length })
    );
    return;
  }

  // 1. 게임 목록 수집 (소스에 따라)
  const games = await collectGameList(steamId, filters);
  if (games.length === 0) {
    controller.enqueue(sseEvent("done", { totalGames: 0, totalReviews: 0 }));
    return;
  }

  const total = games.length;
  let loaded = 0;
  let totalReviews = 0;

  // 2. 게임별 순차 처리
  for (const game of games) {
    // 클라이언트가 연결을 끊었으면 중단
    if (isCancelled()) return;
    loaded++;

    // 무료 게임 제외 필터
    if (filters.excludeFree) {
      // 라이브러리 게임은 캐시 히트일 때만 사전 필터, 아니면 appdetails 호출
      const isFree = await checkIsFree(game.appId);
      if (isFree === true) {
        controller.enqueue(sseEvent("progress", { loaded, total }));
        continue;
      }
      // isFree === null (API 실패)이면 건너뛰지 않고 리뷰 조회 시도
    }

    // 게임 이름/아이콘 확보
    let gameName = game.name || `AppID ${game.appId}`;
    let gameIcon = game.icon || "";

    // 위시리스트 게임은 이름이 없으므로 appdetails에서 가져옴
    if (!game.name) {
      const cached = cacheGet<SteamAppDetails>(`app:${game.appId}:info`);
      if (cached) {
        gameName = cached.data.name;
        gameIcon = cached.data.header_image;
      } else {
        // 이미 checkIsFree에서 appdetails를 호출했을 수 있음
        const details = await getAppDetails(game.appId);
        if (details) {
          gameName = details.data.name;
          gameIcon = details.data.header_image;
        }
      }
    }

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

      // 필터 후 2개 미만 → 20개로 재요청 (1회만, 최대 20개 상한)
      if (reviews.length < 2) {
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
      // 해당 언어 리뷰가 0건
      noReviewsInLanguage = true;
    }

    totalReviews += reviews.length;

    // SSE 이벤트 전송
    controller.enqueue(
      sseEvent("game-reviews", {
        appId: game.appId,
        gameName,
        gameIcon,
        reviews,
        noReviewsInLanguage,
      })
    );

    // 진행 상태
    controller.enqueue(sseEvent("progress", { loaded, total }));
  }

  // 3. 완료
  controller.enqueue(
    sseEvent("done", { totalGames: total, totalReviews })
  );
}

/** 통합 게임 정보 (위시리스트와 라이브러리를 통일된 형태로) */
interface GameEntry {
  appId: number;
  name?: string; // 라이브러리만 name 포함
  icon?: string; // 라이브러리만 icon 포함
}

/**
 * 소스(위시리스트/라이브러리/both)에 따라 게임 목록을 수집한다.
 * 사전 필터링: 캐시에 is_free=true인 게임만 제외.
 * 정렬 및 상한(50개) 적용.
 */
async function collectGameList(
  steamId: string,
  filters: ReturnType<typeof parseFilters>
): Promise<GameEntry[]> {
  const games: GameEntry[] = [];

  // source=both인 경우 각 소스 25개씩
  const limitPerSource =
    filters.source === "both" ? PAGE_SIZE / 2 : PAGE_SIZE;

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
      const sorted = [...result.data].sort((a, b) => {
        const aRecent = a.playtime_2weeks ?? 0;
        const bRecent = b.playtime_2weeks ?? 0;
        if (aRecent > 0 && bRecent === 0) return -1;
        if (aRecent === 0 && bRecent > 0) return 1;
        if (aRecent > 0 && bRecent > 0) return bRecent - aRecent;
        return b.playtime_forever - a.playtime_forever;
      });
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
