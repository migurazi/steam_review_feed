/**
 * lib/fx.ts(getKrwRates) 단위 테스트.
 *
 *   - 성공: open.er-api.com(base USD) 응답을 "통화 1단위당 KRW" 맵으로 변환(USD/EUR 계산).
 *   - 실패: result !== "success" / HTTP 오류 / 비JSON → null + console.warn.
 *   - 캐시: 2번째 호출은 fetch를 다시 하지 않는다.
 *
 * 캐시는 Map 기반 fake, 실호출은 global fetch stub로 흉내 낸다.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

interface FakeEntry { data: unknown; fetchedAt: number; isStale: boolean }
const fakeCache = new Map<string, FakeEntry>();

vi.mock("@/lib/cache", () => ({
  cacheGet: (key: string) => {
    const e = fakeCache.get(key);
    if (!e) return null;
    return { ...e };
  },
  cacheSet: (key: string, data: unknown) => {
    fakeCache.set(key, { data, fetchedAt: Date.now(), isStale: false });
  },
}));

import { getKrwRates } from "@/lib/fx";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

const fetchMock = vi.fn<typeof fetch>();
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fakeCache.clear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  warnSpy.mockRestore();
});

describe("getKrwRates — 성공 변환", () => {
  it("USD/EUR를 통화 1단위당 KRW로 변환하고 KRW=1을 둔다", async () => {
    // base USD: rates.KRW=1340.7(USD 1단위당 KRW), rates.EUR=0.9(USD 1단위당 EUR).
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ result: "success", rates: { USD: 1, EUR: 0.9, KRW: 1340.7, GBP: 0.8 } })
    );
    const rates = await getKrwRates();
    expect(rates).not.toBeNull();
    // USD: 1340.7 / 1
    expect(rates!.USD).toBeCloseTo(1340.7, 4);
    // EUR: 1340.7 / 0.9 = 1489.666…
    expect(rates!.EUR).toBeCloseTo(1340.7 / 0.9, 4);
    // GBP: 1340.7 / 0.8
    expect(rates!.GBP).toBeCloseTo(1340.7 / 0.8, 4);
    // KRW는 1 고정
    expect(rates!.KRW).toBe(1);
  });

  it("값이 0이거나 숫자가 아닌 통화는 제외한다", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ result: "success", rates: { USD: 1, KRW: 1300, BAD: 0, NOPE: "x" } })
    );
    const rates = await getKrwRates();
    expect(rates).not.toBeNull();
    expect(rates!.USD).toBeCloseTo(1300, 4);
    expect("BAD" in rates!).toBe(false);
    expect("NOPE" in rates!).toBe(false);
  });
});

describe("getKrwRates — 실패 → null", () => {
  it("result !== 'success' 이면 null", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ result: "error", rates: { KRW: 1300 } }));
    expect(await getKrwRates()).toBeNull();
  });

  it("rates.KRW 없으면 null", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ result: "success", rates: { USD: 1, EUR: 0.9 } }));
    expect(await getKrwRates()).toBeNull();
  });

  it("HTTP 오류면 null", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ result: "success", rates: { KRW: 1300 } }, 500));
    expect(await getKrwRates()).toBeNull();
  });

  it("비JSON 응답이면 null", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("not json", { status: 200, headers: { "content-type": "text/plain" } })
    );
    expect(await getKrwRates()).toBeNull();
  });

  it("fetch가 던지면 null", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    expect(await getKrwRates()).toBeNull();
  });
});

describe("getKrwRates — 캐시", () => {
  it("2번째 호출은 fetch를 다시 하지 않는다", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ result: "success", rates: { USD: 1, KRW: 1300 } })
    );
    const first = await getKrwRates();
    const second = await getKrwRates();
    expect(first).not.toBeNull();
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
