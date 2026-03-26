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

export interface SteamAppDetails {
  name: string;
  steam_appid: number;
  is_free: boolean;
  header_image: string;
  /** 짧은 설명 */
  short_description: string;
  type: string;
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
