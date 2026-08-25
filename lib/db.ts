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
import { APP_ROOT } from "./app-root";

// DB 파일 경로: 프로젝트 루트의 data/ 디렉토리 (Docker 배포 시 볼륨 마운트 대상).
// APP_ROOT를 쓰는 이유: standalone 서버는 cwd를 .next/standalone 으로 바꾸므로
// process.cwd()로 잡으면 DB가 빌드 산출물 안에 들어가 재빌드 때 삭제/잠금된다.
const DB_PATH = path.join(APP_ROOT, "data", "steam_review_feed.db");

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
  // 라이터 경합 시 즉시 SQLITE_BUSY로 실패하지 않고 최대 5초 대기한다. WAL은
  // 다중 리더 + 단일 라이터를 허용하는데, 도전과제 SSE 스캔·정리 스케줄러가 동시에
  // 쓰거나(다중 연결), 테스트가 병렬로 실행될 때 라이터가 겹치면 대기가 필요하다.
  db.pragma("busy_timeout = 5000");

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

    -- ===== 도전과제 (작업 지시서 20260825_01) =====
    -- 기존 테이블 변경이 없으므로 마이그레이션 불필요 (CREATE TABLE IF NOT EXISTS).

    -- [Phase 1] 앱 도전과제 스키마 스냅샷 (앱 공용, 사용자 비의존).
    -- app_meta / app_details_cache 와 같은 계층. 전 사용자가 공유하므로 앱당 1회만
    -- fetch 한다.
    --   schema: 정규화된 AchievementDef[] JSON (§5.1.2). has_achievements=0 인
    --     negative row는 '[]' 를 저장한다.
    --   schema_hash: diff 대상 필드만으로 계산 (§5.4.2). negative row는 빈 문자열.
    --   has_achievements: 0이면 "과제 없음"이 확인된 앱 (재조회를 막는 negative
    --     cache). HTTP 실패는 여기에 기록하지 않는다 (§5.1.1 3분기 규칙).
    --   miss_streak: negative 판정 연속 관측 횟수. 2 이상에서만 has_achievements=0
    --     을 확정한다 (1회성 이상 응답의 30일 고착 방지).
    CREATE TABLE IF NOT EXISTS app_achievement_schema (
      app_id INTEGER PRIMARY KEY,
      schema TEXT NOT NULL,
      schema_hash TEXT NOT NULL,
      has_achievements INTEGER NOT NULL DEFAULT 1,
      miss_streak INTEGER NOT NULL DEFAULT 0,
      fetched_at INTEGER NOT NULL
    );

    -- [Phase 2] 전역 달성률 (앱 공용, API Key 불필요).
    --   percentages: { [apiName]: number } 정규화 저장. 원본 percent는 string이므로
    --     저장 전 parseFloat (§3.1).
    CREATE TABLE IF NOT EXISTS app_achievement_global (
      app_id INTEGER PRIMARY KEY,
      percentages TEXT NOT NULL,
      fetched_at INTEGER NOT NULL
    );

    -- [Phase 1] 사용자별 게임 진행률 요약.
    -- 과제별 상세는 저장하지 않는다 — 수천 게임 x 과제 50개면 수십만 행이 되고,
    -- 상세는 사용자가 게임을 펼칠 때만 필요하다 (온디맨드, §5.5.2).
    --   이 테이블의 "현재 행"이 다음 스캔 시점에는 "직전 상태"가 된다. §5.4.4의
    --   완벽달성 해제 판정은 upsert 이전에 이 행을 읽어 수행한다 (별도 이력 컬럼
    --   불필요). 순서를 어기면(먼저 덮어쓰면) 판정 불가.
    --   unlocked_30d: 스캔 시점 기준 최근 30일 내 획득한 과제 수. §5.6.1 요약 카드
    --     "최근 30일 획득 수"의 유일한 근거다. 과제별 unlockTime 은 온디맨드라 영속
    --     저장하지 않으므로, 스캔 시 그 자리에서 집계해 이 스칼라만 저장한다.
    --     last_unlock_at(게임당 최신 1건)으로는 "획득 개수"를 산출할 수 없다.
    CREATE TABLE IF NOT EXISTS user_achievement_progress (
      user_id INTEGER NOT NULL,
      app_id INTEGER NOT NULL,
      unlocked INTEGER NOT NULL,
      total INTEGER NOT NULL,
      last_unlock_at INTEGER,
      unlocked_30d INTEGER NOT NULL DEFAULT 0,
      fetched_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, app_id),
      FOREIGN KEY (user_id) REFERENCES users(user_id)
    );

    -- [Phase 3] 스키마 변경 이력 (앱 공용, append-only).
    -- before/after는 SQL 예약어 혼동을 피해 before_value/after_value로 명명.
    CREATE TABLE IF NOT EXISTS app_achievement_change (
      change_id INTEGER PRIMARY KEY AUTOINCREMENT,
      app_id INTEGER NOT NULL,
      detected_at INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('added','removed','renamed','desc','unhidden')),
      api_name TEXT NOT NULL,
      before_value TEXT,
      after_value TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_ach_change_app_time
      ON app_achievement_change (app_id, detected_at DESC);

    -- [Phase 3] 사용자별 알림. 스캔 시점에 판정된 결과를 영속화한다.
    -- 판정 재료(직전 진행률)가 upsert로 사라지므로 스캔 시점이 판정 가능한 유일한
    -- 시점이다 (§5.4.4). seen_at: 배너 확인 시각. NULL이면 미확인.
    CREATE TABLE IF NOT EXISTS user_achievement_alert (
      alert_id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      app_id INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('perfect_broken','changed')),
      detected_at INTEGER NOT NULL,
      payload TEXT NOT NULL,
      seen_at INTEGER,
      FOREIGN KEY (user_id) REFERENCES users(user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_ach_alert_user
      ON user_achievement_alert (user_id, detected_at DESC);
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
 * 사용자별(개인 데이터) 자식 테이블. `users`를 참조하며, 사용자 만료 시 이 행들도
 * 함께 지워야 한다. **순서가 곧 정합성**이다: getDb()가 `PRAGMA foreign_keys`를
 * 켜지 않아 FK가 강제되지 않으므로(ON DELETE CASCADE도 없음), 이 테이블들을 `users`
 * DELETE보다 먼저 지워야 고아 행이 남지 않는다.
 *
 * 개별 DELETE를 손으로 복붙하는 대신 이 배열을 순회한다 — 신규 개인 테이블은 여기
 * 한 줄만 추가하면 되고, 자식→부모 순서가 구조적으로 보장된다(§4.2, M2/E3).
 * (테이블명은 코드 상수라 SQL 인젝션 위험 없음.)
 */
const USER_CHILD_TABLES = [
  "user_game_list",
  "recommendation_cache",
  "user_achievement_progress",
  "user_achievement_alert",
] as const;

/** 만료 사용자 판정 조건 (자식/부모 삭제에서 공유). */
const EXPIRED_USER_PREDICATE = "last_login_at < datetime('now', '-6 months')";

/**
 * 마지막 로그인으로부터 6개월 경과한 사용자 데이터를 삭제한다.
 * 기획서 8.2절: "마지막 로그인으로부터 6개월, 이후 자동 삭제"
 *
 * 트랜잭션으로 자식 테이블 전부 → users 순서로 삭제하여 FK 제약(비강제)을 순서로
 * 준수한다.
 *
 * @returns 삭제된 사용자 수
 */
export function cleanupExpiredUsers(): number {
  const database = getDb();

  const cleanup = database.transaction(() => {
    // 자식 먼저 — 배열 순회로 복붙 제거 + 순서 구조적 보장.
    for (const table of USER_CHILD_TABLES) {
      database.exec(
        `DELETE FROM ${table} WHERE user_id IN (
           SELECT user_id FROM users WHERE ${EXPIRED_USER_PREDICATE}
         )`
      );
    }
    // 부모 마지막.
    return database
      .prepare(`DELETE FROM users WHERE ${EXPIRED_USER_PREDICATE}`)
      .run();
  });

  const result = cleanup();
  return result.changes;
}

/**
 * 1년 경과한 도전과제 변경 이력을 삭제한다.
 *
 * `app_achievement_change`는 앱 공용 append-only 테이블이라 사용자 만료와 무관하게
 * 무한 증가한다. `cleanupExpiredUsers`(개인정보 6개월)와 성격이 다르므로 별도
 * 함수로 두고, 같은 `startCleanupScheduler` 타이머에서 함께 호출한다
 * (작업 지시서 20260825_01 §4.2, Q3/L6).
 *
 * 앱 공용 스키마/전역률 테이블(app_achievement_schema/global)은 최신 1행만
 * 유지(INSERT OR REPLACE)하므로 정리 대상이 아니다.
 *
 * **detected_at 저장 단위 계약(중요)**: 이 비교는 `detected_at`이 **Unix 밀리초**
 * (`Date.now()`)로 저장됨을 전제한다. `app_achievement_change`에 행을 쓰는 모든
 * 코드(Phase 3 insertChanges 등)는 반드시 `Date.now()` ms를 넣어야 한다. 만약
 * 초 단위나 `datetime('now')` 텍스트(기존 users/user_game_list 관례)로 저장하면 이
 * 비교가 전 이력을 삭제하거나 사전식으로 오작동한다. 이 계약은 `db.test.ts`의
 * `cleanupOldAchievementChanges` 테스트가 실제 DELETE로 고정한다.
 *
 * @returns 삭제된 이력 행 수
 */
export function cleanupOldAchievementChanges(): number {
  const database = getDb();
  const result = database
    .prepare(
      "DELETE FROM app_achievement_change WHERE detected_at < ?"
    )
    // detected_at은 Unix ms 저장 → 1년 전 시각을 ms로 계산해 비교.
    .run(Date.now() - 365 * 24 * 60 * 60 * 1000);
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
    // 도전과제 변경 이력 정리 — 개인 정리와 독립 실패하도록 try/catch 분리.
    try {
      const purged = cleanupOldAchievementChanges();
      if (purged > 0) {
        console.log(`[db] Purged ${purged} old achievement change(s)`);
      }
    } catch (err) {
      console.error("[db] Achievement change cleanup failed:", err);
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
