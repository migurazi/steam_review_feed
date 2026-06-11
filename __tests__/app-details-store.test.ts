/**
 * lib/app-details-store.ts 회귀 방지.
 *
 * 핵심 검증 사항:
 *   1. set 후 get으로 동일 SteamAppDetails 복원
 *   2. fetchedAt이 set 시각으로 설정됨 (TTL 판단 근거)
 *   3. 같은 appId 재 set 시 덮어쓰기 (INSERT OR REPLACE)
 *   4. 미저장 appId는 null
 *   5. delete 후 null
 *
 * (JSON 손상 케이스는 DB raw 접근 없이 시뮬레이션 어렵고, set이 항상 valid
 * JSON.stringify로 저장하므로 자연 발생 시나리오 한정 — 별도 단위 테스트 생략.)
 */

import { describe, it, expect, afterAll } from "vitest";
import { stopCleanupScheduler } from "@/lib/db";
import {
  getAppDetailsFromStore,
  setAppDetailsInStore,
  deleteAppDetailsFromStore,
} from "@/lib/app-details-store";
import type { SteamAppDetails } from "@/lib/steam/types";

afterAll(() => {
  stopCleanupScheduler();
});

function uniqueAppId(): number {
  return 2_000_000_000 + Math.floor(Math.random() * 1_000_000_000);
}

function sampleDetails(): SteamAppDetails {
  return {
    name: "Sample Game",
    steam_appid: 12345,
    is_free: false,
    header_image: "https://store.example/header.jpg",
    short_description: "A test game",
    type: "game",
    genres: [{ id: "1", description: "Action" }],
    categories: [{ id: 2, description: "Single-player" }],
    // price_overview는 본 store에 저장 시 caller가 strip — 테스트에선 누락 케이스.
  };
}

describe("app-details-store", () => {
  it("set 후 get으로 동일 details 복원", () => {
    const appId = uniqueAppId();
    const details = sampleDetails();
    setAppDetailsInStore(appId, details);

    const got = getAppDetailsFromStore(appId);
    expect(got).not.toBeNull();
    expect(got!.details).toEqual(details);
  });

  it("fetchedAt은 set 시점으로 설정 — TTL 판단 가능", () => {
    const appId = uniqueAppId();
    const before = Date.now();
    setAppDetailsInStore(appId, sampleDetails());
    const after = Date.now();

    const got = getAppDetailsFromStore(appId);
    expect(got!.fetchedAt).toBeGreaterThanOrEqual(before);
    expect(got!.fetchedAt).toBeLessThanOrEqual(after);
  });

  it("같은 appId 재 set은 INSERT OR REPLACE — 최신 본문 + 최신 fetched_at", () => {
    const appId = uniqueAppId();
    const v1 = { ...sampleDetails(), name: "Old Name" };
    const v2 = { ...sampleDetails(), name: "New Name" };

    setAppDetailsInStore(appId, v1);
    const firstFetchedAt = getAppDetailsFromStore(appId)!.fetchedAt;

    // 미세하지만 timestamp 진행 보장 — 매우 빠른 머신에선 동일할 수 있어
    // expect는 >=로 검사.
    setAppDetailsInStore(appId, v2);

    const got = getAppDetailsFromStore(appId);
    expect(got!.details.name).toBe("New Name");
    expect(got!.fetchedAt).toBeGreaterThanOrEqual(firstFetchedAt);
  });

  it("미저장 appId 조회는 null", () => {
    expect(getAppDetailsFromStore(uniqueAppId())).toBeNull();
  });

  it("delete 후 조회는 null", () => {
    const appId = uniqueAppId();
    setAppDetailsInStore(appId, sampleDetails());
    expect(getAppDetailsFromStore(appId)).not.toBeNull();

    deleteAppDetailsFromStore(appId);
    expect(getAppDetailsFromStore(appId)).toBeNull();
  });
});
