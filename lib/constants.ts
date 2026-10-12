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
 *
 * appdetails는 비공식 API라 Rate Limit이 매우 엄격하다 — 커뮤니티 관측상
 * ~200 req/5min(=40 req/min) 한도. 우리가 STREAM_CONCURRENCY × 1/delay 로
 * 환산해 한도 안에 들어가야 거의 모든 호출이 200 OK를 받는다.
 *
 * 이전 설정(concurrency 3 + 1000ms)은 실효 180 req/min로 4배 초과 → 거의
 * 모든 응답이 429. 5347 라이브러리 분석 시 appdetails 호출이 거의 다 null
 * 반환, 분석 신호 무효, 캐시 미적재의 악순환 관측.
 *
 * 변경 후(concurrency 1 + 1500ms): 40 req/min — Steam 한도 내. 5347 게임 첫
 * 분석은 ~134분으로 길지만, app_details_cache에 successfull 저장 → 다음
 * 분석부터 캐시 hit으로 빠름. 한 번만 견디면 됨.
 *
 * 주의: 위 근거 서술(40 req/min 한도 등)은 **`appDetails` 키에만** 적용된다 (L3).
 *   `reviews`/`achievements`는 공식 엔드포인트라 한도 체계가 다르다 —
 *   `achievements`는 공식 api.steampowered.com(키당 100,000/day)이며
 *   appdetails 레인과 경쟁하지 않는다 (작업 지시서 20260825_01 §1.2).
 */
export const STEAM_API_DELAY = {
  /** store.steampowered.com/api/appdetails (비공식, Rate Limit 엄격) */
  appDetails: 1500,
  /** store.steampowered.com/appreviews (공식 문서화) */
  reviews: 500,
  /**
   * 공식 api.steampowered.com/ISteamUserStats 용 (도전과제 스키마/진행률/전역률).
   * appdetails(비공식, 1500ms)와 **별개 레인**. V9 부하 측정 결과에 따라 500으로
   * 상향될 수 있다 (§3.3 V9, §5.3.3).
   */
  achievements: 250,
} as const;

/**
 * 도전과제 스캔의 앱 단위 동시성 (한 사용자 스캔 내에서 병렬 처리할 앱 수).
 * 작업 지시서 20260825_01 §5.3.3. `achievements` 딜레이와 함께 실효 req/s를 결정.
 */
export const ACHIEVEMENT_CONCURRENCY = 3;

/**
 * 프로세스 전역 아웃바운드 동시성 상한 (전 사용자 합산).
 *
 * 인바운드 IP 제한(`lib/rate-limit.ts`)은 아웃바운드 동시성을 제어하지 못한다.
 * 사용자 N명이 동시에 첫 스캔을 돌리면 N × ACHIEVEMENT_CONCURRENCY 동시 요청이
 * 나가므로, `lib/outbound-limit.ts`의 전역 세마포어가 이 값으로 상한을 건다 (M11).
 */
export const ACHIEVEMENT_GLOBAL_CONCURRENCY = 8;

/**
 * 도전과제 일일 콜 예산 (프로세스 내 카운터 상한).
 *
 * Steam Web API Key 한도 100,000/day에 대한 안전 마진. 초과 시 새 스캔을 거부하고
 * `done.budgetExceeded`를 반환한다 (§5.8, §7.1). 프로세스 재시작 시 리셋되므로
 * 단일 프로세스 배포(standalone) 가정 하의 soft guard다.
 */
export const ACHIEVEMENT_DAILY_CALL_BUDGET = 80_000;

/**
 * 동시에 병렬 처리할 게임 수 (SSE 스트리밍에서 사용).
 *
 * 1로 설정 — Steam appdetails Rate Limit 회피. 위 STEAM_API_DELAY 주석 참조.
 * 리뷰 fetch는 별도 endpoint(공식 문서화)라 더 너그럽지만 단순성 위해 같은
 * 값 공유.
 */
export const STREAM_CONCURRENCY = 1;

/**
 * 가격 신선도 기준 (ms). 가격 캐시 TTL(CACHE_TTL.appPrice)과 클라이언트의 "묵은 가격"
 * 표시 기준을 한 값으로 묶어 둘이 어긋나지 않게 한다. 클라이언트도 import하므로
 * 이 파일은 서버 전용 의존을 갖지 않아야 한다. (작업 지시서 20261010_01 §1-5)
 */
export const PRICE_STALE_MS = 60 * 60 * 1000;

/**
 * appdetails `filters=price_overview` 다중 appid 1회 조회 개수.
 * 단계 0 V1에서 191개까지 동작 확인 — URL 길이·여유를 고려해 100으로 둔다.
 */
export const PRICE_BATCH_SIZE = 100;

/**
 * last-known 가격 보관 기간 (ms). 가격 조회가 실패할 때 "마지막으로 확인한 가격"을 회색으로 계속
 * 보여줄 수 있는 상한. 이보다 오래된 가격은 끝난 할인을 할인 중으로 보여줄 위험이 커 미상으로 둔다.
 * (작업 지시서 20261010_02 §1-1)
 */
export const PRICE_LAST_KNOWN_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * 미보유 할인 게임 발굴 트랙 상한 (작업 지시서 20261010_01 단계 2, 부록 B 설계 확정 3·4).
 *   - DISCOVER_POOL_SIZE:       검색 specials에서 모을 후보 appid 수 (페이지 100개 → 2회 호출).
 *   - DISCOVER_SEARCH_PAGE_SIZE: 검색 1페이지 행 수. V4에서 count=100이 한 번에 100행 반환 확인.
 *   - DISCOVER_META_CAP:        장르 메타(appdetails, 1.5s 직렬)를 조회할 후보 수. GetItems는
 *                               장르를 주지 않으므로 이 단계가 발굴 비용의 대부분이다.
 *   - DISCOVER_TIME_BUDGET_MS:  발굴 단계 전체 시간 예산. 초과 시 확보한 데이터로 진행.
 *   - STORE_ITEMS_BATCH_SIZE:   GetItems 1회 조회 appid 수. V2에서 100개/호출 ~0.2s 확인.
 */
export const DISCOVER_POOL_SIZE = 150;
export const DISCOVER_SEARCH_PAGE_SIZE = 100;
export const DISCOVER_META_CAP = 40;
export const DISCOVER_TIME_BUDGET_MS = 120_000;
export const STORE_ITEMS_BATCH_SIZE = 100;

/**
 * 번들 차트 메이커(ITAD) 상수 (작업 지시서 20261012_01 단계 1-1).
 *   - ITAD_BUNDLE_SCAN_PAGES:    by-id 엔드포인트 부재 → findBundle이 번들 목록을 스캔할 최대 페이지 수
 *                                (limit 50 × 4p ≈ 200건). 못 찾으면 미스 음성 캐시 후 조용한 상한 대신 로그.
 *   - ITAD_LIST_CACHE_TTL_MS:    getRecentBundles 목록 캐시 (10분).
 *   - ITAD_BUNDLE_CACHE_TTL_MS:  findBundle 발견분 캐시 (60분).
 *   - ITAD_BUNDLE_MISS_TTL_MS:   findBundle 미스 음성 캐시 (10분 — 재스캔 억제).
 *   - ITAD_APPID_CACHE_TTL_MS:   lookupSteamAppIds UUID→appid 개별 캐시 (7일, 음성 0 포함).
 *   - BUNDLE_INPUT_MAX_IDS:      수동/번들 입력 배열 길이 상한 (익명 남용 방어).
 */
export const ITAD_BUNDLE_SCAN_PAGES = 4;
export const ITAD_LIST_CACHE_TTL_MS = 10 * 60 * 1000;
export const ITAD_BUNDLE_CACHE_TTL_MS = 60 * 60 * 1000;
export const ITAD_BUNDLE_MISS_TTL_MS = 10 * 60 * 1000;
export const ITAD_APPID_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const BUNDLE_INPUT_MAX_IDS = 100;

/**
 * 패키지+번들 전개 대상 상한 (익명 남용 방어). /api/bundle/resolve에서 전개할 패키지·번들 URL의
 * 합계가 이 값을 넘으면 거부한다 — 전개 1건당 직렬 Steam 호출이 따르므로 요청당 호출량을 묶는다.
 * (appid 직접 입력은 전개가 없어 BUNDLE_INPUT_MAX_IDS 상한만 적용.)
 */
export const BUNDLE_EXPAND_MAX_COLLECTIONS = 10;

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
