/**
 * 미보유 할인 게임 발굴 트랙 순수 로직 단위 테스트.
 * (작업 지시서 20261010_01 단계 2-3, 2-7)
 *
 * 검색 HTML·GetItems 응답은 단계 0에서 저장한 실응답 픽스처를 쓴다.
 */

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import {
  parseSearchResultAppIds,
  storeItemToPrice,
  storeItemToReviewSummary,
  normalizeStoreItem,
  filterDiscoverPool,
  selectDealCandidatesForMeta,
} from "@/lib/steam/deals";
import {
  recommendStoreDeals,
  buildStoreDealCandidate,
  blendRecommendations,
  computeReviewScore,
  computeDealScore,
  analyzeTaste,
  REVIEW_BADGE_MIN_SAMPLE,
  DEFAULT_ANALYZE_OPTIONS,
  type AnalyzeOptions,
  type OwnedAnalyzedGame,
  type StoreDealCandidate,
} from "@/lib/steam/profile";
import type {
  SteamStoreBrowseItem,
  StoreItemSummary,
  SteamPriceOverview,
  SteamAppDetails,
} from "@/lib/steam/types";

const FIXTURE_DIR = path.join(__dirname, "fixtures", "steam-stage0");
const readJson = (name: string) => JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), "utf8"));
const searchP0 = readJson("v4_reviews_p0.json");
const searchP50 = readJson("v4_reviews_p50.json");
const getItems = readJson("v2_getitems_nokey.json");
const storeItems: SteamStoreBrowseItem[] = getItems.response.store_items;
const byAppid = (id: number) => storeItems.find(it => it.appid === id)!;

const opts = (o: Partial<AnalyzeOptions> = {}): AnalyzeOptions => ({ ...DEFAULT_ANALYZE_OPTIONS, ...o });

/** KRW 가격 (원 단위 입력 → 1/100 단위). */
function krw(initialWon: number, discountPercent: number): SteamPriceOverview {
  const f = Math.round(initialWon * (100 - discountPercent) / 100);
  return {
    currency: "KRW",
    initial: initialWon * 100,
    final: f * 100,
    discount_percent: discountPercent,
    initial_formatted: discountPercent > 0 ? `₩ ${initialWon}` : "",
    final_formatted: `₩ ${f}`,
  };
}

function summary(appid: number, price: SteamPriceOverview | null, reviews: number, pct = 90): StoreItemSummary {
  const totalPositive = Math.round(pct * reviews / 100);
  return {
    appid,
    price,
    review: reviews > 0
      ? { reviewScore: 8, reviewScoreDesc: "", totalPositive, totalNegative: reviews - totalPositive, totalReviews: reviews }
      : null,
    categoryIds: [2],
    isFree: false,
    fetchedAt: 1000,
  };
}

// ============================================================================
// 검색 HTML 파서
// ============================================================================

describe("parseSearchResultAppIds", () => {
  it("실응답 첫 페이지에서 appid를 순서대로 추출한다 (V3·V4 픽스처)", () => {
    const ids = parseSearchResultAppIds(searchP0.results_html);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.length).toBeLessThanOrEqual(50);
    expect(ids.every(id => Number.isInteger(id) && id > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("패키지 행(data-ds-packageid, 다중 appid \"4700,4780\")은 제외한다", () => {
    const html: string = searchP50.results_html;
    expect(html).toContain('data-ds-packageid="460"');
    const ids = parseSearchResultAppIds(html);
    // 이 페이지에는 Sub_460(4700,4780) 패키지 행과 별개로 앱 4700 단독 행도 있다.
    // 단독 행에서 온 4700은 한 번만 남고, 패키지에만 있는 4780은 나오지 않아야 한다.
    expect(ids.filter(id => id === 4700)).toHaveLength(1);
    expect(ids).not.toContain(4780);
    // 패키지 행을 뺀 일반 행은 추출된다 (예: 같은 페이지의 Oxygen Not Included)
    expect(ids).toContain(457140);
    // 패키지 행만 따로 넣으면 아무것도 추출되지 않는다
    const pkgRow = html.match(/<a\s[^>]*data-ds-packageid="460"[^>]*>/)![0];
    expect(parseSearchResultAppIds(pkgRow)).toEqual([]);
  });

  it("번들 행·다중 appid·비숫자 값은 제외하고 중복은 한 번만", () => {
    const html = [
      '<a href="x" data-ds-appid="10" data-ds-itemkey="App_10">',
      '<a href="x" data-ds-bundleid="5" data-ds-appid="11">',
      '<a href="x" data-ds-appid="12,13">',
      '<a href="x" data-ds-appid="abc">',
      '<a href="x" data-ds-appid="">',
      '<a href="x" data-ds-appid="10">',
      '<a href="x" data-ds-appid="20">',
    ].join("\n");
    expect(parseSearchResultAppIds(html)).toEqual([10, 20]);
  });

  it("빈·깨진 HTML은 빈 배열", () => {
    expect(parseSearchResultAppIds("")).toEqual([]);
    expect(parseSearchResultAppIds("<div>no rows</div>")).toEqual([]);
    expect(parseSearchResultAppIds('<a data-ds-appid="1"')).toEqual([]);
    expect(parseSearchResultAppIds(undefined as unknown as string)).toEqual([]);
  });
});

// ============================================================================
// GetItems 정규화
// ============================================================================

describe("storeItemToPrice", () => {
  it("할인 중 (Terraria 50%): 정가·할인가·할인율·표시 문자열", () => {
    expect(storeItemToPrice(byAppid(105600))).toEqual({
      currency: "KRW",
      initial: 1100000,
      final: 550000,
      discount_percent: 50,
      initial_formatted: "₩ 11,000",
      final_formatted: "₩ 5,500",
    });
  });

  it("무할인 (Witcher 3): 정가 = 최종가, initial_formatted 빈 문자열 (appdetails 관례)", () => {
    const p = storeItemToPrice(byAppid(292030))!;
    expect(p.discount_percent).toBe(0);
    expect(p.initial).toBe(5490000);
    expect(p.final).toBe(5490000);
    expect(p.initial_formatted).toBe("");
  });

  it("구매 옵션 없음 (무료 Dota 2) → null", () => {
    expect(storeItemToPrice(byAppid(570))).toBeNull();
  });

  it("할인 표시 불가 옵션은 할인 0으로 본다 (할인이 아닌 할인 차단)", () => {
    const item: SteamStoreBrowseItem = {
      success: 1, appid: 1,
      best_purchase_option: {
        final_price_in_cents: "500000", original_price_in_cents: "1000000", discount_pct: 50,
        price_cannot_be_displayed_as_discount: true,
      },
    };
    const p = storeItemToPrice(item)!;
    expect(p.discount_percent).toBe(0);
    expect(p.initial).toBe(500000);
  });

  it("금액 파싱 불가·음수면 null", () => {
    expect(storeItemToPrice({ success: 1, best_purchase_option: { final_price_in_cents: "x" } })).toBeNull();
    expect(storeItemToPrice({ success: 1, best_purchase_option: { final_price_in_cents: "-1" } })).toBeNull();
  });
});

describe("storeItemToReviewSummary / normalizeStoreItem", () => {
  it("percent_positive·review_count → totalPositive 환산 (Terraria 97%)", () => {
    const s = storeItemToReviewSummary(byAppid(105600))!;
    expect(s.totalReviews).toBe(1244628);
    expect(s.totalPositive).toBe(Math.round(0.97 * 1244628));
    expect(s.totalNegative).toBe(1244628 - s.totalPositive);
    // 기존 computeReviewScore 입력으로 그대로 쓸 수 있다
    expect(computeReviewScore(s)).toBeCloseTo(0.97, 2);
  });

  it("리뷰 요약 없음·0개면 null", () => {
    expect(storeItemToReviewSummary({ success: 1 })).toBeNull();
    expect(storeItemToReviewSummary({
      success: 1,
      reviews: { summary_filtered: { review_count: 0, percent_positive: 0, review_score: 0, review_score_label: "" } },
    })).toBeNull();
  });

  it("normalizeStoreItem: 카테고리 3종 합집합, 할인 종료 시각, success!==1 → null", () => {
    const t = normalizeStoreItem(byAppid(105600), 777)!;
    expect(t.appid).toBe(105600);
    expect(t.fetchedAt).toBe(777);
    expect(t.categoryIds).toEqual(expect.arrayContaining([2, 1, 22, 28]));
    expect(new Set(t.categoryIds).size).toBe(t.categoryIds.length);
    expect(t.discountEndsAt).toBe(1792083600);
    // 무할인이면 종료 시각 없음
    expect(normalizeStoreItem(byAppid(292030), 0)!.discountEndsAt).toBeUndefined();
    expect(normalizeStoreItem(byAppid(570), 0)!.isFree).toBe(true);
    expect(normalizeStoreItem({ success: 2, appid: 1 }, 0)).toBeNull();
    expect(normalizeStoreItem({ success: 1 }, 0)).toBeNull();
  });
});

// ============================================================================
// 후보 선정
// ============================================================================

describe("filterDiscoverPool", () => {
  it("소유·위시리스트 제외, 순서 보존", () => {
    expect(filterDiscoverPool([5, 1, 4, 2, 3], new Set([1]), new Set([2, 9]))).toEqual([5, 4, 3]);
  });
});

describe("selectDealCandidatesForMeta", () => {
  const items = new Map<number, StoreItemSummary>([
    [1, summary(1, krw(60000, 50), 100)],                       // deal 0.5·0.875
    [2, summary(2, krw(60000, 75), 100)],                       // 더 깊은 할인
    [3, summary(3, krw(60000, 0), 100)],                        // 할인 없음 → 제외
    [4, summary(4, krw(60000, 90), REVIEW_BADGE_MIN_SAMPLE - 1)], // 리뷰 하한 미달 → 제외
    [5, summary(5, null, 100)],                                 // 무료·미판매 → 제외
    [6, summary(6, krw(60000, 50), 0)],                         // 리뷰 요약 없음 → 제외
    [7, summary(7, krw(60000, 50), 100)],                       // 1과 동점 → appid asc
  ]);
  const ids = [1, 2, 3, 4, 5, 6, 7, 8 /* GetItems 미상 */];

  it("할인 중 + 리뷰 하한 충족만, dealScore desc → appid asc", () => {
    expect(selectDealCandidatesForMeta(ids, items, 10, REVIEW_BADGE_MIN_SAMPLE)).toEqual([2, 1, 7]);
  });

  it("cap으로 자른다 / cap ≤ 0이면 빈 배열", () => {
    expect(selectDealCandidatesForMeta(ids, items, 2, REVIEW_BADGE_MIN_SAMPLE)).toEqual([2, 1]);
    expect(selectDealCandidatesForMeta(ids, items, 0, REVIEW_BADGE_MIN_SAMPLE)).toEqual([]);
  });
});

// ============================================================================
// 매칭 (profile.ts)
// ============================================================================

describe("buildStoreDealCandidate", () => {
  const details = {
    name: "Game", is_free: false, header_image: "h.jpg",
    genres: [{ id: "1", description: "액션" }],
    categories: [{ id: 2, description: "싱글 플레이어" }],
    price_overview: krw(99999, 0), // 묵었을 수 있는 메타 가격 — 쓰면 안 된다
  } as unknown as SteamAppDetails;

  it("장르·카테고리 라벨은 메타, 가격·시각·종료는 GetItems 요약", () => {
    const item = { ...summary(10, krw(20000, 40), 100), discountEndsAt: 123 };
    const c = buildStoreDealCandidate(details, item)!;
    expect(c.genreIds).toEqual(["1"]);
    expect(c.genreLabels).toEqual({ "1": "액션" });
    expect(c.categoryLabels).toEqual({ 2: "싱글 플레이어" });
    expect(c.price).toEqual(krw(20000, 40));
    expect(c.priceFetchedAt).toBe(1000);
    expect(c.discountEndsAt).toBe(123);
  });

  it("isFree는 appdetails(F2P) 기준 — GetItems is_free(100% 할인 배포)는 무시", () => {
    const giveaway = { ...summary(11, krw(5500, 100), 100), isFree: true };
    expect(buildStoreDealCandidate(details, giveaway)!.isFree).toBe(false);
  });

  it("메타 없음(null)이면 null — 장르 없이는 매칭 불가", () => {
    expect(buildStoreDealCandidate(null, summary(10, krw(20000, 40), 100))).toBeNull();
  });
});

describe("recommendStoreDeals", () => {
  const owned: OwnedAnalyzedGame[] = [{
    appid: 100, name: "Owned", playtimeMinutes: 6000, recent2wMinutes: 0,
    genreIds: ["1"], categoryIds: [], genreLabels: { "1": "Action" }, categoryLabels: {}, isFree: false,
  }];
  const profile = analyzeTaste(owned, opts());
  const cand = (appid: number, genreIds: string[], price: SteamPriceOverview | null, isFree = false): StoreDealCandidate => ({
    appid, name: `S${appid}`, isFree, genreIds, categoryIds: [],
    genreLabels: Object.fromEntries(genreIds.map(g => [g, `G${g}`])), categoryLabels: {},
    price, priceFetchedAt: 5,
  });

  it("매칭 0·할인 없음·무료(excludeFree) 탈락, source=store-deal, 가격 실림", () => {
    const out = recommendStoreDeals([
      cand(1, ["1"], krw(20000, 50)),
      cand(2, ["9"], krw(20000, 50)),        // 매칭 0
      cand(3, ["1"], krw(20000, 0)),         // 할인 없음
      cand(4, ["1"], krw(20000, 50), true),  // 무료 + excludeFree
    ], profile, opts({ excludeFree: true }));
    expect(out.map(r => r.appid)).toEqual([1]);
    expect(out[0].source).toBe("store-deal");
    expect(out[0].price).toEqual(krw(20000, 50));
    expect(out[0].priceFetchedAt).toBe(5);
    expect(out[0].score).toBe(out[0].matchScore);
  });

  it("정렬: matchScore desc → dealScore desc → appid asc, limit 적용", () => {
    const out = recommendStoreDeals([
      cand(30, ["1", "8"], krw(20000, 90)),  // 태그 많아 매칭 낮음
      cand(20, ["1"], krw(20000, 30)),
      cand(10, ["1"], krw(20000, 30)),       // 20과 완전 동점 → appid asc
      cand(5, ["1"], krw(20000, 60)),        // 매칭 동점, 할인 깊음 → 앞
    ], profile, opts(), 3);
    expect(out.map(r => r.appid)).toEqual([5, 10, 20]);
  });

  it("블렌딩 (라우트 경로 재현): 가성비 산식, [0,1] 유계", () => {
    const shortlist = recommendStoreDeals([cand(1, ["1"], krw(60000, 80)), cand(2, ["1"], krw(60000, 10))], profile, opts());
    const reviews = new Map([[1, 0.5], [2, 0.9]]);
    const deals = new Map(shortlist.map(r => [r.appid, computeDealScore(r.price)]));
    const ranked = blendRecommendations(shortlist, reviews, 10, deals);
    for (const r of ranked) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
      expect(r.dealScore).toBe(deals.get(r.appid));
      expect(r.source).toBe("store-deal");
    }
  });
});

describe("storeItemToPrice 정가 누락 (리뷰 L5)", () => {
  it("할인율만 있고 정가가 없으면 무할인으로 본다", () => {
    const p = storeItemToPrice({
      success: 1,
      best_purchase_option: { final_price_in_cents: "500000", discount_pct: 50, formatted_final_price: "₩ 5,000" },
    })!;
    expect(p.discount_percent).toBe(0);
    expect(p.initial).toBe(500000);
    expect(p.initial_formatted).toBe("");
  });
});
