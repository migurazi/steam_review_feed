/**
 * SQLite 데이터베이스 초기화 및 쿼리 유틸리티.
 *
 * better-sqlite3는 동기(synchronous) API를 사용한다.
 * MVP 규모(WAU 100)에서는 이벤트 루프 블로킹이 문제되지 않는다.
 * 확장 시 PostgreSQL로 전환할 때 비동기 드라이버로 교체.
 */

import Database from "better-sqlite3";
import path from "path";

// DB 파일 경로: 프로젝트 루트의 data/ 디렉토리
// Docker 배포 시 볼륨 마운트 대상
const DB_PATH = path.join(process.cwd(), "data", "steam_review_feed.db");

let db: Database.Database | null = null;

/**
 * SQLite DB 인스턴스를 반환한다. 최초 호출 시 DB 파일 생성 및 스키마 초기화.
 * 싱글톤 패턴으로 프로세스 내 하나의 인스턴스만 유지한다.
 */
export function getDb(): Database.Database {
  if (db) return db;

  db = new Database(DB_PATH);

  // WAL 모드: 읽기/쓰기 동시성 향상
  db.pragma("journal_mode = WAL");

  // 스키마 초기화
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      user_id INTEGER PRIMARY KEY AUTOINCREMENT,
      steam_id TEXT UNIQUE NOT NULL,
      display_name TEXT,
      preferences TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      last_login_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS user_game_list (
      user_id INTEGER NOT NULL,
      app_id INTEGER NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('wishlist', 'library', 'manual')),
      added_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, app_id, source),
      FOREIGN KEY (user_id) REFERENCES users(user_id)
    );
  `);

  return db;
}

// --- 사용자 관련 쿼리 ---

export interface DbUser {
  user_id: number;
  steam_id: string;
  display_name: string | null;
  preferences: string;
  created_at: string;
  last_login_at: string;
}

/**
 * Steam ID로 사용자를 조회하거나 없으면 새로 생성한다 (upsert).
 * 이미 존재하면 last_login_at만 갱신한다.
 */
export function upsertUser(
  steamId: string,
  displayName?: string
): DbUser {
  const database = getDb();

  // INSERT OR IGNORE로 중복 시 무시, 이후 UPDATE로 last_login_at 갱신
  database
    .prepare(
      `INSERT INTO users (steam_id, display_name) VALUES (?, ?)
       ON CONFLICT(steam_id) DO UPDATE SET
         last_login_at = datetime('now'),
         display_name = COALESCE(excluded.display_name, users.display_name)`
    )
    .run(steamId, displayName ?? null);

  return database
    .prepare("SELECT * FROM users WHERE steam_id = ?")
    .get(steamId) as DbUser;
}

/**
 * Steam ID로 사용자를 조회한다. 없으면 null.
 */
export function getUserBySteamId(steamId: string): DbUser | null {
  const database = getDb();
  return (
    (database
      .prepare("SELECT * FROM users WHERE steam_id = ?")
      .get(steamId) as DbUser | undefined) ?? null
  );
}

/**
 * 마지막 로그인으로부터 6개월 경과한 사용자 데이터를 삭제한다.
 * 기획서 8.2절: "마지막 로그인으로부터 6개월, 이후 자동 삭제"
 */
export function cleanupExpiredUsers(): number {
  const database = getDb();

  const cleanup = database.transaction(() => {
    database.exec(`
      DELETE FROM user_game_list WHERE user_id IN (
        SELECT user_id FROM users
        WHERE last_login_at < datetime('now', '-6 months')
      )
    `);

    return database
      .prepare(
        "DELETE FROM users WHERE last_login_at < datetime('now', '-6 months')"
      )
      .run();
  });

  const result = cleanup();
  return result.changes;
}

// 만료 사용자 정리: 24시간마다 실행 (개인정보처리방침 준수)
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

export function startCleanupScheduler(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    try {
      const deleted = cleanupExpiredUsers();
      if (deleted > 0) {
        console.log(`[db] Cleaned up ${deleted} expired user(s)`);
      }
    } catch (err) {
      console.error("[db] Cleanup failed:", err);
    }
  }, CLEANUP_INTERVAL_MS);
  // 타이머가 프로세스 종료를 막지 않도록
  if (cleanupTimer && typeof cleanupTimer === "object" && "unref" in cleanupTimer) {
    cleanupTimer.unref();
  }
}

// DB 초기화 시 스케줄러 시작
startCleanupScheduler();
