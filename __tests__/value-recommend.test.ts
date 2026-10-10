/**
 * 가성비(할인·리뷰·취향) 추천 순수 로직 단위 테스트.
 * (작업 지시서 20261010_01 §1-2, §1-4, §1-7)
 */

import { describe, it, expect } from "vitest";
import {
  computeDealScore,
  priceToWon,
  isOnSale,
  blendRecommendations,
  augmentWithDeals,
  planWishlistBlend,
  blendWishlistTrack,
  recommendFromWishlist,
  analyzeTaste,
  W_MATCH,
  W_REVIEW,
  W_MATCH_V,
  W_REVIEW_V,
  W_DEAL,
  DEAL_PRICE_REF_KRW,
  DEFAULT_ANALYZE_OPTIONS,
  type AnalyzeOptions,
  type Recommendation,
  type WishlistAnalyzedGame,
  type OwnedAnalyzedGame,
} from "@/lib/steam/profile";
import type { SteamPriceOverview } from "@/lib/steam/types";

/** KRW 가격. 금액 인자는 원 단위로 받고 Steam 형식(1/100 단위)으로 변환한다. */
function krw(initialWon: number, discountPercent: number, finalWon?: number): SteamPriceOverview {
  const f = finalWon ?? Math.round(initialWon * (100 - discountPercent) / 100);
  return {
    currency: "KRW",
    initial: initialWon * 100,
    final: f * 100,
    discount_percent: discountPercent,
    initial_formatted: discountPercent > 0 ? `₩ ${initialWon}` : "",
    final_formatted: `₩ ${f}`,
  };
}

const opts = (o: Partial<AnalyzeOptions> = {}): AnalyzeOptions => ({ ...DEFAULT_ANALYZE_OPTIONS, ...o });

describe("priceToWon", () => {
  it("KRW는 1/100 단위를 원으로 (단계 0 V5)", () => {
    const p = krw(54900, 0);
    expect(p.final).toBe(5490000);
    expect(priceToWon(p, p.final)).toBe(54900);
  });
  it("KRW 외 통화와 NaN은 null", () => {
    expect(priceToWon({ ...krw(1000, 0), currency: "USD" }, 100)).toBeNull();
    expect(priceToWon(krw(1000, 0), NaN)).toBeNull();
  });
});

describe("computeDealScore", () => {
  it("할인 없으면 0 (가격이 싸도)", () => {
    expect(computeDealScore(krw(1000, 0))).toBe(0);
  });
  it("가격 미상/무료·미판매는 0", () => {
    expect(computeDealScore(undefined)).toBe(0);
    expect(computeDealScore(null)).toBe(0);
  });
  it("100% 할인(final 0)은 정확히 1.0 (C3)", () => {
    expect(computeDealScore(krw(30000, 100, 0))).toBe(1);
  });
  it("소폭 할인 저가 게임은 큰 할인 고가 게임보다 낮다 (M6)", () => {
    const cheapSmall = computeDealScore(krw(1000, 10));   // ≈ 0.10
    const bigHalf = computeDealScore(krw(60000, 50));     // 0.5·(0.75+0.25·0.5) = 0.4375
    expect(cheapSmall).toBeCloseTo(0.1 * (0.75 + 0.25 * (1 - 900 / DEAL_PRICE_REF_KRW)), 9);
    expect(bigHalf).toBeCloseTo(0.4375, 9);
    expect(cheapSmall).toBeLessThan(bigHalf);
  });
  it("최종가가 기준가 이상이면 cheap=0 → d·0.75", () => {
    expect(computeDealScore(krw(200000, 50))).toBeCloseTo(0.5 * 0.75, 9);
    expect(computeDealScore(krw(120000, 50, DEAL_PRICE_REF_KRW))).toBeCloseTo(0.5 * 0.75, 9);
  });
  it("KRW 외 통화는 가격 항 없이 d·0.75", () => {
    expect(computeDealScore({ ...krw(1000, 40), currency: "USD" })).toBeCloseTo(0.4 * 0.75, 9);
  });
  it("음수 할인율/NaN은 0", () => {
    expect(computeDealScore({ ...krw(1000, 0), discount_percent: -5 })).toBe(0);
    expect(computeDealScore({ ...krw(1000, 0), discount_percent: NaN })).toBe(0);
  });
  it("항상 [0,1]", () => {
    for (const pct of [1, 25, 50, 75, 99, 100]) {
      for (const won of [0, 500, 10000, 59999, 60000, 300000]) {
        const s = computeDealScore(krw(won, pct));
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("isOnSale", () => {
  it("discount_percent > 0만 true", () => {
    expect(isOnSale(krw(1000, 10))).toBe(true);
    expect(isOnSale(krw(1000, 0))).toBe(false);
    expect(isOnSale(null)).toBe(false);
    expect(isOnSale(undefined)).toBe(false);
  });
});

const rec = (args: Partial<Recommendation> & { appid: number; matchScore: number }): Recommendation => ({
  name: `Game ${args.appid}`,
  isFree: false,
  matchedGenres: [],
  matchedCategories: [],
  score: args.matchScore,
  source: "wishlist",
  wishlistPriority: 0,
  wishlistDateAdded: 0,
  ...args,
});

describe("blendRecommendations + dealScoreByAppid", () => {
  const shortlist = [
    rec({ appid: 1, matchScore: 0.9, price: krw(30000, 0) }),
    rec({ appid: 2, matchScore: 0.7, price: krw(30000, 80) }),
    rec({ appid: 3, matchScore: 0.5 }),
  ];
  const reviews = new Map<number, number>([[1, 0.6], [2, 0.7], [3, 0.9]]);

  it("미전달이면 기존 산식과 정확히 동일 (회귀)", () => {
    const out = blendRecommendations(shortlist, reviews, 10);
    for (const r of out) {
      const review = reviews.get(r.appid)!;
      // 기존 구현과 같은 연산 순서 → toBe(비트 동일)로 검증
      expect(r.score).toBe(W_MATCH * shortlist.find(s => s.appid === r.appid)!.matchScore + W_REVIEW * review);
      expect(r.dealScore).toBeUndefined();
    }
    expect(out.map(r => r.appid)).toEqual([1, 2, 3]);
  });

  it("전달하면 가성비 산식, 가중치 합 1, 할인이 순위를 뒤집을 수 있다", () => {
    expect(W_MATCH_V + W_REVIEW_V + W_DEAL).toBeCloseTo(1, 12);
    const deals = new Map(shortlist.map(r => [r.appid, computeDealScore(r.price)]));
    const out = blendRecommendations(shortlist, reviews, 10, deals);
    const two = out.find(r => r.appid === 2)!;
    expect(two.dealScore).toBeCloseTo(computeDealScore(krw(30000, 80)), 12);
    expect(two.score).toBeCloseTo(W_MATCH_V * 0.7 + W_REVIEW_V * 0.7 + W_DEAL * two.dealScore!, 12);
    // 1: 0.45·0.9+0.3·0.6+0 = 0.585 / 2: 0.315+0.21+0.25·0.8·(0.75+0.25·0.9)=0.72
    expect(out[0].appid).toBe(2);
    for (const r of out) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });

  it("맵에 없는 후보(가격 미상)는 deal=0", () => {
    const out = blendRecommendations(shortlist, reviews, 10, new Map());
    expect(out.every(r => r.dealScore === 0)).toBe(true);
  });
});

describe("augmentWithDeals", () => {
  const shortlist = [rec({ appid: 1, matchScore: 0.9 }), rec({ appid: 2, matchScore: 0.8 })];
  const candidates = [
    ...shortlist,
    rec({ appid: 10, matchScore: 0.3, price: krw(30000, 50) }),
    rec({ appid: 11, matchScore: 0.2, price: krw(30000, 90) }),
    rec({ appid: 12, matchScore: 0.2, price: krw(30000, 0) }),   // 할인 없음
    rec({ appid: 13, matchScore: 0.2 }),                          // 가격 미상
    rec({ appid: 9, matchScore: 0.1, price: krw(30000, 50) }),   // 10과 동점 → appid 오름차순
  ];

  it("할인 후보만 dealScore desc → appid asc로 k개 덧붙인다", () => {
    const out = augmentWithDeals(shortlist, candidates, 3);
    expect(out.map(r => r.appid)).toEqual([1, 2, 11, 9, 10]);
  });
  it("shortlist에 이미 있는 appid는 중복 추가하지 않는다", () => {
    const sl = [rec({ appid: 11, matchScore: 0.2, price: krw(30000, 90) })];
    const out = augmentWithDeals(sl, candidates, 10);
    expect(out.filter(r => r.appid === 11)).toHaveLength(1);
  });
  it("k=0 또는 할인 후보 없음이면 원본 그대로", () => {
    expect(augmentWithDeals(shortlist, candidates, 0)).toBe(shortlist);
    expect(augmentWithDeals(shortlist, shortlist, 5)).toBe(shortlist);
  });
});

describe("recommendFromWishlist saleOnly + 가격 전달", () => {
  const ownedGames: OwnedAnalyzedGame[] = [{
    appid: 100, name: "Owned", playtimeMinutes: 6000, recent2wMinutes: 0,
    genreIds: ["1"], categoryIds: [], genreLabels: { "1": "Action" }, categoryLabels: {}, isFree: false,
  }];
  const profile = analyzeTaste(ownedGames, opts());
  const w = (appid: number, price?: SteamPriceOverview | null): WishlistAnalyzedGame => ({
    appid, name: `W${appid}`, priority: 0, dateAddedUnix: 0,
    genreIds: ["1"], categoryIds: [], genreLabels: { "1": "Action" }, categoryLabels: {}, isFree: false,
    ...(price !== undefined ? { price, priceFetchedAt: 123 } : {}),
  });
  const wl = [w(1, krw(10000, 50)), w(2, krw(10000, 0)), w(3), w(4, null)];

  it("saleOnly=false면 전부, 가격·시각을 Recommendation에 싣는다", () => {
    const out = recommendFromWishlist(wl, profile, opts());
    expect(out.map(r => r.appid).sort()).toEqual([1, 2, 3, 4]);
    const one = out.find(r => r.appid === 1)!;
    expect(one.price).toEqual(krw(10000, 50));
    expect(one.priceFetchedAt).toBe(123);
    expect(out.find(r => r.appid === 3)!.price).toBeUndefined();
    expect(out.find(r => r.appid === 4)!.price).toBeNull();
  });

  it("saleOnly=true면 할인 중만 (미상·무가격 제외)", () => {
    const out = recommendFromWishlist(wl, profile, opts({ saleOnly: true }));
    expect(out.map(r => r.appid)).toEqual([1]);
  });
});

describe("planWishlistBlend + blendWishlistTrack (라우트 결정 로직, 리뷰 M2)", () => {
  // shortlist(매칭 상위 2개) 밖에 매칭은 낮지만 할인이 깊은 후보(appid 9)가 있다.
  const shortlist = [
    rec({ appid: 1, matchScore: 0.9, price: krw(30000, 0) }),
    rec({ appid: 2, matchScore: 0.8, price: krw(30000, 0) }),
  ];
  const all = [...shortlist, rec({ appid: 9, matchScore: 0.4, price: krw(20000, 90) })];
  const reviews = new Map<number, number>([[1, 0.5], [2, 0.5], [9, 0.9]]);

  it("가격 조회 실패(priceOk=false)면 보강 없이 기존 산식과 깊은 동등", () => {
    const { targets, useDeal } = planWishlistBlend(shortlist, all, opts({ valueWeighting: true }), false);
    expect(useDeal).toBe(false);
    expect(targets).toBe(shortlist);
    const out = blendWishlistTrack(targets, reviews, 10, useDeal);
    expect(out).toEqual(blendRecommendations(shortlist, reviews, 10));
    expect(out.some(r => r.dealScore !== undefined)).toBe(false);
  });

  it("valueWeighting=false면 가격이 있어도 기존 산식", () => {
    const { targets, useDeal } = planWishlistBlend(shortlist, all, opts({ valueWeighting: false }), true);
    expect(useDeal).toBe(false);
    expect(blendWishlistTrack(targets, reviews, 10, useDeal)).toEqual(blendRecommendations(shortlist, reviews, 10));
  });

  it("가격 정상 + valueWeighting이면 shortlist 밖 할인 후보가 블렌딩 결과에 들어온다", () => {
    const { targets, useDeal } = planWishlistBlend(shortlist, all, opts({ valueWeighting: true }), true);
    expect(useDeal).toBe(true);
    expect(targets.map(r => r.appid)).toEqual([1, 2, 9]);
    const out = blendWishlistTrack(targets, reviews, 10, useDeal);
    expect(out.map(r => r.appid)).toContain(9);
    expect(out.find(r => r.appid === 9)!.dealScore).toBeGreaterThan(0);
  });
});

describe("recommendFromWishlist limit 동등성 (작업 지시서 20261010_02 §4)", () => {
  // 라우트는 partial 경로에서 전체 정렬 후 slice 대신 limit으로 바로 자른다. 두 결과가 같아야 한다.
  const ownedGames: OwnedAnalyzedGame[] = [{
    appid: 100, name: "Owned", playtimeMinutes: 6000, recent2wMinutes: 0,
    genreIds: ["1", "2"], categoryIds: [2], genreLabels: { "1": "Action", "2": "RPG" }, categoryLabels: { 2: "Single" }, isFree: false,
  }];
  const profile = analyzeTaste(ownedGames, opts());
  const wl: WishlistAnalyzedGame[] = Array.from({ length: 40 }, (_, i) => ({
    appid: 1000 + i, name: `W${i}`, priority: i % 7, dateAddedUnix: 1000 - (i % 5),
    genreIds: i % 3 === 0 ? ["1"] : i % 3 === 1 ? ["1", "2"] : ["2", "9"],
    categoryIds: i % 2 === 0 ? [2] : [], genreLabels: {}, categoryLabels: {}, isFree: false,
  }));

  it("limit으로 자른 결과 = 전체 정렬 후 slice", () => {
    for (const limit of [1, 5, 12, 30, 100]) {
      expect(recommendFromWishlist(wl, profile, opts(), limit))
        .toEqual(recommendFromWishlist(wl, profile, opts(), Number.MAX_SAFE_INTEGER).slice(0, limit));
    }
  });
});
