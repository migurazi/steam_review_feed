/**
 * 인메모리 TTL + LRU 캐시.
 *
 * lru-cache 패키지를 사용하여 TTL 만료 + LRU 교체를 지원한다.
 * 최대 10,000 엔트리를 유지하며, 초과 시 가장 오래 사용되지 않은 항목부터 제거.
 *
 * Steam API 장애 시 만료된 캐시를 stale 상태로 반환하는 기능 포함.
 * (lru-cache의 allowStale 옵션 + fetchedAt 타임스탬프)
 */

import { LRUCache } from "lru-cache";

/** 캐시에 저장되는 래퍼. fetchedAt으로 stale 여부를 판단한다. */
interface CacheValue<T> {
  data: T;
  /** 데이터를 가져온 시각 (Unix ms) */
  fetchedAt: number;
}

// 단일 LRU 캐시 인스턴스 (모든 종류의 캐시를 하나로 관리)
// 캐시 키로 종류를 구분: "wishlist:{steamId}", "app:{appId}:info" 등
const cache = new LRUCache<string, CacheValue<unknown>>({
  max: 10_000,
  // allowStale: true이면 TTL 만료 후에도 stale 데이터를 반환한다.
  // 이를 통해 Steam API 장애 시 "N분 전 데이터" 표시가 가능.
  allowStale: true,
  // 기본 TTL은 set() 호출 시 개별 지정
});

/**
 * 캐시 종류별 TTL (밀리초).
 * 기획서 7.3절 캐시 전략과 일치.
 */
export const CACHE_TTL = {
  /** 위시리스트 목록: 6시간 */
  wishlist: 6 * 60 * 60 * 1000,
  /** 소유 게임 목록: 24시간 */
  library: 24 * 60 * 60 * 1000,
  /** 앱 상세 정보 (is_free, 이름 등): 7일 */
  appInfo: 7 * 24 * 60 * 60 * 1000,
  /** 가격 정보: 1시간. 세일 시작/종료에 빠르게 반응하기 위해 짧게 유지. */
  appPrice: 60 * 60 * 1000,
  /** 리뷰: 15분 */
  reviews: 15 * 60 * 1000,
  /**
   * 리뷰 호평률 요약: 6시간.
   * 누적 호평/비추천 집계는 개별 리뷰(15분)보다 훨씬 느리게 변하므로 길게 잡아
   * /recommend 블렌딩 시 반복 조회 비용을 줄인다. (작업 지시서 2-1)
   */
  reviewSummary: 6 * 60 * 60 * 1000,
} as const;

/**
 * 캐시에서 데이터를 조회한다.
 *
 * @returns 캐시 히트 시 { data, fetchedAt, isStale }. 미스 시 null.
 *   isStale=true인 경우 TTL이 만료된 데이터이지만, API 장애 대비로 반환됨.
 */
export function cacheGet<T>(key: string): {
  data: T;
  fetchedAt: number;
  isStale: boolean;
} | null {
  const entry = cache.get(key) as CacheValue<T> | undefined;
  if (!entry) return null;

  // lru-cache의 getRemainingTTL로 만료 여부 확인
  const remainingTtl = cache.getRemainingTTL(key);
  const isStale = remainingTtl <= 0;

  return {
    data: entry.data,
    fetchedAt: entry.fetchedAt,
    isStale,
  };
}

/**
 * 캐시에 데이터를 저장한다.
 *
 * @param key 캐시 키 (예: "wishlist:76561198056932899")
 * @param data 저장할 데이터
 * @param ttl TTL (밀리초). CACHE_TTL 상수 사용 권장.
 */
export function cacheSet<T>(key: string, data: T, ttl: number): void {
  cache.set(
    key,
    { data, fetchedAt: Date.now() } as CacheValue<unknown>,
    { ttl }
  );
}

/**
 * 특정 캐시 키를 무효화(삭제)한다.
 * 수동 새로고침 시 사용.
 */
export function cacheDelete(key: string): void {
  cache.delete(key);
}

/**
 * 특정 접두사로 시작하는 모든 캐시 키를 무효화한다.
 * 예: cacheDeleteByPrefix("wishlist:76561198056932899")
 */
export function cacheDeleteByPrefix(prefix: string): void {
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) {
      cache.delete(key);
    }
  }
}

/**
 * 현재 캐시 통계 (디버깅/모니터링용).
 */
export function cacheStats(): { size: number; max: number } {
  return {
    size: cache.size,
    max: cache.max,
  };
}
