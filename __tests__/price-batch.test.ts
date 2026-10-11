/**
 * 가격 배치 조회 / getAppPriceSnapshot / store backoff 판정 단위 테스트.
 * (작업 지시서 20261010_01 §1-1, §1-7)
 *
 * - global fetch를 stub하고 fake timer로 1.5s 딜레이를 건너뛴다.
 * - 캐시는 stale 여부를 직접 제어할 수 있는 Map 기반 fake로 대체한다
 *   (실제 LRU는 allowStale이라 만료 항목도 반환한다 — 그 동작을 재현).
 * - DB 의존 모듈은 mock해 SQLite를 열지 않는다.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";

interface FakeEntry { data: unknown; fetchedAt: number; isStale: boolean }
const fakeCache = new Map<string, FakeEntry>();
const cacheSetTtl = new Map<string, number>();
// last-known 전용 캐시 fake (lib/cache.ts의 별도 LRU, 24h TTL — 만료 항목은 반환하지 않음).
const fakeLastKnown = new Map<number, { price: unknown; fetchedAt: number }>();

vi.mock("@/lib/cache", async () => {
  const actual = await vi.importActual<typeof import("@/lib/cache")>("@/lib/cache");
  return {
    CACHE_TTL: actual.CACHE_TTL,
    // lru-cache v11 allowStale 재현: stale 항목은 반환과 동시에 삭제된다.
    cacheGet: (key: string) => {
      const e = fakeCache.get(key);
      if (!e) return null;
      if (e.isStale) fakeCache.delete(key);
      return { ...e };
    },
    cacheSet: (key: string, data: unknown, ttl: number) => {
      fakeCache.set(key, { data, fetchedAt: Date.now(), isStale: false });
      cacheSetTtl.set(key, ttl);
    },
    cacheDelete: (key: string) => { fakeCache.delete(key); },
    cacheDeleteByPrefix: () => {},
    lastKnownPriceGet: (appId: number) => fakeLastKnown.get(appId) ?? null,
    lastKnownPriceSet: (appId: number, snap: { price: unknown; fetchedAt: number }) => { fakeLastKnown.set(appId, snap); },
  };
});
vi.mock("@/lib/app-meta-cache", () => ({ setAppMeta: vi.fn(), setAppMetaBatch: vi.fn() }));
vi.mock("@/lib/app-details-store", () => ({ getAppDetailsFromStore: vi.fn(), setAppDetailsInStore: vi.fn() }));
vi.mock("@/lib/achievement-store", () => ({ getGlobalFromStore: vi.fn(), setGlobalInStore: vi.fn() }));

import {
  getAppPricesBatch,
  getAppPriceSnapshot,
  resetPriceRefreshInFlight,
  isStoreRateLimited,
  resetAppDetailsBackoff,
  getAppDetailsBackoffMs,
} from "@/lib/steam/api";
import type { SteamPriceOverview } from "@/lib/steam/types";

const FIXTURE_DIR = path.join(__dirname, "fixtures", "steam-stage0");
const multi5 = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, "v1_multi5.json"), "utf8"));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

const witcher: SteamPriceOverview = multi5["292030"].data.price_overview;

/** 가격만 꺼내는 테스트 헬퍼 (구 getAppPrice는 제거됨 — /code-review 2차 R7). */
const getAppPrice = async (appId: number) => (await getAppPriceSnapshot(appId))?.price ?? null;

/** 프로미스를 시작한 뒤 모든 타이머를 소진하고 결과를 기다린다. */
async function run<T>(p: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return p;
}

describe("getAppPricesBatch", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.useFakeTimers();
    fakeCache.clear();
    fakeLastKnown.clear();
    cacheSetTtl.clear();
    resetAppDetailsBackoff();
    resetPriceRefreshInFlight();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("다중 appid 응답을 파싱한다: 가격 / 무료(data: []) → null / success=false → 판매 불가(null, 짧은 TTL)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...multi5, "1": { success: false } }));
    const out = await run(getAppPricesBatch([292030, 570, 1]));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("appids=292030,570,1");
    expect(url).toContain("filters=price_overview");
    expect(url).toContain("cc=KR");

    expect(out.get(292030)?.price).toEqual(witcher);
    expect(out.get(570)?.price).toBeNull();
    // success=false(삭제·지역제한)는 매번 같은 답 — 미상으로 두면 커버리지를 영구히 깎으므로
    // null로 집계하고 짧은 TTL로 캐시한다
    expect(out.get(1)?.price).toBeNull();
    expect(cacheSetTtl.get("app:1:price:KR")).toBe(10 * 60 * 1000);
    expect(cacheSetTtl.get("app:292030:price:KR")).toBe(60 * 60 * 1000);
    // 성공분은 가격 캐시에 기록
    expect(fakeCache.get("app:292030:price:KR")?.data).toEqual(witcher);
    expect(fakeCache.has("app:570:price:KR")).toBe(true);
  });

  it("응답에 appid가 없으면 미상(Map 누락), 캐시하지 않는다", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ "292030": multi5["292030"] }));
    const out = await run(getAppPricesBatch([292030, 999]));
    expect(out.has(999)).toBe(false);
    expect(fakeCache.has("app:999:price:KR")).toBe(false);
  });

  it("fetch 실패(429)는 미캐시 + Map 누락, backoff 상승", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 429 }));
    const out = await run(getAppPricesBatch([292030]));
    expect(out.size).toBe(0);
    expect(fakeCache.size).toBe(0);
    expect(getAppDetailsBackoffMs()).toBeGreaterThan(0);
  });

  it("fresh 캐시 히트는 호출에서 제외한다", async () => {
    fakeCache.set("app:292030:price:KR", { data: witcher, fetchedAt: 1000, isStale: false });
    fetchMock.mockResolvedValueOnce(jsonResponse({ "570": multi5["570"] }));
    const out = await run(getAppPricesBatch([292030, 570]));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("appids=570&");
    expect(out.get(292030)).toEqual({ price: witcher, fetchedAt: 1000 });
  });

  it("전부 fresh 히트면 fetch를 호출하지 않는다", async () => {
    fakeCache.set("app:292030:price:KR", { data: witcher, fetchedAt: 1000, isStale: false });
    const out = await run(getAppPricesBatch([292030]));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(out.size).toBe(1);
  });

  it("stale 캐시는 미스로 취급해 재조회한다 (C1)", async () => {
    const old: SteamPriceOverview = { ...witcher, final: 1, final_formatted: "OLD" };
    fakeCache.set("app:292030:price:KR", { data: old, fetchedAt: 1000, isStale: true });
    fetchMock.mockResolvedValueOnce(jsonResponse({ "292030": multi5["292030"] }));
    const out = await run(getAppPricesBatch([292030]));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.get(292030)?.price).toEqual(witcher);
  });

  it("재조회 실패 시 stale 값을 원래 fetchedAt으로 fallback한다 (24시간 이내만)", async () => {
    const old: SteamPriceOverview = { ...witcher, final_formatted: "OLD" };
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
    fakeCache.set("app:292030:price:KR", { data: old, fetchedAt: twoHoursAgo, isStale: true });
    fakeCache.set("app:413150:price:KR", { data: old, fetchedAt: twoDaysAgo, isStale: true });
    fetchMock.mockResolvedValueOnce(new Response("", { status: 429 }));
    const out = await run(getAppPricesBatch([292030, 413150]));
    expect(out.get(292030)).toEqual({ price: old, fetchedAt: twoHoursAgo, fallback: true });
    // 너무 오래된 가격은 끝난 할인을 보여줄 위험 → 미상
    expect(out.has(413150)).toBe(false);
  });

  it("PRICE_BATCH_SIZE(100) 단위로 나눠 조회하고, 중복 appid는 한 번만", async () => {
    const ids = Array.from({ length: 150 }, (_, i) => 10_000 + i);
    fetchMock.mockImplementation(async () => jsonResponse({}));
    await run(getAppPricesBatch([...ids, ids[0]]));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = String(fetchMock.mock.calls[0][0]).match(/appids=([^&]+)/)![1].split(",");
    const second = String(fetchMock.mock.calls[1][0]).match(/appids=([^&]+)/)![1].split(",");
    expect(first).toHaveLength(100);
    expect(second).toHaveLength(50);
  });

  it("취소되면 남은 배치를 조회하지 않는다", async () => {
    const ids = Array.from({ length: 150 }, (_, i) => 10_000 + i);
    let calls = 0;
    fetchMock.mockImplementation(async () => { calls++; return jsonResponse({}); });
    await run(getAppPricesBatch(ids, undefined, () => calls >= 1));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("getAppPrice", () => {
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

  it("fresh 캐시는 그대로 반환 (호출 없음)", async () => {
    fakeCache.set("app:292030:price:KR", { data: witcher, fetchedAt: 1, isStale: false });
    expect(await run(getAppPrice(292030))).toEqual(witcher);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stale 캐시면 stale을 즉시 반환하고 백그라운드에서 재조회한다 (기존 결함 수정)", async () => {
    const old: SteamPriceOverview = { ...witcher, final_formatted: "OLD" };
    fakeCache.set("app:292030:price:KR", { data: old, fetchedAt: Date.now() - 2 * 60 * 60 * 1000, isStale: true });
    fetchMock.mockResolvedValueOnce(jsonResponse({ "292030": multi5["292030"] }));
    // 타이머(딜레이)를 돌리기 전에 이미 응답이 나온다 — 사용자 응답이 딜레이에 묶이지 않음
    expect(await getAppPrice(292030)).toEqual(old);
    await vi.runAllTimersAsync();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // 백그라운드 재조회가 캐시를 새 가격으로 채웠다
    expect(fakeCache.get("app:292030:price:KR")?.data).toEqual(witcher);
    expect(await getAppPrice(292030)).toEqual(witcher);
  });

  it("재조회 실패 시 stale 값을 반환한다 (첫 읽기에서 보관, N2)", async () => {
    const old: SteamPriceOverview = { ...witcher, final_formatted: "OLD" };
    fakeCache.set("app:292030:price:KR", { data: old, fetchedAt: Date.now() - 2 * 60 * 60 * 1000, isStale: true });
    fetchMock.mockResolvedValueOnce(new Response("", { status: 503 }));
    expect(await run(getAppPrice(292030))).toEqual(old);
  });

  it("stale 값이 24시간을 넘었으면 fallback으로 쓰지 않는다 — 끝난 할인 방지 (/code-review 3차 #3)", async () => {
    const old: SteamPriceOverview = { ...witcher, final_formatted: "OLD" };
    fakeCache.set("app:292030:price:KR", { data: old, fetchedAt: Date.now() - 3 * 24 * 60 * 60 * 1000, isStale: true });
    fetchMock.mockResolvedValueOnce(new Response("", { status: 503 }));
    // 즉시 반환하지 않고 재조회를 기다린 뒤, 실패했으므로 미상
    expect(await run(getAppPrice(292030))).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("미스 + 재조회 실패면 null", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 503 }));
    expect(await run(getAppPrice(292030))).toBeNull();
  });
});

describe("last-known 가격 / 대화형 조회 (작업 지시서 20261010_02)", () => {
  const fetchMock = vi.fn<typeof fetch>();
  const DAY = 24 * 60 * 60 * 1000;

  beforeEach(() => {
    vi.useFakeTimers();
    fakeCache.clear();
    fakeLastKnown.clear();
    cacheSetTtl.clear();
    resetAppDetailsBackoff();
    resetPriceRefreshInFlight();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("가격을 받으면 last-known(24h)에도 원래 시각과 함께 기록한다", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ "292030": multi5["292030"] }));
    const out = await run(getAppPricesBatch([292030]));
    const last = fakeLastKnown.get(292030)!;
    expect(last.price).toEqual(witcher);
    expect(last.fetchedAt).toBe(out.get(292030)!.fetchedAt);
    // 메인 LRU에는 1h 신선도 키만 — last-known은 전용 캐시 (/code-review 2차 R2)
    expect(fakeCache.has("app:292030:price:last:KR")).toBe(false);
  });

  it("재조회가 연속으로 실패해도 매번 last-known으로 채운다 (#2 회귀)", async () => {
    const at = Date.now() - 3 * 60 * 60 * 1000;
    fakeLastKnown.set(292030, { price: witcher, fetchedAt: at });
    fetchMock.mockResolvedValue(new Response("", { status: 429 }));
    const first = await run(getAppPricesBatch([292030]));
    const second = await run(getAppPricesBatch([292030]));
    // fallback=true: 표시용(회색)이며 위시 가격 커버리지에는 세지 않는다
    expect(first.get(292030)).toEqual({ price: witcher, fetchedAt: at, fallback: true });
    expect(second.get(292030)).toEqual({ price: witcher, fetchedAt: at, fallback: true });
  });

  it("last-known이 만료(24h 초과)되면 미상", async () => {
    // 전용 LRU는 24h가 지난 항목을 반환하지 않는다 — 즉 fake에 없음과 같다
    fakeLastKnown.clear();
    fetchMock.mockResolvedValue(new Response("", { status: 503 }));
    const out = await run(getAppPricesBatch([292030]));
    expect(out.has(292030)).toBe(false);
  });

  it("getAppPrice: 백그라운드 재조회가 실패해도 두 번째 호출이 last-known을 즉시 반환 (#1 회귀)", async () => {
    const at = Date.now() - 2 * 60 * 60 * 1000;
    fakeCache.set("app:292030:price:KR", { data: witcher, fetchedAt: at, isStale: true });
    fakeLastKnown.set(292030, { price: witcher, fetchedAt: at });
    fetchMock.mockResolvedValue(new Response("", { status: 503 }));
    expect(await getAppPrice(292030)).toEqual(witcher);
    await vi.runAllTimersAsync();
    // 가격 키는 첫 get에서 삭제됐고 재조회도 실패 — 그래도 타이머 없이 즉시 값이 나온다
    expect(await getAppPriceSnapshot(292030)).toEqual({ price: witcher, fetchedAt: at, fallback: true });
  });

  it("같은 게임 동시 요청은 store 호출 1회로 합쳐진다 (#6)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ "292030": multi5["292030"] }));
    const all = await run(Promise.all([getAppPrice(292030), getAppPrice(292030), getAppPrice(292030)]));
    expect(all).toEqual([witcher, witcher, witcher]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("대화형 미스 경로는 base delay(1.5s) 없이 응답한다 (#5)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ "292030": multi5["292030"] }));
    // 타이머를 돌리지 않아도 해결된다 = 딜레이를 기다리지 않음 (backoff 0)
    expect(await getAppPrice(292030)).toEqual(witcher);
  });

  it("backoff 중 미스면 기다리지 않고 info 캐시 가격(24h 이내)을 그 시각과 함께 반환 (#5)", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 429 }));
    await run(getAppPricesBatch([1])); // backoff 상승
    expect(getAppDetailsBackoffMs()).toBeGreaterThan(0);
    const infoAt = Date.now() - 3 * 60 * 60 * 1000;
    fakeCache.set("app:292030:info:KR", { data: { price_overview: witcher }, fetchedAt: infoAt, isStale: false });
    fetchMock.mockResolvedValue(jsonResponse({ "292030": multi5["292030"] }));
    expect(await getAppPriceSnapshot(292030)).toEqual({ price: witcher, fetchedAt: infoAt, fallback: true });
  });

  it("backoff 중 info 가격이 24시간을 넘었으면 내보내지 않고 미상(null) — 끝난 할인 방지 (리뷰 M1)", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 429 }));
    await run(getAppPricesBatch([1]));
    fakeCache.set("app:292030:info:KR", { data: { price_overview: witcher }, fetchedAt: Date.now() - 3 * DAY, isStale: false });
    fetchMock.mockResolvedValue(jsonResponse({ "292030": multi5["292030"] }));
    expect(await getAppPriceSnapshot(292030)).toBeNull();
  });

  it("success=false가 와도 실제 last-known 가격을 null로 덮지 않고 그 가격으로 fallback (/code-review 3차 #2)", async () => {
    const at = Date.now() - 3 * 60 * 60 * 1000;
    fakeLastKnown.set(292030, { price: witcher, fetchedAt: at });
    fetchMock.mockResolvedValueOnce(jsonResponse({ "292030": { success: false } }));
    const out = await run(getAppPricesBatch([292030]));
    expect(fakeLastKnown.get(292030)).toEqual({ price: witcher, fetchedAt: at });
    // 확인된 가격이 아니므로 fallback=true (커버리지 미포함)
    expect(out.get(292030)).toEqual({ price: witcher, fetchedAt: at, fallback: true });
    // 신선도 키도 null로 굳히지 않는다 — 다음 조회에서 다시 확인
    expect(fakeCache.has("app:292030:price:KR")).toBe(false);
  });

  it("success=false + last-known 없음 → 판매 불가(null, 짧은 TTL), last-known은 기록하지 않음", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ "1": { success: false } }));
    const out = await run(getAppPricesBatch([1]));
    expect(out.get(1)?.price).toBeNull();
    expect(out.get(1)?.fallback).toBeUndefined();
    expect(cacheSetTtl.get("app:1:price:KR")).toBe(10 * 60 * 1000);
    expect(fakeLastKnown.has(1)).toBe(false);
  });

  it("success=false + last-known도 판매 불가(null)면 판매 불가로 확정", async () => {
    fakeLastKnown.set(1, { price: null, fetchedAt: Date.now() - 60_000 });
    fetchMock.mockResolvedValueOnce(jsonResponse({ "1": { success: false } }));
    const out = await run(getAppPricesBatch([1]));
    expect(out.get(1)).toEqual({ price: null, fetchedAt: expect.any(Number) });
  });
});

describe("store backoff 시간 기반 초기화 (/code-review 3차 #1)", () => {
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

  it("429 후 5분 동안 429가 없으면 backoff가 0으로 돌아간다 (성공 응답 없이도)", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 429 }));
    await run(getAppPricesBatch([1]));
    expect(getAppDetailsBackoffMs()).toBeGreaterThan(0);
    vi.setSystemTime(Date.now() + 4 * 60 * 1000);
    expect(getAppDetailsBackoffMs()).toBeGreaterThan(0);
    vi.setSystemTime(Date.now() + 60 * 1000 + 1);
    expect(getAppDetailsBackoffMs()).toBe(0);
  });

  it("초기화 뒤 게임 페이지 미스는 대기 경로(재조회 대기)로 돌아간다", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 429 }));
    await run(getAppPricesBatch([1]));
    vi.setSystemTime(Date.now() + 6 * 60 * 1000);
    fetchMock.mockResolvedValueOnce(jsonResponse({ "292030": multi5["292030"] }));
    // backoff 중이면 info 가격이 없어 null이 나왔을 경로 — 이제는 재조회를 기다려 실제 가격
    expect(await run(getAppPrice(292030))).toEqual(witcher);
  });

  it("오래된 backoff 위에 새 429가 오면 누적하지 않고 처음부터 올린다", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 429 }));
    for (let i = 0; i < 6; i++) await run(getAppPricesBatch([1 + i]));
    expect(getAppDetailsBackoffMs()).toBe(30_000);
    vi.setSystemTime(Date.now() + 6 * 60 * 1000);
    await run(getAppPricesBatch([99]));
    expect(getAppDetailsBackoffMs()).toBe(5_000);
  });
});

describe("isStoreRateLimited", () => {
  it("store 비공식 엔드포인트는 true", () => {
    expect(isStoreRateLimited("https://store.steampowered.com/api/appdetails?appids=1&cc=KR")).toBe(true);
    expect(isStoreRateLimited("https://store.steampowered.com/api/appdetails?appids=1,2&filters=price_overview")).toBe(true);
    expect(isStoreRateLimited("https://store.steampowered.com/search/results/?specials=1&json=1")).toBe(true);
    expect(isStoreRateLimited("https://store.steampowered.com/api/featuredcategories?cc=KR")).toBe(true);
  });

  it("appreviews·storesearch와 공식 API는 false", () => {
    expect(isStoreRateLimited("https://store.steampowered.com/appreviews/570?json=1")).toBe(false);
    // storesearch는 타이핑마다 딜레이 없이 호출되어 공유 backoff에서 제외
    expect(isStoreRateLimited("https://store.steampowered.com/api/storesearch/?term=x&cc=KR")).toBe(false);
    expect(isStoreRateLimited("https://api.steampowered.com/IWishlistService/GetWishlist/v1/?key=x")).toBe(false);
  });
});
