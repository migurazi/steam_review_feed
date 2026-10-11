/**
 * 발굴 트랙 API 계층 단위 테스트: getStoreSpecials / getStoreItemsBatch.
 * (작업 지시서 20261010_01 단계 2-2, 2-7, 부록 B 설계 확정 3·4)
 *
 * price-batch.test.ts와 같은 방식 — global fetch stub + fake timer + Map 기반 fake 캐시.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";

interface FakeEntry { data: unknown; fetchedAt: number; isStale: boolean }
const fakeCache = new Map<string, FakeEntry>();

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
    lastKnownPriceGet: () => null,
    lastKnownPriceSet: () => {},
  };
});
vi.mock("@/lib/app-meta-cache", () => ({ setAppMeta: vi.fn(), setAppMetaBatch: vi.fn() }));
vi.mock("@/lib/app-details-store", () => ({ getAppDetailsFromStore: vi.fn(), setAppDetailsInStore: vi.fn() }));
vi.mock("@/lib/achievement-store", () => ({ getGlobalFromStore: vi.fn(), setGlobalInStore: vi.fn() }));

import {
  getStoreSpecials,
  getStoreItemsBatch,
  resetAppDetailsBackoff,
  getAppDetailsBackoffMs,
} from "@/lib/steam/api";
import { parseSearchResultAppIds } from "@/lib/steam/deals";

const FIXTURE_DIR = path.join(__dirname, "fixtures", "steam-stage0");
const readJson = (name: string) => JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), "utf8"));
const searchP0 = readJson("v4_reviews_p0.json");
const searchP50 = readJson("v4_reviews_p50.json");
const featured = readJson("v3b_featuredcategories.json");
const getItems = readJson("v2_getitems_nokey.json");

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function run<T>(p: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return p;
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.useFakeTimers();
  fakeCache.clear();
  resetAppDetailsBackoff();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("getStoreSpecials", () => {
  const p0Ids = parseSearchResultAppIds(searchP0.results_html);
  const p50Ids = parseSearchResultAppIds(searchP50.results_html);

  it("리뷰순·게임만·KR로 페이지를 순회하고 maxItems에서 멈춘 뒤 캐시한다", async () => {
    // 픽스처는 50행 페이지라 page size(100)보다 적지만 total_count가 커서 다음 페이지로 진행한다.
    fetchMock
      .mockResolvedValueOnce(jsonResponse(searchP0))
      .mockResolvedValueOnce(jsonResponse(searchP50));
    const max = p0Ids.length + 5;
    const out = await run(getStoreSpecials(max));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const url0 = String(fetchMock.mock.calls[0][0]);
    expect(url0).toContain("/search/results/");
    expect(url0).toContain("specials=1");
    expect(url0).toContain("sort_by=Reviews_DESC");
    expect(url0).toContain("category1=998");
    expect(url0).toContain("cc=KR");
    expect(url0).toContain("start=0");
    expect(String(fetchMock.mock.calls[1][0])).toContain("start=100");

    expect(out).not.toBeNull();
    expect(out!.degraded).toBe(false);
    expect(out!.ids.length).toBe(max);
    expect(out!.ids.slice(0, p0Ids.length)).toEqual(p0Ids);
    expect(out!.ids).not.toContain(4780); // 패키지 전용 appid 제외
    expect(fakeCache.get("store:specials:KR")?.data).toEqual(out!.ids);
  });

  it("fresh 캐시 히트면 호출 없이 반환", async () => {
    fakeCache.set("store:specials:KR", { data: [1, 2, 3], fetchedAt: 0, isStale: false });
    const out = await run(getStoreSpecials(2));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(out).toEqual({ ids: [1, 2], degraded: false });
  });

  it("stale 캐시는 미스로 취급해 재조회한다", async () => {
    fakeCache.set("store:specials:KR", { data: [1, 2, 3], fetchedAt: 0, isStale: false });
    fakeCache.get("store:specials:KR")!.isStale = true;
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...searchP0, total_count: 10 }));
    const out = await run(getStoreSpecials(150));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ ids: p0Ids, degraded: false });
  });

  it("결과 끝(total_count)에 도달하면 완료로 보고 캐시한다", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...searchP0, total_count: 50 }));
    const out = await run(getStoreSpecials(150));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ ids: p0Ids, degraded: false });
    expect(fakeCache.has("store:specials:KR")).toBe(true);
  });

  it("첫 페이지 실패 → featuredcategories fallback (할인 중인 앱만), 캐시하지 않음", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("", { status: 429 }))
      .mockResolvedValueOnce(jsonResponse(featured));
    const out = await run(getStoreSpecials(150));
    expect(String(fetchMock.mock.calls[1][0])).toContain("/api/featuredcategories");
    const expected = (featured.specials.items as { id: number; type: number; discount_percent: number }[])
      .filter(it => it.type === 0 && it.discount_percent > 0)
      .map(it => it.id);
    // fallback은 약 10개뿐이라 degraded
    expect(out).toEqual({ ids: Array.from(new Set(expected)), degraded: true });
    expect(fakeCache.has("store:specials:KR")).toBe(false);
    // 검색의 429는 store 공유 backoff를 올린다 (isStoreRateLimited)
    expect(getAppDetailsBackoffMs()).toBeGreaterThan(0);
  });

  it("첫 페이지가 success인데 total_count>0이고 0행 파싱이면(마크업 변경) fallback, 빈 목록은 캐시 안 함 (리뷰 M1)", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ success: 1, results_html: "<div>changed</div>", total_count: 3593, start: 0 }))
      .mockResolvedValueOnce(jsonResponse(featured));
    const out = await run(getStoreSpecials(150));
    expect(String(fetchMock.mock.calls[1][0])).toContain("/api/featuredcategories");
    expect(out!.degraded).toBe(true);
    expect(fakeCache.has("store:specials:KR")).toBe(false);
  });

  it("정상적으로 결과가 0건(total_count=0)이면 빈 목록, 캐시하지 않음", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: 1, results_html: "", total_count: 0, start: 0 }));
    const out = await run(getStoreSpecials(150));
    expect(out).toEqual({ ids: [], degraded: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fakeCache.has("store:specials:KR")).toBe(false);
  });

  it("후속 페이지가 결과가 남았는데(start < total_count) 0행이면 끝이 아니다 — degraded, 캐시 안 함 (/code-review #4)", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(searchP0)) // total_count 3593
      .mockResolvedValueOnce(jsonResponse({ success: 1, results_html: "", total_count: 3593, start: 100 }));
    const out = await run(getStoreSpecials(150));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out).toEqual({ ids: p0Ids, degraded: true });
    expect(fakeCache.has("store:specials:KR")).toBe(false);
  });

  it("패키지·번들 행만 있는 페이지는 이상이 아니다 — 다음 페이지로 진행 (/code-review 3차 #7)", async () => {
    const pkgOnly = '<a href="x" data-ds-packageid="460" data-ds-appid="4700,4780">pkg</a>'
      + '<a href="y" data-ds-bundleid="9" data-ds-appid="10">bundle</a>';
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ success: 1, results_html: pkgOnly, total_count: 3593, start: 0 }))
      .mockResolvedValueOnce(jsonResponse({ ...searchP0, start: 100 }))
      .mockResolvedValueOnce(jsonResponse({ success: 1, results_html: "", total_count: 3593, start: 200 }));
    const out = await run(getStoreSpecials(150));
    // featured fallback으로 빠지지 않고 두 번째 검색 페이지를 조회했다
    expect(String(fetchMock.mock.calls[1][0])).toContain("start=100");
    expect(String(fetchMock.mock.calls[1][0])).not.toContain("featuredcategories");
    expect(out!.ids).toEqual(p0Ids);
  });

  it("total_count 이후 페이지의 0행은 정상 끝", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ ...searchP0, total_count: 150 }))
      .mockResolvedValueOnce(jsonResponse({ success: 1, results_html: "", total_count: 100, start: 100 }));
    const out = await run(getStoreSpecials(150));
    expect(out).toEqual({ ids: p0Ids, degraded: false });
    expect(fakeCache.has("store:specials:KR")).toBe(true);
  });

  it("total_count가 없거나 숫자가 아니면 첫 페이지를 끝으로 보지 않는다 (/code-review 2차 R6)", async () => {
    const { total_count: _omit, ...noTotal } = searchP0;
    void _omit;
    fetchMock
      .mockResolvedValueOnce(jsonResponse(noTotal))
      .mockResolvedValueOnce(jsonResponse({ ...searchP50, total_count: "3593" }));
    const out = await run(getStoreSpecials(p0Ids.length + 5));
    expect(fetchMock).toHaveBeenCalledTimes(2); // 2페이지까지 진행
    expect(out).toEqual({ ids: expect.any(Array), degraded: false }); // maxItems를 채워 완료
    expect(out!.ids).toHaveLength(p0Ids.length + 5);
  });

  it("total_count 미상 + 후속 페이지 0행이면 degraded·미캐시", async () => {
    const { total_count: _omit, ...noTotal } = searchP0;
    void _omit;
    fetchMock
      .mockResolvedValueOnce(jsonResponse(noTotal))
      .mockResolvedValueOnce(jsonResponse({ success: 1, results_html: "", start: 100 }));
    const out = await run(getStoreSpecials(150));
    expect(out).toEqual({ ids: p0Ids, degraded: true });
    expect(fakeCache.has("store:specials:KR")).toBe(false);
  });

  it("두 소스 모두 실패하면 null", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("", { status: 500 }))
      .mockResolvedValueOnce(new Response("", { status: 500 }));
    expect(await run(getStoreSpecials(150))).toBeNull();
  });

  it("2페이지 실패면 첫 페이지 결과로 진행하되 캐시하지 않는다", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(searchP0))
      .mockResolvedValueOnce(new Response("", { status: 500 }));
    const out = await run(getStoreSpecials(150));
    expect(out).toEqual({ ids: p0Ids, degraded: true });
    expect(fakeCache.has("store:specials:KR")).toBe(false);
  });

  it("shouldStop이면 호출하지 않고 빈 배열(실패 아님), 중간 중단 결과는 캐시하지 않는다", async () => {
    expect(await run(getStoreSpecials(150, () => true))).toEqual({ ids: [], degraded: true });
    expect(fetchMock).not.toHaveBeenCalled();

    let calls = 0;
    fetchMock.mockImplementation(async () => { calls++; return jsonResponse(searchP0); });
    const out = await run(getStoreSpecials(150, () => calls >= 1));
    expect(calls).toBe(1);
    expect(out).toEqual({ ids: p0Ids, degraded: true });
    expect(fakeCache.has("store:specials:KR")).toBe(false);
    expect(p50Ids.length).toBeGreaterThan(0);
  });
});

describe("getStoreItemsBatch", () => {
  it("GetItems를 KR 컨텍스트·리뷰 포함으로 호출하고 정규화·캐시한다", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(getItems));
    const out = await run(getStoreItemsBatch([292030, 105600, 570]));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("api.steampowered.com/IStoreBrowseService/GetItems/v1/");
    expect(url).not.toContain("key=");
    const input = JSON.parse(decodeURIComponent(url.split("input_json=")[1]));
    expect(input.context.country_code).toBe("KR");
    expect(input.data_request.include_reviews).toBe(true);
    expect(input.ids).toEqual([{ appid: 292030 }, { appid: 105600 }, { appid: 570 }]);

    expect(out.get(105600)?.price?.discount_percent).toBe(50);
    expect(out.get(105600)?.review?.totalReviews).toBe(1244628);
    expect(out.get(570)?.price).toBeNull();
    expect(fakeCache.has("storeitem:105600:KR")).toBe(true);
    // GetItems는 공식 API 호스트 — store backoff에 영향 없음
    expect(getAppDetailsBackoffMs()).toBe(0);
  });

  it("fresh 캐시 히트는 호출에서 제외하고, 요청하지 않은 appid는 무시한다", async () => {
    const cached = { appid: 1, price: null, review: null, categoryIds: [], isFree: true, fetchedAt: 1 };
    fakeCache.set("storeitem:1:KR", { data: cached, fetchedAt: 1, isStale: false });
    fetchMock.mockResolvedValueOnce(jsonResponse(getItems)); // 292030·105600·570 응답
    const out = await run(getStoreItemsBatch([1, 105600]));
    const input = JSON.parse(decodeURIComponent(String(fetchMock.mock.calls[0][0]).split("input_json=")[1]));
    expect(input.ids).toEqual([{ appid: 105600 }]);
    expect(out.get(1)).toEqual(cached);
    expect(out.has(105600)).toBe(true);
    expect(out.has(292030)).toBe(false); // 요청 안 한 appid
    expect(fakeCache.has("storeitem:292030:KR")).toBe(false);
  });

  it("조회 실패는 미캐시 + 누락, 100개 단위 분할, shouldStop이면 남은 배치 중단", async () => {
    const ids = Array.from({ length: 150 }, (_, i) => i + 1);
    fetchMock.mockResolvedValue(new Response("", { status: 500 }));
    const out = await run(getStoreItemsBatch(ids));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out.size).toBe(0);
    expect(fakeCache.size).toBe(0);

    fetchMock.mockClear();
    let n = 0;
    fetchMock.mockImplementation(async () => { n++; return jsonResponse({ response: { store_items: [] } }); });
    await run(getStoreItemsBatch(ids, undefined, () => n >= 1));
    expect(n).toBe(1);
  });
});
