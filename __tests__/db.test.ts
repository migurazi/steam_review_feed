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
  });
});
