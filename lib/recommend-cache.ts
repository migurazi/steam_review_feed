/**
 * /recommend 분석 결과 캐시 (SQLite).
 *
 * 사용 시나리오:
 *   1. 사용자가 /recommend 페이지를 연다.
 *   2. 같은 옵션으로 분석한 적이 있으면 cache hit → 즉시 "이전 분석 결과" 표시.
 *   3. 동시에 새 SSE 분석이 시작 → partial-result → 최종 result.
 *   4. 최종 result 직후 새 캐시를 덮어쓴다.
 *
 * 옵션이 다르면 (options_hash 불일치) cache miss로 처리한다 — 캐시는 사용자별
 * 1행만 유지하여 무제한 누적을 피한다.
 *
 * 스키마는 `lib/db.ts`의 getDb() 초기화 블록에 정의되어 있다.
 */

import { getDb, getUserBySteamId } from "./db";
import type { AnalyzeOptions, TasteProfile, Recommendation } from "./steam/profile";

/**
 * 캐시에 저장하는 payload. JSON 직렬화하여 TEXT 컬럼에 보관.
 *
 * 추천 산출에 필요한 모든 사용자 가시 데이터를 포함하되, 산출 옵션 자체는
 * options_hash에 의해 캐시 키로 분리되어 있어 payload에 중복 저장하지 않는다.
 */
export interface RecommendationCachePayload {
  profile: TasteProfile;
  libraryUnplayed: Recommendation[];
  wishlist: Recommendation[];
  ownedGames: number;
  wishlistGames: number;
  wishlistFetchFailed: boolean;
  /**
   * 미보유 할인 게임 발굴 결과 (tracks.deal, 작업 지시서 20261010_01 단계 2).
   * undefined = 발굴을 요청하지 않았거나 결과가 없음(진행 중 이탈·실패). 구 row 파싱 호환.
   */
  storeDeals?: Recommendation[];
}

export interface RecommendationCacheEntry {
  payload: RecommendationCachePayload;
  /** Unix ms — 마지막 분석 완료 시각 */
  computedAt: number;
}

/**
 * 캐시 키 입력. AnalyzeOptions에 더해 tracks(라이브러리/위시 트랙 활성 여부)
 * 까지 포함해야 의미 있는 분리가 된다 — tracks=lib과 tracks=lib,wish는 같은
 * AnalyzeOptions로도 결과 페이로드가 다르다.
 */
export interface CacheKeyInput {
  options: AnalyzeOptions;
  tracks: { lib: boolean; wish: boolean; deal?: boolean };
}

/**
 * 결정론적 해시 문자열 생성.
 *
 * 핵심 설계:
 *   - Object.keys(opts).sort()로 키 자동 enumerate. AnalyzeOptions에 새 필드가
 *     추가될 때 hashOptions를 갱신하지 않아도 자동 포함된다. (필드 누락에 의한
 *     무음 데이터 손상 방지 — 비판적 리뷰 항목 #7/8 대응)
 *   - tracks는 별도 차원으로 키에 포함. lib/wish 조합이 다른 결과를 만들기에
 *     같은 옵션 hash로 충돌시켜선 안 됨.
 *   - JSON.stringify로 값 직렬화 — 정수/불 외 타입 추가 시 안전.
 *
 * SHA 같은 강한 해시는 불필요 — 충돌 회피만 보장하면 됨.
 */
export function hashOptions(input: CacheKeyInput): string {
  const opts = input.options;
  // Object.keys는 enumerable own properties만 반환. AnalyzeOptions의 모든 필드는
  // 평범한 데이터 속성이라 전부 포함된다. sort()로 키 순서에 의존하지 않게.
  const optKeys = (Object.keys(opts) as Array<keyof AnalyzeOptions>).sort();
  const optsPart = optKeys
    .map(k => `${k}=${JSON.stringify(opts[k])}`)
    .join(",");
  // deal은 true일 때만 덧붙인다 — 발굴 트랙을 쓰지 않는 요청의 tracks 부분 형식을 바꾸지 않기
  // 위함이다 (작업 지시서 20261010_01 §2-5). 단, 같은 작업의 단계 1에서 AnalyzeOptions에
  // valueWeighting·saleOnly가 추가되어 optsPart가 이미 달라졌으므로, 이 변경 이전에 저장된
  // 캐시 row는 배포 후 한 번씩 miss된다 (§1-3 "기존 캐시 row는 1회 miss" — 재분석이 덮어씀).
  const tracksPart =
    `lib=${input.tracks.lib ? 1 : 0},wish=${input.tracks.wish ? 1 : 0}` +
    (input.tracks.deal ? ",deal=1" : "");
  return `${optsPart}|${tracksPart}`;
}

/**
 * 캐시 조회. steamId → user_id → cache row.
 *
 * 사용자가 DB에 없거나, 캐시 행이 없거나, options_hash 불일치면 null.
 * JSON 파싱 실패 시에도 null (캐시 손상은 cache miss로 흡수).
 */
export function getRecommendationCache(
  steamId: string,
  optionsHash: string
): RecommendationCacheEntry | null {
  const user = getUserBySteamId(steamId);
  if (!user) return null;

  const row = getDb()
    .prepare(
      `SELECT options_hash, payload, computed_at
       FROM recommendation_cache
       WHERE user_id = ? AND options_hash = ?`
    )
    .get(user.user_id, optionsHash) as
      | { options_hash: string; payload: string; computed_at: number }
      | undefined;

  if (!row) return null;

  try {
    const payload = JSON.parse(row.payload) as RecommendationCachePayload;
    return { payload, computedAt: row.computed_at };
  } catch (err) {
    console.warn("[recommend-cache] Corrupted payload, treating as miss:", err);
    return null;
  }
}

/**
 * 캐시 저장. INSERT OR REPLACE로 사용자별 1행만 유지.
 *
 * 사용자 행이 없으면 저장하지 않고 false 반환 — 캐시는 인증된 사용자에
 * 한해서만 의미 있다.
 */
export function setRecommendationCache(
  steamId: string,
  optionsHash: string,
  payload: RecommendationCachePayload
): boolean {
  const user = getUserBySteamId(steamId);
  if (!user) return false;

  const json = JSON.stringify(payload);
  getDb()
    .prepare(
      `INSERT INTO recommendation_cache (user_id, options_hash, payload, computed_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         options_hash = excluded.options_hash,
         payload = excluded.payload,
         computed_at = excluded.computed_at`
    )
    .run(user.user_id, optionsHash, json, Date.now());
  return true;
}

/**
 * 특정 사용자의 캐시를 삭제한다. 디버깅 또는 옵션 외 상위 변경에 의한
 * 명시적 invalidate에 사용.
 */
export function deleteRecommendationCache(steamId: string): void {
  const user = getUserBySteamId(steamId);
  if (!user) return;
  getDb()
    .prepare("DELETE FROM recommendation_cache WHERE user_id = ?")
    .run(user.user_id);
}
