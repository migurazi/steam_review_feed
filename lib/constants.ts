/**
 * 애플리케이션 전역 상수.
 *
 * 여러 모듈에서 중복 정의되던 상수를 한 곳으로 통합한다.
 * 변경 시 한 파일만 수정하면 전체에 반영된다.
 */

/** 세션 쿠키 이름. middleware.ts와 session.ts에서 공유. */
export const SESSION_COOKIE_NAME = "steam_review_feed_session";

/** 한 페이지당 표시할 게임 수 (위시리스트/라이브러리/스트리밍 공통) */
export const PAGE_SIZE = 50;

/** 한 게임에서 최대로 가져올 리뷰 수 */
export const MAX_REVIEWS_PER_GAME = 20;

/** 리뷰 재요청 임계값: 필터 후 이 수 미만이면 MAX_REVIEWS_PER_GAME으로 재요청 */
export const REVIEW_RETRY_THRESHOLD = 2;

/** Rate Limit: 슬라이딩 윈도우 크기 (밀리초) */
export const RATE_LIMIT_WINDOW_MS = 60 * 1000;

/** Rate Limit: 윈도우 내 최대 요청 수 */
export const RATE_LIMIT_MAX_REQUESTS = 30;

/**
 * Steam API 호출 간 딜레이 (밀리초).
 * 비공식 API(appdetails)는 1초, 공식 문서화 API(appreviews)는 0.5초.
 */
export const STEAM_API_DELAY = {
  /** store.steampowered.com/api/appdetails (비공식, Rate Limit 엄격) */
  appDetails: 1000,
  /** store.steampowered.com/appreviews (공식 문서화) */
  reviews: 500,
} as const;

/** 동시에 병렬 처리할 게임 수 (SSE 스트리밍에서 사용) */
export const STREAM_CONCURRENCY = 3;

/**
 * 필터 기본값.
 * FilterPanel의 DEFAULT_FILTERS와 서버 측 DEFAULTS를 통합한다.
 */
export const DEFAULT_FILTER_VALUES = {
  source: 'wishlist' as const,
  language: 'koreana',
  minPlaytime: 0,
  minLength: 0,
  reviewType: 'all' as const,
  dayRange: 30,
  excludeFree: true,
  offset: 0,
} as const;
