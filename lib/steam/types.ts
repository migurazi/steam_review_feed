/**
 * Steam API 타입 정의
 *
 * Steam Web API 및 Store API 응답 구조를 TypeScript 타입으로 정의한다.
 * Phase 0.5 검증 결과(20260326_02)에서 확인된 실제 응답 구조 기반.
 */

// --- IWishlistService/GetWishlist ---

export interface SteamWishlistItem {
  appid: number;
  priority: number;
  /** Unix timestamp (초 단위) */
  date_added: number;
}

export interface SteamWishlistResponse {
  response: {
    items: SteamWishlistItem[];
  };
}

// --- IPlayerService/GetOwnedGames ---

export interface SteamOwnedGame {
  appid: number;
  name: string;
  /** 총 플레이타임 (분 단위) */
  playtime_forever: number;
  /** 최근 2주 플레이타임 (분 단위). 없으면 0 또는 미포함 */
  playtime_2weeks?: number;
  img_icon_url: string;
  /** 마지막 플레이 시각 (Unix timestamp) */
  rtime_last_played: number;
  /**
   * 커뮤니티 통계(도전과제/스탯) 노출 여부. 도전과제 스캔 대상 선정에 사용
   * (작업 지시서 20260825_01 §5.3.1). GetOwnedGames가 이 필드를 항상 내려주는지는
   * Phase 0 V7에서 검증 대상이므로 **옵셔널**로 둔다 — 부재 시 caller가 대체안으로
   * 폴백한다(§5.3.1). true인 게임만 도전과제가 있을 개연성이 높다.
   */
  has_community_visible_stats?: boolean;
}

export interface SteamOwnedGamesResponse {
  response: {
    game_count: number;
    games: SteamOwnedGame[];
  };
}

// --- IPlayerService/GetRecentlyPlayedGames ---

export interface SteamRecentlyPlayedResponse {
  response: {
    total_count: number;
    games: SteamOwnedGame[];
  };
}

// --- store.steampowered.com/api/appdetails ---

/** appdetails API의 동영상 항목. DASH/HLS 스트리밍 URL 제공. */
export interface SteamMovie {
  id: number;
  name: string;
  /** 동영상 썸네일 이미지 URL */
  thumbnail: string;
  /** HLS(H.264) 마스터 플레이리스트 URL (.m3u8) — hls.js로 재생 */
  hls_h264: string;
  highlight: boolean;
}

/** appdetails API의 스크린샷 항목. */
export interface SteamScreenshot {
  id: number;
  /** 작은 이미지 (600x338) */
  path_thumbnail: string;
  /** 원본 이미지 (1920x1080) */
  path_full: string;
}

/**
 * appdetails API의 가격 정보. cc=KR로 호출 시 KRW 단위.
 * is_free=true이거나 미출시/지역제한 게임은 응답에 미포함.
 *
 * 주의: KRW 포함 모든 통화에서 initial/final은 1/100 단위다
 * (예: 5490000=₩54,900 — 2026-10-10 cc=KR 실응답 확인, 작업 지시서 20261010_01 V5).
 * 할인 없는 응답은 initial_formatted가 빈 문자열이다. UI에서는 *_formatted 필드 사용 권장.
 */
export interface SteamPriceOverview {
  /** 통화 코드 (예: "KRW") */
  currency: string;
  /** 정가 (1/100 단위, 예: 5490000=₩54,900) */
  initial: number;
  /** 최종 가격 (1/100 단위) */
  final: number;
  /** 할인율 (%). 0=할인 없음 */
  discount_percent: number;
  /** 정가 표시 문자열 (예: "₩30,000") */
  initial_formatted: string;
  /** 최종 가격 표시 문자열 (예: "₩15,000") */
  final_formatted: string;
}

/**
 * appdetails `filters=price_overview` 다중 appid 응답.
 * 무료/미판매 게임은 `data: []`(빈 배열), 없는 appid는 `success: false`로 온다
 * (단계 0 V1 실응답, __tests__/fixtures/steam-stage0/v1_multi5.json).
 */
export type SteamPriceBatchResponse = Record<
  string,
  { success: boolean; data?: { price_overview?: SteamPriceOverview } | unknown[] }
>;

/**
 * 추천용 가격 스냅샷 (작업 지시서 20261010_01 §1-1).
 * Map에 스냅샷이 없는 appid = 가격 미상(조회 실패). price=null은 "확인된 무료/미판매".
 */
export interface PriceSnapshot {
  price: SteamPriceOverview | null;
  /** 가격을 가져온 시각 (Unix ms) */
  fetchedAt: number;
  /**
   * 이번 조회가 실패해 마지막으로 확인한 가격(last-known·만료 캐시)으로 채웠다 (작업 지시서 20261010_02).
   * 표시는 하되(회색) 위시 가격 커버리지 판정에는 세지 않는다 — 장애 중 묵은 할인율이 가성비
   * 순위·saleOnly를 조용히 바꾸지 않도록.
   */
  fallback?: boolean;
}

// --- 스토어 할인 발굴 (작업 지시서 20261010_01 단계 2) ---

/**
 * store.steampowered.com/search/results/?json=1&infinite=1 응답.
 * results_html은 검색 결과 행(<a ... data-ds-appid="...">) HTML 조각이다.
 * appid 정수 추출에만 쓰고 저장·전달하지 않는다 (단계 0 V3, fixtures/v4_reviews_p0.json).
 */
export interface SteamSearchResultsResponse {
  success: number;
  results_html: string;
  total_count: number;
  start: number;
}

/** store.steampowered.com/api/featuredcategories 응답 중 specials 부분만 (V3(b) fallback). */
export interface SteamFeaturedCategoriesResponse {
  specials?: {
    items?: { id: number; type: number; discounted?: boolean; discount_percent?: number }[];
  };
}

/**
 * IStoreBrowseService/GetItems/v1 응답의 store_item 중 사용하는 필드만.
 * (단계 0 V2, fixtures/v2_getitems_nokey.json). 금액은 문자열 1/100 단위.
 */
export interface SteamStoreBrowseItem {
  appid?: number;
  id?: number;
  /** 1=성공 */
  success: number;
  name?: string;
  is_free?: boolean;
  /** 사용자 태그 id (include_tag_count 요청 시, 상위 N개). */
  tagids?: number[];
  tags?: { tagid: number; weight?: number }[];
  /** include_assets 요청 시. 이미지 URL = asset_url_format의 ${FILENAME}을 파일명으로 치환. */
  assets?: { asset_url_format?: string; header?: string };
  /** include_release 요청 시. */
  release?: { steam_release_date?: number; is_coming_soon?: boolean; is_early_access?: boolean };
  categories?: {
    supported_player_categoryids?: number[];
    feature_categoryids?: number[];
    controller_categoryids?: number[];
  };
  reviews?: {
    /** 언어 무관 집계. appreviews filter=all과 집계 방식이 조금 다르다 (부록 B 설계 확정 4). */
    summary_filtered?: {
      review_count: number;
      percent_positive: number;
      review_score: number;
      review_score_label: string;
    };
  };
  best_purchase_option?: {
    final_price_in_cents?: string;
    original_price_in_cents?: string;
    formatted_final_price?: string;
    formatted_original_price?: string;
    discount_pct?: number;
    active_discounts?: { discount_end_date?: number }[];
    hide_discount_pct_for_compliance?: boolean;
    price_cannot_be_displayed_as_discount?: boolean;
    /** 이 옵션에 포함된 게임 수. 1보다 크면 묶음 패키지 (storeItemPriceIsAppPrice). */
    included_game_count?: number;
    /** 세트로만 구매 가능한 옵션. */
    must_purchase_as_set?: boolean;
  };
}

export interface SteamStoreBrowseResponse {
  response?: { store_items?: SteamStoreBrowseItem[] };
}

/**
 * GetItems 한 항목을 정규화한 스토어 요약 (발굴 트랙 전용).
 * price=null은 "구매 옵션 없음(무료/미판매)", review=null은 "리뷰 요약 없음".
 */
export interface StoreItemSummary {
  appid: number;
  price: SteamPriceOverview | null;
  /** 리뷰 요약. 기존 computeReviewScore/buildReviewBadge 입력 형식으로 환산해 둔다. */
  review: ReviewSummary | null;
  /** supported_player + feature + controller 카테고리 id (appdetails 카테고리 id와 동일 체계). */
  categoryIds: number[];
  isFree: boolean;
  /** 진행 중인 할인 종료 시각 (Unix 초). 할인이 없거나 미상이면 undefined. */
  discountEndsAt?: number;
  /** 조회 시각 (Unix ms) */
  fetchedAt: number;
}

/** appdetails API의 출시일 정보. coming_soon=true면 미출시. */
export interface SteamReleaseDate {
  /** true=미출시(출시 예정) */
  coming_soon: boolean;
  /** 출시일 표시 문자열 (예: "2025년 12월 1일", "TBA", "Coming Soon") */
  date: string;
}

/**
 * appdetails API의 장르 정보.
 *
 * 매칭은 반드시 id 기반으로 한다. description은 호출 시 cc/l 파라미터에 따라
 * 언어가 달라지므로(cc=KR&l=koreana 호출 시 "액션" 등 한국어로 반환), 문자열
 * 비교로 누적하면 같은 장르가 분산된다.
 *
 * 참조: 작업 지시서 4.3 (호환성 - 언어 매칭 정책)
 */
export interface SteamGenre {
  /** 장르 ID (문자열, 예: "1"=Action) — 매칭의 기준 */
  id: string;
  /** 표시명 (cc=KR이면 한국어, 예: "액션") */
  description: string;
}

/**
 * appdetails API의 카테고리 정보 (싱글플레이어, 컨트롤러 지원 등).
 *
 * SteamGenre와 마찬가지로 id 기반 매칭, description은 표시 전용.
 * Steam API는 카테고리 id를 정수로 반환한다 (장르 id는 문자열).
 */
export interface SteamCategory {
  /** 카테고리 ID (정수, 예: 2=싱글플레이어) — 매칭의 기준 */
  id: number;
  description: string;
}

export interface SteamAppDetails {
  name: string;
  steam_appid: number;
  is_free: boolean;
  header_image: string;
  /** 짧은 설명 */
  short_description: string;
  type: string;
  movies?: SteamMovie[];
  screenshots?: SteamScreenshot[];
  /** 가격 정보. is_free=true이거나 미출시/지역제한 시 미포함. */
  price_overview?: SteamPriceOverview;
  /** 출시일 정보. UI에서 미출시 게임 라벨 분기에 사용. */
  release_date?: SteamReleaseDate;
  /** 장르 목록. 일부 게임(데모, 도구 등)은 누락될 수 있어 옵셔널. */
  genres?: SteamGenre[];
  /** 카테고리 목록. 일부 게임은 누락될 수 있어 옵셔널. */
  categories?: SteamCategory[];
}

/**
 * appdetails API 응답은 { "appid": { success: boolean, data: SteamAppDetails } } 형태.
 * success=false인 경우 data가 없다 (삭제/이관된 앱).
 */
export interface SteamAppDetailsResponse {
  [appId: string]: {
    success: boolean;
    data?: SteamAppDetails;
  };
}

// --- store.steampowered.com/appreviews ---

export interface SteamReviewAuthor {
  steamid: string;
  num_games_owned: number;
  /** 총 플레이타임 (분 단위) */
  playtime_forever: number;
  /** 리뷰 작성 시점 플레이타임 (분 단위) */
  playtime_at_review: number;
  /** 최근 2주 플레이타임 (분 단위) */
  playtime_last_two_weeks: number;
}

export interface SteamReview {
  recommendationid: string;
  author: SteamReviewAuthor;
  /** 리뷰 본문 */
  review: string;
  /** true=추천, false=비추천 */
  voted_up: boolean;
  /** "도움이 됐어요" 수 */
  votes_up: number;
  votes_funny: number;
  /** 리뷰 작성 시각 (Unix timestamp) */
  timestamp_created: number;
  timestamp_updated: number;
  /** 리뷰 언어 코드 (예: "koreana") */
  language: string;
}

export interface SteamReviewsResponse {
  success: number;
  query_summary: {
    num_reviews: number;
    review_score: number;
    review_score_desc: string;
    total_positive: number;
    total_negative: number;
    total_reviews: number;
  };
  reviews: SteamReview[];
}

/**
 * appreviews query_summary의 집계 호평률 요약.
 * getReviewSummary가 반환하며 /recommend 추천의 리뷰 블렌딩(작업 지시서 단계 2)에 사용.
 * review_score_desc/reviewScore(0~10 등급)는 향후 UI 배지용으로 함께 보존한다.
 */
export interface ReviewSummary {
  /** Steam 리뷰 점수 등급 (0~10). 표본 수 미반영이라 랭킹엔 직접 안 쓰고 표시용. */
  reviewScore: number;
  /** 등급 설명 (예: "Very Positive" / "매우 긍정적"). */
  reviewScoreDesc: string;
  totalPositive: number;
  totalNegative: number;
  totalReviews: number;
}

// --- ISteamUser/ResolveVanityURL ---

export interface SteamVanityUrlResponse {
  response: {
    /** 1=성공, 42=매치 없음 */
    success: number;
    steamid?: string;
    message?: string;
  };
}

// --- store.steampowered.com/api/storesearch ---

export interface SteamStoreSearchItem {
  id: number;
  name: string;
  /** 작은 이미지 URL */
  tiny_image: string;
}

export interface SteamStoreSearchResponse {
  total: number;
  items: SteamStoreSearchItem[];
}

// --- 서비스 내부 타입 ---

/**
 * 캐시에서 반환되는 데이터에 부착되는 메타 정보.
 * Steam API 장애 시 만료된 캐시를 stale 상태로 반환할 때 사용.
 */
export interface CacheEntry<T> {
  data: T;
  /** 데이터를 Steam API에서 가져온 시각 (Unix ms) */
  fetchedAt: number;
  /** 캐시 TTL이 만료되었지만 API 장애로 stale 데이터를 반환하는 경우 true */
  isStale: boolean;
}

/**
 * SSE로 클라이언트에 전송되는 게임별 리뷰 데이터.
 */
export interface GameReviewsEvent {
  appId: number;
  gameName: string;
  gameIcon: string;
  reviews: SteamReview[];
  /** 해당 언어의 리뷰가 0건인 경우 true */
  noReviewsInLanguage?: boolean;
  /** 무료 게임 여부 (is_free). UI에서 "무료" 배지 표시용 */
  isFree?: boolean;
  /** 가격 정보. 무료/미출시/지역제한 시 undefined */
  price?: SteamPriceOverview;
  /** 미출시 게임 여부. true면 "출시 예정" 라벨 */
  comingSoon?: boolean;
  /** 출시일 표시 문자열 (미출시 게임용, 예: "2025년 12월 1일") */
  releaseDate?: string;
}

/**
 * SSE 진행 상태 이벤트.
 */
export interface ProgressEvent {
  loaded: number;
  total: number;
}

/**
 * SSE 완료 이벤트.
 */
export interface DoneEvent {
  totalGames: number;
  totalReviews: number;
}

/**
 * SSE 에러 이벤트 (특정 게임 조회 실패).
 */
export interface ErrorEvent {
  appId: number;
  message: string;
}

// --- 도전과제 (ISteamUserStats) — 작업 지시서 20260825_01 ---
//
// 원형(raw) 응답 타입은 Steam이 내려주는 형태를 그대로 반영하고, 변환은 정규화
// 함수에서만 수행한다 (§5.1.3, M17). 특히 percent/hidden/achieved 등 "숫자/불리언
// 같지만 문자열·0/1로 오는" 필드를 타입 수준에서 원형 그대로 선언해, 경계에서만
// parseFloat / Boolean 변환을 강제한다.

/**
 * GetSchemaForGame 응답의 과제 정의 원형.
 * `game.availableGameStats.achievements[]` 의 원소.
 *
 * 주의:
 *   - `hidden`은 boolean이 아니라 `0 | 1` (숨김 과제=1).
 *   - `description`은 숨김 과제에서 누락될 수 있음 (V1 검증 대상, §5.1.3).
 *   - `icon`/`icongray`는 URL 전체. 정규화 시 파일명만 남긴다 (§5.1.2).
 */
export interface SteamRawAchievementDef {
  name: string;
  displayName: string;
  description?: string;
  hidden: 0 | 1;
  icon: string;
  icongray: string;
  defaultvalue: number;
}

/**
 * GetSchemaForGame/v2 응답 전체.
 * 과제 없는 앱은 `availableGameStats` 자체가 없거나 `achievements`가 빈 배열일 수
 * 있다 — 셋 중 어느 형태인지는 V2 실측으로 확정한다 (§3.3, §5.1.1).
 */
export interface SteamAchievementSchemaResponse {
  game?: {
    gameName?: string;
    availableGameStats?: {
      achievements?: SteamRawAchievementDef[];
    };
  };
}

/**
 * GetPlayerAchievements/v1 응답 전체.
 *
 * 주의:
 *   - 성공 시 `playerstats.success === true`.
 *   - 원소 키가 스키마의 `name`이 아니라 **`apiname`**이라는 가정은 V4 검증 대상
 *     (§5.1.4). 정규화 계층에서 `apiname → name`으로 통일한다.
 *   - `achieved`는 `0 | 1`, `unlocktime`은 미획득 시 `0`.
 *   - 실패 시 `success === false` + `error` 문자열. private 프로필과 통계 없는
 *     게임의 error 문자열 구별 가능성은 V5/V6 검증 대상 (§5.1.4, R7).
 */
export interface SteamPlayerAchievementsResponse {
  playerstats?: {
    success?: boolean;
    error?: string;
    achievements?: {
      apiname: string;
      achieved: 0 | 1;
      unlocktime: number;
    }[];
  };
}

/**
 * GetGlobalAchievementPercentagesForApp/v0002 응답 전체.
 *
 * **`percent`는 number가 아니라 string이다** (§3.1 실측 확인). 저장 전
 * parseFloat 하고, Number.isFinite 실패 시 해당 항목을 제외한다 (§5.1.7).
 * `name`은 스키마의 `name`(API명)과 동일한 안정 키.
 */
export interface SteamGlobalPercentagesResponse {
  achievementpercentages?: {
    achievements?: { name: string; percent: string }[];
  };
}

/**
 * 스키마에서 diff/표시에 실제로 쓰는 필드만 남긴 정규화 형태 (§5.1.2).
 *
 * `icon`은 URL 전체가 아니라 파일명만 저장한다. CDN 도메인이 바뀌어도 diff가
 * 오탐되지 않고 용량도 준다. 표시 시
 *   https://media.steampowered.com/steamcommunity/public/images/apps/{appId}/{icon}
 * 규칙으로 복원한다 (V1에서 규칙 미확인 시 URL 전체 저장으로 되돌림).
 */
export interface AchievementDef {
  /** API명 — 유일한 안정 키. displayName 이 아니다. */
  name: string;
  displayName: string;
  description: string;
  /** 원본은 0|1 이므로 boolean 변환 */
  hidden: boolean;
  /** 아이콘 파일명 (URL 전체가 아님). 예: "a1b2c3....jpg" */
  icon: string;
}
