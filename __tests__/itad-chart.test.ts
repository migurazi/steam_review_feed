/**
 * itadBundleToChart 단위 테스트 (작업 지시서 20261012_01 단계 1-3, 테스트 대상 L2).
 *
 *   - 티어 매핑(ITAD 순서·flat pricing·ITAD type 덮어쓰기).
 *   - unmatched 수집(appid 매핑 실패 UUID, tierIndex 포함).
 *   - URL 스킴 필터(javascript: 등 제거, http/https만 통과).
 *   - pricing=flat 구성(amount/currency 상점 통화 그대로).
 *
 * lookupSteamAppIds·getBundleGameRows는 모듈 mock로 흉내 낸다(순수 변환 로직에 집중).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GameRow } from "@/lib/bundle/types";
import type { ItadBundle } from "@/lib/itad/types";

const lookupMock = vi.fn<(uuids: string[]) => Promise<Map<string, number>>>();
const rowsMock = vi.fn<(appIds: number[]) => Promise<GameRow[]>>();

vi.mock("@/lib/itad/client", () => ({
  lookupSteamAppIds: (uuids: string[]) => lookupMock(uuids),
}));
vi.mock("@/lib/steam/api", () => ({
  getBundleGameRows: (appIds: number[]) => rowsMock(appIds),
}));

import { itadBundleToChart } from "@/lib/itad/chart";

/** 최소 GameRow. */
function row(appId: number, name = `Game ${appId}`): GameRow {
  return {
    appId,
    name,
    headerImage: `https://img/${appId}.jpg`,
    storeUrl: `https://store.steampowered.com/app/${appId}/`,
    type: "game",
    price: null,
    review: null,
  };
}

beforeEach(() => {
  lookupMock.mockReset();
  rowsMock.mockReset();
});

describe("itadBundleToChart", () => {
  it("티어를 ITAD 순서대로 flat pricing으로 만든다", async () => {
    const bundle: ItadBundle = {
      id: 1,
      title: "Test Bundle",
      tiers: [
        { price: { amount: 5, currency: "USD" }, games: [{ id: "u1", slug: "a", title: "A", type: "game" }] },
        { price: { amount: 12.5, currency: "USD" }, games: [{ id: "u2", slug: "b", title: "B", type: "game" }] },
      ],
    };
    lookupMock.mockResolvedValue(new Map([["u1", 100], ["u2", 200]]));
    rowsMock.mockResolvedValue([row(100, "A"), row(200, "B")]);

    const { chart, unmatched } = await itadBundleToChart(bundle);
    expect(chart.title).toBe("Test Bundle");
    expect(chart.tiers).toHaveLength(2);
    expect(chart.tiers[0].label).toBe("티어 1");
    expect(chart.tiers[0].pricing).toEqual({ kind: "flat", amount: 5, currency: "USD" });
    expect(chart.tiers[1].pricing).toEqual({ kind: "flat", amount: 12.5, currency: "USD" });
    expect(chart.tiers[0].games.map(g => g.appId)).toEqual([100]);
    expect(chart.tiers[1].games.map(g => g.appId)).toEqual([200]);
    // Tier.id는 고유 UUID.
    expect(chart.tiers[0].id).not.toBe(chart.tiers[1].id);
    expect(unmatched).toEqual([]);
    // getBundleGameRows는 고유 appid로 한 번.
    expect(rowsMock).toHaveBeenCalledWith([100, 200]);
  });

  it("price가 null인 티어(Build Your Own)는 retail pricing으로 둔다", async () => {
    const bundle: ItadBundle = {
      id: 1,
      title: "Build your own Bundle",
      page: { name: "Fanatical" },
      tiers: [
        { price: null, games: [{ id: "u1", slug: "a", title: "A", type: "game" }] },
      ],
    };
    lookupMock.mockResolvedValue(new Map([["u1", 100]]));
    rowsMock.mockResolvedValue([row(100)]);
    const { chart } = await itadBundleToChart(bundle);
    // flat 0이 아니라 retail — "지불 0"으로 깨지지 않게.
    expect(chart.tiers[0].pricing).toEqual({ kind: "retail" });
    expect(chart.tiers[0].games.map(g => g.appId)).toEqual([100]);
  });

  it("addon 티어는 '애드온' 라벨", async () => {
    const bundle: ItadBundle = {
      id: 1,
      title: "B",
      tiers: [{ price: { amount: 3, currency: "USD" }, addon: true, games: [{ id: "u1", slug: "a", title: "A", type: "game" }] }],
    };
    lookupMock.mockResolvedValue(new Map([["u1", 100]]));
    rowsMock.mockResolvedValue([row(100)]);
    const { chart } = await itadBundleToChart(bundle);
    expect(chart.tiers[0].label).toBe("애드온");
  });

  it("매핑 안 된 UUID는 unmatched(tierIndex 포함)로 모은다", async () => {
    const bundle: ItadBundle = {
      id: 1,
      title: "B",
      tiers: [
        {
          price: { amount: 5, currency: "USD" },
          games: [
            { id: "u1", slug: "a", title: "A", type: "game" },
            { id: "u2", slug: "b", title: "B game", type: "game" },
          ],
        },
        {
          price: { amount: 10, currency: "USD" },
          games: [{ id: "u3", slug: "c", title: "C", type: "game" }],
        },
      ],
    };
    // u2는 매핑 실패.
    lookupMock.mockResolvedValue(new Map([["u1", 100], ["u3", 300]]));
    rowsMock.mockResolvedValue([row(100), row(300)]);

    const { chart, unmatched } = await itadBundleToChart(bundle);
    expect(chart.tiers[0].games.map(g => g.appId)).toEqual([100]);
    expect(chart.tiers[1].games.map(g => g.appId)).toEqual([300]);
    expect(unmatched).toEqual([{ uuid: "u2", title: "B game", slug: "b", tierIndex: 0 }]);
  });

  it("ITAD type(dlc)을 Steam 행 위에 덮어쓴다", async () => {
    const bundle: ItadBundle = {
      id: 1,
      title: "B",
      tiers: [{ price: { amount: 5, currency: "USD" }, games: [{ id: "u1", slug: "a", title: "A", type: "dlc" }] }],
    };
    // getBundleGameRows는 type:"game"으로 돌려주지만 ITAD가 dlc라고 하면 덮어쓴다.
    lookupMock.mockResolvedValue(new Map([["u1", 100]]));
    rowsMock.mockResolvedValue([{ ...row(100), type: "game" }]);
    const { chart } = await itadBundleToChart(bundle);
    expect(chart.tiers[0].games[0].type).toBe("dlc");
  });

  it("url/details는 http/https 스킴만 통과(javascript: 제거)", async () => {
    const bundle: ItadBundle = {
      id: 1,
      title: "B",
      // 실측 필드명: page (이전 예시의 shop 아님).
      page: { name: "Fanatical" },
      url: "javascript:alert(1)",
      details: "https://isthereanydeal.com/bundle/1",
      // 실측 필드명: expiry (이전 예시의 expires 아님).
      expiry: "2026-12-31T00:00:00Z",
      note: "note",
      tiers: [],
    };
    lookupMock.mockResolvedValue(new Map());
    rowsMock.mockResolvedValue([]);
    const { chart } = await itadBundleToChart(bundle);
    // chart.source.shop은 내부 모델(ChartSource) 필드 — 값이 page.name에서 읽혀 매핑됨.
    expect(chart.source?.shop).toBe("Fanatical");
    expect(chart.source?.url).toBeUndefined(); // javascript: 제거.
    expect(chart.source?.details).toBe("https://isthereanydeal.com/bundle/1");
    // chart.source.expires는 내부 모델(ChartSource) 필드 — 값이 expiry에서 읽혀 매핑됨.
    expect(chart.source?.expires).toBe("2026-12-31T00:00:00Z");
    expect(chart.source?.note).toBe("note");
  });

  it("빈 티어 번들도 안전하게 변환(games 없음·unmatched 없음)", async () => {
    const bundle: ItadBundle = { id: 1, title: "Empty", tiers: [] };
    lookupMock.mockResolvedValue(new Map());
    rowsMock.mockResolvedValue([]);
    const { chart, unmatched } = await itadBundleToChart(bundle);
    expect(chart.tiers).toEqual([]);
    expect(unmatched).toEqual([]);
    expect(rowsMock).toHaveBeenCalledWith([]);
  });
});
