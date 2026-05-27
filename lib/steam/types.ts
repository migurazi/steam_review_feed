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
 * 주의: KRW는 initial/final이 원 단위 그대로 (예: 30000=₩30,000),
 * USD/EUR 등은 1/100 단위(cent). UI에서는 *_formatted 필드 사용 권장.
 */
export interface SteamPriceOverview {
  /** 통화 코드 (예: "KRW") */
  currency: string;
  /** 정가 (KRW는 원 단위) */
  initial: number;
  /** 최종 가격 (KRW는 원 단위) */
  final: number;
  /** 할인율 (%). 0=할인 없음 */
  discount_percent: number;
  /** 정가 표시 문자열 (예: "₩30,000") */
  initial_formatted: string;
  /** 최종 가격 표시 문자열 (예: "₩15,000") */
  final_formatted: string;
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
