/**
 * SteamAppDetails 영속 캐시 (SQLite).
 *
 * 인메모리 LRU(lib/cache.ts)의 backup. dev HMR이나 서버 재시작으로 LRU가
 * 비워져도 DB에서 즉시 hydrate해 5000+ 라이브러리의 cold path 재현을 막는다.
 *
 * 사용 패턴 (호출 측 책임 — lib/steam/api.ts::getAppDetails):
 *   1) LRU 체크 (기존)
 *   2) miss이면 getAppDetailsFromStore(appId) 호출
 *   3) fresh DB row가 있으면 LRU에 hydrate + 즉시 반환
 *   4) miss이거나 만료되면 API 호출 → 성공 시 setAppDetailsInStore + LRU 양쪽 저장
 *
 * price_overview는 caller가 store 저장 전 stripping해야 한다. 7일 지난 price를
 * hydrate해 보여주면 사용자가 stale 할인/가격 정보를 보게 됨.
 */

import { getDb } from "./db";
import type { SteamAppDetails } from "./steam/types";

export interface AppDetailsCacheEntry {
  details: SteamAppDetails;
  fetchedAt: number;
}

/**
 * appId의 영속 details를 조회한다.
 *
 * TTL 검사는 호출 측에서 한다 — 모듈은 raw row만 반환하고, 신선도 판단은
 * lib/cache.ts의 CACHE_TTL을 참조하는 호출 측에서 일관 처리.
 *
 * JSON.parse 실패(손상) 시 null 반환 + 로그 — 같은 row를 다음 write가 덮어쓴다.
 */
export function getAppDetailsFromStore(appId: number): AppDetailsCacheEntry | null {
  const row = getDb()
    .prepare("SELECT details, fetched_at FROM app_details_cache WHERE app_id = ?")
    .get(appId) as { details: string; fetched_at: number } | undefined;
  if (!row) return null;
  try {
    const details = JSON.parse(row.details) as SteamAppDetails;
    return { details, fetchedAt: row.fetched_at };
  } catch (err) {
    console.warn(`[app-details-store] corrupted JSON for app ${appId}:`, err);
    return null;
  }
}

/**
 * appId의 details를 영속 저장한다. INSERT OR REPLACE — 항상 최신 본문이 이긴다.
 *
 * 주의: details에 price_overview가 포함돼 있어도 그대로 저장. caller에서
 * stripping을 깜박하면 stale price가 hydrate에 섞일 수 있음. 명시적 인터페이스는
 * 정직 — caller에게 책임을 위임하지만 README/주석으로 강하게 안내.
 */
export function setAppDetailsInStore(appId: number, details: SteamAppDetails): void {
  getDb()
    .prepare(
      `INSERT INTO app_details_cache (app_id, details, fetched_at)
       VALUES (?, ?, ?)
       ON CONFLICT(app_id) DO UPDATE SET
         details = excluded.details,
         fetched_at = excluded.fetched_at`
    )
    .run(appId, JSON.stringify(details), Date.now());
}

/**
 * 테스트/디버깅용 명시적 삭제.
 */
export function deleteAppDetailsFromStore(appId: number): void {
  getDb().prepare("DELETE FROM app_details_cache WHERE app_id = ?").run(appId);
}
