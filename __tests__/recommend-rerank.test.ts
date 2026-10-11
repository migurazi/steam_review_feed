/**
 * lib/recommend-rerank.ts 단위 테스트.
 *
 * 핵심 불변식: 축소한 풀(buildWishlistPool, 상위 CAP)로 재정렬한 결과가 "전체 매칭 목록"으로 재정렬한
 * 결과와 모든 옵션 조합(가성비 on/off × 할인만 on/off × 개수 1..30 × 가격 정상/실패)에서 같다.
 * 이것이 깨지면 클라이언트 재정렬이 서버 재분석과 다른 목록을 보여준다.
 */

import { describe, it, expect } from "vitest";
import {
  buildWishlistPool,
  rerankFromPool,
  shortlistSizeFor,
  poolAppIds,
  shouldKeepPreviousWishlist,
  withPreviousWishlist,
  REVIEW_SHORTLIST_CAP,
  type RerankPool,
} from "@/lib/recommend-rerank";
import type { Recommendation } from "@/lib/steam/profile";
import type { ReviewSummary, SteamPriceOverview } from "@/lib/steam/types";

/** 결정론적 의사 난수 (mulberry32). 테스트 재현성을 위해 시드 고정. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function price(discount: number, initial = 30000): SteamPriceOverview {
  const final = Math.round(initial * (100 - discount) / 100);
  return {
    currency: "KRW",
    initial: initial * 100,
    final: final * 100,
    discount_percent: discount,
    initial_formatted: `₩ ${initial}`,
    final_formatted: `₩ ${final}`,
  };
}

/** 매칭 점수순(desc, appid asc)으로 정렬된 위시 후보 n개. 일부는 할인 중, 일부는 가격 미상. */
function makeWishlist(n: number, seed: number): Recommendation[] {
  const r = rng(seed);
  const recs: Recommendation[] = Array.from({ length: n }, (_, i) => {
    const roll = r();
    const p = roll < 0.4 ? price(Math.ceil(r() * 90)) : roll < 0.8 ? price(0) : roll < 0.9 ? null : undefined;
    return {
      appid: 1000 + i,
      name: `G${i}`,
      isFree: false,
      matchedGenres: [],
      matchedCategories: [],
      matchScore: Math.round(r() * 1000) / 1000,
      score: 0,
      source: "wishlist",
      wishlistPriority: Math.floor(r() * 50),
      wishlistDateAdded: Math.floor(r() * 1e6),
      ...(p !== undefined ? { price: p, priceFetchedAt: 1 } : {}),
    } satisfies Recommendation;
  });
  recs.forEach(x => { x.score = x.matchScore; });
  return recs.sort((a, b) => (b.matchScore - a.matchScore) || (a.appid - b.appid));
}

function makeLibrary(n: number, seed: number): Recommendation[] {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) => ({
    appid: 1 + i,
    name: `L${i}`,
    isFree: false,
    matchedGenres: [],
    matchedCategories: [],
    matchScore: Math.round(r() * 1000) / 1000,
    score: 0,
    source: "library-unplayed" as const,
    playtimeMinutes: Math.floor(r() * 60),
  })).map(x => ({ ...x, score: x.matchScore }))
    .sort((a, b) => (b.matchScore - a.matchScore) || ((b.playtimeMinutes ?? 0) - (a.playtimeMinutes ?? 0)) || (a.appid - b.appid));
}

function summary(pos: number, total: number): ReviewSummary {
  return { reviewScore: 0, reviewScoreDesc: "", totalPositive: pos, totalNegative: total - pos, totalReviews: total };
}

/** 모든 appid에 리뷰를 넣는다 (일부는 조회 실패 null). */
function allReviews(recs: Recommendation[], seed: number): Record<number, ReviewSummary | null> {
  const r = rng(seed);
  const out: Record<number, ReviewSummary | null> = {};
  for (const x of recs) {
    const total = Math.floor(r() * 500);
    out[x.appid] = r() < 0.1 ? null : summary(Math.floor(total * r()), total);
  }
  return out;
}

const ids = (recs: Recommendation[] | null | undefined) => (recs ?? []).map(r => r.appid);

describe("buildWishlistPool", () => {
  it("매칭 상위 · 할인 중 매칭 상위 · 할인 dealScore 상위의 합집합이며, 원래 순서를 유지한다", () => {
    const all = makeWishlist(300, 7);
    const pool = buildWishlistPool(all, 10);
    const poolIds = ids(pool);
    // 순서 유지 (all의 부분 수열)
    expect(poolIds).toEqual(ids(all).filter(id => poolIds.includes(id)));
    // (a) 매칭 상위 10 포함
    for (const id of ids(all.slice(0, 10))) expect(poolIds).toContain(id);
    // (b) 할인 중 매칭 상위 10 포함
    const onSale = all.filter(r => (r.price?.discount_percent ?? 0) > 0);
    for (const id of ids(onSale.slice(0, 10))) expect(poolIds).toContain(id);
    // (c) 할인 dealScore 상위 2·10 포함
    const byDeal = onSale.slice().sort((a, b) =>
      ((b.price!.discount_percent) - (a.price!.discount_percent)) || (a.appid - b.appid));
    for (const id of ids(byDeal.slice(0, 20))) expect(poolIds).toContain(id);
    // 상한: 10 + 10 + 20
    expect(pool.length).toBeLessThanOrEqual(40);
  });

  it("후보가 상한보다 적으면 전체가 그대로 들어간다", () => {
    const all = makeWishlist(5, 1);
    expect(ids(buildWishlistPool(all))).toEqual(ids(all));
  });
});

describe("rerankFromPool — 축소 풀 == 전체 목록 (모든 옵션 조합)", () => {
  const wishAll = makeWishlist(400, 42);
  const library = makeLibrary(120, 43);
  const reviews = { ...allReviews(wishAll, 44), ...allReviews(library, 45) };

  for (const priceOk of [true, false]) {
    it(`가격 ${priceOk ? "정상" : "실패"}: 가성비 × 할인만 × 개수 1..30 전부 일치`, () => {
      const fullPool: RerankPool = {
        library, wishlist: wishAll, reviews, wishPricesReady: true, wishPriceOk: priceOk,
      };
      const reduced: RerankPool = {
        library: library.slice(0, REVIEW_SHORTLIST_CAP),
        wishlist: buildWishlistPool(wishAll),
        reviews,
        wishPricesReady: true,
        wishPriceOk: priceOk,
      };
      for (const valueWeighting of [true, false]) {
        for (const saleOnly of [true, false]) {
          for (let max = 1; max <= 30; max++) {
            const opts = { valueWeighting, saleOnly, maxRecommendationsPerTrack: max };
            const a = rerankFromPool(fullPool, opts);
            const b = rerankFromPool(reduced, opts);
            expect(ids(b.libraryUnplayed)).toEqual(ids(a.libraryUnplayed));
            expect(ids(b.wishlist)).toEqual(ids(a.wishlist));
            expect(b.wishlist?.map(r => r.score)).toEqual(a.wishlist?.map(r => r.score));
          }
        }
      }
    });
  }
});

describe("rerankFromPool — 규칙", () => {
  const wishAll = makeWishlist(60, 9);
  const library = makeLibrary(40, 10);
  const base: RerankPool = {
    library, wishlist: buildWishlistPool(wishAll), reviews: {}, wishPricesReady: true, wishPriceOk: true,
  };
  const opts = { valueWeighting: true, saleOnly: false, maxRecommendationsPerTrack: 12 };

  it("할인만 + 가격 조회 전이면 위시는 null (미확정)", () => {
    expect(rerankFromPool({ ...base, wishPricesReady: false, wishPriceOk: false }, { ...opts, saleOnly: true }).wishlist).toBeNull();
  });

  it("할인만 + 가격 커버리지 부족이면 위시는 빈 목록 (가격 실패 안내용)", () => {
    expect(rerankFromPool({ ...base, wishPriceOk: false }, { ...opts, saleOnly: true }).wishlist).toEqual([]);
  });

  it("할인만이면 할인 중인 후보만 나온다", () => {
    const out = rerankFromPool(base, { ...opts, saleOnly: true }).wishlist!;
    expect(out.length).toBeGreaterThan(0);
    for (const r of out) expect(r.price?.discount_percent ?? 0).toBeGreaterThan(0);
  });

  it("개수 상한을 지킨다", () => {
    const out = rerankFromPool(base, { ...opts, maxRecommendationsPerTrack: 5 });
    expect(out.libraryUnplayed).toHaveLength(5);
    expect(out.wishlist!.length).toBeLessThanOrEqual(5);
  });

  it("리뷰가 없으면 블렌딩 대상 appid를 missingReviewIds로 알리고, null(조회 실패)은 알고 있는 것으로 본다", () => {
    const size = shortlistSizeFor(12);
    const out = rerankFromPool(base, opts);
    for (const r of library.slice(0, size)) expect(out.missingReviewIds).toContain(r.appid);
    const reviews: RerankPool["reviews"] = {};
    for (const id of poolAppIds(base)) reviews[id] = null;
    expect(rerankFromPool({ ...base, reviews }, opts).missingReviewIds).toEqual([]);
  });

  it("최종 카드에만 호평률 배지를 붙인다", () => {
    const reviews: RerankPool["reviews"] = {};
    for (const id of poolAppIds(base)) reviews[id] = summary(90, 100);
    const out = rerankFromPool({ ...base, reviews }, opts);
    for (const r of out.libraryUnplayed) expect(r.reviewBadge).toEqual({ positivePercent: 90, totalReviews: 100 });
  });

  it("발굴 풀이 있으면 가성비 산식으로 블렌딩해 개수만큼, 없으면 undefined", () => {
    expect(rerankFromPool(base, opts).storeDeals).toBeUndefined();
    const deals = makeWishlist(40, 11).map(r => ({ ...r, appid: r.appid + 50_000, source: "store-deal" as const, price: price(50) }));
    const out = rerankFromPool({ ...base, storeDeals: deals }, { ...opts, maxRecommendationsPerTrack: 7 });
    expect(out.storeDeals).toHaveLength(7);
    for (const r of out.storeDeals!) expect(r.dealScore).toBeDefined();
    // 발굴 리뷰는 서버가 항상 채우므로 미조회 추적 대상이 아니다
    expect(out.missingReviewIds.some(id => deals.some(d => d.appid === id))).toBe(false);
  });
});

describe("shouldKeepPreviousWishlist / withPreviousWishlist (서버 poolForCache·클라이언트 mergePartialPool 공용)", () => {
  const rec = (appid: number): Recommendation => ({
    appid, name: "G" + appid, isFree: false, matchedGenres: [], matchedCategories: [],
    matchScore: 0.5, score: 0, source: "wishlist",
  });
  const summary: ReviewSummary = { reviewScore: 8, reviewScoreDesc: "", totalPositive: 9, totalNegative: 1, totalReviews: 10 };
  const prev: RerankPool = {
    library: [], wishlist: [rec(1), rec(2)], reviews: { 1: summary, 2: null, 9: summary },
    wishPricesReady: true, wishPriceOk: false,
  };
  const next: RerankPool = {
    library: [{ ...rec(5), source: "library-unplayed" }], wishlist: [rec(3)], reviews: { 1: null },
    wishPricesReady: false, wishPriceOk: false,
  };

  it("새 풀이 가격 전이고 이전 풀은 가격이 있을 때만 유지한다", () => {
    expect(shouldKeepPreviousWishlist(next, prev)).toBe(true);
    expect(shouldKeepPreviousWishlist({ ...next, wishPricesReady: true }, prev)).toBe(false);
    expect(shouldKeepPreviousWishlist(next, { ...prev, wishPricesReady: false })).toBe(false);
  });

  it("위시 목록·가격 상태는 이전 것, 라이브러리는 새 것, 위시 리뷰는 새 풀에 없을 때만 이전 것", () => {
    const out = withPreviousWishlist(next, prev);
    expect(out.wishlist.map(r => r.appid)).toEqual([1, 2]);
    expect(out.library.map(r => r.appid)).toEqual([5]);
    expect(out.wishPricesReady).toBe(true);
    expect(out.wishPriceOk).toBe(false);
    expect(out.reviews[1]).toBeNull(); // 새 풀 값 우선
    expect(out.reviews[2]).toBeNull(); // 이전 풀에서 (조회 실패 null도 이어 감)
    expect(9 in out.reviews).toBe(false); // 이전 위시가 아닌 리뷰는 가져오지 않음
  });
});
