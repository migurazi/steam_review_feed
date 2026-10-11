/**
 * 인메모리 TTL + LRU 캐시.
 *
 * lru-cache 패키지를 사용하여 TTL 만료 + LRU 교체를 지원한다.
 * 일반 캐시는 최대 10,000 엔트리, 게임 단위 대량 캐시(gameCache)는 별도 인스턴스에 최대 60,000 엔트리.
 * 초과 시 가장 오래 사용되지 않은 항목부터 제거.
 *
 * Steam API 장애 시 만료된 캐시를 stale 상태로 반환하는 기능 포함.
 * (lru-cache의 allowStale 옵션 + fetchedAt 타임스탬프)
 */

import { LRUCache } from "lru-cache";
import { PRICE_STALE_MS, PRICE_LAST_KNOWN_TTL_MS } from "@/lib/constants";

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
 * 게임 단위로 대량 기록되는 키 전용 LRU (/code-review 5차 #5).
 *
 * 성향 분석은 GetItems 응답 하나로 게임마다 메타(storemeta)·리뷰 요약(reviewsummary)·가격(app:{id}:price)을
 * 함께 기록한다(+ 발굴 후보는 storeitem). 미캐시 5,000개 라이브러리 한 번이면 1만 5천 항목 이상이라,
 * 메인 LRU(10,000)에 넣으면 같은 분석이 뒤에서 다시 읽을 리뷰·가격이 먼저 밀려나 재조회되고, 다른 사용자의
 * 위시리스트·라이브러리·리뷰 캐시도 모두 밀려난다. 이 키들은 작은 객체(수백 바이트~1KB)라 별도 인스턴스에
 * 넉넉한 상한을 둔다(최악 수십 MB). 호출 측 API(cacheGet/cacheSet)는 같고 키 접두사로 자동 분기한다.
 */
const gameCache = new LRUCache<string, CacheValue<unknown>>({
  max: 60_000,
  allowStale: true,
});

/** gameCache로 보낼 키: 게임 단위 대량 캐시. */
const GAME_KEY_RE = /^(?:storemeta:|reviewsummary:|storeitem:|app:\d+:price:)/;

/** 키가 속한 LRU 인스턴스. */
function lruFor(key: string): LRUCache<string, CacheValue<unknown>> {
  return GAME_KEY_RE.test(key) ? gameCache : cache;
}

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
  /**
   * 가격 정보: 1시간. 세일 시작/종료에 빠르게 반응하기 위해 짧게 유지.
   * 클라이언트의 묵은 가격 표시 기준과 같은 값을 쓰도록 PRICE_STALE_MS를 참조.
   */
  appPrice: PRICE_STALE_MS,
  /** 리뷰: 15분 */
  reviews: 15 * 60 * 1000,
  /**
   * 리뷰 호평률 요약: 6시간.
   * 누적 호평/비추천 집계는 개별 리뷰(15분)보다 훨씬 느리게 변하므로 길게 잡아
   * /recommend 블렌딩 시 반복 조회 비용을 줄인다. (작업 지시서 2-1)
   */
  reviewSummary: 6 * 60 * 60 * 1000,
  /**
   * 스토어 할인 후보 목록(store:specials:KR)과 GetItems 요약(storeitem:{id}:KR): 1시간.
   * 사용자와 무관한 공유 데이터. 가격을 담으므로 가격 캐시와 같은 신선도 기준을 쓴다.
   * (작업 지시서 20261010_01 단계 2-2)
   */
  storeDeals: PRICE_STALE_MS,
  /**
   * 도전과제 스키마(en): 7일. 앱 공용이며 자주 바뀌지 않는다.
   * TTL이 곧 변경 감지 지연의 상한이다 (작업 지시서 20260825_01 §5.5.3, M15).
   */
  achievementSchema: 7 * 24 * 60 * 60 * 1000,
  /**
   * 도전과제 없음(negative) 캐시: 30일. 과제 없는 수천 개 앱의 재조회를 막는다.
   * 단, negative 확정은 miss_streak >= 2 일 때만 (일시 실패의 30일 고착 방지, §4.1).
   */
  achievementSchemaMissing: 30 * 24 * 60 * 60 * 1000,
  /** 전역 달성률: 1일. 앱 공용 (§5.1.7). */
  achievementGlobal: 24 * 60 * 60 * 1000,
  /**
   * 개인 획득 현황: 1시간. 사용자가 과제를 딴 직후 새로고침 시 옛 값이 보이지
   * 않도록 짧게 유지하고, 조회 시 반드시 isStale를 검사한다 (§5.1.5).
   */
  achievementPlayer: 60 * 60 * 1000,
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
  const lru = lruFor(key);
  const entry = lru.get(key) as CacheValue<T> | undefined;
  if (!entry) return null;

  // lru-cache의 getRemainingTTL로 만료 여부 확인
  const remainingTtl = lru.getRemainingTTL(key);
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
  lruFor(key).set(
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
  lruFor(key).delete(key);
}

/**
 * 특정 접두사로 시작하는 모든 캐시 키를 무효화한다.
 * 예: cacheDeleteByPrefix("wishlist:76561198056932899")
 */
export function cacheDeleteByPrefix(prefix: string): void {
  for (const lru of [cache, gameCache]) {
    for (const key of lru.keys()) {
      if (key.startsWith(prefix)) {
        lru.delete(key);
      }
    }
  }
}

// ============================================================================
// last-known 가격 전용 캐시 (작업 지시서 20261010_02 §1-1, /code-review 2차 R2)
// ============================================================================

/**
 * 마지막으로 확인한 가격 스냅샷 (가격 조회 장애 시 fallback).
 *
 * 메인 LRU와 분리한 이유: 가격을 1시간 키 + 24시간 last-known 두 키로 메인 LRU(10,000)에 넣으면
 * 위시리스트가 큰 사용자 한 명(실사용자 위시 3,736개)만으로 가격 항목이 7,500개를 넘어, 다른
 * 사용자의 info·라이브러리·리뷰 캐시와 last-known 자신까지 밀어낸다. 스냅샷은 작은 객체라
 * 별도 인스턴스에 넉넉한 상한을 둔다(항목당 수백 바이트 × 50,000 ≈ 수십 MB 이하).
 *
 * allowStale 없음 — 24시간이 지난 가격은 fallback으로도 쓰지 않는다(끝난 할인 방지).
 */
export interface LastKnownPrice<P> {
  price: P;
  /** 가격을 확인한 시각 (Unix ms) */
  fetchedAt: number;
}

const lastKnownPrices = new LRUCache<number, LastKnownPrice<unknown>>({
  max: 50_000,
  ttl: PRICE_LAST_KNOWN_TTL_MS,
});

/** last-known 가격 조회. 없거나 24시간이 지났으면 null. */
export function lastKnownPriceGet<P>(appId: number): LastKnownPrice<P> | null {
  return (lastKnownPrices.get(appId) as LastKnownPrice<P> | undefined) ?? null;
}

/** last-known 가격 기록 (TTL 24시간, 기록할 때마다 갱신). */
export function lastKnownPriceSet<P>(appId: number, snapshot: LastKnownPrice<P>): void {
  lastKnownPrices.set(appId, snapshot);
}

/**
 * 현재 캐시 통계 (디버깅/모니터링용).
 */
export function cacheStats(): { size: number; max: number; gameSize: number; gameMax: number } {
  return {
    size: cache.size,
    max: cache.max,
    gameSize: gameCache.size,
    gameMax: gameCache.max,
  };
}
