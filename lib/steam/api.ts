/**
 * Steam API 클라이언트.
 *
 * 모든 Steam API 호출을 캐시 우선으로 처리한다.
 * 캐시 미스 시 API 호출 → 캐시 저장. Rate Limit 딜레이 적용.
 *
 * API 분류 (기획서 7.1절):
 * - 공식 API (api.steampowered.com): IWishlistService, IPlayerService, ISteamUser
 * - 공식 문서화 (store.steampowered.com): appreviews
 * - 비공식 (store.steampowered.com): appdetails, storesearch
 */

import { cacheGet, cacheSet, CACHE_TTL } from "@/lib/cache";
import type {
  SteamWishlistItem,
  SteamWishlistResponse,
  SteamOwnedGame,
  SteamOwnedGamesResponse,
  SteamAppDetails,
  SteamAppDetailsResponse,
  SteamReview,
  SteamReviewsResponse,
  SteamVanityUrlResponse,
  SteamStoreSearchItem,
  SteamStoreSearchResponse,
} from "./types";

function getApiKey(): string {
  if (!process.env.STEAM_API_KEY) {
    throw new Error("STEAM_API_KEY 환경변수가 설정되지 않았습니다. .env.local 파일을 확인하세요.");
  }
  return process.env.STEAM_API_KEY;
}

const STEAM_API_BASE = "https://api.steampowered.com";
const STEAM_STORE_BASE = "https://store.steampowered.com";

/** URL에서 key= 파라미터를 마스킹하여 로그 안전하게 만든다. */
function maskUrl(url: string): string {
  return url.replace(/([?&])key=[^&]+/, "$1key=***");
}

// --- Rate Limit 딜레이 ---

/** 지정된 시간(ms)만큼 대기한다. Steam API Rate Limit 준수용. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- 공통 fetch 헬퍼 ---

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`[steam-api] HTTP ${res.status} for ${maskUrl(url)}`);
      return null;
    }
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      console.error(`[steam-api] Unexpected content-type "${contentType}" for ${maskUrl(url)}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.error(`[steam-api] Fetch failed for ${maskUrl(url)}:`, err);
    return null;
  }
}

// --- API 함수들 ---

/**
 * 위시리스트 게임 목록을 가져온다.
 * IWishlistService/GetWishlist/v1 (공식 API, API Key 필요)
 */
export async function getWishlist(
  steamId: string
): Promise<{ data: SteamWishlistItem[]; isStale: boolean } | null> {
  const cacheKey = `wishlist:${steamId}`;
  const cached = cacheGet<SteamWishlistItem[]>(cacheKey);
  if (cached) return cached;

  const url = `${STEAM_API_BASE}/IWishlistService/GetWishlist/v1/?key=${getApiKey()}&steamid=${steamId}`;
  const res = await fetchJson<SteamWishlistResponse>(url);

  if (!res?.response?.items) return null;

  const items = res.response.items;
  cacheSet(cacheKey, items, CACHE_TTL.wishlist);
  return { data: items, isStale: false };
}

/**
 * 소유 게임 목록을 가져온다.
 * IPlayerService/GetOwnedGames/v1 (공식 API, API Key 필요)
 * include_appinfo=true로 name, img_icon_url 포함.
 */
export async function getOwnedGames(
  steamId: string
): Promise<{ data: SteamOwnedGame[]; isStale: boolean } | null> {
  const cacheKey = `library:${steamId}`;
  const cached = cacheGet<SteamOwnedGame[]>(cacheKey);
  if (cached) return cached;

  const url =
    `${STEAM_API_BASE}/IPlayerService/GetOwnedGames/v1/` +
    `?key=${getApiKey()}&steamid=${steamId}` +
    `&include_appinfo=true&include_played_free_games=true`;
  const res = await fetchJson<SteamOwnedGamesResponse>(url);

  if (!res?.response?.games) return null;

  const games = res.response.games;
  cacheSet(cacheKey, games, CACHE_TTL.library);
  return { data: games, isStale: false };
}

/**
 * 앱 상세 정보를 가져온다 (게임 이름, is_free, 이미지 등).
 * store.steampowered.com/api/appdetails (비공식 API)
 *
 * Rate Limit: 1초 딜레이 필요.
 * 삭제/이관된 앱은 success=false → null 반환.
 */
export async function getAppDetails(
  appId: number
): Promise<{ data: SteamAppDetails; isStale: boolean } | null> {
  const cacheKey = `app:${appId}:info`;
  const cached = cacheGet<SteamAppDetails>(cacheKey);
  if (cached) return cached;

  // 비공식 API Rate Limit: 1초 딜레이
  await delay(1000);

  const url = `${STEAM_STORE_BASE}/api/appdetails?appids=${appId}`;
  const res = await fetchJson<SteamAppDetailsResponse>(url);

  if (!res) return null;

  const appData = res[String(appId)];
  if (!appData?.success || !appData.data) return null;

  cacheSet(cacheKey, appData.data, CACHE_TTL.appInfo);
  return { data: appData.data, isStale: false };
}

/**
 * 게임 리뷰를 가져온다.
 * store.steampowered.com/appreviews/{appid} (공식 문서화 API)
 *
 * Rate Limit: 0.5초 딜레이 필요.
 *
 * @param appId 게임 AppID
 * @param language 언어 코드 (예: "koreana", "english"). "all"이면 전체.
 * @param count 가져올 리뷰 수 (기본 10, 최대 20)
 * @param dayRange 기간 필터 (일). 0이면 전체 기간. Steam API day_range 파라미터로 직접 전달.
 */
export async function getReviews(
  appId: number,
  language: string = "koreana",
  count: number = 10,
  dayRange: number = 30
): Promise<{ data: SteamReview[]; isStale: boolean } | null> {
  count = Math.min(Math.max(1, count), 20);
  const cacheKey = `reviews:${appId}:${language}:${count}:${dayRange}`;
  const cached = cacheGet<SteamReview[]>(cacheKey);
  if (cached) return cached;

  // 공식 문서화 API Rate Limit: 0.5초 딜레이
  await delay(500);

  let url =
    `${STEAM_STORE_BASE}/appreviews/${appId}?json=1` +
    `&filter=recent&num_per_page=${count}&purchase_type=all`;

  // 언어 필터 (서버 사이드)
  if (language !== "all") {
    url += `&language=${language}`;
  }

  // 기간 필터 (Steam API day_range 파라미터로 직접 전달)
  if (dayRange > 0) {
    url += `&day_range=${dayRange}`;
  }

  const res = await fetchJson<SteamReviewsResponse>(url);

  if (!res || res.success !== 1) return null;

  const reviews = res.reviews;
  cacheSet(cacheKey, reviews, CACHE_TTL.reviews);
  return { data: reviews, isStale: false };
}

/**
 * 커스텀 URL을 Steam64 ID로 변환한다.
 * ISteamUser/ResolveVanityURL/v1 (공식 API)
 *
 * @returns Steam64 ID 문자열. 변환 실패 시 null.
 */
export async function resolveVanityUrl(
  vanityUrl: string
): Promise<string | null> {
  const url =
    `${STEAM_API_BASE}/ISteamUser/ResolveVanityURL/v1/` +
    `?key=${getApiKey()}&vanityurl=${encodeURIComponent(vanityUrl)}`;
  const res = await fetchJson<SteamVanityUrlResponse>(url);

  if (!res || res.response.success !== 1) return null;
  return res.response.steamid ?? null;
}

/**
 * 게임을 이름으로 검색한다.
 * store.steampowered.com/api/storesearch (비공식 API)
 *
 * @returns 검색 결과 배열. 실패 시 빈 배열.
 */
export async function searchGames(
  query: string
): Promise<SteamStoreSearchItem[]> {
  const url =
    `${STEAM_STORE_BASE}/api/storesearch/` +
    `?term=${encodeURIComponent(query)}&l=koreana&cc=KR`;
  const res = await fetchJson<SteamStoreSearchResponse>(url);

  return res?.items ?? [];
}

/**
 * Steam 사용자 프로필 정보를 가져온다 (닉네임, 아바타 등).
 * ISteamUser/GetPlayerSummaries/v2 (공식 API)
 */
export async function getPlayerSummary(
  steamId: string
): Promise<{ personaname: string; avatarfull: string } | null> {
  const url =
    `${STEAM_API_BASE}/ISteamUser/GetPlayerSummaries/v2/` +
    `?key=${getApiKey()}&steamids=${steamId}`;
  const res = await fetchJson<{
    response: {
      players: Array<{ personaname: string; avatarfull: string }>;
    };
  }>(url);

  return res?.response?.players?.[0] ?? null;
}
