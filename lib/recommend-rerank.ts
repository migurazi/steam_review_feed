/**
 * /recommend 결과 재정렬 (서버·클라이언트 공용 순수 모듈).
 *
 * 배경: 가성비(valueWeighting)·할인만(saleOnly)·추천 개수(maxRecommendationsPerTrack)는 성향
 * 프로필이나 후보 매칭 점수를 바꾸지 않고, 이미 매칭된 후보를 어떻게 거르고·블렌딩하고·자르는지만
 * 바꾼다. 이 옵션이 바뀔 때마다 서버 분석(SSE)을 처음부터 다시 돌리면 메타·가격이 캐시돼 있어도
 * 프로필 계산·리뷰 조회·결과 캐시 miss가 반복된다.
 *
 * 그래서 서버는 옵션 조합에 무관한 "재정렬 풀(RerankPool)"을 함께 보내고, 클라이언트는 이 모듈의
 * rerankFromPool로 현재 옵션의 최종 목록을 즉시 계산한다. 서버도 최종 목록을 같은 함수로 만들어
 * 두 쪽 결과가 같은 규칙을 따른다.
 *
 * 풀이 보장하는 것 (모든 옵션 조합에서 서버 계산과 같은 후보 집합):
 *   - library: 매칭 점수순 상위 REVIEW_SHORTLIST_CAP. shortlist = 앞에서 min(max·2, CAP)개.
 *   - wishlist: saleOnly=false 기준 전체 매칭 목록에서 아래 세 집합의 합집합 (매칭 점수순 유지):
 *       (a) 매칭 상위 CAP                      — saleOnly=false shortlist
 *       (b) 할인 중 후보의 매칭 상위 CAP         — saleOnly=true shortlist
 *       (c) 할인 중 후보의 dealScore 상위 2·CAP  — 가성비 할인 보강(augmentWithDeals, k=max ≤ CAP).
 *           보강은 shortlist(≤ CAP)에 이미 든 후보를 빼고 k개를 고르므로, 최악의 경우 dealScore 순위
 *           CAP + k ≤ 2·CAP까지 내려간다. CAP만 담으면 개수가 클 때 목록이 서버와 달라진다(테스트로 확인).
 *   - storeDeals: 발굴 트랙 매칭 shortlist 상위 CAP (리뷰는 GetItems 요약으로 항상 채워짐).
 *   - reviews: appid → 리뷰 요약. 키가 없으면 "아직 조회 안 함", null이면 "조회 실패"(중립 0.5).
 *
 * excludeFree·임계값·빠른 모드는 프로필 자체를 바꾸므로 여기서 다루지 않는다(서버 재분석 대상).
 */

import {
  blendRecommendations,
  planWishlistBlend,
  blendWishlistTrack,
  computeReviewScore,
  computeDealScore,
  buildReviewBadge,
  isOnSale,
  type AnalyzeOptions,
  type Recommendation,
} from "./steam/profile";
import type { ReviewSummary } from "./steam/types";

/**
 * 리뷰 블렌딩 shortlist 크기 = min(maxRecommendationsPerTrack · MULTIPLIER, CAP).
 *
 * 리뷰 요약 조회는 per-후보 API 호출(500ms 직렬)이므로 전체 후보가 아니라 매칭 점수
 * 상위 shortlist에만 건다. MULTIPLIER=2로 최종 노출(maxPerTrack)보다 넉넉히 뽑아
 * 리뷰 블렌딩이 순위를 뒤집을 여지를 주되, CAP=30으로 트랙당 상한을 고정한다.
 */
export const REVIEW_SHORTLIST_MULTIPLIER = 2;
export const REVIEW_SHORTLIST_CAP = 30;

/** 재정렬만으로 반영되는(서버 재분석이 필요 없는) 옵션 키. 결과 캐시 키에서도 제외된다. */
export const RERANK_OPTION_KEYS = ["valueWeighting", "saleOnly", "maxRecommendationsPerTrack"] as const;
export type RerankOptions = Pick<AnalyzeOptions, (typeof RERANK_OPTION_KEYS)[number]>;

export interface RerankPool {
  /** 라이브러리 미플레이 후보, 매칭 점수순 상위 CAP. */
  library: Recommendation[];
  /** 위시 후보 합집합(모듈 주석 참조), 매칭 점수순. 가격이 붙어 있다(조회 후). */
  wishlist: Recommendation[];
  /** 발굴 트랙 매칭 shortlist 상위 CAP. 발굴을 안 했으면 undefined. */
  storeDeals?: Recommendation[];
  /** appid → 리뷰 요약. 키 없음 = 미조회, null = 조회 실패. */
  reviews: Record<number, ReviewSummary | null>;
  /** 위시 가격 조회를 마쳤는지. false면 saleOnly 목록을 확정할 수 없다("가격 확인 중"). */
  wishPricesReady: boolean;
  /** 가격 커버리지 충분(조회 완료 && !priceFetchFailed). false면 가성비를 끄고 saleOnly는 비운다. */
  wishPriceOk: boolean;
}

export interface RerankResult {
  libraryUnplayed: Recommendation[];
  /** null = saleOnly인데 가격 조회 전 (미확정). */
  wishlist: Recommendation[] | null;
  storeDeals?: Recommendation[];
  /** 블렌딩 대상인데 리뷰 요약을 아직 조회하지 않은 appid (라이브러리·위시). 중립 0.5로 계산됨. */
  missingReviewIds: number[];
}

/** 현재 옵션의 리뷰 블렌딩 shortlist 크기. */
export function shortlistSizeFor(max: number): number {
  return Math.min(max * REVIEW_SHORTLIST_MULTIPLIER, REVIEW_SHORTLIST_CAP);
}

/**
 * 위시 재정렬 풀을 만든다 (서버 전용 입력, 순수 함수).
 *
 * @param wishAll saleOnly=false로 계산한 전체 매칭 목록(매칭 점수순). 가격이 붙어 있어야
 *   (b)(c)가 의미 있다 — 가격 조회 전이면 (a)만 남는다.
 * @param cap 각 집합 상한 (기본 REVIEW_SHORTLIST_CAP).
 * @returns 합집합. wishAll의 순서(매칭 점수순)를 유지한다 — 클라이언트가 slice로 shortlist를 얻는다.
 */
export function buildWishlistPool(wishAll: Recommendation[], cap: number = REVIEW_SHORTLIST_CAP): Recommendation[] {
  const keep = new Set<number>();
  for (const r of wishAll.slice(0, cap)) keep.add(r.appid);
  const onSale = wishAll.filter(r => isOnSale(r.price));
  for (const r of onSale.slice(0, cap)) keep.add(r.appid);
  // augmentWithDeals와 같은 정렬(dealScore desc → appid asc)로 상위 2·cap (모듈 주석 (c) 참조).
  const byDeal = onSale
    .map(r => ({ r, deal: computeDealScore(r.price) }))
    .sort((a, b) => (b.deal - a.deal) || (a.r.appid - b.r.appid))
    .slice(0, cap * 2);
  for (const { r } of byDeal) keep.add(r.appid);
  return wishAll.filter(r => keep.has(r.appid));
}

/**
 * 풀과 옵션으로 최종 추천 목록을 계산한다 (순수 함수 — 서버 최종 단계·클라이언트 재정렬 공용).
 *
 * 규칙은 서버의 기존 블렌딩과 같다:
 *   - 라이브러리: shortlist(앞 min(max·2, CAP)) → 리뷰 블렌딩 → max개.
 *   - 위시: saleOnly면 할인 중만 → shortlist → planWishlistBlend(가성비 할인 보강) → 블렌딩.
 *     saleOnly인데 가격 커버리지 부족이면 빈 목록(일부 가격만으로 거른 목록을 "할인 게임은 이것뿐"
 *     으로 오해시키지 않기 위함 — 화면은 priceFetchFailed 안내를 띄운다).
 *   - 발굴: shortlist → 리뷰+deal 블렌딩(항상 가성비 산식).
 *   - 최종 카드에만 호평률 배지를 붙인다.
 */
export function rerankFromPool(pool: RerankPool, opts: RerankOptions): RerankResult {
  const max = opts.maxRecommendationsPerTrack;
  const size = shortlistSizeFor(max);
  const missing = new Set<number>();
  const reviewOf = (id: number): ReviewSummary | null | undefined =>
    Object.prototype.hasOwnProperty.call(pool.reviews, id) ? pool.reviews[id] : undefined;
  /** 블렌딩 입력 리뷰 점수. 미조회는 맵에서 빼서 blendRecommendations의 중립 0.5를 탄다. */
  const scoresFor = (recs: Recommendation[], trackMissing: boolean): Map<number, number> => {
    const m = new Map<number, number>();
    for (const r of recs) {
      const s = reviewOf(r.appid);
      if (s === undefined) {
        if (trackMissing) missing.add(r.appid);
        continue;
      }
      m.set(r.appid, computeReviewScore(s));
    }
    return m;
  };
  const withBadges = (recs: Recommendation[]): Recommendation[] =>
    recs.map(r => {
      const badge = buildReviewBadge(reviewOf(r.appid) ?? null);
      return badge ? { ...r, reviewBadge: badge } : r;
    });

  const libShortlist = pool.library.slice(0, size);
  const libraryUnplayed = withBadges(blendRecommendations(libShortlist, scoresFor(libShortlist, true), max));

  let wishlist: Recommendation[] | null;
  if (opts.saleOnly && !pool.wishPricesReady) {
    wishlist = null;
  } else if (opts.saleOnly && !pool.wishPriceOk) {
    wishlist = [];
  } else {
    const candidates = opts.saleOnly ? pool.wishlist.filter(r => isOnSale(r.price)) : pool.wishlist;
    const { targets, useDeal } = planWishlistBlend(
      candidates.slice(0, size),
      candidates,
      // planWishlistBlend는 valueWeighting·maxRecommendationsPerTrack만 읽는다.
      opts as AnalyzeOptions,
      pool.wishPriceOk,
    );
    wishlist = withBadges(blendWishlistTrack(targets, scoresFor(targets, true), max, useDeal));
  }

  let storeDeals: Recommendation[] | undefined;
  if (pool.storeDeals) {
    const shortlist = pool.storeDeals.slice(0, size);
    const deals = new Map(shortlist.map(r => [r.appid, computeDealScore(r.price)]));
    // 발굴 후보의 리뷰는 GetItems 요약으로 서버가 항상 채운다 — 미조회 추적 대상 아님.
    storeDeals = withBadges(blendRecommendations(shortlist, scoresFor(shortlist, false), max, deals));
  }

  return { libraryUnplayed, wishlist, storeDeals, missingReviewIds: Array.from(missing) };
}

/**
 * 새 풀이 가격 조회 전인데 이전 풀은 가격이 있으면 true — 이전 위시 풀을 유지해야 한다.
 * 저장·표시되는 풀이 가격 없는 풀로 바뀌면 할인만 화면이 "가격 확인 중"으로 되돌아간다
 * (/code-review M1). 서버 partial 캐시 쓰기(poolForCache)와 클라이언트 partial 병합(mergePartialPool)이
 * 같은 규칙을 쓴다.
 */
export function shouldKeepPreviousWishlist(next: RerankPool, prev: RerankPool): boolean {
  return !next.wishPricesReady && prev.wishPricesReady;
}

/**
 * next 풀의 위시 부분(목록·가격 상태)을 prev 것으로 바꾼다. 위시 게임의 리뷰는 next에 없을 때만
 * prev에서 가져온다. 라이브러리·발굴은 next 그대로.
 */
export function withPreviousWishlist(next: RerankPool, prev: RerankPool): RerankPool {
  const reviews = { ...next.reviews };
  for (const r of prev.wishlist) {
    if (!(r.appid in reviews) && r.appid in prev.reviews) reviews[r.appid] = prev.reviews[r.appid];
  }
  return {
    ...next,
    wishlist: prev.wishlist,
    reviews,
    wishPricesReady: prev.wishPricesReady,
    wishPriceOk: prev.wishPriceOk,
  };
}

/** 풀에 들어 있는 모든 appid (리뷰 seed용). */
export function poolAppIds(pool: Pick<RerankPool, "library" | "wishlist" | "storeDeals">): number[] {
  return Array.from(new Set([
    ...pool.library.map(r => r.appid),
    ...pool.wishlist.map(r => r.appid),
    ...(pool.storeDeals ?? []).map(r => r.appid),
  ]));
}
