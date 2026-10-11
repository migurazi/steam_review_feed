/**
 * 성향 분석 + 추천 SSE 엔드포인트.
 * GET /api/recommend?cardMin=180&unplayedMax=60&excludeFree=false&topN=6&max=12&value=true&saleOnly=false&tracks=lib,wish[,deal]
 *
 * 작업 지시서 3.3절 구현. 트랙별 추천을 반환:
 *   - 트랙 A (library-unplayed): classify가 'unplayed'로 분류한 라이브러리 게임
 *   - 트랙 B (wishlist):         위시리스트 중 성향 매칭 게임
 *   - 트랙 C (store-deal):       미보유·위시리스트 밖 할인 게임 (tracks에 deal, opt-in)
 *
 * SSE 이벤트 시퀀스:
 *   cached          { profile, libraryUnplayed, wishlist, storeDeals?,
 *                     ownedGames, wishlistGames, wishlistFetchFailed,
 *                     computedAt }                                (0 또는 1회, 가장 먼저)
 *   cached-store-deals { storeDeals }                             (0 또는 1회, 라이브러리 조회 직후 —
 *                     cached의 발굴 목록에서 그 사이 소유·위시 추가된 게임을 뺀 교체본)
 *   progress        { phase: "fetching-meta", loaded, total }    (반복)
 *   partial-result  { profile, libraryUnplayed, wishlist }       (반복, 3초 throttle)
 *                   wishlist는 saleOnly일 때 null (가격 확인 전 미확정)
 *   progress        { phase: "fetching-prices", loaded, total }  (위시 트랙, 반복)
 *   progress        { phase: "analyzing",     loaded, total }    (1회)
 *   progress        { phase: "fetching-reviews", loaded, total } (반복)
 *   result          { profile, libraryUnplayed, wishlist, pool, priceFetchFailed } (1회, 라이브러리·위시 확정)
 *
 * pool (partial-result·result·cached, 발굴은 store-deals의 pool/reviews): 재정렬 풀
 *   (lib/recommend-rerank.ts). 가성비·할인만·개수는 서버 재요청 없이 클라이언트가 이 풀로 다시
 *   계산한다. 그래서 결과 캐시 키에서도 그 세 옵션을 뺀다. 이벤트의 목록들은 요청 옵션 기준이다.
 *   --- tracks.deal일 때만 (발굴 단계, result 이후) ---
 *   progress        { phase: "discovering", loaded, total }        (할인 후보 수집)
 *   progress        { phase: "fetching-prices", loaded, total }    (후보 가격·리뷰 요약, GetItems)
 *   progress        { phase: "fetching-deal-meta", loaded, total } (후보 장르 메타)
 *   store-deals     { storeDeals, failed, truncated, previous? }   (1회, 발굴 확정)
 *   ---
 *   done            { ownedGames, wishlistGames, cacheHitRate,
 *                     wishlistFetchFailed, analysisInsufficient,
 *                     metaMissingDominant, libraryFetchFailed,
 *                     priceFetchFailed, storeDealsFailed,
 *                     storeDealsTruncated }                       (1회, 항상 마지막)
 *
 * 가성비 (작업 지시서 20261010_01 단계 1): 위시 트랙 Recommendation에 price/priceFetchedAt이
 *   실리고, value=true면 할인 매력도를 블렌딩한다. 가격 커버리지가 부족하면
 *   priceFetchFailed=true로 기존 산식 fallback.
 *
 * 할인 발굴 (작업 지시서 20261010_01 단계 2): 라이브러리·위시 result를 먼저 보낸 뒤 발굴한다.
 *   발굴은 최대 DISCOVER_TIME_BUDGET_MS(120초)가 걸릴 수 있어, result에 묶으면 기존 두 트랙
 *   표시가 그만큼 늦어지기 때문이다. 발굴의 어떤 실패도 두 트랙 결과에 영향을 주지 않는다.
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
import {
  getOwnedGames,
  getWishlist,
  getStoreMetaBatch,
  getReviewSummariesBatch,
  getStoreItemPricesBatch,
  getStoreSpecials,
  getStoreItemsBatch,
  getCachedStoreMetaIds,
  peekReviewSummary,
} from "@/lib/steam/api";
import { orderMetaFetch } from "@/lib/recommend-fetch-order";
import { rateLimitResponse } from "@/lib/rate-limit";
import { logEvent } from "@/lib/logger";
import {
  PRICE_STALE_MS,
  DISCOVER_POOL_SIZE,
  DISCOVER_META_CAP,
  DISCOVER_TIME_BUDGET_MS,
} from "@/lib/constants";
import { filterDiscoverPool, selectDealCandidatesForMeta } from "@/lib/steam/deals";
import {
  analyzeTaste,
  recommendLibraryUnplayed,
  recommendFromWishlist,
  buildOwnedAnalyzedGame,
  buildWishlistAnalyzedGame,
  validateAnalyzeOptions,
  computeReviewScore,
  planWishlistBlend,
  blendWishlistTrack,
  buildReviewBadge,
  buildStoreDealCandidate,
  recommendStoreDeals,
  DEFAULT_ANALYZE_OPTIONS,
  REVIEW_BADGE_MIN_SAMPLE,
  type AnalyzeOptions,
  type TasteProfile,
  type OwnedAnalyzedGame,
  type Recommendation,
  type StoreDealCandidate,
} from "@/lib/steam/profile";
import type { SteamAppDetails, SteamOwnedGame, SteamWishlistItem, ReviewSummary, PriceSnapshot } from "@/lib/steam/types";
import {
  getRecommendationCache,
  setRecommendationCache,
  hashOptions,
} from "@/lib/recommend-cache";
import { sseEvent, sseResponse } from "@/lib/sse";
import {
  REVIEW_SHORTLIST_CAP,
  shortlistSizeFor,
  buildWishlistPool,
  rerankFromPool,
  poolAppIds,
  shouldKeepPreviousWishlist,
  withPreviousWishlist,
  type RerankPool,
} from "@/lib/recommend-rerank";

/** partial-result emit 간격 (ms). 너무 짧으면 SSE 트래픽과 분석 CPU 낭비. */
const PARTIAL_EMIT_INTERVAL_MS = 3000;

/**
 * partial-result에 재정렬 풀을 싣는 최소 간격 (ms). 풀은 목록보다 훨씬 크다(후보 최대 ~120개 + 리뷰).
 * 3초마다 실으면 긴 분석에서 SSE 트래픽이 수 MB가 되므로, 바뀌었을 때만 + 이 간격 이상으로 보낸다.
 * 조기 위시 확정 partial과 최종 result는 이 간격과 무관하게 항상 싣는다.
 * 클라이언트는 풀이 없는 partial에서 이전 풀을 유지한다(잠정 결과라 최대 이 간격만큼 늦게 반영).
 */
const PARTIAL_POOL_EMIT_INTERVAL_MS = 30_000;

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

/**
 * 빠른 모드(fastMode) 조회 상한.
 *
 * 메타 조회는 GetItems 배치(100개/호출)라 대형 라이브러리도 수십 초면 끝나지만, 빠른 모드는 여전히
 * 이 둘을 상한해 조회량과 분석 표본을 줄인다. (appdetails 직렬 시절에는 수십 분→몇 분 단축이 목적이었다.)
 *   - FAST_CANDIDATE_CAP: 미플레이 후보 수 상한. 후보는 playtime 내림차순으로
 *     정렬되어 있어 "조금이라도 켜본" 게임이 우선 포함된다(단순 무작위보다 나은 표본).
 *   - FAST_ANALYZED_CAP: 시드(PROFILE_SEED_COUNT) 외 analyzed-tier 조회 상한.
 *     성향은 최다 플레이 상위 게임이 대부분 좌우하므로 상한해도 프로필이 크게 안 변한다.
 * 트레이드오프: 상한 밖 후보는 추천에서 빠진다(완결성 희생). 값은 경험적 조정 대상.
 */
const FAST_CANDIDATE_CAP = 150;
const FAST_ANALYZED_CAP = 80;

/**
 * 외부 조회 성공률 하한 (한 정책을 한 상수로 — /code-review 2차 R9).
 *   - 위시 가격: 확보 비율이 이보다 낮으면 가격 조회 실패로 보고 가성비 블렌딩을 끈다
 *     (기존 산식 fallback) — 작업 지시서 20261010_01 §1-4 ②.
 *   - 할인 발굴: GetItems·장르 메타 성공률이 이보다 낮으면 "일부 후보만 확인"으로 알린다 (단계 2).
 */
const FETCH_COVERAGE_MIN = 0.5;

/** 위시 가격 조회가 실패했을 때 최종 단계에서 다시 시도하기까지의 최소 간격 (R1). */
const PRICE_RETRY_MIN_MS = 5 * 60 * 1000;

/**
 * phase B 동안 조기 확정 위시를 다시 블렌딩하는 간격과, 한 번에 새로 조회할 리뷰 요약 수 상한
 * (작업 지시서 20261010_02 §3-1). 리뷰 요약은 GetItems 배치(100개/호출)라 상한 안이면 호출 1회다.
 * (이전에는 appreviews 개별 호출 0.5s × N이라 5개로 묶어 두었다.)
 */
const EARLY_WISH_REFRESH_MS = 30_000;
const EARLY_WISH_REVIEW_CAP = 100;

/**
 * 재정렬 풀의 내용 식별자 (partial dedupe용). appid·할인율·리뷰 확보 수만 본다 — 클라이언트 재정렬
 * 결과가 바뀔 수 있는 변화(후보 교체, 할인 변동, 새 리뷰 도착)를 잡기에 충분하다.
 */
function poolSignature(pool: RerankPool): string {
  const ids = (recs: Recommendation[]) => recs.map(r => `${r.appid}:${r.price?.discount_percent ?? ""}`).join(",");
  return `${ids(pool.library)}|${ids(pool.wishlist)}|${Object.keys(pool.reviews).length}|${pool.wishPricesReady ? 1 : 0}${pool.wishPriceOk ? 1 : 0}`;
}

/** 풀의 리뷰 중 recs에 해당하는 것만 꺼낸다 (이전 풀의 발굴 리뷰 이어 쓰기용). */
function pickReviews(pool: RerankPool | undefined, recs: Recommendation[] | undefined): RerankPool["reviews"] {
  const out: RerankPool["reviews"] = {};
  if (!pool || !recs) return out;
  for (const r of recs) if (r.appid in pool.reviews) out[r.appid] = pool.reviews[r.appid];
  return out;
}

/** 요청 트랙. deal은 미보유 할인 게임 발굴(opt-in, 작업 지시서 20261010_01 단계 2). */
interface Tracks { lib: boolean; wish: boolean; deal: boolean }

export const dynamic = "force-dynamic";

/**
 * 쿼리 파라미터 파싱 + 검증.
 * 잘못된 값은 throw → 호출 측에서 400 반환.
 */
function parseOptions(params: URLSearchParams): {
  options: AnalyzeOptions;
  tracks: Tracks;
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
    fastMode: params.get("fast") === "true",
    // 기본 true라 "false"일 때만 끈다. 기존 boolean 쿼리와 같은 느슨한 파싱 (작업 지시서 20261010_01 §1-3).
    valueWeighting: params.get("value") !== "false",
    saleOnly: params.get("saleOnly") === "true",
  };
  validateAnalyzeOptions(options);

  const tracksParam = params.get("tracks") ?? "lib,wish";
  const tracksList = tracksParam.split(",").map(s => s.trim()).filter(Boolean);
  const allowed = new Set(["lib", "wish", "deal"]);
  for (const t of tracksList) {
    if (!allowed.has(t)) {
      throw new Error(`Invalid tracks: "${t}" (allowed: lib, wish, deal)`);
    }
  }
  if (tracksList.length === 0) {
    throw new Error(`Invalid tracks: must contain at least one of "lib", "wish", "deal"`);
  }
  return {
    options,
    tracks: {
      lib: tracksList.includes("lib"),
      wish: tracksList.includes("wish"),
      deal: tracksList.includes("deal"),
    },
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
  /**
   * 트랙별 반환 개수 상한. 기본은 maxRecommendationsPerTrack(=최종 노출 수).
   * 최종 분석에서 리뷰 블렌딩용 shortlist를 뽑을 때는 더 큰 값을 넘긴다.
   */
  limit: number = options.maxRecommendationsPerTrack,
  /**
   * 위시리스트 가격 스냅샷 (getStoreItemPricesBatch). 미전달이면 가격 미조회 상태로 분석한다
   * (partial-result 경로). details.price_overview는 캐시 경로에 따라 묵었거나 없으므로
   * 가격은 반드시 이 맵으로만 주입한다 (작업 지시서 20261010_01 §1-1).
   */
  priceMap?: ReadonlyMap<number, PriceSnapshot>,
  /**
   * truncate 전 위시 전체 매칭 목록(wishlistAll)이 필요한지. 할인 후보 보강(planWishlist)을 하는
   * 경로만 true. partial(3초마다)처럼 버릴 목록이면 false로 두어 전체 정렬을 생략한다
   * (작업 지시서 20261010_02 §4). false면 wishlistAll은 빈 배열.
   */
  withWishlistAll = false,
  /**
   * 같은 detailsMap·같은 분석 옵션으로 이미 계산한 라이브러리 분석. 주면 다시 계산하지 않는다.
   * 라이브러리 분석은 보유 게임 수천 개를 도는 가장 비싼 단계인데, 조기 위시 단계는 같은 메타로
   * 세 번 계산했다(잠정 결과·위시 블렌딩·풀 재구성) (/code-review 5차 #10).
   * 성향은 saleOnly·가성비·개수와 무관하므로(classify는 임계값·무료 제외만 본다) 그 옵션만 다른
   * 호출끼리 공유해도 된다. 메타가 다른(진행 중에 채워지는) 맵에는 쓰면 안 된다.
   */
  ownedAnalysis?: OwnedAnalysis,
) {
  const analyzedOwned = ownedAnalysis?.analyzedOwned
    ?? owned.map(g => buildOwnedAnalyzedGame(g, detailsMap.get(g.appid) ?? null));
  const profile = ownedAnalysis?.profile ?? analyzeTaste(analyzedOwned, options);
  const analysis: OwnedAnalysis = { analyzedOwned, profile };
  const libraryUnplayed = tracks.lib ? recommendLibraryUnplayed(analyzedOwned, profile, options, limit) : [];
  if (!tracks.wish) return { profile, libraryUnplayed, wishlist: [], wishlistAll: [], analysis };
  const analyzedWishlist = wishlist.map(w =>
    buildWishlistAnalyzedGame(w, detailsMap.get(w.appid) ?? null, priceMap?.get(w.appid)),
  );
  if (!withWishlistAll) {
    return { profile, libraryUnplayed, wishlist: recommendFromWishlist(analyzedWishlist, profile, options, limit), wishlistAll: [], analysis };
  }
  // truncate 전 전체 매칭 목록 — 할인 후보 보강(augmentWithDeals)의 후보 풀.
  // 한 번만 정렬하고 slice로 shortlist를 얻는다 (recommendFromWishlist의 slice와 같은 결과).
  const wishlistAll = recommendFromWishlist(analyzedWishlist, profile, options, Number.MAX_SAFE_INTEGER);
  return { profile, libraryUnplayed, wishlist: wishlistAll.slice(0, limit), wishlistAll, analysis };
}

/** 라이브러리 분석 결과 (computeRecommendations의 ownedAnalysis 참조). */
interface OwnedAnalysis {
  analyzedOwned: OwnedAnalyzedGame[];
  profile: TasteProfile;
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
 * 3) getStoreMetaBatch (GetItems 100개/호출, 캐시 우선, 진행률 SSE) — 3초 throttle로 partial-result
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
  tracks: Tracks,
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
  // partial-result 풀 전송 throttle 상태 (PARTIAL_POOL_EMIT_INTERVAL_MS).
  let lastPoolSentSig: string | null = null;
  let lastPoolSentAt = 0;
  // 메타 진행 중 partial 캐시 쓰기 시각 (makeMetaProgress 참조). 최종 결과는 force로 쓴다.
  let lastPartialCacheWriteAt = 0;

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
    wishlistRecs: Recommendation[] | null,
    storeDeals?: Recommendation[],
  ): string {
    const genreKeys = profile.genres.map(e => e.key).join(",");
    const catKeys = profile.categories.map(e => e.key).join(",");
    const libIds = libraryUnplayed.map(r => r.appid).join(",");
    // null = 가격 확인 전이라 미확정(saleOnly partial). 할인율도 포함해 할인 변동만
    // 있어도 signature가 바뀌도록 한다 (작업 지시서 20261010_01 §1-4).
    const wishIds = wishlistRecs === null
      ? "-"
      : wishlistRecs.map(r => `${r.appid}:${r.price?.discount_percent ?? ""}`).join(",");
    const base = `${profile.analyzedGames}|${genreKeys}|${catKeys}|${libIds}|${wishIds}`;
    // 발굴 결과가 없으면(undefined) 단계 1과 같은 문자열을 유지한다.
    return storeDeals === undefined
      ? base
      : `${base}|${storeDeals.map(r => `${r.appid}:${r.price?.discount_percent ?? ""}`).join(",")}`;
  }

  // 이전 분석의 발굴 결과 (deal 해시 캐시에서). 발굴이 끝나기 전의 중간 캐시 쓰기(partial,
  // result 직후)가 storeDeals 없이 행을 덮어 이전 발굴 결과를 지우지 않도록 이어 쓴다.
  // 가격에는 priceFetchedAt이 있어 클라이언트가 묵은 가격을 회색으로 구분한다.
  let carriedStoreDeals: Recommendation[] | undefined;
  // 이전 분석의 위시 결과. 위시 메타가 아직 다 오지 않은 동안의 partial 캐시 쓰기가 일부 위시만으로
  // 만든 목록으로 완전한 이전 결과를 덮지 않도록 대신 저장한다 (wishForCache).
  let carriedWishlist: Recommendation[] | undefined;
  // 이전 분석의 재정렬 풀. 위시 풀은 carriedWishlist와, 발굴 풀(storeDeals)은 carriedStoreDeals와 같은
  // 이유로 이어 쓴다. 구 캐시 row(풀 도입 전)에는 없다.
  let carriedPool: RerankPool | undefined;

  // 0. 캐시 조회 — DB I/O가 빠르고 분석 시작 전 즉시 보여주기 위함.
  //    조회 실패는 silent (try/catch) — 캐시 모듈 자체 오류로 분석을 막지 않는다.
  try {
    const cached = getRecommendationCache(steamId, optionsHash);
    if (cached && tracks.deal) carriedStoreDeals = cached.payload.storeDeals;
    if (cached && tracks.wish) carriedWishlist = cached.payload.wishlist;
    if (cached) carriedPool = cached.payload.pool;
    if (cached) {
      controller.enqueue(sseEvent("cached", {
        profile: cached.payload.profile,
        libraryUnplayed: cached.payload.libraryUnplayed,
        wishlist: cached.payload.wishlist,
        // 발굴 트랙 결과. deal을 요청한 해시에만 저장되므로 그 외에는 undefined.
        storeDeals: cached.payload.storeDeals,
        ownedGames: cached.payload.ownedGames,
        wishlistGames: cached.payload.wishlistGames,
        wishlistFetchFailed: cached.payload.wishlistFetchFailed,
        // 재정렬 풀 + 위시 가격 실패 여부. 캐시 키가 재정렬 옵션(가성비·할인만·개수)을 빼고 만들어져
        // 있어, 클라이언트는 풀로 현재 옵션의 목록을 다시 계산한다.
        pool: cached.payload.pool,
        priceFetchFailed: cached.payload.priceFetchFailed ?? false,
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

  // 이어 쓸 이전 발굴 결과를 지금의 라이브러리·위시리스트로 다시 거른다 — 지난 분석 이후 구매하거나
  // 위시리스트에 넣은 게임이 "미보유 할인"으로 계속 남지 않도록. 위시리스트를 못 불러왔으면
  // 거를 수 없으므로 이어 쓰지 않는다.
  //
  // cached 이벤트는 라이브러리 조회 전에 나가므로 거르지 않은 목록이 이미 클라이언트에 있다.
  // 걸러서 빠진 게임이 있으면 cached-store-deals로 교체해, 발굴(1–2분)이 끝나기 전이나 분석이
  // store-deals 전에 오류로 끝나도 구매한 게임이 "미보유 할인"으로 남지 않게 한다.
  // 위시리스트 조회 실패 시 화면용으로는 소유만이라도 거르고, 캐시 이어 쓰기는 하지 않는다.
  if (carriedStoreDeals !== undefined) {
    const excluded = new Set([...owned.map(g => g.appid), ...wishlist.map(w => w.appid)]);
    const filtered = carriedStoreDeals.filter(r => !excluded.has(r.appid));
    // 발굴 풀도 같은 기준으로 거른다 — 클라이언트는 풀로 다시 계산하므로 목록만 거르면 구매한 게임이 남는다.
    const poolDeals = carriedPool?.storeDeals;
    const filteredPoolDeals = poolDeals?.filter(r => !excluded.has(r.appid));
    if (filtered.length !== carriedStoreDeals.length || filteredPoolDeals?.length !== poolDeals?.length) {
      try {
        controller.enqueue(sseEvent("cached-store-deals", { storeDeals: filtered, poolStoreDeals: filteredPoolDeals }));
      } catch { /* closed */ }
    }
    carriedStoreDeals = wishlistFetchFailed ? undefined : filtered;
    if (carriedPool) {
      carriedPool = { ...carriedPool, storeDeals: wishlistFetchFailed ? undefined : filteredPoolDeals };
    }
  } else if (carriedPool?.storeDeals !== undefined && !tracks.deal) {
    // 발굴을 요청하지 않은 분석이면 이전 발굴 풀도 이어 쓰지 않는다 (carriedStoreDeals와 같은 규칙).
    carriedPool = { ...carriedPool, storeDeals: undefined };
  }

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
   *   - !(tracks.wish && wishlistFetchFailed) — 위시리스트 일시 장애를 cache에
   *     굳히지 않음. 단 위시리스트 트랙이 꺼진(tracks.wish=false) 요청은 위시리스트
   *     결과 자체를 보여주지 않으므로 장애가 무의미 → 라이브러리 결과만이라도 캐시한다.
   *     (트랙 조합은 optionsHash에 포함되어 wish=off 캐시가 wish=on 뷰로 새지 않는다.)
   *     (이전엔 final write에서만 검사하여 partial이 wishlistFetchFailed=false
   *     를 거짓으로 박는 회귀가 있었음 — 이제 통합 helper가 한 번에 처리.)
   *   - 중복 dedupe — 같은 모양의 payload를 연속 쓰지 않음 (force=false인 경우).
   *     후반부 메타 누락 게임 연속 fetch 시 동일 페이로드가 반복 저장되는 낭비 차단.
   *   - force=true (final write 전용) — dedupe를 우회한다. 마지막 partial과 final
   *     의 sig가 우연히 일치해도 final write는 반드시 수행하여 cache row의
   *     computed_at이 분석 완료 시각으로 갱신되도록. 그렇지 않으면 다음 방문 시
   *     cached banner에 표시되는 "N분 전"이 실제 완료 시각보다 빠르게 표시.
   *
   * @returns 이 payload가 캐시에 반영된 상태인지 (방금 썼거나 같은 내용이 이미 저장됨). 가드로
   *   건너뛰었거나 쓰기가 실패하면 false — partial 쓰기 throttle이 시각을 갱신하지 않고 다음 틱에 다시 시도한다.
   */
  function tryWriteCache(
    profile: TasteProfile,
    libraryUnplayed: Recommendation[],
    wishlistRecs: Recommendation[],
    /**
     * 재정렬 풀. storeDeals 필드는 이 함수가 storeDealsArg 규칙으로 채운다(호출 측 값은 무시).
     * 발굴 풀을 줄 때는 storeDealsArg.pool로 넘긴다.
     */
    poolArg: RerankPool,
    force = false,
    /**
     * 발굴 트랙 결과.
     *   - { list, pool }: 그 결과(최종 목록 + 재정렬용 shortlist)를 저장.
     *   - 생략(undefined): 이전 분석의 발굴 결과(carriedStoreDeals·carriedPool.storeDeals)를 이어 쓰고,
     *     없으면 넣지 않는다.
     *   - null: 이어 쓰지 않고 payload에서 뺀다 (이번 발굴이 저장할 수 없는 결과일 때).
     */
    storeDealsArg?: { list: Recommendation[]; pool: Recommendation[]; reviews: RerankPool["reviews"] } | null,
  ): boolean {
    const storeDeals = storeDealsArg === null ? undefined : (storeDealsArg?.list ?? carriedStoreDeals);
    const poolStoreDeals = storeDealsArg === null ? undefined : (storeDealsArg?.pool ?? carriedPool?.storeDeals);
    const pool: RerankPool = {
      ...poolArg,
      storeDeals: poolStoreDeals,
      // 발굴 풀의 리뷰(GetItems 요약)도 함께 둔다. 이어 쓰는 경우는 이전 풀에서 가져온다.
      reviews: {
        ...(storeDealsArg ? storeDealsArg.reviews : storeDealsArg === undefined ? pickReviews(carriedPool, poolStoreDeals) : {}),
        ...poolArg.reviews,
      },
    };
    if (isCancelled()) return false;
    // 위시리스트 트랙이 켜져 있을 때만 위시리스트 장애로 캐시를 막는다.
    if (tracks.wish && wishlistFetchFailed) return false;
    if (profile.analyzedGames === 0) return false;
    if (profile.genres.length === 0 && profile.categories.length === 0) return false;

    // dedupe signature — 사용자에게 보여지는 cached payload의 모양이 바뀌었는지만
    // 빠르게 비교한다. profile/추천이 정밀하게 바뀐 경우(weight 미세 변화)는
    // 의도적으로 무시 — 그 수준의 차이는 cache hit으로 보여줘도 같은 결과처럼
    // 보이고, 저장 노이즈만 늘림.
    const sig = `${computeResultSignature(profile, libraryUnplayed, wishlistRecs, storeDeals)}#${poolSignature(pool)}`;
    if (!force && sig === lastWrittenSignature) return true;

    try {
      setRecommendationCache(steamId, optionsHash, {
        profile,
        libraryUnplayed,
        wishlist: wishlistRecs,
        ownedGames: owned.length,
        wishlistGames: wishlist.length,
        // wish 트랙이 켜져 있으면 위 가드에서 wishlistFetchFailed=false가 보장된다.
        // wish 트랙이 꺼진 경우엔 위시리스트 장애가 이 뷰와 무관하므로 false로 저장
        // (cached 수신 시 클라이언트가 위시리스트 실패 배너를 잘못 띄우지 않도록).
        wishlistFetchFailed: tracks.wish && wishlistFetchFailed,
        ...(storeDeals !== undefined ? { storeDeals } : {}),
        pool,
        // 캐시는 재정렬 옵션과 무관한 키라, 위시 가격 실패를 함께 저장해 두어야 다음 방문의 cached
        // 결과에서 클라이언트가 (할인만 켬일 때) "할인 게임 없음" 대신 가격 실패 안내를 띄운다.
        // 저장하는 풀에서 계산한다 — poolForCache가 이전 분석의 위시 풀을 이어 쓸 수 있어, 이번 실행의
        // priceFetchFailed 값과 풀이 어긋나면 다음 방문에 "할인 게임 없음"이 잘못 보인다 (/code-review M2).
        priceFetchFailed: tracks.wish && pool.wishPricesReady && !pool.wishPriceOk,
      });
      lastWrittenSignature = sig;
      return true;
    } catch (err) {
      console.warn("[recommend] cache write failed:", err);
      return false;
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
  // 시드 이후 게임을 후보/analyzed-tier로 분리
  // - 후보: pt ≤ unplayedMaxMinutes (excludeFree는 fetch 단계에서 따지지 않음 — 메타
  //   없이는 isFree를 모르므로. 분석/추천 단계의 classify가 정확히 거른다.)
  // - analyzed-tier: pt ≥ cardFarmingMaxMinutes (성향 신호에 기여, 시드 외)
  //
  // 카드팜 구간(unplayedMax < pt < cardFarmingMax)은 조회 목록에서 **제외**한다.
  // 이 구간 게임은 classify가 playtime만으로 'card-farming'으로 판정해 분석·추천
  // 양쪽에서 배제하므로 메타(장르/카테고리)가 전혀 필요 없다. 첫 분석의 메타 조회
  // 양을 줄이는 무료·안전 최적화 — 추천 결과는 불변이다.
  //   주의: excludeFree=true + 무료인 카드팜 게임은 메타 없이는 isFree를 몰라
  //   excludedFree 대신 cardFarmingExcluded로 집계된다(둘 다 '제외'라 추천엔 무영향,
  //   진단 카운트만 미세 이동). 이 희귀 교집합의 정확도를 위해 수천 건을 더 조회할
  //   가치는 없다.
  const afterSeed = ownedByPlaytimeDesc.filter(g => !seedIdSet.has(g.appid));
  const candidatesAll = afterSeed.filter(g => g.playtime_forever <= options.unplayedMaxMinutes);
  // analyzed-tier: classify의 'analyzed'와 정확히 일치 (pt ≥ cardFarmingMax AND pt >
  // unplayedMax). `pt > unplayedMax` 조건은 두 슬라이더가 같을 때(cardFarmingMax ==
  // unplayedMax) 경계 게임이 candidates와 겹쳐 이중 집계되는 것을 막는다.
  const analyzedRestAll = afterSeed.filter(
    g => g.playtime_forever >= options.cardFarmingMaxMinutes
      && g.playtime_forever > options.unplayedMaxMinutes,
  );
  // 세 버킷(candidates / analyzedRest / card-farming)은 disjoint하며 afterSeed를
  // 정확히 덮으므로 skip 수 = 나머지.
  const cardFarmingSkipped = afterSeed.length - candidatesAll.length - analyzedRestAll.length;
  // 빠른 모드: 조회 대상을 상한한다. 두 배열 모두 playtime 내림차순이라 slice는
  // 후보에서 "더 많이 켜본" 게임, analyzed에서 "최다 플레이" 게임을 우선 남긴다.
  const candidates = options.fastMode ? candidatesAll.slice(0, FAST_CANDIDATE_CAP) : candidatesAll;
  const analyzedRest = options.fastMode ? analyzedRestAll.slice(0, FAST_ANALYZED_CAP) : analyzedRestAll;
  const fastModeSkipped = options.fastMode
    ? (candidatesAll.length - candidates.length) + (analyzedRestAll.length - analyzedRest.length)
    : 0;
  // 조회는 두 단계로 나눈다 — 순서 규칙은 lib/recommend-fetch-order.ts 참조.
  //   phase A: 시드 + 영속 캐시에 메타가 있는 후보·위시·나머지 라이브러리 (딜레이 없이 수 초).
  //            끝나면 위시 트랙을 가격·리뷰까지 반영해 조기 확정하고, 라이브러리 트랙도 캐시된
  //            후보만으로 바로 보인다.
  //   phase B: 미캐시분 (GetItems 100개/호출) — 후보 먼저, 그다음 나머지 라이브러리와 위시를 번갈아.
  //   이전 순서(시드 + 위시 전체 → 후보)는 위시리스트가 수천 개면 위시 메타 조회에 1시간 넘게
  //   걸려 라이브러리 트랙이 그동안 비었다.
  //   위시 메타에는 이미 소유한 위시 게임도 포함한다 — 위시 트랙은 소유 여부와 무관하게 전체가
  //   후보이고, 카드팜 구간이면 라이브러리 버킷에서도 메타를 받지 못하기 때문.
  //   위시 트랙이 꺼진 요청(tracks.wish=false)은 위시 메타를 조회하지 않는다.
  const seedIds = seed.map(g => g.appid);
  const candidateIds = candidates.map(g => g.appid);
  const wishlistMetaIds = tracks.wish ? wishlist.map(w => w.appid) : [];
  const restIds = analyzedRest.map(g => g.appid);
  const { phaseA: phaseAIds, phaseB: phaseBIds } = orderMetaFetch({
    seedIds,
    candidateIds,
    wishlistIds: wishlistMetaIds,
    restIds,
    // 공유 캐시 테이블 전체가 아니라 이번 분석이 조회할 appid만 확인한다 (/code-review 3차 #8).
    cachedIds: getCachedStoreMetaIds([...seedIds, ...candidateIds, ...wishlistMetaIds, ...restIds]),
  });
  const total = phaseAIds.length + phaseBIds.length;
  if (cardFarmingSkipped > 0) {
    logEvent("recommend_cardfarming_skipped", { steamId, count: cardFarmingSkipped });
  }
  if (fastModeSkipped > 0) {
    logEvent("recommend_fastmode_capped", { steamId, count: fastModeSkipped });
  }

  // 분석 스코프. 빠른 모드에서는 조회 대상(seed+candidates+analyzedRest)으로 한정한다.
  // 그렇지 않으면 상한 밖 analyzed 게임이 메타 없이 analyzeTaste에 들어가 'metaMissing'
  // 으로 집계되어 프로필 통계에 "메타 누락 N"이 부풀려 표시된다(추천엔 무영향이나
  // 사용자에게 오류처럼 보임). 스코프를 좁혀 통계가 실제 분석 표본을 반영하게 한다.
  //   - 전체 모드: owned 그대로. 카드팜 게임은 조회 안 해도 playtime만으로 classify가
  //     'card-farming'으로 집계(metaMissing 아님)하므로 통계 왜곡 없음.
  //   - 라이브러리 크기(ownedGames)는 done/캐시에서 여전히 owned.length(전체)로 보고.
  const fetchedOwnedIdSet = new Set(
    [...seed, ...candidates, ...analyzedRest].map(g => g.appid),
  );
  const ownedForAnalysis = options.fastMode
    ? owned.filter(g => fetchedOwnedIdSet.has(g.appid))
    : owned;

  controller.enqueue(sseEvent("progress", { phase: "fetching-meta", loaded: 0, total }));

  // 3초 throttle 상태. 시작 시각을 lastEmit으로 두어 첫 번째 emit이 3초 후에 발생.
  let lastPartialEmitAt = Date.now();

  // 위시 가격 상태. 조기 위시 단계(phase A 직후)에서 채우고 최종 단계에서 재사용한다.
  let priceMap: Map<number, PriceSnapshot> | undefined;
  let priceFetchFailed = false;
  /**
   * 위시 가격 스냅샷의 기준 시각 (Unix ms) — 첫 조회 또는 마지막 전체 재조회 시각. 최종 단계
   * 재조회 판단용 (R1). 0이면 아직 조회 전.
   */
  let wishlistPricesFetchedAt = 0;
  /** 이번 실행에서 가격 조회를 시도한 위시 appid. 증분 조회가 같은 실패를 반복하지 않게 한다. */
  const priceAttemptedIds = new Set<number>();
  /**
   * 이번 실행에서 확보한 리뷰 요약 (appid → 요약, null = 조회 실패). 재정렬 풀(pool.reviews)의
   * 출처다 — 클라이언트가 가성비·할인만·개수를 바꿔 재정렬할 때 서버 재요청 없이 쓸 수 있도록
   * 조회한 것은 모두 모아 둔다. 풀에 넣을 때는 6시간 캐시(peekReviewSummary)도 함께 본다.
   */
  const reviewMap = new Map<number, ReviewSummary | null>();
  // 조기 확정된 위시 트랙(가격·리뷰 반영). 설정되면 phase B의 partial-result는 매칭 전용
  // 위시 목록 대신 이것을 보낸다 — 가격·배지가 있는 목록이 매칭 전용으로 뒤집히지 않도록.
  // phase B 동안 EARLY_WISH_REFRESH_MS마다 그때까지 도착한 메타·성향으로 다시 블렌딩한다
  // (작업 지시서 20261010_02 §3-1). 미캐시 위시는 phase B에서 도착하므로 고정해 두면 수천 개
  // 위시가 최종 result 전까지 반영되지 않는다.
  let earlyWishlist: Recommendation[] | null = null;
  let phaseBActive = false;
  let wishRefreshInFlight: Promise<void> | null = null;
  let lastWishRefreshAt = 0;
  // 이번 실행에서 리뷰 요약 조회가 실패한 appid. getReviewSummary는 실패를 캐시하지 않으므로,
  // 기억해 두지 않으면 재블렌딩이 30초마다 같은 실패 appid에 상한을 다 써서 뒤 후보가 영영
  // 리뷰를 못 받는다 (/code-review 2차 R3).
  const reviewFailedIds = new Set<number>();

  // 위시 메타가 모두 도착했는지 판정용. 미캐시 위시는 phase B에서 나머지 라이브러리와 번갈아 온다.
  const wishMetaIds = tracks.wish ? Array.from(new Set(wishlist.map(w => w.appid))) : [];
  const wishMetaComplete = (m: ReadonlyMap<number, unknown>): boolean => wishMetaIds.every(id => m.has(id));
  /**
   * partial 캐시 쓰기에 넣을 위시 목록. 위시 메타가 아직 다 오지 않았으면 지금 목록은 위시리스트
   * 일부만으로 만든 것이라, 이전 분석이 남긴 완전한 위시 결과(carriedWishlist)를 덮지 않고 그대로
   * 둔다. 이전 결과가 없으면 지금 목록이라도 저장한다(빈 캐시보다 낫다). 화면에는 지금 목록이 간다.
   */
  const wishForCache = (current: Recommendation[], m: ReadonlyMap<number, unknown>): Recommendation[] =>
    carriedWishlist !== undefined && !wishMetaComplete(m) ? carriedWishlist : current;

  /**
   * 지금까지 받은 메타로 재정렬 풀을 만든다 (lib/recommend-rerank.ts). partial·result 공용.
   *
   *   - 라이브러리: 매칭 상위 REVIEW_SHORTLIST_CAP.
   *   - 위시: saleOnly=false로 계산한 전체 매칭 목록에서 buildWishlistPool 합집합. 요청이 saleOnly여도
   *     풀은 할인 여부와 무관하게 만든다 — 클라이언트가 saleOnly를 끄면 그대로 쓸 수 있어야 한다.
   *   - 리뷰: 이번 실행에서 받은 것(reviewMap) + 6시간 캐시(peek). 네트워크 호출 없음.
   *
   * @returns 풀과 그 계산에 쓴 성향 프로필.
   */
  function buildPool(
    map: ReadonlyMap<number, SteamAppDetails | null>,
    ownedAnalysis?: OwnedAnalysis,
  ): { pool: RerankPool; profile: TasteProfile; analysis: OwnedAnalysis } {
    const computed = computeRecommendations(
      ownedForAnalysis, wishlist, map, tracks, { ...options, saleOnly: false }, REVIEW_SHORTLIST_CAP, priceMap, true,
      ownedAnalysis,
    );
    const pool: RerankPool = {
      library: computed.libraryUnplayed,
      wishlist: buildWishlistPool(computed.wishlistAll),
      reviews: {},
      wishPricesReady: priceMap !== undefined,
      wishPriceOk: priceMap !== undefined && !priceFetchFailed,
    };
    for (const id of poolAppIds(pool)) {
      const s = reviewMap.has(id) ? reviewMap.get(id)! : peekReviewSummary(id);
      if (s !== undefined) pool.reviews[id] = s;
    }
    return { pool, profile: computed.profile, analysis: computed.analysis };
  }

  /**
   * partial 캐시 쓰기에 넣을 풀. wishForCache와 같은 이유로, 위시 메타가 덜 왔으면 이전 분석의 위시
   * 풀(가격·리뷰 포함)을 유지한다.
   */
  const poolForCache = (current: RerankPool, m: ReadonlyMap<number, unknown>): RerankPool => {
    // 이전 풀을 유지하는 경우: (1) 위시 메타가 덜 왔을 때(일부 위시만으로 만든 풀), (2) 이번 풀이 가격
    // 조회 전인데 이전 풀은 가격이 있을 때 — 캐시 키가 할인만 여부와 무관해져, 가격 없는 풀이 저장되면
    // 다음 방문의 할인만 화면이 "가격 확인 중"에 머문다 (/code-review M1). 클라이언트 mergePartialPool과 같은 규칙.
    if (carriedPool === undefined) return current;
    const keepCarried = !wishMetaComplete(m) || shouldKeepPreviousWishlist(current, carriedPool);
    return keepCarried ? withPreviousWishlist(current, carriedPool) : current;
  };

  /**
   * 메타 배치 진행 콜백 생성. phase A/B가 하나의 진행률(total)을 공유하도록 offset을 더한다.
   * 3초 throttle로 잠정 추천(partial-result)을 보내고 캐시에 영속화한다.
   */
  const makeMetaProgress = (
    offset: number,
    baseMap: ReadonlyMap<number, SteamAppDetails | null>,
  ) => (loaded: number, _t: number, partial: ReadonlyMap<number, SteamAppDetails | null>) => {
      const overall = offset + loaded;
      // 진행률은 캐시분 처리 후와 GetItems 배치(100개)마다 한 번씩 온다 — 호출 수가 적어 매번 보낸다.
      {
        try {
          controller.enqueue(sseEvent("progress", { phase: "fetching-meta", loaded: overall, total }));
        } catch { /* closed */ }
      }
      // 위시 주기 재블렌딩 (§3-1). 메타 콜백은 동기라 기다리지 않고 백그라운드로 돌리고,
      // 끝나면 earlyWishlist만 교체한다 — 다음 partial이 새 목록을 보낸다(signature에 appid 포함).
      //   - 진행 중 Map은 getStoreMetaBatch가 계속 채우므로 시점 스냅샷을 복사해 넘긴다.
      //   - 리뷰 요약은 캐시분 + 미캐시 최대 EARLY_WISH_REVIEW_CAP개만 GetItems 배치로 조회.
      //   - phase B가 끝난 뒤 늦게 끝난 재블렌딩은 버린다(최종 단계가 전체로 다시 계산).
      if (
        earlyWishlist !== null && phaseBActive && wishRefreshInFlight === null
        && Date.now() - lastWishRefreshAt >= EARLY_WISH_REFRESH_MS
      ) {
        const snapshot = new Map([...baseMap, ...partial]);
        wishRefreshInFlight = rankWishlist(snapshot, EARLY_WISH_REVIEW_CAP)
          .then(ranked => {
            if (ranked !== null && phaseBActive && !isCancelled()) earlyWishlist = ranked;
          })
          .catch(err => console.warn("[recommend] wishlist refresh failed:", err))
          .finally(() => {
            wishRefreshInFlight = null;
            lastWishRefreshAt = Date.now();
          });
      }
      // 3초 throttle로 잠정 추천 전송. 마지막 게임에서도 한 번 더 보내면 final result와
      // 중복이라 마지막 게임 도달 시는 skip — final phase에서 result 이벤트로 보낸다.
      const now = Date.now();
      if (overall < total && now - lastPartialEmitAt >= PARTIAL_EMIT_INTERVAL_MS) {
        lastPartialEmitAt = now;
        // phase B에서는 phase A 결과(baseMap)와 진행 중 결과(partial)를 합쳐 분석한다.
        const merged = baseMap.size > 0 ? new Map([...baseMap, ...partial]) : partial;
        // 재정렬 풀을 만들고 요청 옵션의 목록은 풀에서 계산한다 (클라이언트와 같은 규칙).
        // 클라이언트는 풀로 현재 옵션의 목록을 다시 계산하므로, 아래 목록은 signature·캐시용이다.
        const { pool, profile } = buildPool(merged);
        const lists = rerankFromPool(pool, options);
        const libraryUnplayed = lists.libraryUnplayed;
        // 위시 트랙: 조기 확정분이 있으면 그것. 없고 saleOnly면 가격 확인 전이라 확정할 수
        // 없으므로 null(rerankFromPool)로 보내 클라이언트가 이전 위시 state를 유지하게 한다
        // (깜빡임 방지, 작업 지시서 20261010_01 §1-4 partial-result).
        // 위시 트랙이 꺼진 요청은 풀의 위시가 비어 있어 []가 된다 — null이면 partial 캐시 쓰기가
        // 전부 생략되므로 (/code-review 2차 R5).
        const wishlistRecs: Recommendation[] | null =
          earlyWishlist ?? (tracks.wish ? lists.wishlist : []);
        // 동일 signature dedup — 후반부 메타 누락 게임이 연속 fetch되어
        // 결과 모양이 같은 시점이 흔하다. 같은 sig가 또 오면 SSE/cache 양쪽
        // skip하여 (1) 네트워크 트래픽 (2) 클라이언트 React re-render
        // (3) SQLite write를 모두 절약. throttle timer는 그대로 갱신해 다음
        // 비교 시점을 정상화.
        // sig는 요청 옵션 목록의 모양만 본다. 풀 변화는 poolPending(30초 간격)이 따로 판단한다 —
        // 풀 signature를 sig에 넣으면 리뷰 수만 바뀌어도 매 틱(3초) 같은 목록을 다시 보내게 된다
        // (/code-review 5차 #8). 클라이언트는 풀이 오는 시점에 재정렬 결과를 갱신한다.
        const poolSig = poolSignature(pool);
        const sig = computeResultSignature(profile, libraryUnplayed, wishlistRecs);
        // 풀이 아직 못 보낸 변경을 담고 있고 전송 간격이 지났으면, 모양이 같아도 건너뛰지 않는다 —
        // 그렇지 않으면 간격 안에서 바뀐 풀이 result까지 묶인다 (/code-review M3).
        const poolPending = poolSig !== lastPoolSentSig && now - lastPoolSentAt >= PARTIAL_POOL_EMIT_INTERVAL_MS;
        // 중간 부분 결과를 DB에 영속화 — 사용자가 분석 도중에 탭을 닫아도 다음 방문 시 cached event로
        // 여기까지 모은 결과가 즉시 표시된다. 가드/dedupe 정책은 tryWriteCache가 통합 관리.
        //   - 쓰기 간격은 PARTIAL_POOL_EMIT_INTERVAL_MS(30초) — 3초마다 풀(후보 ~120개)을 SQLite에 다시 쓰지
        //     않도록 (/code-review 4차 #7). 탭을 닫아도 최대 30초 전 결과까지는 남는다.
        //   - 아래 SSE dedup(return)보다 먼저 판단한다. 그렇지 않으면 throttle에 걸려 못 쓴 상태가 이후
        //     같은 signature로 계속 dedup되어 끝까지 저장되지 않는다(최종 쓰기 전에 탭을 닫으면 유실).
        //     tryWriteCache가 자체 signature로 같은 내용 재기록을 막으므로 반복 호출 비용은 비교 1회다.
        //   - 가드로 건너뛴 경우(분석 게임 0 등)는 시각을 갱신하지 않아 다음 틱에 바로 다시 시도한다.
        //   - saleOnly partial은 위시 트랙이 미확정(null)이면 저장하지 않는다. 위시 메타가 덜 왔으면 이전
        //     완전한 위시 결과를 유지(wishForCache·poolForCache).
        if (wishlistRecs !== null && now - lastPartialCacheWriteAt >= PARTIAL_POOL_EMIT_INTERVAL_MS) {
          if (tryWriteCache(profile, libraryUnplayed, wishForCache(wishlistRecs, merged), poolForCache(pool, merged))) {
            lastPartialCacheWriteAt = now;
          }
        }
        if (sig === lastEmittedSignature && !poolPending) {
          // skip SSE emit (캐시 쓰기는 위에서 이미 판단).
          return;
        }
        lastEmittedSignature = sig;
        // 풀은 바뀌었고 마지막 전송 후 간격이 지났을 때만 싣는다 (트래픽).
        const sendPool = poolPending;
        if (sendPool) {
          lastPoolSentSig = poolSig;
          lastPoolSentAt = now;
        }
        try {
          controller.enqueue(sseEvent("partial-result", {
            profile,
            libraryUnplayed,
            wishlist: wishlistRecs,
            ...(sendPool ? { pool } : {}),
            loaded: overall,
            total,
          }));
        } catch { /* closed */ }
      }
    };

  /**
   * 위시리스트 가격 (작업 지시서 20261010_01 §1-4, 1-A 흐름).
   *
   * 조회 범위 (/code-review 3차 #5): 메타가 있는 위시 게임 전체. saleOnly는 shortlist 이전에 걸러야
   *   결과 수가 보장되고, 가성비는 shortlist 밖 할인 후보를 보강하기 때문이다. 요청이 둘 다 꺼져
   *   있어도 전체를 조회한다 — 클라이언트가 서버 재요청 없이 가성비·할인만을 켤 수 있도록 재정렬
   *   풀(lib/recommend-rerank.ts)에 가격이 있어야 하기 때문이다. (3차 #6의 "노출 카드만 조회" 최적화는
   *   이 기능과 양립할 수 없어 되돌렸다.)
   *   메타가 없는 위시 게임은 매칭 점수 0이라 어떤 순위에도 들지 않으므로 제외한다 — 그래서 조기
   *   단계는 phase A(캐시) 메타분만 조회하고, 나머지는 메타가 도착한 뒤(주기 재블렌딩·최종 단계)에
   *   조회한다. 이전 구현은 조기 단계에서 위시리스트 전체(수천 개면 1분+)를 조회해 그동안 미캐시
   *   라이브러리 후보의 메타 조회(phase B)가 시작되지 못했다.
   *
   * 증분 조회: 이미 시도한 appid는 다시 조회하지 않는다(priceAttemptedIds). refresh=true면 시도
   * 여부와 무관하게 coverageIds 전체를 다시 조회한다 — getStoreItemPricesBatch가 fresh 캐시(1h)는 호출 없이
   * 돌려주므로 실제 호출은 만료·실패분만큼이다.
   *
   * 조회 경로: GetItems(api.steampowered.com, 100개/호출, 호출 사이 0.5초). 이전에는 appdetails 가격
   * 배치(store 호스트, 100개마다 1.5초 + 공유 429 backoff)라 위시리스트 수천 개면 수십 초가 걸렸고,
   * 발굴 단계의 store 호출과 한도를 나눠 썼다. 같은 응답으로 위시 게임의 리뷰 요약도 캐시에 채워져
   * 블렌딩 단계의 리뷰 조회가 대부분 캐시에서 끝난다.
   *
   * 커버리지가 FETCH_COVERAGE_MIN 미만이면 가격 조회 실패로 보고, 가성비 블렌딩을 끄고 기존 산식으로
   * fallback한다 (가격 실패가 조용히 순위를 바꾸지 않도록). 커버리지는 coverageIds 기준이다.
   *
   * @param coverageIds 이번 판단에 필요한 위시 appid (중복 허용).
   * @param opts.refresh 이미 시도한 appid도 다시 조회 (가격 만료·실패 재시도).
   * @param opts.progress fetching-prices 진행률을 보낼지. 주기 재블렌딩처럼 메타 진행률과 겹치는
   *   백그라운드 호출은 false.
   */
  async function fetchWishlistPrices(
    coverageIds: readonly number[],
    opts: { refresh?: boolean; progress?: boolean } = {},
  ): Promise<void> {
    if (!tracks.wish) return;
    const ids = Array.from(new Set(coverageIds));
    const fetchIds = opts.refresh ? ids : ids.filter(id => !priceAttemptedIds.has(id));
    if (fetchIds.length > 0) {
      const emit = (loaded: number, t: number) => {
        if (!opts.progress) return;
        try {
          controller.enqueue(sseEvent("progress", { phase: "fetching-prices", loaded, total: t }));
        } catch { /* closed — 탭 닫힘. isCancelled 경로로 조용히 끝나게 한다 (R4) */ }
      };
      emit(0, fetchIds.length);
      const fetched = await getStoreItemPricesBatch(fetchIds, emit, isCancelled);
      // 취소로 중간에 끊긴 경우 결과에 없는 appid는 시도하지 않은 것으로 남겨 둔다(어차피 곧 종료).
      for (const id of fetchIds) {
        if (!isCancelled() || fetched.has(id)) priceAttemptedIds.add(id);
      }
      priceMap = new Map([...(priceMap ?? []), ...fetched]);
      // 스냅샷 신선도 기준 시각: 첫 조회 또는 전체 재조회 시에만 갱신한다. 증분 조회로 갱신하면
      // 1시간 넘게 묵은 앞선 가격이 "방금 조회한 것"으로 보여 최종 단계 재조회가 생략된다.
      if (opts.refresh || wishlistPricesFetchedAt === 0) wishlistPricesFetchedAt = Date.now();
    }
    // 조회할 것이 없었어도(메타 있는 위시 0개 등) "가격 확인 완료" 상태로 둔다 — planWishlist가
    // priceMap === undefined를 가격 미조회로 보기 때문.
    priceMap ??= new Map();
    if (ids.length === 0) {
      priceFetchFailed = false;
      return;
    }
    // 커버리지는 실제로 확인한 가격(fresh 캐시 + 조회 성공)만 센다. 조회 실패분을 채운
    // last-known(fallback)은 카드 표시용(회색)일 뿐 — 세면 Steam 장애 중에도 묵은 할인율로
    // 가성비 순위·saleOnly가 조용히 바뀐다 (작업 지시서 20261010_02, 리뷰 L2).
    const map = priceMap;
    const confirmed = ids.filter(id => {
      const s = map.get(id);
      return s !== undefined && !s.fallback;
    }).length;
    const failed = confirmed / ids.length < FETCH_COVERAGE_MIN;
    // 로그는 실패로 바뀌는 순간만 — 주기 재블렌딩이 30초마다 같은 실패를 남기지 않도록.
    if (failed && !priceFetchFailed) {
      logEvent("recommend_price_fetch_failed", { steamId, fetched: confirmed, total: ids.length });
    }
    priceFetchFailed = failed;
  }

  /** 메타가 도착한(null 아님) 위시 appid = 위시 가격 조회 대상. */
  const wishIdsWithMeta = (m: ReadonlyMap<number, SteamAppDetails | null>): number[] =>
    wishMetaIds.filter(id => m.get(id));

  /** 요청 옵션의 리뷰 블렌딩 shortlist 크기 (조기 위시 단계·발굴 트랙). */
  const shortlistSize = shortlistSizeFor(options.maxRecommendationsPerTrack);

  /**
   * 위시 트랙 블렌딩 대상 산출 (가성비 계획 + saleOnly 가격 실패 처리).
   * 조기 단계와 최종 단계가 같은 규칙을 쓰도록 한 곳에 둔다.
   */
  function planWishlist(shortlistedWish: Recommendation[], wishAll: Recommendation[]) {
    const plan = planWishlistBlend(
      shortlistedWish,
      wishAll,
      options,
      priceMap !== undefined && !priceFetchFailed,
    );
    // saleOnly인데 가격 커버리지가 부족하면, 일부 가격만으로 거른 목록은 위시리스트의
    // 부분집합에 불과해 "할인 게임은 이것뿐"으로 오해된다. 위시 트랙을 비워 클라이언트가
    // 가격 실패 안내를 띄우게 한다 (정직성 제약, 리뷰 M1). 버릴 결과의 리뷰 조회도 생략.
    const targets = options.saleOnly && priceFetchFailed ? [] : plan.targets;
    return { targets, useDeal: plan.useDeal };
  }

  /**
   * 주어진 메타로 위시 트랙을 가격·리뷰까지 블렌딩한다 (조기 확정 + phase B 주기 재블렌딩 공용).
   *
   * @param map 지금까지 받은 메타 (호출 시점 스냅샷이어야 한다 — 비동기 동안 바뀌면 안 됨).
   * @param reviewCap 생략: shortlist 리뷰 요약을 전부 조회하며 진행률을 보낸다(조기 확정, 1회).
   *   지정: 캐시된 요약은 그대로 쓰고 미캐시는 최대 reviewCap개만 조회, 진행률 없음(주기 재블렌딩).
   *   상한을 넘은 후보는 중립 0.5로 블렌딩되고 다음 재블렌딩에서 채워진다.
   * @param ownedAnalysis 같은 map으로 이미 계산한 라이브러리 분석 (조기 확정 경로가 재사용).
   * @returns 블렌딩 결과(배지 포함). 취소되면 null.
   */
  async function rankWishlist(
    map: ReadonlyMap<number, SteamAppDetails | null>,
    reviewCap?: number,
    ownedAnalysis?: OwnedAnalysis,
  ): Promise<Recommendation[] | null> {
    // 블렌딩 전에 메타가 있는 위시 가격을 확보한다. 이미 시도한 appid는 건너뛰므로 주기
    // 재블렌딩에서는 그사이 메타가 도착한 위시만 조회된다(보통 배치 1회 이하).
    await fetchWishlistPrices(wishIdsWithMeta(map), { progress: reviewCap === undefined });
    if (isCancelled()) return null;
    const computed = computeRecommendations(
      ownedForAnalysis, wishlist, map, { lib: false, wish: true }, options, shortlistSize, priceMap, true,
      ownedAnalysis,
    );
    const { targets, useDeal } = planWishlist(computed.wishlist, computed.wishlistAll);
    if (targets.length === 0) return [];
    const ids = targets.map(r => r.appid);

    let summaries: Map<number, ReviewSummary | null>;
    if (reviewCap === undefined) {
      try {
        controller.enqueue(sseEvent("progress", { phase: "fetching-reviews", loaded: 0, total: ids.length }));
      } catch { /* closed (R4) */ }
      // 리뷰 요약: 6시간 캐시 → 미캐시분만 GetItems 배치(100개/호출). 진행률은 캐시분 처리 후와 배치마다
      // 한 번씩만 오므로(호출 수가 적다) 거르지 않고 모두 보낸다.
      summaries = await getReviewSummariesBatch(
        ids,
        (loaded, t) => {
          try {
            controller.enqueue(sseEvent("progress", { phase: "fetching-reviews", loaded, total: t }));
          } catch { /* closed */ }
        },
        isCancelled,
      );
    } else {
      summaries = new Map();
      const missing: number[] = [];
      for (const id of ids) {
        const s = peekReviewSummary(id);
        if (s !== undefined) summaries.set(id, s);
        else missing.push(id);
      }
      const toFetch = missing.filter(m => !reviewFailedIds.has(m)).slice(0, reviewCap);
      if (toFetch.length > 0) {
        const fetched = await getReviewSummariesBatch(toFetch, undefined, isCancelled);
        for (const [id, summary] of fetched) {
          summaries.set(id, summary);
          if (summary === null) reviewFailedIds.add(id);
        }
      }
    }
    if (isCancelled()) return null;
    // 재정렬 풀이 쓰도록 모아 둔다 (조회 실패 null 포함 — 클라이언트가 같은 실패를 재요청하지 않게).
    for (const [id, summary] of summaries) reviewMap.set(id, summary);

    const reviewScores = new Map(ids.map(id => [id, computeReviewScore(summaries.get(id) ?? null)]));
    return blendWishlistTrack(targets, reviewScores, options.maxRecommendationsPerTrack, useDeal)
      .map(r => {
        const badge = buildReviewBadge(summaries.get(r.appid) ?? null);
        return badge ? { ...r, reviewBadge: badge } : r;
      });
  }

  // 3a. phase A — 시드 + 위시리스트 메타.
  // 캐시 히트 통계: getStoreMetaBatch가 캐시분·배치마다 onProgress 호출.
  // 캐시 히트율을 측정하려면 캐시 인스턴스 노출이 필요한데 1차 범위에선 생략.
  // done 이벤트의 cacheHitRate는 0(미측정)으로 둔다.
  const detailsMapA = await getStoreMetaBatch(phaseAIds, makeMetaProgress(0, new Map()), isCancelled);
  if (isCancelled()) return;

  // 3b. 조기 위시 단계 — 라이브러리 나머지(phase B)가 남아 있을 때만 의미가 있다.
  //   시드 기반 근사 성향으로 위시 트랙을 가격·리뷰까지 반영해 확정하고 partial-result로
  //   즉시 보낸다. 최종 단계에서 전체 성향으로 다시 계산하지만, 가격(1h)·리뷰 요약(6h)이
  //   캐시되어 있어 재계산 비용은 거의 없다.
  if (tracks.wish && wishlist.length > 0 && phaseBIds.length > 0) {
    // 위시 가격(phase A 메타분, 100개/호출)·리뷰 조회는 대형 위시리스트에서 수십 초 걸릴 수 있다.
    // 그 전에 phase A(캐시분) 결과로 잠정 결과를 한 번 보내 라이브러리 트랙을 바로 보이게 한다.
    // 위시는 매칭 전용(saleOnly면 가격 확인 전이라 null) — 조기 확정 직후 교체된다.
    // 여기서 계산한 성향·라이브러리 트랙은 조기 확정 partial에서도 재사용한다(같은 detailsMapA).
    const quickBuilt = buildPool(detailsMapA);
    const quickLists = rerankFromPool(quickBuilt.pool, options);
    const quick = { profile: quickBuilt.profile, libraryUnplayed: quickLists.libraryUnplayed };
    {
      // 가격 조회 전이라 saleOnly면 null (rerankFromPool).
      const quickWish = quickLists.wishlist;
      // 목록 모양만 비교한다 (makeMetaProgress의 sig와 같은 규칙). 이 이벤트는 풀을 항상 싣는다.
      const sig = computeResultSignature(quick.profile, quick.libraryUnplayed, quickWish);
      // 목록이 같아도 풀이 마지막으로 보낸 것과 다르면 보낸다 — phase A partial이 목록만 보냈을 수 있다
      // (풀은 30초 간격). 그렇지 않으면 화면(풀로 재정렬)이 최대 30초 묵은 풀에 머문다 (/code-review 5차 재검토 L1).
      if (sig !== lastEmittedSignature || poolSignature(quickBuilt.pool) !== lastPoolSentSig) {
        lastEmittedSignature = sig;
        lastPartialEmitAt = Date.now();
        try {
          controller.enqueue(sseEvent("partial-result", {
            profile: quick.profile,
            libraryUnplayed: quick.libraryUnplayed,
            wishlist: quickWish,
            pool: quickBuilt.pool,
            loaded: phaseAIds.length,
            total,
          }));
        } catch { /* closed */ }
        lastPoolSentSig = poolSignature(quickBuilt.pool);
        lastPoolSentAt = Date.now();
        if (quickWish !== null) {
          tryWriteCache(
            quick.profile, quick.libraryUnplayed, wishForCache(quickWish, detailsMapA),
            poolForCache(quickBuilt.pool, detailsMapA),
          );
        }
      }
    }

    // 시드 성향에 신호가 없으면(시드 메타 누락 등) 조기 확정하지 않는다 — 매칭이 전부 0이라
    // 빈 위시 목록이 phase B 내내 고정된다. 이 경우 phase B partial은 매칭 전용 위시를 3초마다
    // 갱신하고, 가격은 최종 단계에서 조회한다 (작업 지시서 20261010_02 §3-1 가드).
    const seedHasSignal = quick.profile.genres.length > 0 || quick.profile.categories.length > 0;
    if (seedHasSignal) {
      // 가격은 rankWishlist가 필요한 만큼(phase A 메타분 또는 노출 카드) 조회한다.
      // detailsMapA는 phase A가 끝나 더 바뀌지 않으므로 잠정 결과에서 계산한 라이브러리 분석을 재사용한다.
      const ranked = await rankWishlist(detailsMapA, undefined, quickBuilt.analysis);
      if (ranked === null || isCancelled()) return;
      // saleOnly + 가격 실패면 위시 트랙을 확정하지 않는다(null). 그러면 phase B partial도
      // null을 보내 클라이언트는 이전 state를 유지하고, 캐시에도 쓰지 않는다 — 빈 목록이
      // 저장되어 다음 방문에 "할인 게임 없음"으로 보이는 것을 막는다 (최종 쓰기 정책과 동일).
      earlyWishlist = options.saleOnly && priceFetchFailed ? null : ranked;
      lastWishRefreshAt = Date.now();
      // 가격·리뷰가 채워졌으니 풀을 다시 만든다 (메타는 같은 detailsMapA — 성향·매칭 동일).
      const earlyPool = buildPool(detailsMapA, quickBuilt.analysis).pool;
      // 다음 throttle 시점을 기다리지 않고 즉시 보낸다.
      lastEmittedSignature = computeResultSignature(quick.profile, quick.libraryUnplayed, earlyWishlist);
      lastPartialEmitAt = Date.now();
      try {
        controller.enqueue(sseEvent("partial-result", {
          profile: quick.profile,
          libraryUnplayed: quick.libraryUnplayed,
          wishlist: earlyWishlist,
          pool: earlyPool,
          loaded: phaseAIds.length,
          total,
        }));
        lastPoolSentSig = poolSignature(earlyPool);
        lastPoolSentAt = Date.now();
        // 진행 표시가 "리뷰 n/n"에 머물지 않도록 메타 단계로 즉시 되돌린다.
        controller.enqueue(sseEvent("progress", { phase: "fetching-meta", loaded: phaseAIds.length, total }));
      } catch { /* closed */ }
      if (earlyWishlist !== null) {
        tryWriteCache(
          quick.profile, quick.libraryUnplayed, wishForCache(earlyWishlist, detailsMapA),
          poolForCache(earlyPool, detailsMapA),
        );
      }
    }
  }

  // 3c. phase B — 미캐시 메타 (후보 → 나머지 라이브러리·위시 번갈아).
  phaseBActive = true;
  const detailsMapB = await getStoreMetaBatch(
    phaseBIds,
    makeMetaProgress(phaseAIds.length, detailsMapA),
    isCancelled,
  );
  phaseBActive = false;
  // 진행 중인 위시 재블렌딩이 있으면 끝나길 기다린다 — 그 리뷰 조회가 최종 단계의 리뷰 조회와
  // 겹치지 않게(결과는 phaseBActive=false라 버려진다). 미캐시 리뷰는 GetItems 배치 1회(≤ EARLY_WISH_REVIEW_CAP개).
  if (wishRefreshInFlight) await wishRefreshInFlight;
  if (isCancelled()) return;
  const detailsMap = new Map([...detailsMapA, ...detailsMapB]);

  // 최종 단계 가격. 다음 경우 다시 조회한다 (/code-review 2차 R1):
  //   - 조기 단계를 건너뜀(라이브러리 나머지 없음, 시드 신호 없음 등) — 아직 가격이 없다.
  //   - 조기 단계 가격이 PRICE_STALE_MS(1h)를 넘음 — 대형 라이브러리는 phase B가 1시간 넘게 걸려,
  //     그대로 쓰면 최종 순위·saleOnly가 그 사이 끝난 할인으로 계산되고 카드가 전부 회색이 된다.
  //   - 조기 단계 가격 조회가 커버리지 미달(priceFetchFailed) — Steam이 회복됐을 수 있다.
  //     단, 마지막 시도 후 PRICE_RETRY_MIN_MS가 지났을 때만. 장애가 계속되는 중에 곧바로 같은 실패
  //     조회를 반복하면 최종 result만 늦어지고 결과는 같은 fallback이다 (/code-review 2차 R1 재검토).
  //     (가격이 GetItems로 바뀌어 조건에서 store 429 backoff를 뺐다. 묶음 전용 게임의 appdetails 보충은
  //     backoff 중이면 getStoreItemPricesBatch가 스스로 건너뛴다.)
  // 가격 캐시(1h)에 남은 것은 호출 없이 재사용되므로 재조회 비용은 만료·실패분만큼이다.
  // 조기 단계 이후 메타가 도착한 위시(phase B)는 아직 시도 전이라 refresh 없이도 여기서 조회된다.
  const sincePriceFetch = Date.now() - wishlistPricesFetchedAt;
  const retryFailedPrices =
    priceFetchFailed && sincePriceFetch >= PRICE_RETRY_MIN_MS;
  const refreshPrices = wishlistPricesFetchedAt > 0 && (retryFailedPrices || sincePriceFetch > PRICE_STALE_MS);
  await fetchWishlistPrices(wishIdsWithMeta(detailsMap), { refresh: refreshPrices, progress: true });
  if (isCancelled()) return;

  // 4. 최종 분석 — 전체 메타로 재정렬 풀을 만든다 (라이브러리·위시 후보 + 가격 + 확보한 리뷰).
  controller.enqueue(sseEvent("progress", { phase: "analyzing", loaded: total, total }));
  const { pool: finalPool, profile } = buildPool(detailsMap);
  if (isCancelled()) return;

  // 4b. 리뷰 호평률 블렌딩 (작업 지시서 단계 2).
  //   - 요청 옵션으로 한 번 계산해 블렌딩 대상 중 리뷰 미확보 appid(missingReviewIds)를 얻고, 그것만
  //     조회한다. 대상 = 라이브러리 shortlist + 위시 블렌딩 대상(가성비 할인 보강 포함), 두 트랙 합쳐
  //     dedupe(소유한 위시 게임은 라이브러리 후보와 겹칠 수 있음).
  //   - 위시 트랙은 조기 단계에서 블렌딩했더라도 전체 성향으로 다시 계산한다 — 리뷰 요약은 6시간
  //     캐시라 거의 무비용(buildPool이 캐시분을 이미 풀에 넣어 둠).
  //   - 조회 실패 후보는 null로 넣어 중립 0.5로 흡수(탈락 없음).
  //   - 최종 목록은 클라이언트 재정렬과 같은 rerankFromPool로 만든다.
  const reviewAppIds = rerankFromPool(finalPool, options).missingReviewIds;
  if (reviewAppIds.length > 0) {
    controller.enqueue(sseEvent("progress", { phase: "fetching-reviews", loaded: 0, total: reviewAppIds.length }));
    // 진행률은 배치 단위로 띄엄띄엄 오므로 모두 보낸다 (위 rankWishlist와 같은 이유).
    const summaryMap = await getReviewSummariesBatch(
      reviewAppIds,
      (loaded, t) => {
        try {
          controller.enqueue(sseEvent("progress", { phase: "fetching-reviews", loaded, total: t }));
        } catch { /* closed */ }
      },
      isCancelled,
    );
    if (isCancelled()) return;
    for (const [id, summary] of summaryMap) {
      reviewMap.set(id, summary);
      finalPool.reviews[id] = summary;
    }
  }
  const finalLists = rerankFromPool(finalPool, options);
  const libraryUnplayed = finalLists.libraryUnplayed;
  // null은 saleOnly + 가격 조회 전인데, 최종 단계에서는 가격 조회를 마쳤으므로 생기지 않는다(방어).
  const wishlistRecs = finalLists.wishlist ?? [];

  // 5. result — 라이브러리·위시 트랙 확정. 발굴(tracks.deal)은 이 뒤에 별도로 진행한다.
  //    pool: 클라이언트가 가성비·할인만·개수를 바꿀 때 서버 재요청 없이 재정렬하는 데 쓴다.
  controller.enqueue(sseEvent("result", {
    profile,
    libraryUnplayed,
    wishlist: wishlistRecs,
    pool: finalPool,
    priceFetchFailed: tracks.wish && priceFetchFailed,
  }));

  // 6. 캐시 저장 — partial과 동일한 tryWriteCache 헬퍼 사용. 가드 정책은 헬퍼
  //    정의에 모아 둠. analysisInsufficient/metaMissingDominant는 헬퍼의 "의미
  //    있는 signal" 가드(genres + categories 모두 빔 차단)로 자연히 막힌다.
  //    force=true: 마지막 partial과 sig가 우연히 일치해도 final write는 반드시
  //    수행하여 computed_at이 분석 완료 시각으로 갱신되도록.
  //    위시 가격 조회 실패도 저장한다 — 캐시 키가 재정렬 옵션(할인만 등)과 무관해져, 실패 여부를
  //    payload의 priceFetchFailed로 함께 저장하고 클라이언트가 그것을 보고 "할인 게임 없음" 대신
  //    가격 실패 안내를 띄운다. (이전에는 saleOnly + 가격 실패를 저장하지 않았다 — 실패 정보 없이
  //    빈 목록이 캐시되는 것을 막기 위해서였다.)
  //    발굴 전에 먼저 저장한다 — 발굴(최대 120초) 도중 탭을 닫아도 두 트랙 결과는 남도록.
  //    이 시점의 payload엔 이전 분석의 발굴 결과(carriedStoreDeals, 없으면 생략)가 들어가고,
  //    이번 발굴이 저장 가능한 결과를 내면 아래에서 한 번 더 덮어쓴다.
  tryWriteCache(profile, libraryUnplayed, wishlistRecs, finalPool, true);

  // 7. 미보유 할인 게임 발굴 (tracks.deal, 작업 지시서 20261010_01 단계 2).
  //    실패 격리: 발굴 단계의 어떤 예외도 여기서 흡수하고 두 트랙 결과(이미 전송)에 영향을
  //    주지 않는다. storeDealsFailed로만 알린다.
  let storeDealsFailed = false;
  let storeDealsTruncated = false;
  if (tracks.deal) {
    let outcome: DiscoverOutcome | null;
    try {
      outcome = await discoverStoreDeals(profile);
    } catch (err) {
      console.warn("[recommend] store deal discovery failed:", err);
      outcome = { storeDeals: [], failed: true, truncated: false, pool: [], reviews: {} };
    }
    if (outcome === null || isCancelled()) return; // 탭 닫힘 — 즉시 중단
    storeDealsFailed = outcome.failed;
    storeDealsTruncated = outcome.truncated;
    // 상태 플래그도 함께 보낸다 — done을 기다리면 그 사이 "할인 게임 없음"이 잠깐 보인다.
    // failed면 클라이언트는 previous(현재 라이브러리·위시리스트로 다시 거른 이전 발굴 결과,
    // 없으면 undefined)를 "이전 결과"로 표시한다. cached로 받은 목록을 그대로 두면 그 사이
    // 구매한 게임이 남는다.
    try {
      controller.enqueue(sseEvent("store-deals", {
        storeDeals: outcome.storeDeals,
        failed: outcome.failed,
        truncated: outcome.truncated,
        // 재정렬용 발굴 shortlist + 그 리뷰(GetItems 요약). 클라이언트가 개수 변경 시 다시 계산한다.
        pool: outcome.pool,
        reviews: outcome.reviews,
        ...(outcome.failed && carriedStoreDeals !== undefined ? { previous: carriedStoreDeals } : {}),
        ...(outcome.failed && carriedPool?.storeDeals !== undefined
          ? { previousPool: carriedPool.storeDeals, previousReviews: pickReviews(carriedPool, carriedPool.storeDeals) }
          : {}),
      }));
    } catch { /* closed */ }
    logEvent("recommend_store_deals", {
      steamId,
      count: outcome.storeDeals.length,
      failed: outcome.failed,
      truncated: outcome.truncated,
      elapsedMs: outcome.elapsedMs,
    });
    // 실패한 발굴은 저장하지 않는다 — 빈 목록이 캐시되면 다음 방문의 cached 결과가
    // "취향에 맞는 할인 게임 없음"으로 보인다(정직성 제약). 캐시에는 failed/truncated 플래그가
    // 없으므로, 일부만 확인한 결과도 비어 있으면 같은 이유로 저장하지 않는다. 일부만 확인했어도
    // 찾은 게임이 있으면 그 자체로 유효한 추천이라 저장한다.
    const storable = !outcome.failed && (!outcome.truncated || outcome.storeDeals.length > 0);
    if (storable) {
      tryWriteCache(profile, libraryUnplayed, wishlistRecs, finalPool, true, {
        list: outcome.storeDeals, pool: outcome.pool, reviews: outcome.reviews,
      });
    } else if (carriedStoreDeals !== undefined || carriedPool?.storeDeals !== undefined) {
      // result 직후 쓰기에는 이전 분석의 발굴 결과가 이어 써져 있다. 이번 발굴이 저장할 수 없는
      // 결과면 그 묵은 목록이 다음 방문에 (실패 사실 없이) 현재 결과처럼 보이므로 빼고 다시 쓴다.
      // 다음 방문은 storeDeals 없는 캐시 → "찾는 중"으로 시작한다. 이번 화면에는 store-deals의
      // previous로 이전 결과가 "이전 결과" 안내와 함께 계속 보인다.
      tryWriteCache(profile, libraryUnplayed, wishlistRecs, finalPool, true, null);
    }
  }

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
    // 위시리스트 트랙이 켜져 있을 때만 위시리스트 장애를 보고한다. wish=off 요청은
    // 위시리스트 결과를 보여주지 않으므로 장애가 무의미 — false로 내려 클라이언트가
    // '위시리스트 조회 실패' 배너를 잘못 띄우지 않도록. tryWriteCache의 캐시 저장
    // 정책(tracks.wish && wishlistFetchFailed)과 동일하게 맞춰 live/cached 경로 일관.
    wishlistFetchFailed: tracks.wish && wishlistFetchFailed,
    analysisInsufficient,
    metaMissingDominant,
    libraryFetchFailed: false,
    // 위시 가격 커버리지 부족. 클라이언트는 "할인 게임 없음" 대신 가격 실패 안내를 띄운다.
    priceFetchFailed: tracks.wish && priceFetchFailed,
    // 발굴 트랙: 후보 수집 실패/예외 → failed, 시간 예산 초과로 일부만 확인 → truncated.
    storeDealsFailed: tracks.deal && storeDealsFailed,
    storeDealsTruncated: tracks.deal && storeDealsTruncated,
  }));

  /**
   * 미보유 할인 게임 발굴 (작업 지시서 20261010_01 §2-4, 부록 B 설계 확정 4).
   *
   *   discovering        getStoreSpecials(150)          — 검색 specials 리뷰순, 2회 호출
   *                      filterDiscoverPool             — 소유·위시리스트 제외
   *   fetching-prices    getStoreItemsBatch(pool)       — 가격·리뷰 요약·카테고리 (GetItems, 2회)
   *                      selectDealCandidatesForMeta    — 할인 중 + 리뷰 ≥ 10 + dealScore 상위 40
   *   fetching-deal-meta getStoreMetaBatch(selected)    — 장르(태그)·카테고리 메타 (GetItems 배치)
   *                      recommendStoreDeals            — 매칭 shortlist
   *                      blendRecommendations(+deal)    — 리뷰는 GetItems 요약으로 (추가 호출 없음)
   *
   * 시간 예산: 시작 시각 기준 DISCOVER_TIME_BUDGET_MS. stop()을 모든 조회에 넘겨 초과 시 그때까지
   * 확보한 데이터로 진행한다(진행 중인 단건 호출 1개는 끝까지 기다림).
   * 블렌딩은 valueWeighting과 무관하게 항상 가성비 산식 — 이 트랙의 목적이 할인이다.
   *
   * 정직성 판정 (외부 조회 실패를 "할인 게임 없음"으로 보이지 않게):
   *   failed    — 단계 전체가 실패해 판단 근거가 없음: 후보 수집 실패, GetItems 전량 실패,
   *               장르 메타 전량 실패, 위시리스트 조회 실패(위시 게임을 제외할 수 없음).
   *   truncated — 일부 후보만 확인: 예산 초과로 건너뜀, 후보 소스 degraded(featured fallback 등),
   *               GetItems·메타 성공률 FETCH_COVERAGE_MIN 미만. 실제로 건너뛴 것이 있을 때만
   *               켜진다(마지막 항목 직후 예산을 넘긴 경우는 해당 없음).
   *
   * @returns 탭이 닫혔으면 null(호출 측이 즉시 종료). 그 외에는 결과(빈 배열 가능).
   */
  async function discoverStoreDeals(currentProfile: TasteProfile): Promise<DiscoverOutcome | null> {
    const startedAt = Date.now();
    const stop = (): boolean =>
      isCancelled() || Date.now() - startedAt > DISCOVER_TIME_BUDGET_MS;
    const emit = (phase: string, loaded: number, t: number) => {
      try {
        controller.enqueue(sseEvent("progress", { phase, loaded, total: t }));
      } catch { /* closed */ }
    };
    let partial = false;
    const done = (
      storeDeals: Recommendation[],
      failed = false,
      pool: Recommendation[] = [],
      reviews: RerankPool["reviews"] = {},
    ): DiscoverOutcome => ({
      storeDeals, failed, truncated: !failed && partial, elapsedMs: Date.now() - startedAt, pool, reviews,
    });

    // 위시리스트를 못 불러왔으면 위시 게임을 제외할 수 없어 "미보유·위시 밖" 계약을 지킬 수 없다.
    if (wishlistFetchFailed) return done([], true);
    // 성향 신호가 없으면 매칭이 전부 0 — 외부 호출 없이 빈 결과.
    if (currentProfile.genres.length === 0 && currentProfile.categories.length === 0) return done([]);

    // (1) 후보 수집
    emit("discovering", 0, 1);
    const specials = await getStoreSpecials(DISCOVER_POOL_SIZE, stop);
    if (isCancelled()) return null;
    if (specials === null) return done([], true);
    if (specials.degraded) partial = true;
    emit("discovering", 1, 1);

    // (2) 소유·위시리스트 제외. 소유는 분석 스코프(빠른 모드 상한)가 아니라 전체 라이브러리.
    const ownedIds = new Set(owned.map(g => g.appid));
    const wishIds = new Set(wishlist.map(w => w.appid));
    const filtered = filterDiscoverPool(specials.ids, ownedIds, wishIds);
    if (filtered.length === 0) return done([]);

    // (3) 가격·리뷰 요약·카테고리 (GetItems). 조회 실패·예산 중단분은 Map에서 빠진다.
    emit("fetching-prices", 0, filtered.length);
    // getStoreItemsBatch는 캐시분 처리 후와 배치마다 onProgress(loaded, total)를 부르고, 끝까지
    // 진행했으면 마지막 호출이 loaded === total이다. 이것으로 "남은 배치를 실제로 건너뛰었는지"를 판정한다.
    let itemsComplete = false;
    const items = await getStoreItemsBatch(
      filtered,
      (loaded, t) => {
        itemsComplete = loaded >= t;
        emit("fetching-prices", loaded, t);
      },
      stop,
    );
    if (isCancelled()) return null;
    // 예산 초과로 남은 배치를 건너뛰었으면 "일부만 확인"이지 실패가 아니다(첫 배치 전 중단 포함).
    // 반환 직후 stop()으로 판정하면 마지막 배치가 예산 경계를 넘겨 끝난 경우도 "건너뜀"으로 잡혀,
    // 전부 확인했는데 "일부만 확인" 안내가 뜨고, 전 배치 실패가 failed 대신 truncated로 보고됐다
    // (/code-review 3차 #4).
    const itemsStopped = !itemsComplete;
    if (itemsStopped) partial = true;
    if (items.size === 0) return done([], !itemsStopped);
    if (items.size < filtered.length * FETCH_COVERAGE_MIN) partial = true;

    // (4) 메타 조회 대상 선정 — 할인 중 + 리뷰 하한(M9) + dealScore 상위 cap
    const selected = selectDealCandidatesForMeta(filtered, items, DISCOVER_META_CAP, REVIEW_BADGE_MIN_SAMPLE);
    if (selected.length === 0) return done([]);

    // (5) 장르 메타 — 기존 uniqueIds 배치와 분리된 2차 배치 (성향 확정 후 후보만)
    emit("fetching-deal-meta", 0, selected.length);
    const metas = await getStoreMetaBatch(
      selected,
      // getStoreMetaBatch 진행률은 캐시분 처리 후·배치(100개)마다 한 번이라 37/40처럼 건너뛰며 온다.
      // 5의 배수만 보내면 그런 값이 버려져 0/40에 머문다 (/code-review 5차 #7) — 모두 보낸다.
      (loaded, t) => emit("fetching-deal-meta", loaded, t),
      stop,
    );
    if (isCancelled()) return null;
    // metas에는 시도한 appid만 들어간다(실패는 null). 예산으로 시도조차 못 한 후보가 있으면 partial.
    if (metas.size < selected.length) partial = true;
    const metaOk = Array.from(metas.values()).filter(d => d !== null).length;
    if (metas.size > 0 && metaOk === 0) return done([], true); // 전량 실패 (Rate Limit 등)
    if (metas.size > 0 && metaOk < metas.size * FETCH_COVERAGE_MIN) partial = true;

    // (6) 매칭 → shortlist. 메타를 못 받은 후보(예산 초과로 미조회 포함)는 제외.
    const candidates: StoreDealCandidate[] = [];
    for (const id of selected) {
      const item = items.get(id);
      if (!item) continue;
      const c = buildStoreDealCandidate(metas.get(id) ?? null, item);
      if (c) candidates.push(c);
    }
    // 재정렬 풀용으로 상한(CAP)까지 뽑는다 — 클라이언트가 개수를 늘려도 서버 재요청 없이 계산하도록.
    // 리뷰는 GetItems 요약으로 이미 확보돼 있어 추가 호출이 없다.
    const poolShortlist = recommendStoreDeals(candidates, currentProfile, options, REVIEW_SHORTLIST_CAP);
    if (poolShortlist.length === 0) return done([]);

    // (7) 블렌딩 — 리뷰는 GetItems 요약, deal은 항상 반영. 클라이언트와 같은 rerankFromPool 규칙.
    const reviews: RerankPool["reviews"] = {};
    for (const r of poolShortlist) reviews[r.appid] = items.get(r.appid)?.review ?? null;
    const ranked = rerankFromPool(
      { library: [], wishlist: [], storeDeals: poolShortlist, reviews, wishPricesReady: true, wishPriceOk: true },
      options,
    ).storeDeals ?? [];
    return done(ranked, false, poolShortlist, reviews);
  }
}

/** 발굴 단계 결과. */
interface DiscoverOutcome {
  storeDeals: Recommendation[];
  /** 판단 근거가 없을 만큼 실패 (후보 수집·GetItems·메타 전량 실패, 위시리스트 조회 실패, 예외). */
  failed: boolean;
  /** 일부 후보만 확인했다 (예산 초과·소스 degraded·부분 조회 실패). */
  truncated: boolean;
  /** 소요 시간 (ms). 로그·측정용 (완료 기준의 소요 측정). */
  elapsedMs?: number;
  /** 재정렬 풀용 발굴 shortlist (매칭순, 상한 CAP). 실패·빈 결과면 []. */
  pool: Recommendation[];
  /** pool 후보의 리뷰 요약 (GetItems). */
  reviews: RerankPool["reviews"];
}
