/**
 * 번들 차트 메이커 API 라우트 입력 검증 단위 테스트 (작업 지시서 20261012_01 단계 2, 테스트 대상 L2).
 *
 *   - /api/bundle/resolve: 배열 길이 상한 초과 400, 비정수 원소 400, 정상 통과.
 *   - /api/bundle/itad/list: 미설정 시 200 { configured:false, bundles:[] } (에러 아님).
 *   - /api/bundle/itad/resolve: 미설정 503, bundleId 비정수/비양수 400.
 *
 * route handler를 직접 import해 Request mock으로 호출한다. 외부 의존(ITAD 클라이언트·Steam API·
 * rate-limit)은 mock으로 치환해 네트워크 없이 검증한다.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { BUNDLE_INPUT_MAX_IDS, BUNDLE_EXPAND_MAX_COLLECTIONS } from "@/lib/constants";

// rate-limit: 통과 고정(통과 경로만 검증). 각 라우트는 rateLimitResponse→null, checkRateLimit→allowed.
vi.mock("@/lib/rate-limit", () => ({
  rateLimitResponse: () => null,
  checkRateLimit: () => ({ allowed: true, remaining: 30 }),
}));

// ITAD 클라이언트: configured 플래그와 findBundle 결과를 테스트에서 조절.
let itadIsConfigured = false;
const findBundleMock = vi.fn<(id: number) => Promise<unknown>>();
const getRecentBundlesMock = vi.fn<(opts?: unknown) => Promise<unknown[]>>();
vi.mock("@/lib/itad/client", () => ({
  itadConfigured: () => itadIsConfigured,
  findBundle: (id: number) => findBundleMock(id),
  getRecentBundles: (opts?: unknown) => getRecentBundlesMock(opts),
}));

vi.mock("@/lib/itad/chart", () => ({
  itadBundleToChart: async () => ({ chart: { title: "t", tiers: [] }, unmatched: [] }),
}));

// Steam API: getBundleGameRows는 요청 appid를 그대로 되비춰 순서/개수 확인, expand는 빈 배열.
const getBundleGameRowsMock = vi.fn(async (ids: number[]) =>
  ids.map((appId) => ({
    appId,
    name: `App ${appId}`,
    headerImage: "",
    storeUrl: `https://store.steampowered.com/app/${appId}/`,
    type: "game" as const,
    price: null,
    review: null,
  })),
);
const expandSteamCollectionMock = vi.fn<(kind: string, id: number) => Promise<number[]>>();
vi.mock("@/lib/steam/api", () => ({
  getBundleGameRows: (ids: number[]) => getBundleGameRowsMock(ids),
  expandSteamCollection: (kind: string, id: number) => expandSteamCollectionMock(kind, id),
}));

import { POST as resolvePost } from "@/app/api/bundle/resolve/route";
import { GET as itadListGet } from "@/app/api/bundle/itad/list/route";
import { POST as itadResolvePost } from "@/app/api/bundle/itad/resolve/route";

type AnyReq = Parameters<typeof resolvePost>[0];

/** JSON body POST 요청 mock. nextUrl도 붙여 list GET 등과 공용. */
function postReq(body: unknown, url = "http://localhost/api/bundle/resolve"): AnyReq {
  const req = new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as AnyReq;
  // NextRequest.nextUrl 대용(라우트가 참조할 수 있음).
  (req as unknown as { nextUrl: URL }).nextUrl = new URL(url);
  return req;
}

function getReq(url: string): Parameters<typeof itadListGet>[0] {
  const req = new Request(url, { method: "GET" }) as unknown as Parameters<typeof itadListGet>[0];
  (req as unknown as { nextUrl: URL }).nextUrl = new URL(url);
  return req;
}

beforeEach(() => {
  itadIsConfigured = false;
  findBundleMock.mockReset();
  getRecentBundlesMock.mockReset();
  getRecentBundlesMock.mockResolvedValue([]);
  getBundleGameRowsMock.mockClear();
  expandSteamCollectionMock.mockClear();
  expandSteamCollectionMock.mockResolvedValue([]);
});

describe("POST /api/bundle/resolve", () => {
  it("appIds 길이가 상한을 넘으면 400", async () => {
    const tooMany = Array.from({ length: BUNDLE_INPUT_MAX_IDS + 1 }, (_, i) => i + 1);
    const res = await resolvePost(postReq({ appIds: tooMany }));
    expect(res.status).toBe(400);
  });

  it("appIds 원소가 비정수면 400", async () => {
    const res = await resolvePost(postReq({ appIds: [1, 2.5, 3] }));
    expect(res.status).toBe(400);
  });

  it("appIds 원소가 0 이하면 400", async () => {
    const res = await resolvePost(postReq({ appIds: [1, 0] }));
    expect(res.status).toBe(400);
  });

  it("steamPackageIds가 배열이 아니면 400", async () => {
    const res = await resolvePost(postReq({ steamPackageIds: 123 }));
    expect(res.status).toBe(400);
  });

  it("정상 appIds면 200 + 순서 보존 rows", async () => {
    const res = await resolvePost(postReq({ appIds: [10, 20, 30] }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.rows.map((r: { appId: number }) => r.appId)).toEqual([10, 20, 30]);
    expect(json.notes).toBeUndefined();
  });

  it("Steam 번들 전개가 비면 notes에 미지원 안내", async () => {
    expandSteamCollectionMock.mockResolvedValue([]);
    const res = await resolvePost(postReq({ steamBundleIds: [999] }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.notes).toContain(
      "Steam 번들 전개는 지원되지 않습니다. ITAD 목록/수동 입력을 사용하세요.",
    );
  });

  it("빈 body면 빈 rows 200", async () => {
    const res = await resolvePost(postReq({}));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.rows).toEqual([]);
  });

  it("패키지+번들 전개 대상 합이 상한을 넘으면 400 (전개 없이)", async () => {
    const half = Math.ceil((BUNDLE_EXPAND_MAX_COLLECTIONS + 1) / 2);
    const pkgIds = Array.from({ length: half }, (_, i) => i + 1);
    const bundleIds = Array.from(
      { length: BUNDLE_EXPAND_MAX_COLLECTIONS + 1 - half },
      (_, i) => 1000 + i,
    );
    const res = await resolvePost(
      postReq({ steamPackageIds: pkgIds, steamBundleIds: bundleIds }),
    );
    expect(res.status).toBe(400);
    // 상한 초과면 전개 자체를 하지 않는다(직렬 Steam 호출 방어).
    expect(expandSteamCollectionMock).not.toHaveBeenCalled();
  });

  it("전개 대상이 상한 이하면 전개 진행 200", async () => {
    expandSteamCollectionMock.mockResolvedValue([111]);
    const pkgIds = Array.from(
      { length: BUNDLE_EXPAND_MAX_COLLECTIONS },
      (_, i) => i + 1,
    );
    const res = await resolvePost(postReq({ steamPackageIds: pkgIds }));
    expect(res.status).toBe(200);
    expect(expandSteamCollectionMock).toHaveBeenCalledTimes(BUNDLE_EXPAND_MAX_COLLECTIONS);
  });

  it("appid 직접 입력은 전개 상한과 무관(BUNDLE_INPUT_MAX_IDS만 적용)", async () => {
    // 전개 대상이 아니므로 BUNDLE_EXPAND_MAX_COLLECTIONS를 넘는 appid 수도 허용.
    const appIds = Array.from(
      { length: BUNDLE_EXPAND_MAX_COLLECTIONS + 5 },
      (_, i) => i + 1,
    );
    const res = await resolvePost(postReq({ appIds }));
    expect(res.status).toBe(200);
  });
});

describe("GET /api/bundle/itad/list", () => {
  it("미설정이면 200 { configured:false, bundles:[] } (에러 아님)", async () => {
    itadIsConfigured = false;
    const res = await itadListGet(getReq("http://localhost/api/bundle/itad/list"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ configured: false, bundles: [] });
  });

  it("설정이면 200 + 경량 매핑(configured:true)", async () => {
    itadIsConfigured = true;
    getRecentBundlesMock.mockResolvedValue([
      {
        id: 42,
        title: "Great Bundle",
        // 실측 필드명: page (이전 예시의 shop 아님).
        page: { name: "Humble" },
        url: "https://humble/x",
        // 실측 필드명: expiry (이전 예시의 expires 아님).
        expiry: "2026-11-01",
        counts: { games: 5 },
        tiers: [
          { price: { amount: 10, currency: "USD" }, games: [{ id: "u1", slug: "", title: "", type: "game" }] },
        ],
      },
    ]);
    const res = await itadListGet(
      getReq("http://localhost/api/bundle/itad/list?country=KR&limit=5"),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.configured).toBe(true);
    expect(json.bundles[0]).toMatchObject({
      id: 42,
      title: "Great Bundle",
      shop: "Humble",
      gameCount: 1,
      tierPrices: [{ amount: 10, currency: "USD" }],
    });
  });
});

describe("POST /api/bundle/itad/resolve", () => {
  it("bundleId가 비정수면 400", async () => {
    const res = await itadResolvePost(postReq({ bundleId: 1.5 }));
    expect(res.status).toBe(400);
  });

  it("bundleId가 0 이하면 400", async () => {
    const res = await itadResolvePost(postReq({ bundleId: 0 }));
    expect(res.status).toBe(400);
  });

  it("bundleId가 없으면 400", async () => {
    const res = await itadResolvePost(postReq({}));
    expect(res.status).toBe(400);
  });

  it("미설정이면 503", async () => {
    itadIsConfigured = false;
    const res = await itadResolvePost(postReq({ bundleId: 42 }));
    expect(res.status).toBe(503);
  });

  it("설정 + 못 찾으면 404", async () => {
    itadIsConfigured = true;
    findBundleMock.mockResolvedValue(null);
    const res = await itadResolvePost(postReq({ bundleId: 42 }));
    expect(res.status).toBe(404);
  });

  it("설정 + 발견이면 200 { chart, unmatched }", async () => {
    itadIsConfigured = true;
    findBundleMock.mockResolvedValue({ id: 42, title: "t", tiers: [] });
    const res = await itadResolvePost(postReq({ bundleId: 42 }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.chart).toBeDefined();
    expect(json.unmatched).toEqual([]);
  });
});
