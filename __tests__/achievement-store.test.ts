/**
 * lib/achievement-store.ts 회귀 방지 (실제 SQLite DB 사용, 고유 ID로 격리).
 *
 * 검증:
 *   - 스키마 set/get 왕복, 손상 JSON → null + 경고
 *   - bumpSchemaMiss 누적 + 2회차 negative 확정, setSchemaInStore가 negative 복구
 *   - 진행률 upsert/조회, unlocked_30d 왕복, getProgressSummary 집계
 *   - 사용자 행 부재 시 no-op(false / 빈 Map / null)
 */

import { describe, it, expect, afterAll } from "vitest";
import { getDb, upsertUser, stopCleanupScheduler } from "@/lib/db";
import {
  getSchemaFromStore,
  setSchemaInStore,
  bumpSchemaMiss,
  getProgress,
  getProgressSummary,
  upsertProgressBatch,
  insertChanges,
  insertAlerts,
  getUnseenAlerts,
  markAlertsSeen,
} from "@/lib/achievement-store";
import type { AchievementDef } from "@/lib/steam/types";

afterAll(() => {
  stopCleanupScheduler();
});

function uniqueAppId(): number {
  return 2_000_000_000 + Math.floor(Math.random() * 1_000_000_000);
}
function uniqueSteamId(): string {
  return `ach_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
function def(name: string, over: Partial<AchievementDef> = {}): AchievementDef {
  return {
    name,
    displayName: over.displayName ?? name,
    description: over.description ?? `${name} desc`,
    hidden: over.hidden ?? false,
    icon: over.icon ?? `${name}.jpg`,
  };
}

describe("achievement-store 스키마", () => {
  it("set 후 get으로 defs/hash 복원, hasAchievements=true, missStreak=0", () => {
    const appId = uniqueAppId();
    const defs = [def("a"), def("b")];
    setSchemaInStore(appId, defs, "hash-1");

    const got = getSchemaFromStore(appId);
    expect(got).not.toBeNull();
    expect(got!.defs).toEqual(defs);
    expect(got!.hash).toBe("hash-1");
    expect(got!.hasAchievements).toBe(true);
    expect(got!.missStreak).toBe(0);
  });

  it("손상된 schema JSON은 null 반환", () => {
    const appId = uniqueAppId();
    // raw 저장으로 손상 JSON 주입 (set은 항상 valid JSON이라 직접 주입 필요).
    getDb()
      .prepare(
        `INSERT INTO app_achievement_schema
           (app_id, schema, schema_hash, has_achievements, miss_streak, fetched_at)
         VALUES (?, '{not valid json', '', 1, 0, ?)`
      )
      .run(appId, Date.now());

    expect(getSchemaFromStore(appId)).toBeNull();
  });

  it("bumpSchemaMiss: 1회는 미확정, 2회 연속에서 negative 확정", () => {
    const appId = uniqueAppId();

    const first = bumpSchemaMiss(appId);
    expect(first).toBe(1);
    const afterFirst = getSchemaFromStore(appId);
    expect(afterFirst!.missStreak).toBe(1);
    expect(afterFirst!.hasAchievements).toBe(true); // 아직 미확정

    const second = bumpSchemaMiss(appId);
    expect(second).toBe(2);
    const afterSecond = getSchemaFromStore(appId);
    expect(afterSecond!.missStreak).toBe(2);
    expect(afterSecond!.hasAchievements).toBe(false); // negative 확정
    expect(afterSecond!.defs).toEqual([]);
  });

  it("setSchemaInStore는 negative 상태를 정상으로 복구", () => {
    const appId = uniqueAppId();
    bumpSchemaMiss(appId);
    bumpSchemaMiss(appId); // negative 확정

    setSchemaInStore(appId, [def("a")], "hash-2");
    const got = getSchemaFromStore(appId);
    expect(got!.hasAchievements).toBe(true);
    expect(got!.missStreak).toBe(0);
    expect(got!.defs).toEqual([def("a")]);
  });

  it("미저장 appId 스키마 조회는 null", () => {
    expect(getSchemaFromStore(uniqueAppId())).toBeNull();
  });
});

describe("achievement-store 진행률", () => {
  it("upsert 후 조회 — unlocked_30d 포함 왕복", () => {
    const steamId = uniqueSteamId();
    upsertUser(steamId, "ProgUser");
    const appId = uniqueAppId();
    const now = Date.now();

    const ok = upsertProgressBatch(steamId, [
      {
        appId,
        unlocked: 5,
        total: 20,
        lastUnlockAt: now,
        unlocked30d: 2,
        fetchedAt: now,
      },
    ]);
    expect(ok).toBe(true);

    const map = getProgress(steamId, [appId]);
    const row = map.get(appId);
    expect(row).toBeDefined();
    expect(row!.unlocked).toBe(5);
    expect(row!.total).toBe(20);
    expect(row!.unlocked30d).toBe(2);
    expect(row!.lastUnlockAt).toBe(now);
  });

  it("upsert 멱등 — 같은 (user, app) 재저장은 덮어쓰기", () => {
    const steamId = uniqueSteamId();
    upsertUser(steamId);
    const appId = uniqueAppId();
    const now = Date.now();

    upsertProgressBatch(steamId, [
      { appId, unlocked: 1, total: 10, lastUnlockAt: null, unlocked30d: 0, fetchedAt: now },
    ]);
    upsertProgressBatch(steamId, [
      { appId, unlocked: 7, total: 10, lastUnlockAt: now, unlocked30d: 3, fetchedAt: now },
    ]);

    const row = getProgress(steamId, [appId]).get(appId);
    expect(row!.unlocked).toBe(7);
    expect(row!.unlocked30d).toBe(3);
    // 행이 중복 생성되지 않았는지 — 전체 조회에서 1건만.
    expect(getProgress(steamId).size).toBe(1);
  });

  it("getProgress(appIds)는 요청한 subset만 반환한다 (json_each IN 필터)", () => {
    const steamId = uniqueSteamId();
    upsertUser(steamId);
    const now = Date.now();
    const a1 = uniqueAppId();
    const a2 = uniqueAppId();
    const a3 = uniqueAppId();
    upsertProgressBatch(steamId, [
      { appId: a1, unlocked: 1, total: 5, lastUnlockAt: null, unlocked30d: 0, fetchedAt: now },
      { appId: a2, unlocked: 2, total: 5, lastUnlockAt: null, unlocked30d: 0, fetchedAt: now },
      { appId: a3, unlocked: 3, total: 5, lastUnlockAt: null, unlocked30d: 0, fetchedAt: now },
    ]);

    const subset = getProgress(steamId, [a1, a3]);
    expect(subset.size).toBe(2);
    expect(subset.has(a1)).toBe(true);
    expect(subset.has(a3)).toBe(true);
    expect(subset.has(a2)).toBe(false); // 요청하지 않은 앱은 제외
    expect(subset.get(a3)!.unlocked).toBe(3);

    // appIds 생략 시 전체 반환.
    expect(getProgress(steamId).size).toBe(3);
  });

  it("getProgressSummary: totalUnlocked/perfectGames/avgRate/recent30d 집계", () => {
    const steamId = uniqueSteamId();
    upsertUser(steamId);
    const now = Date.now();
    const appPerfect = uniqueAppId();
    const appPartial = uniqueAppId();

    upsertProgressBatch(steamId, [
      // 완벽 달성: 10/10, 최근 30일 획득 3
      { appId: appPerfect, unlocked: 10, total: 10, lastUnlockAt: now, unlocked30d: 3, fetchedAt: now },
      // 부분: 5/20, 최근 30일 획득 2
      { appId: appPartial, unlocked: 5, total: 20, lastUnlockAt: now, unlocked30d: 2, fetchedAt: now },
    ]);

    const summary = getProgressSummary(steamId)!;
    expect(summary.totalUnlocked).toBe(15);
    expect(summary.totalAchievements).toBe(30);
    expect(summary.perfectGames).toBe(1);
    expect(summary.recent30d).toBe(5);
    // avgRate = (10/10 + 5/20) / 2 = (1 + 0.25) / 2 = 0.625
    expect(summary.avgRate).toBeCloseTo(0.625, 5);
  });
});

describe("achievement-store 사용자 부재 처리(M1)", () => {
  it("upsertProgressBatch는 사용자 행 부재 시 no-op + false", () => {
    const unknown = uniqueSteamId();
    const ok = upsertProgressBatch(unknown, [
      { appId: uniqueAppId(), unlocked: 1, total: 2, lastUnlockAt: null, unlocked30d: 0, fetchedAt: Date.now() },
    ]);
    expect(ok).toBe(false);
  });

  it("getProgress는 사용자 부재 시 빈 Map", () => {
    expect(getProgress(uniqueSteamId()).size).toBe(0);
  });

  it("getProgressSummary는 사용자 부재 시 null", () => {
    expect(getProgressSummary(uniqueSteamId())).toBeNull();
  });
});

describe("achievement-store Phase 3 (변경 이력 + 알림)", () => {
  it("insertChanges가 변경 이력을 저장한다", () => {
    const appId = uniqueAppId();
    insertChanges(appId, [
      { kind: "added", apiName: "ACH_X", after: "X" },
      { kind: "renamed", apiName: "ACH_Y", before: "Old", after: "New" },
    ]);
    const rows = getDb()
      .prepare("SELECT kind, api_name FROM app_achievement_change WHERE app_id = ? ORDER BY change_id")
      .all(appId) as { kind: string; api_name: string }[];
    expect(rows.map((r) => r.kind)).toEqual(["added", "renamed"]);

    // 같은 (app, kind, api_name)을 같은 날 재기록하면 중복을 무시한다(#5).
    insertChanges(appId, [{ kind: "added", apiName: "ACH_X", after: "X" }]);
    const dupCount = getDb()
      .prepare("SELECT COUNT(*) AS c FROM app_achievement_change WHERE app_id = ? AND kind = 'added' AND api_name = 'ACH_X'")
      .get(appId) as { c: number };
    expect(dupCount.c).toBe(1);

    // 정리
    getDb().prepare("DELETE FROM app_achievement_change WHERE app_id = ?").run(appId);
  });

  it("insertAlerts → getUnseenAlerts 왕복, markAlertsSeen 후 비움", () => {
    const steamId = uniqueSteamId();
    upsertUser(steamId);
    const appId = uniqueAppId();
    insertAlerts(steamId, [
      { appId, kind: "perfect_broken", payload: { gameName: "Hades", added: 3 } },
    ]);

    const unseen = getUnseenAlerts(steamId, 10);
    expect(unseen).toHaveLength(1);
    expect(unseen[0].kind).toBe("perfect_broken");
    expect((unseen[0].payload as { gameName: string }).gameName).toBe("Hades");

    const marked = markAlertsSeen(steamId);
    expect(marked).toBe(1);
    expect(getUnseenAlerts(steamId, 10)).toHaveLength(0);
  });

  it("insertAlerts는 미확인 중복을 무시하고, 확인 후엔 재알림한다 (§8 #11, #7)", () => {
    const steamId = uniqueSteamId();
    upsertUser(steamId);
    const appId = uniqueAppId();
    insertAlerts(steamId, [{ appId, kind: "changed", payload: { a: 1 } }]);
    // 미확인 상태에서 같은 종류 재삽입 → 무시(배너 중복 방지).
    insertAlerts(steamId, [{ appId, kind: "changed", payload: { a: 2 } }]);
    expect(getUnseenAlerts(steamId, 10)).toHaveLength(1);
    // 다른 종류는 별도로 저장됨.
    insertAlerts(steamId, [{ appId, kind: "perfect_broken", payload: {} }]);
    expect(getUnseenAlerts(steamId, 10)).toHaveLength(2);
    // 확인(seen) 후 같은 종류가 다시 오면 재알림된다.
    markAlertsSeen(steamId);
    insertAlerts(steamId, [{ appId, kind: "changed", payload: { a: 3 } }]);
    expect(getUnseenAlerts(steamId, 10)).toHaveLength(1);
  });

  it("사용자 부재 시 insertAlerts false / getUnseenAlerts 빈 배열 / markAlertsSeen 0", () => {
    const unknown = uniqueSteamId();
    expect(insertAlerts(unknown, [{ appId: uniqueAppId(), kind: "changed", payload: {} }])).toBe(false);
    expect(getUnseenAlerts(unknown, 10)).toEqual([]);
    expect(markAlertsSeen(unknown)).toBe(0);
  });
});
