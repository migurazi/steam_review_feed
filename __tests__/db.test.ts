/**
 * lib/db.ts 단위 테스트.
 *
 * SQLite DB 관련 기능을 테스트한다:
 * - 사용자 upsert (신규 생성 및 기존 업데이트)
 * - 사용자 조회
 * - 만료 사용자 정리
 * - 정리 스케줄러 시작/중지
 *
 * 주의: 실제 SQLite DB 파일을 사용하므로 테스트 간 격리를 위해
 *       고유한 Steam ID를 사용한다.
 */

import { describe, it, expect, afterAll } from "vitest";
import {
  upsertUser,
  getUserBySteamId,
  getDb,
  stopCleanupScheduler,
  cleanupOldAchievementChanges,
} from "@/lib/db";

// 테스트 후 스케줄러가 남지 않도록 정리
afterAll(() => {
  stopCleanupScheduler();
});

/** 테스트용 고유 Steam ID 생성 */
function uniqueSteamId(): string {
  return `test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

describe("db", () => {
  describe("upsertUser", () => {
    it("새 사용자를 생성한다", () => {
      const steamId = uniqueSteamId();
      const user = upsertUser(steamId, "TestUser");

      expect(user).toBeDefined();
      expect(user.steam_id).toBe(steamId);
      expect(user.display_name).toBe("TestUser");
      expect(user.user_id).toBeGreaterThan(0);
    });

    it("기존 사용자의 display_name과 last_login_at을 업데이트한다", () => {
      const steamId = uniqueSteamId();
      const first = upsertUser(steamId, "Name1");
      const second = upsertUser(steamId, "Name2");

      expect(second.user_id).toBe(first.user_id);
      expect(second.display_name).toBe("Name2");
    });

    it("displayName이 없으면 기존 값을 유지한다", () => {
      const steamId = uniqueSteamId();
      upsertUser(steamId, "OriginalName");
      const updated = upsertUser(steamId);

      expect(updated.display_name).toBe("OriginalName");
    });

    it("displayName이 없고 신규 사용자면 null이다", () => {
      const steamId = uniqueSteamId();
      const user = upsertUser(steamId);

      expect(user.display_name).toBeNull();
    });
  });

  describe("getUserBySteamId", () => {
    it("존재하는 사용자를 반환한다", () => {
      const steamId = uniqueSteamId();
      upsertUser(steamId, "Finder");

      const found = getUserBySteamId(steamId);
      expect(found).not.toBeNull();
      expect(found!.steam_id).toBe(steamId);
      expect(found!.display_name).toBe("Finder");
    });

    it("존재하지 않는 사용자는 null을 반환한다", () => {
      const found = getUserBySteamId("nonexistent_" + Date.now());
      expect(found).toBeNull();
    });
  });

  describe("getDb", () => {
    it("싱글톤 인스턴스를 반환한다", () => {
      const db1 = getDb();
      const db2 = getDb();
      expect(db1).toBe(db2);
    });

    it("users 테이블이 존재한다", () => {
      const db = getDb();
      const result = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='users'"
        )
        .get() as { name: string } | undefined;

      expect(result?.name).toBe("users");
    });

    it("user_game_list 테이블이 존재한다", () => {
      const db = getDb();
      const result = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='user_game_list'"
        )
        .get() as { name: string } | undefined;

      expect(result?.name).toBe("user_game_list");
    });

    it("도전과제 신규 테이블 5종이 모두 존재한다", () => {
      const db = getDb();
      const tables = [
        "app_achievement_schema",
        "app_achievement_global",
        "user_achievement_progress",
        "app_achievement_change",
        "user_achievement_alert",
      ];
      for (const t of tables) {
        const result = db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
          )
          .get(t) as { name: string } | undefined;
        expect(result?.name).toBe(t);
      }
    });
  });

  describe("cleanupExpiredUsers 도전과제 정리 회귀 (§9 격리)", () => {
    // 주의: 이 테스트는 실제 data/steam_review_feed.db를 쓰므로 cleanupExpiredUsers()
    // 를 직접 호출하지 않는다 — 호출하면 6개월 이상 미접속 실제 사용자를 전부
    // 삭제한다(§9). 대신 만료 사용자의 도전과제 자식 행이 cleanup과 **동일한 WHERE
    // 조건의 삭제 대상 집합에 포함되는지**를 SELECT로 검증하고, 합성 사용자만
    // scoped 정리한다. 함수 실동작(실제 DELETE) 검증은 테스트 DB 경로 주입을
    // 도입하는 별도 작업으로 분리한다.
    it("만료 사용자의 progress/alert 행이 삭제 대상 조건에 포함된다", () => {
      const db = getDb();
      const steamId = uniqueSteamId();
      const user = upsertUser(steamId);
      const appId = 2_100_000_000 + Math.floor(Math.random() * 1_000_000);
      const now = Date.now();

      db.prepare(
        `INSERT INTO user_achievement_progress
           (user_id, app_id, unlocked, total, last_unlock_at, unlocked_30d, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(user.user_id, appId, 1, 2, null, 0, now);
      db.prepare(
        `INSERT INTO user_achievement_alert
           (user_id, app_id, kind, detected_at, payload, seen_at)
         VALUES (?, ?, 'perfect_broken', ?, '{}', NULL)`
      ).run(user.user_id, appId, now);

      // last_login_at을 7개월 전으로 back-date → 만료 집합에 포함되게 한다.
      db.prepare(
        "UPDATE users SET last_login_at = datetime('now', '-7 months') WHERE user_id = ?"
      ).run(user.user_id);

      // cleanupExpiredUsers와 동일한 만료 WHERE로, 우리 사용자의 자식 행이 대상인지 확인.
      const expiredWhere =
        "user_id IN (SELECT user_id FROM users WHERE last_login_at < datetime('now', '-6 months'))";
      const prog = db
        .prepare(
          `SELECT COUNT(*) AS c FROM user_achievement_progress WHERE ${expiredWhere} AND user_id = ?`
        )
        .get(user.user_id) as { c: number };
      const alert = db
        .prepare(
          `SELECT COUNT(*) AS c FROM user_achievement_alert WHERE ${expiredWhere} AND user_id = ?`
        )
        .get(user.user_id) as { c: number };

      expect(prog.c).toBe(1);
      expect(alert.c).toBe(1);

      // 합성 데이터만 scoped 정리 (자식 먼저).
      db.prepare("DELETE FROM user_achievement_progress WHERE user_id = ?").run(user.user_id);
      db.prepare("DELETE FROM user_achievement_alert WHERE user_id = ?").run(user.user_id);
      db.prepare("DELETE FROM users WHERE user_id = ?").run(user.user_id);
    });
  });

  describe("cleanupOldAchievementChanges (detected_at ms 계약)", () => {
    // app_achievement_change는 앱 공용(개인정보 아님)이라 실제 DELETE를 안전하게
    // 검증할 수 있다. detected_at을 Unix ms로 저장했을 때 1년 경계로만 삭제되는지
    // 확인해, 미래 writer가 초/텍스트로 저장하면 깨지는 계약을 고정한다.
    it("1년 초과 ms 행만 삭제하고 최근 행은 보존한다", () => {
      const db = getDb();
      // 다른 테스트와 충돌하지 않도록 고유 app_id 대역 사용.
      const oldAppId = 2_140_000_000 + Math.floor(Math.random() * 1_000_000);
      const freshAppId = 2_150_000_000 + Math.floor(Math.random() * 1_000_000);
      const now = Date.now();
      const oldMs = now - 400 * 24 * 60 * 60 * 1000; // 400일 전 (>1년)
      const freshMs = now - 10 * 24 * 60 * 60 * 1000; // 10일 전 (<1년)

      const insert = db.prepare(
        `INSERT INTO app_achievement_change
           (app_id, detected_at, kind, api_name, before_value, after_value)
         VALUES (?, ?, 'added', 'ACH_X', NULL, 'X')`
      );
      insert.run(oldAppId, oldMs);
      insert.run(freshAppId, freshMs);

      const purged = cleanupOldAchievementChanges();
      expect(purged).toBeGreaterThanOrEqual(1); // 최소 우리 old 행 1건

      const oldLeft = db
        .prepare("SELECT COUNT(*) AS c FROM app_achievement_change WHERE app_id = ?")
        .get(oldAppId) as { c: number };
      const freshLeft = db
        .prepare("SELECT COUNT(*) AS c FROM app_achievement_change WHERE app_id = ?")
        .get(freshAppId) as { c: number };
      expect(oldLeft.c).toBe(0); // 1년 초과 → 삭제됨
      expect(freshLeft.c).toBe(1); // 최근 → 보존

      // 합성 데이터 정리.
      db.prepare("DELETE FROM app_achievement_change WHERE app_id IN (?, ?)").run(
        oldAppId,
        freshAppId
      );
    });
  });
});
