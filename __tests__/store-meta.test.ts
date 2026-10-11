/**
 * GetItems 기반 성향 분석 메타 (속도 개선) 단위 테스트.
 *   - storeItemToAppDetails: 순수 변환 (장르=장르 태그, 카테고리 라벨, 출시 예정, 헤더 이미지)
 *   - getStoreMetaBatch: 캐시 계층(LRU → SQLite → GetItems), 100개 배치, 다른 캐시 채우기, 실패 처리
 *   - getReviewSummariesBatch: 캐시 우선 + GetItems 배치
 *
 * price-batch.test.ts와 같은 방식 — global fetch stub + fake timer + Map 기반 fake 캐시·fake 영속 저장소.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

interface FakeEntry { data: unknown; fetchedAt: number; isStale: boolean }
const fakeCache = new Map<string, FakeEntry>();
const fakeLastKnown = new Map<number, unknown>();
const fakeStore = new Map<number, { details: unknown; fetchedAt: number }>();

vi.mock("@/lib/cache", async () => {
  const actual = await vi.importActual<typeof import("@/lib/cache")>("@/lib/cache");
  return {
    CACHE_TTL: actual.CACHE_TTL,
    cacheGet: (key: string) => {
      const e = fakeCache.get(key);
      if (!e) return null;
      if (e.isStale) fakeCache.delete(key);
      return { ...e };
    },
    cacheSet: (key: string, data: unknown) => {
      fakeCache.set(key, { data, fetchedAt: Date.now(), isStale: false });
    },
    cacheDelete: (key: string) => { fakeCache.delete(key); },
    cacheDeleteByPrefix: () => {},
    lastKnownPriceGet: (id: number) => fakeLastKnown.get(id) ?? null,
    lastKnownPriceSet: (id: number, snap: unknown) => { fakeLastKnown.set(id, snap); },
  };
});
vi.mock("@/lib/store-meta-store", () => ({
  getStoreMetaFromStore: (ids: readonly number[], minFetchedAt: number) => {
    const out = new Map<number, { details: unknown; fetchedAt: number }>();
    for (const id of ids) {
      const e = fakeStore.get(id);
      if (e && e.fetchedAt > minFetchedAt) out.set(id, e);
    }
    return out;
  },
  getStoreMetaIdsInStore: (ids: readonly number[], minFetchedAt: number) => {
    const out = new Set<number>();
    for (const id of ids) {
      const e = fakeStore.get(id);
      if (e && e.fetchedAt > minFetchedAt) out.add(id);
    }
    return out;
  },
  setStoreMetaInStore: (entries: Map<number, unknown>, fetchedAt: number) => {
    for (const [id, details] of entries) fakeStore.set(id, { details, fetchedAt });
  },
}));
const setAppMetaFromStoreBatch = vi.fn();
vi.mock("@/lib/app-meta-cache", () => ({
  setAppMeta: vi.fn(),
  setAppMetaBatch: vi.fn(),
  setAppMetaFromStoreBatch: (...args: unknown[]) => setAppMetaFromStoreBatch(...args),
}));
vi.mock("@/lib/app-details-store", () => ({ getAppDetailsFromStore: vi.fn(), setAppDetailsInStore: vi.fn() }));
vi.mock("@/lib/achievement-store", () => ({ getGlobalFromStore: vi.fn(), setGlobalInStore: vi.fn() }));

import {
  getStoreMetaBatch,
  getReviewSummariesBatch,
  getCachedStoreMetaIds,
  getStoreItemPricesBatch,
  resetStoreCategoryLabelsState,
} from "@/lib/steam/api";
import {
  storeItemToAppDetails,
  storeItemHeaderImage,
  storeItemIsFreeToPlay,
  storeItemPriceIsAppPrice,
  GENRE_TAG_LABELS,
} from "@/lib/steam/store-meta";
import { normalizeStoreItem } from "@/lib/steam/deals";
import type { SteamStoreBrowseItem } from "@/lib/steam/types";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function run<T>(p: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return p;
}

/** GetItems store_item 하나 (실응답 모양 축약). */
function item(appid: number, over: Partial<SteamStoreBrowseItem> = {}): SteamStoreBrowseItem {
  return {
    appid,
    success: 1,
    name: `Game ${appid}`,
    tagids: [19, 1695, 122, 4182], // 액션, (오픈 월드), RPG, (싱글)
    categories: { supported_player_categoryids: [2], feature_categoryids: [22], controller_categoryids: [18] },
    assets: { asset_url_format: `steam/apps/${appid}/\${FILENAME}?t=1`, header: "header.jpg" },
    release: { steam_release_date: 1_600_000_000 },
    reviews: { summary_filtered: { review_count: 1000, percent_positive: 90, review_score: 8, review_score_label: "매우 긍정적" } },
    best_purchase_option: {
      final_price_in_cents: "1500000",
      original_price_in_cents: "3000000",
      formatted_final_price: "₩ 15,000",
      formatted_original_price: "₩ 30,000",
      discount_pct: 50,
    },
    ...over,
  };
}

const CATEGORIES = { response: { categories: [
  { categoryid: 2, display_name: "싱글 플레이어" },
  { categoryid: 22, display_name: "Steam 도전 과제" },
] } };

const getItemsUrl = (u: string) => u.includes("/IStoreBrowseService/GetItems/");
const requestedIds = (u: string): number[] =>
  JSON.parse(decodeURIComponent(u.split("input_json=")[1])).ids.map((x: { appid: number }) => x.appid);

describe("storeItemToAppDetails", () => {
  it("장르는 상위 태그 중 장르 태그만, 카테고리는 세 종류 id를 합쳐 라벨을 붙인다", () => {
    const d = storeItemToAppDetails(item(10), { 2: "싱글 플레이어", 22: "Steam 도전 과제" })!;
    expect(d.genres).toEqual([
      { id: "19", description: GENRE_TAG_LABELS[19] },
      { id: "122", description: GENRE_TAG_LABELS[122] },
    ]);
    expect(d.categories).toEqual([
      { id: 2, description: "싱글 플레이어" },
      { id: 22, description: "Steam 도전 과제" },
      { id: 18, description: "카테고리 18" }, // 라벨 없음 → fallback
    ]);
    expect(d.name).toBe("Game 10");
    expect(d.is_free).toBe(false);
    expect(d.release_date).toEqual({ coming_soon: false, date: "" });
  });

  it("출시 예정·무료(F2P)·헤더 이미지", () => {
    const d = storeItemToAppDetails(
      item(11, { is_free: true, best_purchase_option: undefined, release: { is_coming_soon: true } }), {},
    )!;
    expect(d.is_free).toBe(true);
    expect(d.release_date?.coming_soon).toBe(true);
    expect(storeItemHeaderImage(item(11))).toBe(
      "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/11/header.jpg?t=1",
    );
    expect(storeItemToAppDetails(item(12, { assets: undefined }), {})!.header_image).toBe("");
  });

  it("success!==1(삭제·지역 제한)이면 null", () => {
    expect(storeItemToAppDetails(item(13, { success: 15 }), {})).toBeNull();
  });

  it("tagids가 없으면 tags[].tagid를 쓴다", () => {
    const d = storeItemToAppDetails(item(14, { tagids: undefined, tags: [{ tagid: 21 }, { tagid: 9 }] }), {})!;
    expect(d.genres!.map(g => g.id)).toEqual(["21", "9"]);
  });
});

describe("storeItemIsFreeToPlay / storeItemPriceIsAppPrice", () => {
  const giveaway = item(20, {
    is_free: true,
    best_purchase_option: {
      final_price_in_cents: "0", original_price_in_cents: "2200000", discount_pct: 100,
      formatted_final_price: "₩ 0", formatted_original_price: "₩ 22,000",
    },
  });

  it("is_free여도 100% 할인 배포(한정 무료)는 F2P가 아니다 — excludeFree가 최고 할인을 거르지 않게", () => {
    expect(storeItemIsFreeToPlay(item(21, { is_free: true, best_purchase_option: undefined }))).toBe(true);
    expect(storeItemIsFreeToPlay(giveaway)).toBe(false);
    expect(storeItemToAppDetails(giveaway, {})!.is_free).toBe(false);
    // 0원 옵션에 할인 표시가 없으면 F2P
    expect(storeItemIsFreeToPlay(item(22, { is_free: true, best_purchase_option: { final_price_in_cents: "0" } }))).toBe(true);
    expect(storeItemIsFreeToPlay(item(23))).toBe(false);
  });

  it("F2P의 최저 옵션이 유료 팩이어도 F2P이고 가격은 null(무료) — 팩 가격이 게임 가격·할인으로 보이지 않게", () => {
    const pack = item(24, {
      is_free: true,
      best_purchase_option: {
        final_price_in_cents: "990000", original_price_in_cents: "1980000", discount_pct: 50,
        formatted_final_price: "₩ 9,900", formatted_original_price: "₩ 19,800",
      },
    });
    expect(storeItemIsFreeToPlay(pack)).toBe(true);
    expect(storeItemPriceIsAppPrice(pack)).toBe(true);
    expect(normalizeStoreItem(pack, 1)!.price).toBeNull();
    // 0원 옵션 F2P도 ₩0 가격이 아니라 null
    expect(normalizeStoreItem(item(25, { is_free: true, best_purchase_option: { final_price_in_cents: "0" } }), 1)!.price).toBeNull();
    // 한정 무료 배포는 0원 할인 가격 그대로
    expect(normalizeStoreItem(giveaway, 1)!.price).toMatchObject({ final: 0, discount_percent: 100 });
  });

  it("발굴 요약(normalizeStoreItem)도 묶음 전용 옵션 가격은 쓰지 않는다", () => {
    const opt = item(26).best_purchase_option!;
    expect(normalizeStoreItem(item(26, { best_purchase_option: { ...opt, included_game_count: 3 } }), 1)!.price).toBeNull();
    expect(normalizeStoreItem(item(27), 1)!.price).toMatchObject({ discount_percent: 50 });
  });

  it("가격 캐시에 넣는 가격: 단일 게임 옵션·F2P만 (묶음·세트·옵션 없는 유료 게임 제외)", () => {
    expect(storeItemPriceIsAppPrice(item(30))).toBe(true);
    expect(storeItemPriceIsAppPrice(giveaway)).toBe(true);
    const opt = item(31).best_purchase_option!;
    expect(storeItemPriceIsAppPrice(item(31, { best_purchase_option: { ...opt, included_game_count: 3 } }))).toBe(false);
    expect(storeItemPriceIsAppPrice(item(32, { best_purchase_option: { ...opt, must_purchase_as_set: true } }))).toBe(false);
    expect(storeItemPriceIsAppPrice(item(33, { best_purchase_option: undefined }))).toBe(false);
    expect(storeItemPriceIsAppPrice(item(34, { is_free: true, best_purchase_option: undefined }))).toBe(true);
  });
});

describe("getStoreMetaBatch", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.useFakeTimers();
    fakeCache.clear();
    fakeLastKnown.clear();
    fakeStore.clear();
    resetStoreCategoryLabelsState();
    setAppMetaFromStoreBatch.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockImplementation(async (input) => {
      const u = String(input);
      if (u.includes("GetStoreCategories")) return jsonResponse(CATEGORIES);
      if (getItemsUrl(u)) return jsonResponse({ response: { store_items: requestedIds(u).map(id => item(id)) } });
      return new Response("", { status: 404 });
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("100개 단위로 GetItems를 부르고(150개 → 2회), 결과를 LRU·영속 저장소에 넣는다", async () => {
    const ids = Array.from({ length: 150 }, (_, i) => 1000 + i);
    const out = await run(getStoreMetaBatch(ids));
    const calls = fetchMock.mock.calls.map(c => String(c[0])).filter(getItemsUrl);
    expect(calls).toHaveLength(2);
    expect(requestedIds(calls[0])).toHaveLength(100);
    expect(requestedIds(calls[1])).toHaveLength(50);
    // 카테고리 이름은 한 번만
    expect(fetchMock.mock.calls.filter(c => String(c[0]).includes("GetStoreCategories"))).toHaveLength(1);
    expect(out.size).toBe(150);
    expect(out.get(1000)?.categories?.[0]).toEqual({ id: 2, description: "싱글 플레이어" });
    expect(fakeCache.has("storemeta:1000:KR")).toBe(true);
    expect(fakeStore.has(1149)).toBe(true);
    // KR 컨텍스트 + 필요한 필드만 요청
    const input = JSON.parse(decodeURIComponent(calls[0].split("input_json=")[1]));
    expect(input.context).toEqual({ language: "koreana", country_code: "KR" });
    expect(input.data_request).toMatchObject({ include_tag_count: 20, include_reviews: true, include_release: true });
  });

  it("같은 응답으로 리뷰 요약·가격 캐시를 함께 채운다 (개별 appreviews·가격 호출 불필요)", async () => {
    await run(getStoreMetaBatch([7]));
    expect(fakeCache.get("reviewsummary:7")?.data).toMatchObject({ totalReviews: 1000, totalPositive: 900 });
    // 발굴 트랙은 보유·위시 게임을 읽지 않으므로 스토어 요약은 채우지 않는다 (캐시 절약)
    expect(fakeCache.has("storeitem:7:KR")).toBe(false);
    expect(fakeCache.get("app:7:price:KR")?.data).toMatchObject({ final: 1500000, discount_percent: 50 });
    expect(fakeLastKnown.has(7)).toBe(true);
  });

  it("유료 게임에 구매 옵션이 없거나 묶음 옵션이면 가격 캐시(last-known 포함)를 건드리지 않는다", async () => {
    const opt = item(1).best_purchase_option!;
    fetchMock.mockImplementation(async (input) => {
      const u = String(input);
      if (u.includes("GetStoreCategories")) return jsonResponse(CATEGORIES);
      return jsonResponse({ response: { store_items: [
        item(40, { best_purchase_option: undefined }),
        item(41, { best_purchase_option: { ...opt, included_game_count: 2 } }),
        item(42, { is_free: true, best_purchase_option: undefined }),
      ] } });
    });
    await run(getStoreMetaBatch([40, 41, 42]));
    expect(fakeLastKnown.has(40)).toBe(false);
    expect(fakeLastKnown.has(41)).toBe(false);
    // 묶음 전용은 "판매 불가"로도 쓰지 않는다 — 할인 중인 게임이 가격 없음으로 보이지 않게
    expect(fakeCache.has("app:41:price:KR")).toBe(false);
    // F2P는 "무료(null)"로 기록
    expect(fakeCache.get("app:42:price:KR")?.data).toBeNull();
    // 옵션 없는 유료 게임(출시 예정 등)은 신선도 키에만 판매 불가(null) — 위시 가격 단계가 다시 묻지 않게
    expect(fakeCache.get("app:40:price:KR")?.data).toBeNull();
  });

  it("카테고리 이름 조회가 실패하면 영속 저장하지 않는다 (\"카테고리 {id}\"가 7일 굳지 않게)", async () => {
    fetchMock.mockImplementation(async (input) => {
      const u = String(input);
      if (u.includes("GetStoreCategories")) return new Response("", { status: 500 });
      return jsonResponse({ response: { store_items: requestedIds(u).map(id => item(id)) } });
    });
    const out = await run(getStoreMetaBatch([50]));
    expect(out.get(50)?.categories?.[0]).toEqual({ id: 2, description: "카테고리 2" });
    expect(fakeStore.has(50)).toBe(false);
    expect(fakeCache.has("storemeta:50:KR")).toBe(true); // 이번 실행용으로는 LRU에 (짧게)
  });

  it("이름·헤더 이미지를 app_meta에도 저장한다 (도전과제 탭). 이름 없는 응답은 자리표시로 덮지 않게 뺀다", async () => {
    fetchMock.mockImplementation(async (input) => {
      const u = String(input);
      if (u.includes("GetStoreCategories")) return jsonResponse(CATEGORIES);
      return jsonResponse({ response: { store_items: [item(60), item(61, { name: undefined })] } });
    });
    await run(getStoreMetaBatch([60, 61]));
    expect(setAppMetaFromStoreBatch).toHaveBeenCalledWith([
      { appId: 60, name: "Game 60", headerImage: "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/60/header.jpg?t=1" },
    ]);
  });

  it("리뷰가 없는 앱은 \"리뷰 없음\"(null)으로 캐시돼 다시 조회하지 않는다", async () => {
    fetchMock.mockImplementation(async (input) => {
      const u = String(input);
      if (u.includes("GetStoreCategories")) return jsonResponse(CATEGORIES);
      return jsonResponse({ response: { store_items: [item(70, { reviews: undefined })] } });
    });
    await run(getStoreMetaBatch([70]));
    expect(fakeCache.has("reviewsummary:70")).toBe(true);
    expect(fakeCache.get("reviewsummary:70")?.data).toBeNull();
    fetchMock.mockClear();
    const out = await run(getReviewSummariesBatch([70]));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(out.get(70)).toBeNull();
  });

  it("LRU·영속 캐시에 있으면 GetItems를 부르지 않는다", async () => {
    fakeCache.set("storemeta:1:KR", { data: { name: "A" }, fetchedAt: Date.now(), isStale: false });
    fakeStore.set(2, { details: { name: "B" }, fetchedAt: Date.now() });
    const out = await run(getStoreMetaBatch([1, 2]));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(out.get(1)).toEqual({ name: "A" });
    expect(out.get(2)).toEqual({ name: "B" });
    // 영속 캐시에서 읽은 것은 LRU에도 채운다
    expect(fakeCache.has("storemeta:2:KR")).toBe(true);
    expect(getCachedStoreMetaIds([1, 2, 3])).toEqual(new Set([2]));
  });

  it("GetItems가 실패하면 만료된 이전 메타(LRU·SQLite 7일 초과)로 채우고 다시 캐시하지 않는다", async () => {
    fakeCache.set("storemeta:80:KR", { data: { name: "Old LRU" }, fetchedAt: 1, isStale: true });
    fakeStore.set(81, { details: { name: "Old DB" }, fetchedAt: 1 }); // 7일 훨씬 넘음
    fetchMock.mockImplementation(async (input) => {
      const u = String(input);
      if (u.includes("GetStoreCategories")) return jsonResponse(CATEGORIES);
      return new Response("", { status: 500 });
    });
    const out = await run(getStoreMetaBatch([80, 81, 82]));
    expect(out.get(80)).toEqual({ name: "Old LRU" });
    expect(out.get(81)).toEqual({ name: "Old DB" });
    expect(out.get(82)).toBeNull();
    expect(fakeCache.has("storemeta:80:KR")).toBe(false); // fallback 값은 재캐시하지 않음
    expect(fakeStore.get(81)?.fetchedAt).toBe(1);
  });

  it("카테고리 이름이 만료된 뒤 재조회가 실패하면 이전 이름을 다시 캐시해 계속 쓴다", async () => {
    fakeCache.set("store:categories:koreana", { data: { 2: "싱글 플레이어" }, fetchedAt: 1, isStale: true });
    fetchMock.mockImplementation(async (input) => {
      const u = String(input);
      if (u.includes("GetStoreCategories")) return new Response("", { status: 500 });
      return jsonResponse({ response: { store_items: requestedIds(u).map(id => item(id)) } });
    });
    const out = await run(getStoreMetaBatch([90]));
    expect(out.get(90)?.categories?.[0]).toEqual({ id: 2, description: "싱글 플레이어" });
    expect(fakeStore.has(90)).toBe(true); // 이름이 있으니 영속 저장
    expect(fakeCache.get("store:categories:koreana")?.isStale).toBe(false); // 다시 캐시됨
  });

  it("동시에 시작한 분석은 카테고리 이름 조회를 공유한다 (만료 후 장애 중에도 둘 다 이전 이름)", async () => {
    fakeCache.set("store:categories:koreana", { data: { 2: "싱글 플레이어" }, fetchedAt: 1, isStale: true });
    let labelCalls = 0;
    fetchMock.mockImplementation(async (input) => {
      const u = String(input);
      if (u.includes("GetStoreCategories")) { labelCalls++; return new Response("", { status: 500 }); }
      return jsonResponse({ response: { store_items: requestedIds(u).map(id => item(id)) } });
    });
    const [a, b] = await run(Promise.all([getStoreMetaBatch([91]), getStoreMetaBatch([92])]));
    expect(labelCalls).toBe(1);
    expect(a.get(91)?.categories?.[0]?.description).toBe("싱글 플레이어");
    expect(b.get(92)?.categories?.[0]?.description).toBe("싱글 플레이어");
    expect(fakeStore.has(91) && fakeStore.has(92)).toBe(true);
  });

  it("success!==1 앱은 null로 캐시(negative), 호출 실패 배치는 null이되 캐시하지 않는다", async () => {
    fetchMock.mockImplementation(async (input) => {
      const u = String(input);
      if (u.includes("GetStoreCategories")) return jsonResponse(CATEGORIES);
      const ids = requestedIds(u);
      if (ids.includes(5)) return new Response("", { status: 500 });
      return jsonResponse({ response: { store_items: [item(3, { success: 15 })] } });
    });
    const a = await run(getStoreMetaBatch([3, 4]));
    expect(a.get(3)).toBeNull();
    expect(fakeStore.get(3)?.details).toBeNull(); // negative 저장
    expect(a.get(4)).toBeNull(); // 응답에 없음
    expect(fakeStore.has(4)).toBe(false);
    const b = await run(getStoreMetaBatch([5]));
    expect(b.get(5)).toBeNull();
    expect(fakeStore.has(5)).toBe(false);
    expect(fakeCache.has("storemeta:5:KR")).toBe(false);
  });

  it("진행률 콜백: 캐시분 처리 후와 배치마다, 마지막은 loaded === total", async () => {
    fakeCache.set("storemeta:1:KR", { data: null, fetchedAt: Date.now(), isStale: false });
    const progress: number[] = [];
    await run(getStoreMetaBatch([1, 2, 3], (loaded, total) => { progress.push(loaded); expect(total).toBe(3); }));
    expect(progress).toEqual([1, 3]);
  });

  it("취소되면 남은 배치를 부르지 않는다", async () => {
    const ids = Array.from({ length: 250 }, (_, i) => 5000 + i);
    let getItemsCalls = 0;
    fetchMock.mockImplementation(async (input) => {
      const u = String(input);
      if (u.includes("GetStoreCategories")) return jsonResponse(CATEGORIES);
      getItemsCalls++;
      return jsonResponse({ response: { store_items: requestedIds(u).map(id => item(id)) } });
    });
    await run(getStoreMetaBatch(ids, undefined, () => getItemsCalls >= 1));
    expect(getItemsCalls).toBe(1);
  });
});

describe("getReviewSummariesBatch", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.useFakeTimers();
    fakeCache.clear();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("캐시된 요약은 그대로, 없는 것만 GetItems 배치 1회로 받는다", async () => {
    const cached = { reviewScore: 9, reviewScoreDesc: "", totalPositive: 1, totalNegative: 0, totalReviews: 1 };
    fakeCache.set("reviewsummary:1", { data: cached, fetchedAt: Date.now(), isStale: false });
    fetchMock.mockImplementation(async (input) =>
      jsonResponse({ response: { store_items: requestedIds(String(input)).map(id => item(id)) } }));
    const out = await run(getReviewSummariesBatch([1, 2, 3]));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestedIds(String(fetchMock.mock.calls[0][0]))).toEqual([2, 3]);
    expect(out.get(1)).toEqual(cached);
    expect(out.get(2)).toMatchObject({ totalReviews: 1000 });
    // 받은 요약은 캐시에도 들어간다
    expect(fakeCache.has("reviewsummary:3")).toBe(true);
  });

  it("조회 실패면 null (호출 측 중립 0.5)", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 500 }));
    const out = await run(getReviewSummariesBatch([9]));
    expect(out.get(9)).toBeNull();
  });
});

describe("getStoreItemPricesBatch (위시 가격, GetItems)", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.useFakeTimers();
    fakeCache.clear();
    fakeLastKnown.clear();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("fresh 가격 캐시는 그대로, 미스만 100개 단위 GetItems로 받고 가격·리뷰 캐시를 채운다", async () => {
    fakeCache.set("app:1:price:KR", { data: null, fetchedAt: 123, isStale: false });
    fetchMock.mockImplementation(async (input) =>
      jsonResponse({ response: { store_items: requestedIds(String(input)).map(id => item(id)) } }));
    const ids = [1, ...Array.from({ length: 120 }, (_, i) => 100 + i)];
    const out = await run(getStoreItemPricesBatch(ids));
    expect(fetchMock).toHaveBeenCalledTimes(2); // 120개 → 100 + 20
    expect(requestedIds(String(fetchMock.mock.calls[0][0]))).not.toContain(1);
    expect(out.get(1)).toEqual({ price: null, fetchedAt: 123 });
    expect(out.get(100)?.price).toMatchObject({ final: 1500000, discount_percent: 50 });
    expect(out.get(100)?.fallback).toBeUndefined();
    expect(fakeLastKnown.has(100)).toBe(true);
    expect(fakeCache.has("reviewsummary:219")).toBe(true);
  });

  it("구매 옵션 없는 유료 게임(출시 예정)·삭제 앱은 판매 불가(null)로 두되 last-known은 덮지 않는다", async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ response: { store_items: [
      item(10, { best_purchase_option: undefined, release: { is_coming_soon: true } }),
      item(12, { success: 15 }),
    ] } }));
    const out = await run(getStoreItemPricesBatch([10, 12]));
    for (const id of [10, 12]) {
      expect(out.get(id)?.price).toBeNull();
      expect(fakeLastKnown.has(id)).toBe(false);
    }
  });

  it("최저 옵션이 묶음 전용인 게임만 appdetails로 단품 가격을 보충한다", async () => {
    const opt = item(1).best_purchase_option!;
    const appdetailsPrice = {
      currency: "KRW", initial: 2000000, final: 1000000, discount_percent: 50,
      initial_formatted: "₩ 20,000", final_formatted: "₩ 10,000",
    };
    fetchMock.mockImplementation(async (input) => {
      const u = String(input);
      if (getItemsUrl(u)) {
        return jsonResponse({ response: { store_items: [
          item(11, { best_purchase_option: { ...opt, included_game_count: 4 } }),
          item(13),
        ] } });
      }
      if (u.includes("/api/appdetails")) {
        expect(u).toContain("appids=11&"); // 묶음 전용인 11만
        return jsonResponse({ 11: { success: true, data: { price_overview: appdetailsPrice } } });
      }
      return new Response("", { status: 404 });
    });
    const out = await run(getStoreItemPricesBatch([11, 13]));
    expect(out.get(11)?.price).toEqual(appdetailsPrice);
    expect(out.get(13)?.price).toMatchObject({ final: 1500000 });
    expect(fetchMock.mock.calls.filter(c => String(c[0]).includes("/api/appdetails"))).toHaveLength(1);
  });

  it("가격을 확정할 수 없는 응답인데 최근 실제 가격이 있으면 그 가격을 fallback으로 쓴다", async () => {
    const known = { price: { currency: "KRW", initial: 100, final: 100, discount_percent: 0, initial_formatted: "", final_formatted: "" }, fetchedAt: 5 };
    fakeLastKnown.set(10, known);
    fetchMock.mockImplementation(async () =>
      jsonResponse({ response: { store_items: [item(10, { best_purchase_option: undefined })] } }));
    const out = await run(getStoreItemPricesBatch([10]));
    expect(out.get(10)).toEqual({ ...known, fallback: true });
    expect(fakeLastKnown.get(10)).toBe(known); // 덮지 않음
  });

  it("호출이 실패하면 last-known으로 채우고(fallback), 없으면 미상", async () => {
    const known = { price: null, fetchedAt: 7 };
    fakeLastKnown.set(20, known);
    fetchMock.mockResolvedValue(new Response("", { status: 500 }));
    const out = await run(getStoreItemPricesBatch([20, 21]));
    expect(out.get(20)).toEqual({ ...known, fallback: true });
    expect(out.has(21)).toBe(false);
  });
});
