/**
 * 성향 분석 + 추천 SSE 엔드포인트.
 * GET /api/recommend?cardMin=180&unplayedMax=60&excludeFree=false&topN=6&max=12&tracks=lib,wish
 *
 * 작업 지시서 3.3절 구현. 두 트랙 추천을 모두 반환:
 *   - 트랙 A (library-unplayed): classify가 'unplayed'로 분류한 라이브러리 게임
 *   - 트랙 B (wishlist):         위시리스트 중 성향 매칭 게임
 *
 * SSE 이벤트 시퀀스:
 *   cached          { profile, libraryUnplayed, wishlist,
 *                     ownedGames, wishlistGames, wishlistFetchFailed,
 *                     computedAt }                                (0 또는 1회, 가장 먼저)
 *   progress        { phase: "fetching-meta", loaded, total }    (반복)
 *   partial-result  { profile, libraryUnplayed, wishlist }       (반복, 3초 throttle)
 *   progress        { phase: "analyzing",     loaded, total }    (1회)
 *   result          { profile, libraryUnplayed, wishlist }       (1회, 확정)
 *   done            { ownedGames, wishlistGames, cacheHitRate,
 *                     wishlistFetchFailed, analysisInsufficient } (1회)
 *
 * cached: 같은 옵션으로 분석한 캐시가 있으면 어떤 fetch보다도 먼저 전달한다.
 *   클라이언트는 "이전 분석 결과"로 즉시 그려줄 수 있고, 백그라운드 분석이
 *   완료되면 result/done에서 새 데이터로 덮어쓴다. 캐시 조회 실패는 silent skip.
 *
 * partial-result 의도: 5000+ 라이브러리의 첫 분석이 수십 분 걸리는 동안
 * 사용자가 즉시 잠정 순위를 볼 수 있도록 한다. fetch 순서를 라이브러리
 * playtime 내림차순으로 강제하여 성향 프로필이 초반에 빠르게 안정화되고,
 * 후속 메타 도착은 위시리스트와 미플레이 후보의 매칭만 채워나가는 구조.
 *
 * 취소 패턴은 `app/api/reviews/stream/route.ts:116-138, 228-264` 와 동일:
 *   cancelled 플래그 + ReadableStream cancel() 콜백. 배치 시작 전 isCancelled
 *   체크. delay는 abortable이 아니지만 1초 단위로 짧다.
 */

import { NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getOwnedGames, getWishlist, getAppDetailsBatch } from "@/lib/steam/api";
import { rateLimitResponse } from "@/lib/rate-limit";
import { logEvent } from "@/lib/logger";
import {
  analyzeTaste,
  recommendLibraryUnplayed,
  recommendFromWishlist,
  buildOwnedAnalyzedGame,
  buildWishlistAnalyzedGame,
  validateAnalyzeOptions,
  DEFAULT_ANALYZE_OPTIONS,
  type AnalyzeOptions,
  type TasteProfile,
  type Recommendation,
} from "@/lib/steam/profile";
import type { SteamAppDetails, SteamOwnedGame, SteamWishlistItem } from "@/lib/steam/types";
import {
  getRecommendationCache,
  setRecommendationCache,
  hashOptions,
} from "@/lib/recommend-cache";
import { sseEvent, sseResponse } from "@/lib/sse";

/** partial-result emit 간격 (ms). 너무 짧으면 SSE 트래픽과 분석 CPU 낭비. */
const PARTIAL_EMIT_INTERVAL_MS = 3000;

/**
 * 시드 단계 게임 수.
 *
 * fetch 순서의 첫 단계로 최고 playtime 상위 N개를 우선 처리한다. 이 시드만
 * 채워져도 성향 프로필이 분산되지 않은 형태로 형성되어, 이후 단계에서 들어오는
 * 후보 게임이 즉시 점수를 받을 수 있다.
 *
 * 20개 근거: log(1+pt) 가중치 하에서 상위 20개가 사용자별 totalWeight의
 * 절반 이상을 차지하는 것이 일반적(샘플: 5347 라이브러리에서 ~62%). 더 늘리면
 * 첫 후보가 나타나는 시점이 뒤로 밀린다.
 */
const PROFILE_SEED_COUNT = 20;

export const dynamic = "force-dynamic";

/**
 * 쿼리 파라미터 파싱 + 검증.
 * 잘못된 값은 throw → 호출 측에서 400 반환.
 */
function parseOptions(params: URLSearchParams): {
  options: AnalyzeOptions;
  tracks: { lib: boolean; wish: boolean };
} {
  const num = (key: string, fallback: number, min: number, max: number): number => {
    const raw = params.get(key);
    if (raw === null) return fallback;
    const n = parseInt(raw, 10);
    if (Number.isNaN(n) || n < min || n > max) {
      throw new Error(`Invalid ${key}: ${raw} (expected integer in [${min}, ${max}])`);
    }
    return n;
  };

  const options: AnalyzeOptions = {
    cardFarmingMaxMinutes: num("cardMin", DEFAULT_ANALYZE_OPTIONS.cardFarmingMaxMinutes, 0, 1440),
    unplayedMaxMinutes: num("unplayedMax", DEFAULT_ANALYZE_OPTIONS.unplayedMaxMinutes, 0, 600),
    excludeFree: params.get("excludeFree") === "true",
    topNTaste: num("topN", DEFAULT_ANALYZE_OPTIONS.topNTaste, 1, 12),
    maxRecommendationsPerTrack: num("max", DEFAULT_ANALYZE_OPTIONS.maxRecommendationsPerTrack, 1, 30),
  };
  validateAnalyzeOptions(options);

  const tracksParam = params.get("tracks") ?? "lib,wish";
  const tracksList = tracksParam.split(",").map(s => s.trim()).filter(Boolean);
  const allowed = new Set(["lib", "wish"]);
  for (const t of tracksList) {
    if (!allowed.has(t)) {
      throw new Error(`Invalid tracks: "${t}" (allowed: lib, wish)`);
    }
  }
  if (tracksList.length === 0) {
    throw new Error(`Invalid tracks: must contain at least one of "lib", "wish"`);
  }
  return {
    options,
    tracks: { lib: tracksList.includes("lib"), wish: tracksList.includes("wish") },
  };
}

export async function GET(request: NextRequest) {
  const limited = rateLimitResponse(request);
  if (limited) return limited;

  const session = await getSession();
  if (!session.steamId) {
    return new Response("Unauthorized", { status: 401 });
  }

  let parsed: ReturnType<typeof parseOptions>;
  try {
    parsed = parseOptions(request.nextUrl.searchParams);
  } catch (err) {
    return new Response((err as Error).message, { status: 400 });
  }

  logEvent("recommend_analyze", {
    steamId: session.steamId,
    options: parsed.options,
    tracks: parsed.tracks,
  });

  let cancelled = false;
  const stream = new ReadableStream({
    async start(controller) {
      try {
        await runAnalysis(controller, session.steamId!, parsed.options, parsed.tracks, () => cancelled);
      } catch (err) {
        if (cancelled) return;
        console.error("[recommend] Analysis error:", err);
        try {
          controller.enqueue(sseEvent("error", { message: "분석 중 오류가 발생했습니다." }));
        } catch { /* controller already closed */ }
      } finally {
        if (!cancelled) {
          try { controller.close(); } catch { /* already closed */ }
        }
      }
    },
    cancel() { cancelled = true; },
  });

  return sseResponse(stream);
}

/**
 * 분석 입력(owned + wishlist + detailsMap)으로부터 profile + 두 트랙 추천을 계산한다.
 *
 * 부분 분석/최종 분석 양쪽에서 호출되는 공통 헬퍼. detailsMap이 부분적으로
 * 채워져 있어도 동작한다 — 미수신 appid는 detailsMap.get()이 undefined를
 * 반환하므로 buildOwnedAnalyzedGame이 null details fallback으로 처리하고,
 * 메타가 없는 게임은 genreIds/categoryIds가 비어 score=0이 되어 추천에서 제외된다.
 */
function computeRecommendations(
  owned: SteamOwnedGame[],
  wishlist: SteamWishlistItem[],
  detailsMap: ReadonlyMap<number, SteamAppDetails | null>,
  tracks: { lib: boolean; wish: boolean },
  options: AnalyzeOptions,
) {
  const analyzedOwned = owned.map(g => buildOwnedAnalyzedGame(g, detailsMap.get(g.appid) ?? null));
  const analyzedWishlist = wishlist.map(w => buildWishlistAnalyzedGame(w, detailsMap.get(w.appid) ?? null));
  const profile = analyzeTaste(analyzedOwned, options);
  const libraryUnplayed = tracks.lib ? recommendLibraryUnplayed(analyzedOwned, profile, options) : [];
  const wishlistRecs = tracks.wish ? recommendFromWishlist(analyzedWishlist, profile, options) : [];
  return { profile, libraryUnplayed, wishlist: wishlistRecs };
}

/**
 * 분석 메인 로직.
 *
 * 0) 캐시 조회 — 같은 옵션 결과가 DB에 있으면 cached 이벤트 즉시 전송 (분석은 계속 진행).
 * 1) 라이브러리 + 위시리스트 동시 fetch (라이브러리 실패 시 종료)
 * 2) uniqueIds 4-bucket 정렬:
 *    a. 시드 — 최고 playtime 상위 PROFILE_SEED_COUNT (성향 빠른 안정화)
 *    b. 후보 — pt ≤ unplayedMaxMinutes (시드 제외) → 첫 추천 카드 빠르게 출현
 *    c. 나머지 라이브러리 — card-farming + 시드 외 analyzed-tier (playtime 내림차순)
 *    d. 위시리스트 — 라이브러리에 없는 ID
 *    각 bucket 내부는 playtime 내림차순(시드/c) 또는 playtime 내림차순(b) +
 *    appid 오름차순 동률 처리로 결정론 보장.
 * 3) getAppDetailsBatch (캐시 우선, 진행률 SSE) — 3초 throttle로 partial-result
 *    emit + 같은 throttle 구간에서 부분 결과를 recommendation_cache에 저장.
 *    사용자가 분석 도중 탭을 닫아도 다음 방문 시 그때까지 모은 결과를 즉시 본다.
 * 4) 라이브러리는 분석, 두 트랙 모두 추천 산출
 * 5) result + done 이벤트 전송
 * 6) 최종 결과를 캐시에 저장 (실패해도 분석 흐름에 영향 없음)
 */
async function runAnalysis(
  controller: ReadableStreamDefaultController,
  steamId: string,
  options: AnalyzeOptions,
  tracks: { lib: boolean; wish: boolean },
  isCancelled: () => boolean,
) {
  // optionsHash는 read/write 모두에서 같은 값을 써야 한다. options나 tracks가
  // 어디선가 변형돼 두 hash가 어긋나면 같은 의미의 cache가 매번 miss된다.
  // 단 한 번만 계산하여 closure로 공유.
  const optionsHash = hashOptions({ options, tracks });

  // partial-result 결과의 "content signature". 동일 모양이 반복 emit되는 후반부
  // (메타 누락 게임이 연속 도착하는 시점 등)에 중복 SSE emit과 중복 cache write를
  // 모두 막기 위함. 매 emit 시점에 비교 — 동일하면 SSE/cache 양쪽 skip.
  //
  // contract: lastEmittedSignature는 null로 초기화돼야 함 — 첫 partial이 반드시
  // 발화하여 클라이언트의 cached banner를 clear(page.tsx의 setCachedAt(null))
  // 시키는 보장. cached payload의 sig로 seed하면 cached banner가 stuck됨.
  let lastEmittedSignature: string | null = null;
  let lastWrittenSignature: string | null = null;

  /**
   * 현재 결과의 signature 생성.
   *
   * 단순 길이 비교가 아니라 "내용 식별 가능한 키"까지 포함한다 — 이전엔 length만
   * 비교해서 다음 collision이 발생했다:
   *   - profile.genres.length가 topNTaste(기본 8)에 saturate된 후 내부 ranking
   *     이 바뀌어도 sig 동일 → 사용자가 stale 추천 봄.
   *   - 추천 list에서 한 게임이 빠지고 다른 게임이 들어오면 length 그대로 → 변경
   *     감지 못함.
   * 이제 genre/category의 key + 추천의 appid를 sig에 포함시켜 identity 변화도
   * 감지. 비교 비용: ~200-300자 string equality, 무시 가능.
   */
  function computeResultSignature(
    profile: TasteProfile,
    libraryUnplayed: Recommendation[],
    wishlistRecs: Recommendation[],
  ): string {
    const genreKeys = profile.genres.map(e => e.key).join(",");
    const catKeys = profile.categories.map(e => e.key).join(",");
    const libIds = libraryUnplayed.map(r => r.appid).join(",");
    const wishIds = wishlistRecs.map(r => r.appid).join(",");
    return `${profile.analyzedGames}|${genreKeys}|${catKeys}|${libIds}|${wishIds}`;
  }

  // 0. 캐시 조회 — DB I/O가 빠르고 분석 시작 전 즉시 보여주기 위함.
  //    조회 실패는 silent (try/catch) — 캐시 모듈 자체 오류로 분석을 막지 않는다.
  try {
    const cached = getRecommendationCache(steamId, optionsHash);
    if (cached) {
      controller.enqueue(sseEvent("cached", {
        profile: cached.payload.profile,
        libraryUnplayed: cached.payload.libraryUnplayed,
        wishlist: cached.payload.wishlist,
        ownedGames: cached.payload.ownedGames,
        wishlistGames: cached.payload.wishlistGames,
        wishlistFetchFailed: cached.payload.wishlistFetchFailed,
        computedAt: cached.computedAt,
      }));
    }
  } catch (err) {
    console.warn("[recommend] cache read failed:", err);
  }

  // 1. 라이브러리/위시리스트 fetch (병렬)
  const [ownedRes, wishlistRes] = await Promise.all([
    getOwnedGames(steamId),
    getWishlist(steamId),
  ]);

  if (isCancelled()) return;

  if (!ownedRes) {
    // 라이브러리 조회 실패 → 분석 자체가 불가. result 없이 done에 플래그로 알린다.
    // EventSource는 named "error" 이벤트의 data를 일반 핸들러로 받지만,
    // 클라이언트가 명확히 분기하려면 done 플래그가 더 안정적이다.
    controller.enqueue(sseEvent("done", {
      ownedGames: 0,
      wishlistGames: 0,
      cacheHitRate: 0,
      wishlistFetchFailed: false,
      analysisInsufficient: false,
      libraryFetchFailed: true,
    }));
    return;
  }

  const owned = ownedRes.data;
  const wishlistFetchFailed = wishlistRes === null;
  const wishlist = wishlistRes?.data ?? [];

  /**
   * 분석 도중/완료 시점에 cache write를 시도하는 통합 헬퍼.
   *
   * 가드 정책 (한 곳에 모음):
   *   - !isCancelled — 더 최근 분석이 먼저 끝났을 때 이 분석이 stale row를
   *     덮지 않도록. INSERT OR REPLACE last-writer-wins 회피.
   *   - 의미 있는 signal — profile.analyzedGames > 0 AND (genres OR categories
   *     중 하나는 채워짐). 이 두 조건이 모두 충족되어야 cached event가 나중에
   *     사용자에게 보여줄 가치가 있다. analyzedGames=0(=analysisInsufficient)
   *     이거나 모든 차원 비어있음(=metaMissingDominant)이면 차단.
   *     partial/final 동일 정책.
   *   - !wishlistFetchFailed — 위시리스트 일시 장애를 cache에 굳히지 않음.
   *     (이전엔 final write에서만 검사하여 partial이 wishlistFetchFailed=false
   *     를 거짓으로 박는 회귀가 있었음 — 이제 통합 helper가 한 번에 처리.)
   *   - 중복 dedupe — 같은 모양의 payload를 연속 쓰지 않음 (force=false인 경우).
   *     후반부 메타 누락 게임 연속 fetch 시 동일 페이로드가 반복 저장되는 낭비 차단.
   *   - force=true (final write 전용) — dedupe를 우회한다. 마지막 partial과 final
   *     의 sig가 우연히 일치해도 final write는 반드시 수행하여 cache row의
   *     computed_at이 분석 완료 시각으로 갱신되도록. 그렇지 않으면 다음 방문 시
   *     cached banner에 표시되는 "N분 전"이 실제 완료 시각보다 빠르게 표시.
   */
  function tryWriteCache(
    profile: TasteProfile,
    libraryUnplayed: Recommendation[],
    wishlistRecs: Recommendation[],
    force = false,
  ): void {
    if (isCancelled()) return;
    if (wishlistFetchFailed) return;
    if (profile.analyzedGames === 0) return;
    if (profile.genres.length === 0 && profile.categories.length === 0) return;

    // dedupe signature — 사용자에게 보여지는 cached payload의 모양이 바뀌었는지만
    // 빠르게 비교한다. profile/추천이 정밀하게 바뀐 경우(weight 미세 변화)는
    // 의도적으로 무시 — 그 수준의 차이는 cache hit으로 보여줘도 같은 결과처럼
    // 보이고, 저장 노이즈만 늘림.
    const sig = computeResultSignature(profile, libraryUnplayed, wishlistRecs);
    if (!force && sig === lastWrittenSignature) return;

    try {
      setRecommendationCache(steamId, optionsHash, {
        profile,
        libraryUnplayed,
        wishlist: wishlistRecs,
        ownedGames: owned.length,
        wishlistGames: wishlist.length,
        // wishlistFetchFailed는 위 가드에서 false임을 보장 — 실제 값을 그대로 저장.
        wishlistFetchFailed,
      });
      lastWrittenSignature = sig;
    } catch (err) {
      console.warn("[recommend] cache write failed:", err);
    }
  }

  // 2. fetch 순서 4-bucket 정렬
  //    시드(상위 K) → 후보(pt ≤ unplayedMax) → 나머지 라이브러리 → 위시리스트
  //    동률은 appid 오름차순으로 결정론 보장.
  const ownedByPlaytimeDesc = owned
    .slice()
    .sort((a, b) => b.playtime_forever - a.playtime_forever || a.appid - b.appid);
  const seed = ownedByPlaytimeDesc.slice(0, PROFILE_SEED_COUNT);
  const seedIdSet = new Set(seed.map(g => g.appid));
  // 시드 이후 게임을 후보/나머지로 분리
  // - 후보: pt ≤ unplayedMaxMinutes (excludeFree는 fetch 단계에서 따지지 않음 — 메타
  //   없이는 isFree를 모르므로. 분석/추천 단계의 classify가 정확히 거른다.)
  // - 나머지: card-farming 구간 + 시드 외 analyzed-tier
  const afterSeed = ownedByPlaytimeDesc.filter(g => !seedIdSet.has(g.appid));
  const candidates = afterSeed.filter(g => g.playtime_forever <= options.unplayedMaxMinutes);
  const remaining = afterSeed.filter(g => g.playtime_forever > options.unplayedMaxMinutes);
  // 위시리스트는 라이브러리와 중복 제거 (같은 appid는 라이브러리 쪽 위치에서 한 번만 fetch)
  const ownedIdSet = new Set(owned.map(g => g.appid));
  const wishlistIdsOnly = wishlist.map(w => w.appid).filter(id => !ownedIdSet.has(id));
  const uniqueIds = [
    ...seed.map(g => g.appid),
    ...candidates.map(g => g.appid),
    ...remaining.map(g => g.appid),
    ...wishlistIdsOnly,
  ];
  const total = uniqueIds.length;

  controller.enqueue(sseEvent("progress", { phase: "fetching-meta", loaded: 0, total }));

  // 3초 throttle 상태. 시작 시각을 lastEmit으로 두어 첫 번째 emit이 3초 후에 발생.
  let lastPartialEmitAt = Date.now();

  // 캐시 히트 통계: getAppDetailsBatch가 한 게임 끝낼 때마다 onProgress 호출.
  // 캐시 히트율을 측정하려면 캐시 인스턴스 노출이 필요한데 1차 범위에선 생략.
  // done 이벤트의 cacheHitRate는 0(미측정)으로 둔다.
  const detailsMap = await getAppDetailsBatch(
    uniqueIds,
    (loaded, t, partial) => {
      // 매 게임마다 progress 보내면 SSE 트래픽이 많음. 5게임마다 또는 마지막에만 전송.
      if (loaded % 5 === 0 || loaded === t) {
        try {
          controller.enqueue(sseEvent("progress", { phase: "fetching-meta", loaded, total: t }));
        } catch { /* closed */ }
      }
      // 3초 throttle로 잠정 추천 전송. 마지막 게임에서도 한 번 더 보내면 final result와
      // 중복이라 마지막 게임 도달 시는 skip — final phase에서 result 이벤트로 보낸다.
      const now = Date.now();
      if (loaded < t && now - lastPartialEmitAt >= PARTIAL_EMIT_INTERVAL_MS) {
        lastPartialEmitAt = now;
        const { profile, libraryUnplayed, wishlist: wishlistRecs } =
          computeRecommendations(owned, wishlist, partial, tracks, options);
        // 동일 signature dedup — 후반부 메타 누락 게임이 연속 fetch되어
        // 결과 모양이 같은 시점이 흔하다. 같은 sig가 또 오면 SSE/cache 양쪽
        // skip하여 (1) 네트워크 트래픽 (2) 클라이언트 React re-render
        // (3) SQLite write를 모두 절약. throttle timer는 그대로 갱신해 다음
        // 비교 시점을 정상화.
        const sig = computeResultSignature(profile, libraryUnplayed, wishlistRecs);
        if (sig === lastEmittedSignature) {
          // skip SSE emit + cache write. tryWriteCache도 자체 lastWrittenSignature
          // 가드로 막히지만 명시적으로 skip하여 의도 명확화.
          return;
        }
        lastEmittedSignature = sig;
        try {
          controller.enqueue(sseEvent("partial-result", {
            profile,
            libraryUnplayed,
            wishlist: wishlistRecs,
            loaded,
            total: t,
          }));
        } catch { /* closed */ }
        // 중간 부분 결과를 DB에 영속화 — 사용자가 분석 도중에 탭을 닫아도
        // 다음 방문 시 cached event로 여기까지 모은 결과가 즉시 표시된다.
        // 가드/dedupe 정책은 tryWriteCache가 통합 관리.
        tryWriteCache(profile, libraryUnplayed, wishlistRecs);
      }
    },
    isCancelled,
  );

  if (isCancelled()) return;

  // 4. 최종 분석 (입력은 동일 함수)
  controller.enqueue(sseEvent("progress", { phase: "analyzing", loaded: total, total }));

  const { profile, libraryUnplayed, wishlist: wishlistRecs } =
    computeRecommendations(owned, wishlist, detailsMap, tracks, options);

  if (isCancelled()) return;

  // 5. result + done
  controller.enqueue(sseEvent("result", {
    profile,
    libraryUnplayed,
    wishlist: wishlistRecs,
  }));

  // analysisInsufficient: 작업 지시서 R5b — 분석에 기여한 게임이 0.
  // 메타 누락이 많아 분석 풀은 있지만 신호가 없는 케이스는 별도 플래그(metaMissingDominant).
  const analysisInsufficient = profile.analyzedGames === 0;
  const metaMissingDominant = profile.analyzedGames > 0
    && profile.genres.length === 0
    && profile.categories.length === 0;

  controller.enqueue(sseEvent("done", {
    ownedGames: owned.length,
    wishlistGames: wishlist.length,
    cacheHitRate: 0,
    wishlistFetchFailed,
    analysisInsufficient,
    metaMissingDominant,
    libraryFetchFailed: false,
  }));

  // 6. 캐시 저장 — partial과 동일한 tryWriteCache 헬퍼 사용. 가드 정책은 헬퍼
  //    정의에 모아 둠. analysisInsufficient/metaMissingDominant는 헬퍼의 "의미
  //    있는 signal" 가드(genres + categories 모두 빔 차단)로 자연히 막힌다.
  //    force=true: 마지막 partial과 sig가 우연히 일치해도 final write는 반드시
  //    수행하여 computed_at이 분석 완료 시각으로 갱신되도록.
  tryWriteCache(profile, libraryUnplayed, wishlistRecs, true);
}
