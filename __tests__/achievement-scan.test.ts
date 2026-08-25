/**
 * lib/achievement-scan.ts 오케스트레이션 테스트.
 *
 * 모듈 경계(@/lib/steam/api)를 vi.mock으로 대체하고(media-api.test.ts:17 선례),
 * store/db는 실제 SQLite를 고유 ID로 격리해 사용한다. Phase 1 핵심 회귀:
 *   - status:'error' 앱이 negative cache에 기록되지 않는다 (C2)
 *   - none은 bumpSchemaMiss로 2회차에 negative 확정
 *   - private 1건은 중단 안 함 / 2건 이상 중단(profilePrivate)
 *   - unavailable은 중단 안 함
 *   - 신선한 progress를 가진 앱은 재조회에서 제외 (§5.3.4)
 *   - unlocked_30d 집계 + 요약
 */

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

vi.mock("@/lib/steam/api", () => ({
  getOwnedGames: vi.fn(),
  getAchievementSchema: vi.fn(),
  getPlayerAchievements: vi.fn(),
}));

import {
  getOwnedGames,
  getAchievementSchema,
  getPlayerAchievements,
} from "@/lib/steam/api";
import { scanAchievements } from "@/lib/achievement-scan";
import { upsertUser, stopCleanupScheduler, getDb } from "@/lib/db";
import {
  getSchemaFromStore,
  setSchemaInStore,
  getProgress,
  getProgressSummary,
  upsertProgressBatch,
  getUnseenAlerts,
} from "@/lib/achievement-store";
import type { SteamOwnedGame } from "@/lib/steam/types";

const mockOwned = vi.mocked(getOwnedGames);
const mockSchema = vi.mocked(getAchievementSchema);
const mockPlayer = vi.mocked(getPlayerAchievements);

afterAll(() => stopCleanupScheduler());

beforeEach(() => {
  vi.clearAllMocks();
});

function uniqueSteamId(): string {
  return `scan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
let appSeq = 2_300_000_000 + Math.floor(Math.random() * 1_000_000);
function uniqueAppId(): number {
  return ++appSeq;
}
function game(appid: number, playtime = 100): SteamOwnedGame {
  return {
    appid,
    name: `Game ${appid}`,
    playtime_forever: playtime,
    img_icon_url: "",
    rtime_last_played: 0,
  };
}
function okSchema(n = 2) {
  const defs = Array.from({ length: n }, (_, i) => ({
    name: `a${i}`,
    displayName: `A${i}`,
    description: "d",
    hidden: false,
    icon: "i.jpg",
  }));
  return { status: "ok" as const, defs, hash: "h" };
}

describe("scanAchievements", () => {
  it("status:'error' 앱은 negative cache에 기록되지 않는다 (C2)", async () => {
    const steamId = uniqueSteamId();
    upsertUser(steamId);
    const appId = uniqueAppId();
    mockOwned.mockResolvedValue({ data: [game(appId)], isStale: false });
    mockSchema.mockResolvedValue({ status: "error" });

    const res = await scanAchievements(steamId);

    expect(getSchemaFromStore(appId)).toBeNull(); // 아무것도 저장 안 됨
    expect(res.done.skipped).toBeGreaterThanOrEqual(1);
    expect(mockPlayer).not.toHaveBeenCalled(); // 스키마 실패 → 진행률 조회 안 함
  });

  it("none은 bumpSchemaMiss로 2회차에 negative 확정", async () => {
    const steamId = uniqueSteamId();
    upsertUser(steamId);
    const appId = uniqueAppId();
    mockOwned.mockResolvedValue({ data: [game(appId)], isStale: false });
    mockSchema.mockResolvedValue({ status: "none" });

    await scanAchievements(steamId);
    const after1 = getSchemaFromStore(appId);
    expect(after1?.missStreak).toBe(1);
    expect(after1?.hasAchievements).toBe(true); // 아직 미확정

    await scanAchievements(steamId);
    const after2 = getSchemaFromStore(appId);
    expect(after2?.missStreak).toBe(2);
    expect(after2?.hasAchievements).toBe(false); // negative 확정
  });

  it("private 1건은 중단하지 않는다", async () => {
    const steamId = uniqueSteamId();
    upsertUser(steamId);
    const appId = uniqueAppId();
    mockOwned.mockResolvedValue({ data: [game(appId)], isStale: false });
    mockSchema.mockResolvedValue(okSchema());
    mockPlayer.mockResolvedValue({ status: "private" });

    const res = await scanAchievements(steamId);
    expect(res.done.profilePrivate).toBe(false);
  });

  it("private 2건 이상이면 중단하고 profilePrivate=true", async () => {
    const steamId = uniqueSteamId();
    upsertUser(steamId);
    mockOwned.mockResolvedValue({
      data: [game(uniqueAppId()), game(uniqueAppId()), game(uniqueAppId())],
      isStale: false,
    });
    mockSchema.mockResolvedValue(okSchema());
    mockPlayer.mockResolvedValue({ status: "private" });

    const res = await scanAchievements(steamId);
    expect(res.done.profilePrivate).toBe(true);
  });

  it("unavailable은 중단하지 않고 skip", async () => {
    const steamId = uniqueSteamId();
    upsertUser(steamId);
    mockOwned.mockResolvedValue({
      data: [game(uniqueAppId()), game(uniqueAppId())],
      isStale: false,
    });
    mockSchema.mockResolvedValue(okSchema());
    mockPlayer.mockResolvedValue({ status: "unavailable" });

    const res = await scanAchievements(steamId);
    expect(res.done.profilePrivate).toBe(false);
    expect(res.done.skipped).toBe(2);
    // 두 앱 모두 결정에 도달 → 남은 것 없음(정상 완료).
    expect(res.done.remaining).toBe(0);
  });

  it("신선한 progress를 가진 앱은 재조회에서 제외된다 (§5.3.4)", async () => {
    const steamId = uniqueSteamId();
    upsertUser(steamId);
    const appId = uniqueAppId();
    // 방금 스캔한 것처럼 신선한 progress 주입.
    upsertProgressBatch(steamId, [
      { appId, unlocked: 3, total: 10, lastUnlockAt: Date.now(), unlocked30d: 1, fetchedAt: Date.now() },
    ]);
    mockOwned.mockResolvedValue({ data: [game(appId)], isStale: false });

    const res = await scanAchievements(steamId);

    // API를 부르지 않고, 캐시된 진행률을 행으로 반환.
    expect(mockSchema).not.toHaveBeenCalled();
    expect(mockPlayer).not.toHaveBeenCalled();
    const row = res.rows.find((r) => r.appId === appId);
    expect(row?.unlocked).toBe(3);
    expect(row?.total).toBe(10);
  });

  it("force=true면 신선한 progress도 재조회한다", async () => {
    const steamId = uniqueSteamId();
    upsertUser(steamId);
    const appId = uniqueAppId();
    upsertProgressBatch(steamId, [
      { appId, unlocked: 3, total: 10, lastUnlockAt: Date.now(), unlocked30d: 1, fetchedAt: Date.now() },
    ]);
    mockOwned.mockResolvedValue({ data: [game(appId)], isStale: false });
    mockSchema.mockResolvedValue(okSchema());
    mockPlayer.mockResolvedValue({ status: "ok", achievements: [] });

    await scanAchievements(steamId, { force: true });
    expect(mockSchema).toHaveBeenCalled();
  });

  it("unlocked_30d 집계 + 요약(recent30d/perfectGames)", async () => {
    const steamId = uniqueSteamId();
    upsertUser(steamId);
    const appId = uniqueAppId();
    const nowSec = Math.floor(Date.now() / 1000);
    mockOwned.mockResolvedValue({ data: [game(appId)], isStale: false });
    mockSchema.mockResolvedValue(okSchema(2)); // total 2
    mockPlayer.mockResolvedValue({
      status: "ok",
      achievements: [
        { name: "a0", achieved: true, unlockTime: nowSec - 5 * 86400 }, // 최근 30일
        { name: "a1", achieved: true, unlockTime: nowSec - 100 * 86400 }, // 오래 전
      ],
    });

    const res = await scanAchievements(steamId);

    const row = getProgress(steamId, [appId]).get(appId);
    expect(row?.unlocked).toBe(2);
    expect(row?.total).toBe(2);
    expect(row?.unlocked30d).toBe(1); // 최근 30일 내 1건

    // 요약은 이제 payload가 아니라 store 집계로 검증(클라이언트가 rows에서 파생, #4).
    const summary = getProgressSummary(steamId)!;
    expect(summary.totalUnlocked).toBe(2);
    expect(summary.perfectGames).toBe(1); // 2/2 완벽
    expect(summary.recent30d).toBe(1);

    expect(res.done.scanned).toBe(1);
    expect(res.done.remaining).toBe(0); // 정상 완료
  });

  it("unlocked는 스키마에 없는 획득 과제를 세지 않는다 — unlocked>total 방지 (#1)", async () => {
    const steamId = uniqueSteamId();
    upsertUser(steamId);
    const appId = uniqueAppId();
    mockOwned.mockResolvedValue({ data: [game(appId)], isStale: false });
    mockSchema.mockResolvedValue(okSchema(2)); // 스키마 과제: a0, a1 (total 2)
    mockPlayer.mockResolvedValue({
      status: "ok",
      achievements: [
        { name: "a0", achieved: true, unlockTime: 0 },
        { name: "a1", achieved: true, unlockTime: 0 },
        // 스키마가 축소돼 더 이상 없는 옛 과제를 플레이어가 achieved로 보고.
        { name: "ghost", achieved: true, unlockTime: 0 },
      ],
    });

    await scanAchievements(steamId);
    const row = getProgress(steamId, [appId]).get(appId);
    expect(row?.total).toBe(2);
    expect(row?.unlocked).toBe(2); // ghost 제외 → unlocked>total 안 됨
  });

  it("스캔 중 중단(cancel)해도 그때까지 스캔한 진행률은 저장된다", async () => {
    const steamId = uniqueSteamId();
    upsertUser(steamId);
    const appIds = Array.from({ length: 6 }, () => uniqueAppId());
    mockOwned.mockResolvedValue({ data: appIds.map((id) => game(id)), isStale: false });
    mockSchema.mockResolvedValue(okSchema(3));
    let playerCalls = 0;
    mockPlayer.mockImplementation(async () => {
      playerCalls++;
      return { status: "ok", achievements: [{ name: "a0", achieved: true, unlockTime: 0 }] };
    });

    // 개인 진행률을 2건 이상 가져오면 중단.
    const res = await scanAchievements(steamId, {}, { isCancelled: () => playerCalls >= 2 });

    const savedCount = getProgress(steamId).size;
    expect(savedCount).toBeGreaterThanOrEqual(1); // 중단 전 스캔분이 저장됨(유실 아님)
    expect(savedCount).toBeLessThan(6); // 전체는 아님(중단됨)
    expect(res.done.remaining).toBeGreaterThan(0); // 남은 후보 있음(재방문 시 이어서)
  });

  it("완벽 달성 해제 감지 → perfect_broken 알림 (Phase 3, §5.4.4)", async () => {
    const steamId = uniqueSteamId();
    upsertUser(steamId);
    const appId = uniqueAppId();

    // 기준선 스키마(과제 2개). store-hit을 막아 재fetch+diff가 돌도록 fetched_at을
    // 오래 전으로 back-date.
    setSchemaInStore(appId, okSchema(2).defs, "h0");
    getDb()
      .prepare("UPDATE app_achievement_schema SET fetched_at = ? WHERE app_id = ?")
      .run(Date.now() - 8 * 24 * 60 * 60 * 1000, appId);

    // 직전 진행률: 2/2 = 100% 완벽 달성.
    upsertProgressBatch(steamId, [
      { appId, unlocked: 2, total: 2, lastUnlockAt: null, unlocked30d: 0, fetchedAt: Date.now() },
    ]);

    // 이번 스캔: 스키마에 과제가 1개 추가(3개) → 100%가 깨짐.
    mockOwned.mockResolvedValue({ data: [game(appId)], isStale: false });
    mockSchema.mockResolvedValue(okSchema(3));
    mockPlayer.mockResolvedValue({
      status: "ok",
      achievements: [
        { name: "a0", achieved: true, unlockTime: 0 },
        { name: "a1", achieved: true, unlockTime: 0 },
        { name: "a2", achieved: false, unlockTime: 0 },
      ],
    });

    await scanAchievements(steamId, { force: true }); // force로 신선 progress도 후보에 포함

    const pb = getUnseenAlerts(steamId, 10).find((a) => a.kind === "perfect_broken");
    expect(pb).toBeDefined();
    expect((pb!.payload as { added: number }).added).toBe(1);
  });

  it("순수 개명(renamed)만 있으면 changed 알림을 만들지 않는다 (#2 노이즈 방지)", async () => {
    const steamId = uniqueSteamId();
    upsertUser(steamId);
    const appId = uniqueAppId();

    setSchemaInStore(appId, okSchema(2).defs, "h0"); // 기준선: a0(A0), a1(A1)
    getDb()
      .prepare("UPDATE app_achievement_schema SET fetched_at = ? WHERE app_id = ?")
      .run(Date.now() - 8 * 24 * 60 * 60 * 1000, appId);
    // 착수(미완벽) 진행률.
    upsertProgressBatch(steamId, [
      { appId, unlocked: 1, total: 2, lastUnlockAt: null, unlocked30d: 0, fetchedAt: Date.now() },
    ]);

    // 이번 스키마: a0의 표시명만 바뀜(구조 변화 없음) → renamed diff 1건.
    mockOwned.mockResolvedValue({ data: [game(appId)], isStale: false });
    mockSchema.mockResolvedValue({
      status: "ok",
      defs: [
        { name: "a0", displayName: "RENAMED", description: "d", hidden: false, icon: "i.jpg" },
        { name: "a1", displayName: "A1", description: "d", hidden: false, icon: "i.jpg" },
      ],
      hash: "h1",
    });
    mockPlayer.mockResolvedValue({
      status: "ok",
      achievements: [{ name: "a0", achieved: true, unlockTime: 0 }],
    });

    await scanAchievements(steamId, { force: true });

    // 구조 변화가 없으므로 changed/perfect_broken 알림이 없어야 한다.
    expect(getUnseenAlerts(steamId, 10)).toHaveLength(0);
  });

  it("라이브러리 조회 실패 시 libraryFetchFailed", async () => {
    const steamId = uniqueSteamId();
    upsertUser(steamId);
    mockOwned.mockResolvedValue(null);

    const res = await scanAchievements(steamId);
    expect(res.done.libraryFetchFailed).toBe(true);
  });
});
