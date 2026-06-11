/**
 * SQLite 데이터베이스 초기화 및 쿼리 유틸리티.
 *
 * better-sqlite3는 동기(synchronous) API를 사용한다.
 * MVP 규모(WAU 100)에서는 이벤트 루프 블로킹이 문제되지 않는다.
 * 확장 시 PostgreSQL로 전환할 때 비동기 드라이버로 교체.
 *
 * 주의: 이 모듈은 import만으로 사이드이펙트를 발생시키지 않는다.
 *       정리 스케줄러는 initDb()를 명시적으로 호출해야 시작된다.
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

    -- /recommend 분석 결과 캐시 — 사용자별 1행.
    -- 사용자가 옵션을 바꾸지 않은 채 재방문하면 이 캐시에서 즉시 결과를 보여
    -- 주고 백그라운드에서 새 분석을 진행한다. 새 분석이 끝나면 같은 행을
    -- REPLACE 한다. 옵션이 바뀐 경우엔 options_hash가 달라 cache miss.
    CREATE TABLE IF NOT EXISTS recommendation_cache (
      user_id INTEGER PRIMARY KEY,
      options_hash TEXT NOT NULL,
      payload TEXT NOT NULL,
      computed_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(user_id)
    );

    -- 앱(게임) 메타 영속 캐시 — 사용자에 의존하지 않는 공용 테이블.
    -- 인메모리 LRU 캐시는 서버 재시작 시 비고 Rate Limit 상황에서 appdetails
    -- 호출이 실패하면 fallback이 "AppID 12345"가 되어 UX가 나빠진다. 한 번
    -- 이라도 성공해서 받은 name/header_image를 여기 저장해 다음에 반드시
    -- 표시되도록 한다.
    CREATE TABLE IF NOT EXISTS app_meta (
      app_id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      header_image TEXT,
      updated_at INTEGER NOT NULL
    );

    -- 앱 상세(SteamAppDetails) 영속 캐시 — 인메모리 LRU의 백업.
    -- 인메모리 LRU(lib/cache.ts)는 dev HMR이나 서버 재시작 시 비워지는데,
    -- 5000+ 라이브러리의 appdetails 한 번 fetch에 ~30분 걸리므로 LRU 분실
    -- 시 매번 처음부터 시작하는 회귀가 발생한다. 한 번 성공해 받은 details를
    -- 여기에도 저장해 두면 LRU miss 시 SQLite에서 hydrate해 즉시 hit으로 처리.
    --
    -- price_overview는 별도 짧은 TTL 캐시(app:{appId}:price:KR, 1시간) 대상
    -- 이므로 본 테이블에 저장하기 전 caller가 stripping해야 한다. 7일 지난
    -- price를 hydrate해서 표시하면 잘못된 할인율 등이 보일 수 있음.
    --
    -- TTL은 read 시점에 fetched_at으로 검사 (CACHE_TTL.appInfo, 7일). 만료된
    -- row는 즉시 cache miss로 처리하고 API 재호출. 만료 row의 자동 삭제는
    -- 별도 정리 루틴 없이도 다음 갱신 시 INSERT OR REPLACE로 덮어쓴다.
    CREATE TABLE IF NOT EXISTS app_details_cache (
      app_id INTEGER PRIMARY KEY,
      details TEXT NOT NULL,
      fetched_at INTEGER NOT NULL
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
 * 이미 존재하면 last_login_at과 display_name을 갱신한다.
 *
 * @param steamId Steam64 ID
 * @param displayName Steam 닉네임 (없으면 기존 값 유지)
 * @returns upsert된 사용자 레코드
 */
export function upsertUser(
  steamId: string,
  displayName?: string
): DbUser {
  const database = getDb();

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
 * Steam ID로 사용자를 조회한다.
 *
 * @param steamId Steam64 ID
 * @returns 사용자 레코드. 없으면 null.
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
 *
 * 트랜잭션으로 user_game_list -> users 순서로 삭제하여 FK 제약을 준수한다.
 *
 * @returns 삭제된 사용자 수
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
    database.exec(`
      DELETE FROM recommendation_cache WHERE user_id IN (
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

// --- 정리 스케줄러 ---

/** 만료 사용자 정리 간격: 24시간 */
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

/**
 * 만료 사용자 자동 정리 스케줄러를 시작한다.
 * 24시간마다 cleanupExpiredUsers()를 실행한다 (개인정보처리방침 준수).
 *
 * 주의: 이 함수는 명시적으로 호출해야 한다. 모듈 import만으로는 시작되지 않는다.
 *       서버 초기화 시점(예: 미들웨어, layout)에서 한 번 호출한다.
 */
export function startCleanupScheduler(): void {
  if (cleanupTimer) return; // 중복 시작 방지
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
  // 타이머가 프로세스 종료를 막지 않도록 unref
  if (cleanupTimer && typeof cleanupTimer === "object" && "unref" in cleanupTimer) {
    cleanupTimer.unref();
  }
}

/**
 * 정리 스케줄러를 중지한다. 테스트에서 사용.
 */
export function stopCleanupScheduler(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}
