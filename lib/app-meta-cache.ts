/**
 * 앱(게임) 메타 영속 캐시.
 *
 * 인메모리 LRU 캐시(`lib/cache.ts`)는 서버 재시작 시 비어버리고, Steam의
 * 비공식 appdetails API가 Rate Limit으로 실패하면 fallback이 "AppID 12345"
 * 가 되어 사용자 UX가 망가진다. 한 번이라도 성공해서 받은 name/header_image
 * 를 DB에 저장해 두면 다음 요청에서는 인메모리 캐시 미스 + API 실패 상황에서도
 * 게임 이름을 표시할 수 있다.
 *
 * 사용 패턴 (호출 측 책임):
 *   - 쓰기: getAppDetails 성공 시, getOwnedGames 성공 시 (라이브러리 일괄 upsert)
 *   - 읽기: gameName resolution chain의 최종 fallback (AppID 직전)
 *
 * 스키마는 `lib/db.ts`의 getDb() 초기화 블록에 정의되어 있다.
 */

import { getDb } from "./db";

export interface AppMetaEntry {
  appId: number;
  name: string;
  headerImage: string | null;
  updatedAt: number;
}

/**
 * appId → name/header_image 조회. 없으면 null.
 */
export function getAppMeta(appId: number): AppMetaEntry | null {
  const row = getDb()
    .prepare(
      "SELECT app_id, name, header_image, updated_at FROM app_meta WHERE app_id = ?"
    )
    .get(appId) as
      | { app_id: number; name: string; header_image: string | null; updated_at: number }
      | undefined;
  if (!row) return null;
  return {
    appId: row.app_id,
    name: row.name,
    headerImage: row.header_image,
    updatedAt: row.updated_at,
  };
}

/**
 * upsert 한 건. name이 빈 문자열이면 무시 (의미 있는 이름만 저장).
 *
 * header_image normalize:
 *   Steam appdetails는 unreleased / region-locked / delisted 게임에 대해
 *   header_image=''(빈 문자열)을 반환하는 경우가 관측됨. 이 값을 그대로
 *   넘기면 COALESCE가 ''를 non-null로 간주해 기존에 저장된 좋은 이미지를
 *   덮어쓴다 → /feed의 fallback이 깨진 이미지를 표시.
 *
 *   `headerImage ?? null`은 undefined만 null로 변환하므로 빈 문자열은 그대로
 *   통과한다. 빈 문자열도 null로 normalize하여 "값 없음"을 일관 표현하고,
 *   COALESCE가 기존 값을 보존하도록 한다.
 */
export function setAppMeta(
  appId: number,
  name: string,
  headerImage?: string | null
): void {
  if (!name) return;
  // null/undefined/'' 모두 SQL NULL로 통일 — COALESCE가 기존 값 보존하도록.
  const normalizedHeader = headerImage ? headerImage : null;
  getDb()
    .prepare(
      `INSERT INTO app_meta (app_id, name, header_image, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(app_id) DO UPDATE SET
         name = excluded.name,
         header_image = COALESCE(excluded.header_image, app_meta.header_image),
         updated_at = excluded.updated_at`
    )
    .run(appId, name, normalizedHeader, Date.now());
}

/**
 * store 출처 entry 여러 개를 단일 트랜잭션으로 저장한다 — setAppMeta와 같은 규칙(이름 덮어쓰기,
 * header_image는 COALESCE로 빈 값이면 기존 보존).
 *
 * GetItems 메타 배치(getStoreMetaBatch)가 쓴다. 이전 appdetails 경로는 게임마다 setAppMeta를 불러
 * app_meta를 채웠고 도전과제 탭(achievement-scan)이 그 이름·헤더 이미지를 읽는다. GetItems로 바꾼 뒤에도
 * 같은 캐시를 채워야 헤더 이미지가 빠지지 않는다 (/code-review 4차 #4).
 * setAppMetaBatch(라이브러리 출처, INSERT OR IGNORE)와 달리 store 값이 기존 값을 이긴다.
 */
export function setAppMetaFromStoreBatch(
  entries: { appId: number; name: string; headerImage?: string | null }[]
): void {
  const valid = entries.filter(e => e.name);
  if (valid.length === 0) return;
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO app_meta (app_id, name, header_image, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(app_id) DO UPDATE SET
       name = excluded.name,
       header_image = COALESCE(excluded.header_image, app_meta.header_image),
       updated_at = excluded.updated_at`
  );
  const now = Date.now();
  db.transaction((rows: typeof valid) => {
    for (const r of rows) stmt.run(r.appId, r.name, r.headerImage ? r.headerImage : null, now);
  })(valid);
}

/**
 * 다수 entry를 단일 트랜잭션으로 batch 저장한다. 라이브러리 응답
 * (IPlayerService/GetOwnedGames)의 5000+ 게임을 한 번에 처리하는 hot path.
 *
 * 중요한 차이 (setAppMeta vs setAppMetaBatch):
 *   - setAppMeta (store appdetails 출처): INSERT … ON CONFLICT(app_id) DO UPDATE.
 *     name은 항상 덮어쓰고 header_image는 COALESCE로 새 값이 NULL이면 기존 값
 *     보존. store 응답이 가장 권위 있는 이름/이미지.
 *   - setAppMetaBatch (라이브러리 출처): INSERT OR IGNORE. 기존 row가 있으면
 *     건드리지 않는다. 라이브러리 응답의 name은 가끔 store와 다르다 (지역 표기,
 *     ® / ™ 부착, demo / beta suffix 등). store에서 받아 둔 정제된 이름을
 *     라이브러리 batch가 덮어쓰면 /feed의 fallback에서 강등된 이름이 표시되는
 *     회귀가 발생한다.
 *
 * 호출 측: name이 빈 문자열인 entry는 자동 필터링되므로 그대로 넘겨도 됨.
 */
export function setAppMetaBatch(
  entries: { appId: number; name: string; headerImage?: string | null }[]
): void {
  const valid = entries.filter(e => e.name);
  if (valid.length === 0) return;

  const db = getDb();
  // INSERT OR IGNORE: 같은 app_id row가 있으면 무시. store 출처의 quality 데이터
  // 보호 + library 출처가 새 row를 채우는 양쪽 목적 충족.
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO app_meta (app_id, name, header_image, updated_at)
     VALUES (?, ?, ?, ?)`
  );
  const now = Date.now();
  const tx = db.transaction((rows: typeof valid) => {
    // setAppMeta와 동일하게 빈 문자열은 SQL NULL로 normalize (setAppMeta 주석 참조).
    // 라이브러리 batch는 현재 headerImage를 안 넘기지만, 미래 호출자/refactor가
    // 빈 문자열을 그대로 넘겨도 NULL로 저장되어 의미 일관성 유지.
    for (const r of rows) stmt.run(r.appId, r.name, r.headerImage ? r.headerImage : null, now);
  });
  tx(valid);
}
