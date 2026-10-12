/**
 * 번들 차트 Steam 보강 단위 테스트 (작업 지시서 20261012_01 단계 1-2, 테스트 대상 L2).
 *
 *   - toGameRowPrice: 할인/무할인(initial_formatted 빈 문자열)·cents 보존.
 *   - getBundleGameRows: price/priceUnknown/무료 분기, 순서 보존, 미응답 appid.
 *   - expandSteamCollection: packagedetails apps[].id 파싱, 실패 [].
 *
 * price-batch.test.ts와 같은 패턴 — global fetch stub + fake timer(딜레이 건너뜀) + Map 기반 캐시 fake.
 * ITAD는 이 Wave 범위 아님.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

interface FakeEntry { data: unknown; fetchedAt: number; isStale: boolean }
const fakeCache = new Map<string, FakeEntry>();
const fakeLastKnown = new Map<number, { price: unknown; fetchedAt: number }>();

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
    lastKnownPriceGet: (appId: number) => fakeLastKnown.get(appId) ?? null,
    lastKnownPriceSet: (appId: number, snap: { price: unknown; fetchedAt: number }) => { fakeLastKnown.set(appId, snap); },
  };
});
vi.mock("@/lib/app-meta-cache", () => ({ setAppMeta: vi.fn(), setAppMetaBatch: vi.fn(), setAppMetaFromStoreBatch: vi.fn() }));
vi.mock("@/lib/app-details-store", () => ({ getAppDetailsFromStore: vi.fn(), setAppDetailsInStore: vi.fn() }));
vi.mock("@/lib/achievement-store", () => ({ getGlobalFromStore: vi.fn(), setGlobalInStore: vi.fn() }));
vi.mock("@/lib/store-meta-store", () => ({
  getStoreMetaFromStore: () => new Map(),
  getStoreMetaIdsInStore: () => new Set(),
  setStoreMetaInStore: vi.fn(),
}));

import {
  toGameRowPrice,
  getBundleGameRows,
  expandSteamCollection,
  resetAppDetailsBackoff,
  resetPriceRefreshInFlight,
} from "@/lib/steam/api";
import type { SteamPriceOverview, SteamStoreBrowseItem } from "@/lib/steam/types";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** 프로미스를 시작한 뒤 모든 타이머를 소진하고 결과를 기다린다. */
async function run<T>(p: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return p;
}

/** GetItems 응답 한 건을 조립한다. */
function storeItemsResponse(items: SteamStoreBrowseItem[]): Response {
  return jsonResponse({ response: { store_items: items } });
}

/** 가격 구매 옵션이 있는 store_item (단일 게임, 할인 포함). */
function pricedItem(opts: {
  appid: number;
  name?: string;
  final: string;
  original?: string;
  discountPct?: number;
  finalFmt?: string;
  originalFmt?: string;
  reviewCount?: number;
  percentPositive?: number;
  header?: boolean;
}): SteamStoreBrowseItem {
  const item: SteamStoreBrowseItem = {
    appid: opts.appid,
    success: 1,
    name: opts.name,
    best_purchase_option: {
      final_price_in_cents: opts.final,
      original_price_in_cents: opts.original,
      discount_pct: opts.discountPct,
      formatted_final_price: opts.finalFmt,
      formatted_original_price: opts.originalFmt,
    },
  };
  if (opts.header) {
    item.assets = { asset_url_format: "steam/apps/" + opts.appid + "/${FILENAME}", header: "header.jpg" };
  }
  if (opts.reviewCount !== undefined) {
    item.reviews = {
      summary_filtered: {
        review_count: opts.reviewCount,
        percent_positive: opts.percentPositive ?? 0,
        review_score: 8,
        review_score_label: "매우 긍정적",
      },
    };
  }
  return item;
}

describe("toGameRowPrice", () => {
  it("할인 가격을 그대로 매핑한다 (cents 보존)", () => {
    const p: SteamPriceOverview = {
      currency: "KRW",
      initial: 5490000,
      final: 2745000,
      discount_percent: 50,
      initial_formatted: "₩54,900",
      final_formatted: "₩27,450",
    };
    expect(toGameRowPrice(p)).toEqual({
      currency: "KRW",
      initial: 5490000,
      final: 2745000,
      discountPercent: 50,
      initialFormatted: "₩54,900",
      finalFormatted: "₩27,450",
    });
  });

  it("무할인이면 initial_formatted 빈 문자열 → final_formatted로 폴백", () => {
    const p: SteamPriceOverview = {
      currency: "KRW",
      initial: 3000000,
      final: 3000000,
      discount_percent: 0,
      initial_formatted: "",
      final_formatted: "₩30,000",
    };
    const row = toGameRowPrice(p);
    expect(row.initialFormatted).toBe("₩30,000");
    expect(row.finalFormatted).toBe("₩30,000");
    expect(row.initial).toBe(3000000);
    expect(row.discountPercent).toBe(0);
  });
});

describe("getBundleGameRows", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.useFakeTimers();
    fakeCache.clear();
    fakeLastKnown.clear();
    resetAppDetailsBackoff();
    resetPriceRefreshInFlight();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** GetItems URL인지, 그리고 그 input에 include_assets가 있는지(=행 fetch) 판별한다. */
  function parseGetItems(url: string): { ids: unknown[]; dataRequest: Record<string, unknown> } {
    const m = url.match(/input_json=([^&]+)/);
    const input = JSON.parse(decodeURIComponent(m![1]));
    return { ids: input.ids, dataRequest: input.data_request };
  }

  it("가격 있음/무료/미상 분기 + 순서 보존", async () => {
    // 100: 할인 가격 + 리뷰 + 헤더, 200: 무료(구매 옵션 없음), 300: 응답에 없음(미상).
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      const { dataRequest } = parseGetItems(url);
      // 행 fetch(include_assets)와 가격 fetch(include_reviews만) 모두 같은 store_items로 응답.
      void dataRequest;
      return storeItemsResponse([
        pricedItem({
          appid: 100,
          name: "Priced Game",
          final: "2745000",
          original: "5490000",
          discountPct: 50,
          finalFmt: "₩27,450",
          originalFmt: "₩54,900",
          reviewCount: 1000,
          percentPositive: 95,
          header: true,
        }),
        // 200: is_free + 구매 옵션 없음 → F2P → 가격 null(무료 확인).
        { appid: 200, success: 1, name: "Free Game", is_free: true },
        // 300은 응답에 없음.
      ]);
    });

    const rows = await run(getBundleGameRows([100, 200, 300]));

    // 순서 보존.
    expect(rows.map(r => r.appId)).toEqual([100, 200, 300]);

    // 100: 가격 있음.
    expect(rows[0].name).toBe("Priced Game");
    expect(rows[0].price).toEqual({
      currency: "KRW",
      initial: 5490000,
      final: 2745000,
      discountPercent: 50,
      initialFormatted: "₩54,900",
      finalFormatted: "₩27,450",
    });
    expect(rows[0].priceUnknown).toBeUndefined();
    expect(rows[0].review).toEqual({ positivePercent: 95, total: 1000, desc: "매우 긍정적" });
    expect(rows[0].headerImage).toMatch(/^https:\/\//);
    expect(rows[0].storeUrl).toBe("https://store.steampowered.com/app/100/");

    // 200: 무료/미판매 확인 (price null, priceUnknown false).
    expect(rows[1].price).toBeNull();
    expect(rows[1].priceUnknown).toBeUndefined();
    expect(rows[1].name).toBe("Free Game");

    // 300: 미응답 → 미상.
    expect(rows[2].price).toBeNull();
    expect(rows[2].priceUnknown).toBe(true);
    expect(rows[2].name).toBe("AppID 300");
    expect(rows[2].headerImage).toBe("");
    expect(rows[2].review).toBeNull();
  });

  it("중복 appid는 한 행으로 합친다", async () => {
    fetchMock.mockImplementation(async () =>
      storeItemsResponse([pricedItem({ appid: 100, name: "G", final: "1000", finalFmt: "₩10" })]),
    );
    const rows = await run(getBundleGameRows([100, 100]));
    expect(rows).toHaveLength(1);
    expect(rows[0].appId).toBe(100);
  });

  it("빈 입력이면 호출 없이 []", async () => {
    const rows = await run(getBundleGameRows([]));
    expect(rows).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("리뷰 0건이면 review=null", async () => {
    fetchMock.mockImplementation(async () =>
      storeItemsResponse([
        pricedItem({ appid: 100, name: "G", final: "1000", finalFmt: "₩10", reviewCount: 0 }),
      ]),
    );
    const rows = await run(getBundleGameRows([100]));
    expect(rows[0].review).toBeNull();
  });
});

describe("expandSteamCollection", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.useFakeTimers();
    fakeCache.clear();
    fakeLastKnown.clear();
    resetAppDetailsBackoff();
    resetPriceRefreshInFlight();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("package: packagedetails의 data.apps[].id를 전개한다", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ "12345": { success: true, data: { apps: [{ id: 10 }, { id: 20 }, { id: 30 }] } } }),
    );
    const out = await run(expandSteamCollection("package", 12345));
    expect(out).toEqual([10, 20, 30]);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("packagedetails?packageids=12345");
    expect(url).toContain("cc=KR");
  });

  it("package: 응답 실패/구조 없음 → []", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ "12345": { success: false } }));
    expect(await run(expandSteamCollection("package", 12345))).toEqual([]);
  });

  it("package: 네트워크 실패 → []", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 503 }));
    expect(await run(expandSteamCollection("package", 12345))).toEqual([]);
  });

  it("bundle: included_appids / included_items.included_apps[].appid 수집 (중복 제거)", async () => {
    fetchMock.mockResolvedValueOnce(
      storeItemsResponse([
        {
          success: 1,
          included_appids: [1, 2],
          included_items: { included_apps: [{ appid: 2 }, { appid: 3 }] },
        },
      ]),
    );
    const out = await run(expandSteamCollection("bundle", 777));
    expect(out.sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  it("bundle: 전개 필드 없으면 [] (V3b 미지원)", async () => {
    fetchMock.mockResolvedValueOnce(storeItemsResponse([{ success: 1 }]));
    expect(await run(expandSteamCollection("bundle", 777))).toEqual([]);
  });
});
