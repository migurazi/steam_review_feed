/**
 * 도전과제 영속 계층 (SQLite).
 *
 * `lib/app-details-store.ts`와 동일한 규약: **raw row만 반환, TTL 판정은 caller**.
 * 개인 데이터 함수는 모듈 경계에서 `steamId`를 받아 내부에서 `getUserBySteamId`로
 * 변환하고, 사용자 행이 없으면 `null`/`false`/빈 결과를 반환한다 (M1,
 * lib/recommend-cache.ts 선례).
 *
 * 작업 지시서 20260825_01 §5.2. Phase 1/2/3 함수를 포함한다.
 */

import { getDb, getUserBySteamId } from "./db";
import type { AchievementDef } from "./steam/types";
import type { AchievementChange } from "./achievement-diff";

// --- 앱 공용: 스키마 스냅샷 ---

export interface SchemaStoreEntry {
  defs: AchievementDef[];
  hash: string;
  /** false면 "과제 없음"이 확정된 negative row (§4.1). */
  hasAchievements: boolean;
  /** negative 판정 연속 관측 횟수. */
  missStreak: number;
  fetchedAt: number;
}

/**
 * 앱의 스키마 스냅샷을 조회한다. 없으면 null.
 * schema JSON 파싱 실패(손상) 시 null + console.warn — 다음 write가 같은 row를
 * 덮어쓴다(app-details-store 선례).
 */
export function getSchemaFromStore(appId: number): SchemaStoreEntry | null {
  const row = getDb()
    .prepare(
      `SELECT schema, schema_hash, has_achievements, miss_streak, fetched_at
       FROM app_achievement_schema WHERE app_id = ?`
    )
    .get(appId) as
      | {
          schema: string;
          schema_hash: string;
          has_achievements: number;
          miss_streak: number;
          fetched_at: number;
        }
      | undefined;
  if (!row) return null;
  try {
    const defs = JSON.parse(row.schema) as AchievementDef[];
    return {
      defs,
      hash: row.schema_hash,
      hasAchievements: row.has_achievements === 1,
      missStreak: row.miss_streak,
      fetchedAt: row.fetched_at,
    };
  } catch (err) {
    console.warn(`[achievement-store] corrupted schema JSON for app ${appId}:`, err);
    return null;
  }
}

/**
 * 스키마 스냅샷을 저장한다. INSERT OR REPLACE — 최신 스냅샷이 이긴다.
 * 실제 과제가 확인된 것이므로 has_achievements=1, miss_streak=0으로 리셋한다
 * (이전에 일시적 negative였더라도 정상 복구).
 */
export function setSchemaInStore(
  appId: number,
  defs: AchievementDef[],
  hash: string
): void {
  getDb()
    .prepare(
      `INSERT INTO app_achievement_schema
         (app_id, schema, schema_hash, has_achievements, miss_streak, fetched_at)
       VALUES (?, ?, ?, 1, 0, ?)
       ON CONFLICT(app_id) DO UPDATE SET
         schema = excluded.schema,
         schema_hash = excluded.schema_hash,
         has_achievements = 1,
         miss_streak = 0,
         fetched_at = excluded.fetched_at`
    )
    .run(appId, JSON.stringify(defs), hash, Date.now());
}

/**
 * negative(과제 없음) 관측을 1회 누적하고 갱신된 miss_streak을 반환한다.
 *
 * "2회 연속 관측"에서만 negative를 확정하는 규칙(§4.1, §5.1.1)을 이 함수가
 * 캡슐화한다: 갱신된 streak이 2 이상이면 같은 문에서 has_achievements=0으로
 * 확정한다(1회성 이상 응답이 30일 캐시로 고착되는 것 방지). caller는 반환값으로
 * 확정 여부를 로깅/분기할 수 있다.
 *
 * 최초 관측(행 없음)은 miss_streak=1, has_achievements=1(미확정)로 생성한다.
 */
export function bumpSchemaMiss(appId: number): number {
  const db = getDb();
  const now = Date.now();
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO app_achievement_schema
         (app_id, schema, schema_hash, has_achievements, miss_streak, fetched_at)
       VALUES (?, '[]', '', 1, 1, ?)
       ON CONFLICT(app_id) DO UPDATE SET
         miss_streak = miss_streak + 1,
         -- miss_streak은 여기서 '갱신 전' 값이므로 +1이 곧 새 streak. 2 이상이면
         -- negative 확정. schema는 '[]'로, schema_hash는 ''로 함께 정규화한다 —
         -- 셋을 같이 리셋하지 않으면 defs=[]인데 hash에 이전 유효 값이 남아
         -- 스캔의 해시 비교가 어긋난다(정합성 유지).
         has_achievements = CASE WHEN miss_streak + 1 >= 2 THEN 0 ELSE has_achievements END,
         schema = CASE WHEN miss_streak + 1 >= 2 THEN '[]' ELSE schema END,
         schema_hash = CASE WHEN miss_streak + 1 >= 2 THEN '' ELSE schema_hash END,
         fetched_at = excluded.fetched_at`
    ).run(appId, now);
    const row = db
      .prepare("SELECT miss_streak FROM app_achievement_schema WHERE app_id = ?")
      .get(appId) as { miss_streak: number };
    return row.miss_streak;
  });
  return tx();
}

// --- 앱 공용: 전역 달성률 (Phase 2) ---

export interface GlobalStoreEntry {
  percentages: Record<string, number>;
  fetchedAt: number;
}

export function getGlobalFromStore(appId: number): GlobalStoreEntry | null {
  const row = getDb()
    .prepare("SELECT percentages, fetched_at FROM app_achievement_global WHERE app_id = ?")
    .get(appId) as { percentages: string; fetched_at: number } | undefined;
  if (!row) return null;
  try {
    return {
      percentages: JSON.parse(row.percentages) as Record<string, number>,
      fetchedAt: row.fetched_at,
    };
  } catch (err) {
    console.warn(`[achievement-store] corrupted global JSON for app ${appId}:`, err);
    return null;
  }
}

export function setGlobalInStore(
  appId: number,
  percentages: Record<string, number>
): void {
  getDb()
    .prepare(
      `INSERT INTO app_achievement_global (app_id, percentages, fetched_at)
       VALUES (?, ?, ?)
       ON CONFLICT(app_id) DO UPDATE SET
         percentages = excluded.percentages,
         fetched_at = excluded.fetched_at`
    )
    .run(appId, JSON.stringify(percentages), Date.now());
}

// --- 사용자별: 진행률 ---

export interface ProgressRow {
  unlocked: number;
  total: number;
  lastUnlockAt: number | null;
  unlocked30d: number;
  fetchedAt: number;
}

/** upsert 입력 행. §5.3.2 6/7단계에서 스캔이 구성한다. */
export interface ProgressUpsertRow {
  appId: number;
  unlocked: number;
  total: number;
  lastUnlockAt: number | null;
  unlocked30d: number;
  fetchedAt: number;
}

/**
 * 사용자의 진행률 행을 조회한다. `appIds`가 비어 있지 않으면 그 집합으로 필터링,
 * 비어 있으면 사용자의 전체 행을 반환한다.
 *
 * 구현 메모: appIds가 주어지면 `app_id IN (SELECT value FROM json_each(?))`로
 * 필터를 SQL에 위임한다 — 배열을 JSON 한 개 파라미터로 바인딩하므로 IN(...)
 * 바인드 상한도 피하고, 20개만 필요할 때 사용자 전체(수천 행)를 읽어 버리는
 * 낭비도 없앤다(better-sqlite3의 관용 패턴, JSON1은 기본 활성). 사용자 행 부재
 * 시 빈 Map.
 */
export function getProgress(
  steamId: string,
  appIds: number[] = []
): Map<number, ProgressRow> {
  const result = new Map<number, ProgressRow>();
  const user = getUserBySteamId(steamId);
  if (!user) return result;

  const db = getDb();
  const rows = (
    appIds.length > 0
      ? db
          .prepare(
            `SELECT app_id, unlocked, total, last_unlock_at, unlocked_30d, fetched_at
             FROM user_achievement_progress
             WHERE user_id = ? AND app_id IN (SELECT value FROM json_each(?))`
          )
          .all(user.user_id, JSON.stringify(appIds))
      : db
          .prepare(
            `SELECT app_id, unlocked, total, last_unlock_at, unlocked_30d, fetched_at
             FROM user_achievement_progress WHERE user_id = ?`
          )
          .all(user.user_id)
  ) as {
    app_id: number;
    unlocked: number;
    total: number;
    last_unlock_at: number | null;
    unlocked_30d: number;
    fetched_at: number;
  }[];

  for (const r of rows) {
    result.set(r.app_id, {
      unlocked: r.unlocked,
      total: r.total,
      lastUnlockAt: r.last_unlock_at,
      unlocked30d: r.unlocked_30d,
      fetchedAt: r.fetched_at,
    });
  }
  return result;
}

export interface ProgressSummary {
  totalUnlocked: number;
  totalAchievements: number;
  perfectGames: number;
  /** 게임별 달성률(unlocked/total)의 평균. 0~1. total=0 게임은 제외. */
  avgRate: number;
  /** SUM(unlocked_30d) — §5.6.1 "최근 30일 획득 수". */
  recent30d: number;
}

/**
 * 요약 카드용 집계(§5.6.1 4개 지표의 유일 출처). 사용자 행 부재 시 null.
 * 진행률 행이 하나도 없으면 전부 0인 요약을 반환한다.
 */
export function getProgressSummary(steamId: string): ProgressSummary | null {
  const user = getUserBySteamId(steamId);
  if (!user) return null;

  const row = getDb()
    .prepare(
      `SELECT
         COALESCE(SUM(unlocked), 0)  AS total_unlocked,
         COALESCE(SUM(total), 0)     AS total_achievements,
         COALESCE(SUM(CASE WHEN total > 0 AND unlocked = total THEN 1 ELSE 0 END), 0) AS perfect_games,
         COALESCE(AVG(CASE WHEN total > 0 THEN unlocked * 1.0 / total END), 0) AS avg_rate,
         COALESCE(SUM(unlocked_30d), 0) AS recent_30d
       FROM user_achievement_progress WHERE user_id = ?`
    )
    .get(user.user_id) as {
      total_unlocked: number;
      total_achievements: number;
      perfect_games: number;
      avg_rate: number;
      recent_30d: number;
    };

  return {
    totalUnlocked: row.total_unlocked,
    totalAchievements: row.total_achievements,
    perfectGames: row.perfect_games,
    avgRate: row.avg_rate,
    recent30d: row.recent_30d,
  };
}

/**
 * 진행률 행들을 단일 트랜잭션으로 upsert한다. 사용자 행 부재 시 no-op + false.
 *
 * §7.4: better-sqlite3는 동기 API라 수천 건 개별 커밋 시 이벤트 루프를 막는다 —
 * caller가 20개 단위로 잘라 호출하고, 이 함수는 받은 묶음을 한 트랜잭션으로 쓴다.
 */
export function upsertProgressBatch(
  steamId: string,
  rows: ProgressUpsertRow[]
): boolean {
  const user = getUserBySteamId(steamId);
  if (!user) return false;
  if (rows.length === 0) return true;

  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO user_achievement_progress
       (user_id, app_id, unlocked, total, last_unlock_at, unlocked_30d, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, app_id) DO UPDATE SET
       unlocked = excluded.unlocked,
       total = excluded.total,
       last_unlock_at = excluded.last_unlock_at,
       unlocked_30d = excluded.unlocked_30d,
       fetched_at = excluded.fetched_at`
  );
  const tx = db.transaction((batch: ProgressUpsertRow[]) => {
    for (const r of batch) {
      stmt.run(
        user.user_id,
        r.appId,
        r.unlocked,
        r.total,
        r.lastUnlockAt,
        r.unlocked30d,
        r.fetchedAt
      );
    }
  });
  tx(rows);
  return true;
}

// --- Phase 3: 스키마 변경 이력 + 사용자 알림 ---

export type AlertKind = "perfect_broken" | "changed";

export interface AlertInput {
  appId: number;
  kind: AlertKind;
  /** 배너 문구 구성용 JSON (게임명, 추가/삭제 수 등). */
  payload: unknown;
  /** 감지 시각(ms). 생략 시 now. */
  detectedAt?: number;
}

export interface StoredAlert {
  alertId: number;
  appId: number;
  kind: AlertKind;
  detectedAt: number;
  payload: unknown;
}

/**
 * 앱 공용 스키마 변경 이력을 append한다 (Phase 3, §5.4). 단일 트랜잭션.
 * detected_at은 **Unix ms**(Date.now())로 저장한다 — cleanupOldAchievementChanges의
 * 계약(db.ts). before/after는 renamed/desc의 이전·이후 문자열(없으면 null).
 */
export function insertChanges(appId: number, changes: AchievementChange[]): void {
  if (changes.length === 0) return;
  const db = getDb();
  const now = Date.now();
  const DAY_MS = 86_400_000;
  const dayStart = Math.floor(now / DAY_MS) * DAY_MS;
  // 앱 공용 이력 — 여러 사용자의 스캔이 async로 교차되며 같은 변경을 각자 기록하는
  // 중복을 막는다(코드리뷰 #5): 같은 (app, kind, api_name)이 같은 날 이미 있으면 생략.
  const stmt = db.prepare(
    `INSERT INTO app_achievement_change
       (app_id, detected_at, kind, api_name, before_value, after_value)
     SELECT ?, ?, ?, ?, ?, ?
     WHERE NOT EXISTS (
       SELECT 1 FROM app_achievement_change
       WHERE app_id = ? AND kind = ? AND api_name = ?
         AND detected_at >= ? AND detected_at < ?
     )`
  );
  const tx = db.transaction((list: AchievementChange[]) => {
    for (const c of list) {
      stmt.run(
        appId,
        now,
        c.kind,
        c.apiName,
        c.before ?? null,
        c.after ?? null,
        appId,
        c.kind,
        c.apiName,
        dayStart,
        dayStart + DAY_MS
      );
    }
  });
  tx(changes);
}

/**
 * 사용자 알림을 저장한다 (Phase 3). 사용자 행 부재 시 no-op + false.
 *
 * **중복 무시**(§8 #11): 두 탭/두 스캔이 같은 변경을 두 번 감지해도 알림이 한 번만
 * 남도록, `(user_id, app_id, kind, 같은 날)` 기준으로 이미 있으면 삽입하지 않는다.
 * "같은 날" = detected_at(ms)의 정수 나눗셈 일자 버킷(detected_at/86400000).
 */
export function insertAlerts(steamId: string, alerts: AlertInput[]): boolean {
  const user = getUserBySteamId(steamId);
  if (!user) return false;
  if (alerts.length === 0) return true;

  const db = getDb();
  // 중복 무시(§8 #11, 코드리뷰 #7): 같은 (user, app, kind)의 **미확인**(seen_at NULL)
  // 알림이 이미 있으면 다시 넣지 않는다 — 배너가 떠 있는 동안 같은 알림이 쌓이지
  // 않게. 사용자가 '모두 확인'(seen)한 뒤 새 변경이 오면 다시 알림된다. 타임존/자정
  // 경계와 무관하다(이전의 UTC 하루 버킷 방식이 KST 09:00 경계에서 중복을 새게 함).
  const stmt = db.prepare(
    `INSERT INTO user_achievement_alert (user_id, app_id, kind, detected_at, payload, seen_at)
     SELECT ?, ?, ?, ?, ?, NULL
     WHERE NOT EXISTS (
       SELECT 1 FROM user_achievement_alert
       WHERE user_id = ? AND app_id = ? AND kind = ? AND seen_at IS NULL
     )`
  );
  const tx = db.transaction((list: AlertInput[]) => {
    for (const a of list) {
      const at = a.detectedAt ?? Date.now();
      stmt.run(
        user.user_id,
        a.appId,
        a.kind,
        at,
        JSON.stringify(a.payload),
        user.user_id,
        a.appId,
        a.kind
      );
    }
  });
  tx(alerts);
  return true;
}

/**
 * 미확인(seen_at NULL) 알림을 최신순으로 반환한다. 사용자 부재/무알림이면 빈 배열.
 * payload JSON 파싱 실패 시 null로 흡수.
 */
export function getUnseenAlerts(steamId: string, limit: number): StoredAlert[] {
  const user = getUserBySteamId(steamId);
  if (!user) return [];
  const rows = getDb()
    .prepare(
      `SELECT alert_id, app_id, kind, detected_at, payload
       FROM user_achievement_alert
       WHERE user_id = ? AND seen_at IS NULL
       ORDER BY detected_at DESC LIMIT ?`
    )
    .all(user.user_id, limit) as {
      alert_id: number;
      app_id: number;
      kind: AlertKind;
      detected_at: number;
      payload: string;
    }[];
  return rows.map((r) => {
    let payload: unknown = null;
    try {
      payload = JSON.parse(r.payload);
    } catch {
      payload = null;
    }
    return {
      alertId: r.alert_id,
      appId: r.app_id,
      kind: r.kind,
      detectedAt: r.detected_at,
      payload,
    };
  });
}

/** 사용자의 미확인 알림을 모두 확인 처리한다(배너 닫기). 처리된 행 수 반환. */
export function markAlertsSeen(steamId: string): number {
  const user = getUserBySteamId(steamId);
  if (!user) return 0;
  const res = getDb()
    .prepare(
      `UPDATE user_achievement_alert SET seen_at = ?
       WHERE user_id = ? AND seen_at IS NULL`
    )
    .run(Date.now(), user.user_id);
  return res.changes;
}
