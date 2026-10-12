/**
 * ITAD 클라이언트 단위 테스트 (작업 지시서 20261012_01 단계 1-1, 테스트 대상 L2).
 *
 *   - getRecentBundles: 방어적 파싱(배열 아니면 [], 필드 누락 허용), 키 없으면 [].
 *   - findBundle: 스캔 상한, 미스 음성 캐시, 발견.
 *   - lookupSteamAppIds: app-item 선택 규칙, 음성 캐시, 100개 분할.
 *
 * CI는 ITAD 키 없이 전부 통과해야 하므로 실호출은 global fetch stub로 흉내 낸다.
 * 캐시는 Map 기반 fake, outbound-limit은 passthrough로 mock.
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

// outbound-limit: 슬롯은 그냥 실행, 예산은 테스트에서 조절 가능한 플래그.
let budgetExceeded = false;
vi.mock("@/lib/outbound-limit", () => ({
  withOutboundSlot: <T>(fn: () => Promise<T>) => fn(),
  isDailyBudgetExceeded: () => budgetExceeded,
}));

import {
  itadConfigured,
  getRecentBundles,
  findBundle,
  lookupSteamAppIds,
} from "@/lib/itad/client";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** 최소 유효 번들 (id/title/tiers). */
function bundle(id: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, title: `Bundle ${id}`, tiers: [], ...extra };
}

const fetchMock = vi.fn<typeof fetch>();
const originalEnv = { ...process.env };

beforeEach(() => {
  fakeCache.clear();
  budgetExceeded = false;
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  process.env.ITAD_API_KEY = "test-itad-key";
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...originalEnv };
});

describe("itadConfigured", () => {
  it("키가 있으면 true, 없으면 false", () => {
    expect(itadConfigured()).toBe(true);
    delete process.env.ITAD_API_KEY;
    expect(itadConfigured()).toBe(false);
  });
});

describe("getRecentBundles", () => {
  it("배열 응답을 방어적으로 파싱한다 (필드 누락 허용)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse([
        bundle(1, {
          // 실측 필드명: page (이전 예시의 shop 아님).
          page: { name: "Humble Bundle", shopId: 37 },
          url: "https://humble.com/x",
          tiers: [{ price: { amount: 10, currency: "USD" }, games: [{ id: "u1", slug: "g", title: "G", type: "game" }] }],
        }),
        // id 누락 → 버려진다.
        { title: "No id", tiers: [] },
        // price 누락 → null 보존(Fanatical Build Your Own 등). amount 0으로 날조하지 않는다.
        bundle(2, { tiers: [{ games: [] }] }),
      ]),
    );
    const out = await getRecentBundles();
    expect(out).toHaveLength(2);
    expect(out[0].id).toBe(1);
    // 실측 필드명: page.name.
    expect(out[0].page?.name).toBe("Humble Bundle");
    expect(out[0].page?.shopId).toBe(37);
    expect(out[0].tiers[0].price).toEqual({ amount: 10, currency: "USD" });
    expect(out[0].tiers[0].games[0].id).toBe("u1");
    expect(out[1].id).toBe(2);
    expect(out[1].tiers[0].price).toBeNull();
  });

  it("응답이 배열이 아니면 []", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "nope" }));
    expect(await getRecentBundles()).toEqual([]);
  });

  it("HTTP 실패면 []", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 500 }));
    expect(await getRecentBundles()).toEqual([]);
  });

  it("키가 없으면 호출 없이 []", async () => {
    delete process.env.ITAD_API_KEY;
    expect(await getRecentBundles()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("일일 예산 초과면 호출 없이 []", async () => {
    budgetExceeded = true;
    expect(await getRecentBundles()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("같은 쿼리는 캐시에서 돌려준다(두 번째 호출 fetch 없음)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([bundle(1)]));
    const first = await getRecentBundles();
    const second = await getRecentBundles();
    expect(first).toEqual(second);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("limit은 50으로 캡되고 쿼리에 key 마스킹 없이 실제 key가 들어간다", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    await getRecentBundles({ limit: 999 });
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("limit=50");
    expect(url).toContain("key=test-itad-key");
  });
});

describe("findBundle", () => {
  it("첫 페이지(expired=false)에서 찾으면 반환 + 캐시", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([bundle(1), bundle(42), bundle(3)]));
    const found = await findBundle(42);
    expect(found?.id).toBe(42);
    // 두 번째 호출은 캐시 히트 → fetch 추가 없음.
    const again = await findBundle(42);
    expect(again?.id).toBe(42);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("스캔 상한(4페이지 × 2) 소진 후 미발견이면 null + 음성 캐시 + 경고", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // 꽉 찬(limit=50) 페이지를 계속 돌려줘 상한까지 스캔하게 한다. 찾는 id는 없음.
    const fullPage = Array.from({ length: 50 }, (_, i) => bundle(1000 + i));
    fetchMock.mockImplementation(async () => jsonResponse(fullPage));

    const found = await findBundle(99999);
    expect(found).toBeNull();
    // expired false 4페이지 + expired true 4페이지 = 8페이지.
    expect(fetchMock).toHaveBeenCalledTimes(8);
    expect(warn).toHaveBeenCalled();

    // 음성 캐시 히트 → 재조회 없음.
    fetchMock.mockClear();
    expect(await findBundle(99999)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("짧은(미달) 페이지를 만나면 그 분기 스캔을 중단한다", async () => {
    // expired=false 첫 페이지가 10건(<50) → 소진으로 간주, 다음 페이지 안 봄. 이어 expired=true도 1페이지만.
    fetchMock
      .mockResolvedValueOnce(jsonResponse([bundle(1), bundle(2)]))
      .mockResolvedValueOnce(jsonResponse([bundle(3)]));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const found = await findBundle(777);
    expect(found).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("페이지 fetch 실패(HTTP 500)면 음성 캐시 없이 null — 재호출 시 재조회한다", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // 첫 페이지 요청이 HTTP 실패 → fetchBundlesPage가 null → 소진이 아니므로 음성 캐시 없이 즉시 null.
    fetchMock.mockResolvedValueOnce(new Response("", { status: 500 }));
    const first = await findBundle(555);
    expect(first).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 음성 캐시가 없으므로 재호출은 다시 네트워크를 친다(이번엔 발견).
    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(jsonResponse([bundle(555)]));
    const second = await findBundle(555);
    expect(second?.id).toBe(555);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe("lookupSteamAppIds", () => {
  it("첫 app/<n> 항목을 선택한다 (sub/dlc 무시)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        u1: ["sub/55", "app/100", "app/200"],
        u2: ["app/300"],
        u3: ["sub/99"], // app 항목 없음 → 음성.
      }),
    );
    const map = await lookupSteamAppIds(["u1", "u2", "u3"]);
    expect(map.get("u1")).toBe(100);
    expect(map.get("u2")).toBe(300);
    expect(map.has("u3")).toBe(false);
  });

  it("음성 캐시: 매핑 없는 UUID는 재조회하지 않는다", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ u1: ["sub/1"] }));
    await lookupSteamAppIds(["u1"]);
    fetchMock.mockClear();
    const map = await lookupSteamAppIds(["u1"]);
    expect(map.has("u1")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("양성 캐시: 매핑된 UUID는 재조회 없이 돌려준다", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ u1: ["app/100"] }));
    await lookupSteamAppIds(["u1"]);
    fetchMock.mockClear();
    const map = await lookupSteamAppIds(["u1"]);
    expect(map.get("u1")).toBe(100);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("100개 초과는 분할 호출한다", async () => {
    const uuids = Array.from({ length: 250 }, (_, i) => `u${i}`);
    fetchMock.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit).body)) as string[];
      const obj: Record<string, string[]> = {};
      for (const u of body) obj[u] = [`app/${Number(u.slice(1)) + 1}`];
      return jsonResponse(obj);
    });
    const map = await lookupSteamAppIds(uuids);
    // 250 → 100/100/50 세 번.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(map.size).toBe(250);
    expect(map.get("u0")).toBe(1);
    expect(map.get("u249")).toBe(250);
  });

  it("키가 없으면 빈 Map", async () => {
    delete process.env.ITAD_API_KEY;
    const map = await lookupSteamAppIds(["u1"]);
    expect(map.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetch 실패(HTTP 500)면 그 배치를 음성 캐시하지 않는다 — 재호출 시 재조회한다", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // 첫 호출은 HTTP 실패 → itadFetch null → 배치 전체를 appid=0으로 음성 캐시하지 않는다.
    fetchMock.mockResolvedValueOnce(new Response("", { status: 500 }));
    const firstMap = await lookupSteamAppIds(["u1", "u2"]);
    expect(firstMap.size).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 음성 캐시가 없으므로 재호출은 다시 조회한다(이번엔 성공).
    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(jsonResponse({ u1: ["app/100"], u2: ["app/200"] }));
    const secondMap = await lookupSteamAppIds(["u1", "u2"]);
    expect(secondMap.get("u1")).toBe(100);
    expect(secondMap.get("u2")).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
