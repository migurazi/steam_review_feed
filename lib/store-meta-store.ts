/**
 * 성향 분석용 스토어 메타 영속 캐시 (SQLite, 테이블 store_meta_cache).
 *
 * 인메모리 LRU(`storemeta:{id}:KR`)의 백업. 재시작·HMR로 LRU가 비어도 라이브러리 수천 개를 다시
 * 받지 않도록 한다. GetItems는 100개/호출이라 다시 받아도 빠르지만(5,000개 ≈ 50회), 매 재시작마다
 * 반복할 이유는 없다.
 *
 * 값: storeItemToAppDetails 결과(축약 SteamAppDetails) 또는 null(메타 없음 — 삭제·지역 제한 앱).
 * null도 저장해 두어야 매 분석마다 같은 앱을 다시 묻지 않는다.
 */

import { getDb } from "./db";
import type { SteamAppDetails } from "./steam/types";

export interface StoreMetaEntry {
  details: SteamAppDetails | null;
  fetchedAt: number;
}

/** IN 절 한 번에 넣는 appid 수 (SQLite 바인딩 변수 한도보다 넉넉히 작게). */
const CHUNK = 500;

/**
 * 여러 appid의 메타를 한 번에 읽는다. fetched_at > minFetchedAt인 row만.
 * 손상된 JSON row는 건너뛴다(다음 조회가 덮어씀).
 */
export function getStoreMetaFromStore(
  appIds: readonly number[],
  minFetchedAt: number,
): Map<number, StoreMetaEntry> {
  const out = new Map<number, StoreMetaEntry>();
  const unique = Array.from(new Set(appIds));
  const db = getDb();
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    // placeholders는 "?"만으로 만든다 — 값은 바인딩으로 넘기므로 인젝션 여지 없음.
    const rows = db
      .prepare(
        `SELECT app_id, details, fetched_at FROM store_meta_cache
         WHERE fetched_at > ? AND app_id IN (${chunk.map(() => "?").join(",")})`
      )
      .all(minFetchedAt, ...chunk) as { app_id: number; details: string; fetched_at: number }[];
    for (const r of rows) {
      try {
        out.set(r.app_id, { details: JSON.parse(r.details) as SteamAppDetails | null, fetchedAt: r.fetched_at });
      } catch (err) {
        console.warn(`[store-meta-store] corrupted JSON for app ${r.app_id}:`, err);
      }
    }
  }
  return out;
}

/**
 * 신선한 row가 있는 appid만 돌려준다 (JSON은 읽지 않음).
 * /recommend가 조회 순서("캐시된 것 먼저")를 정할 때 라이브러리 수천 개의 details를 파싱하지 않도록
 * 키만 조회한다 (/code-review 4차 #8). 실제 값은 getStoreMetaBatch가 한 번만 읽는다.
 */
export function getStoreMetaIdsInStore(appIds: readonly number[], minFetchedAt: number): Set<number> {
  const out = new Set<number>();
  const unique = Array.from(new Set(appIds));
  const db = getDb();
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    const rows = db
      .prepare(
        `SELECT app_id FROM store_meta_cache
         WHERE fetched_at > ? AND app_id IN (${chunk.map(() => "?").join(",")})`
      )
      .all(minFetchedAt, ...chunk) as { app_id: number }[];
    for (const r of rows) out.add(r.app_id);
  }
  return out;
}

/** 여러 appid의 메타를 한 트랜잭션으로 저장한다 (INSERT OR REPLACE). */
export function setStoreMetaInStore(entries: ReadonlyMap<number, SteamAppDetails | null>, fetchedAt: number): void {
  if (entries.size === 0) return;
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO store_meta_cache (app_id, details, fetched_at) VALUES (?, ?, ?)
     ON CONFLICT(app_id) DO UPDATE SET details = excluded.details, fetched_at = excluded.fetched_at`
  );
  db.transaction(() => {
    for (const [id, details] of entries) stmt.run(id, JSON.stringify(details), fetchedAt);
  })();
}
