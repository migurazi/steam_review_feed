/**
 * Steam API 클라이언트.
 *
 * 모든 Steam API 호출을 캐시 우선으로 처리한다.
 * 캐시 미스 시 API 호출 -> 캐시 저장. Rate Limit 딜레이 적용.
 *
 * API 분류 (기획서 7.1절):
 * - 공식 API (api.steampowered.com): IWishlistService, IPlayerService, ISteamUser
 * - 공식 문서화 (store.steampowered.com): appreviews
 * - 비공식 (store.steampowered.com): appdetails, storesearch
 *
 * 에러 처리:
 *   fetchJson은 모든 HTTP 오류를 null로 반환한다.
 *   상태별(429, 403, 5xx) 상세 메시지를 콘솔에 기록하여 디버깅이 가능하다.
 *   네트워크 오류, Content-Type 불일치, JSON 파싱 실패도 null 반환.
 */

import { cacheGet, cacheSet, CACHE_TTL } from "@/lib/cache";
import { getSteamApiKey } from "@/lib/env";
import { STEAM_API_DELAY, STREAM_CONCURRENCY } from "@/lib/constants";
import type {
  SteamWishlistItem,
  SteamWishlistResponse,
  SteamOwnedGame,
  SteamOwnedGamesResponse,
  SteamAppDetails,
  SteamAppDetailsResponse,
  SteamPriceOverview,
  SteamReview,
  SteamReviewsResponse,
  SteamVanityUrlResponse,
  SteamStoreSearchItem,
  SteamStoreSearchResponse,
} from "./types";

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

/**
 * URL을 fetch하여 JSON으로 파싱한다.
 *
 * HTTP 오류 시 SteamApiError를 throw하지 않고 null을 반환한다.
 * 단, 에러 정보는 콘솔에 기록하여 디버깅이 가능하다.
 * 네트워크 오류, Content-Type 불일치, JSON 파싱 실패도 null 반환.
 *
 * @param url 요청 URL
 * @returns 파싱된 JSON 객체 또는 null (실패 시)
 */
async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);

    if (!res.ok) {
      const masked = maskUrl(url);
      // 상태별 상세 경고 메시지
      if (res.status === 429) {
        console.warn(`[steam-api] Rate limited (429) for ${masked}`);
      } else if (res.status === 403) {
        console.error(`[steam-api] Unauthorized (403) for ${masked} - API Key가 만료되었거나 유효하지 않습니다`);
      } else if (res.status >= 500) {
        console.error(`[steam-api] Server error (${res.status}) for ${masked}`);
      } else {
        console.error(`[steam-api] HTTP ${res.status} for ${masked}`);
      }
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
 *
 * @param steamId Steam64 ID
 * @returns 위시리스트 아이템 배열과 stale 여부. 실패 시 null.
 */
export async function getWishlist(
  steamId: string
): Promise<{ data: SteamWishlistItem[]; isStale: boolean } | null> {
  const cacheKey = `wishlist:${steamId}`;
  const cached = cacheGet<SteamWishlistItem[]>(cacheKey);
  if (cached) return cached;

  const url = `${STEAM_API_BASE}/IWishlistService/GetWishlist/v1/?key=${getSteamApiKey()}&steamid=${steamId}`;
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
 *
 * @param steamId Steam64 ID
 * @returns 소유 게임 배열과 stale 여부. 실패 시 null.
 */
export async function getOwnedGames(
  steamId: string
): Promise<{ data: SteamOwnedGame[]; isStale: boolean } | null> {
  const cacheKey = `library:${steamId}`;
  const cached = cacheGet<SteamOwnedGame[]>(cacheKey);
  if (cached) return cached;

  const url =
    `${STEAM_API_BASE}/IPlayerService/GetOwnedGames/v1/` +
    `?key=${getSteamApiKey()}&steamid=${steamId}` +
    `&include_appinfo=true&include_played_free_games=true`;
  const res = await fetchJson<SteamOwnedGamesResponse>(url);

  if (!res?.response?.games) return null;

  const games = res.response.games;
  cacheSet(cacheKey, games, CACHE_TTL.library);
  return { data: games, isStale: false };
}

/**
 * 앱 상세 정보를 가져온다 (게임 이름, is_free, 가격, 이미지 등).
 * store.steampowered.com/api/appdetails (비공식 API)
 *
 * Rate Limit: appDetails 딜레이 적용.
 * 삭제/이관된 앱은 success=false -> null 반환.
 *
 * 가격은 cc=KR&l=koreana로 KRW 기준 조회. price_overview는 자주 변하므로
 * 별도 캐시 키 `app:{appId}:price`로 짧은 TTL(appPrice)에 분리 저장한다.
 *
 * @param appId Steam App ID
 * @returns 앱 상세 정보와 stale 여부. 실패 시 null.
 */
export async function getAppDetails(
  appId: number
): Promise<{ data: SteamAppDetails; isStale: boolean } | null> {
  const cacheKey = `app:${appId}:info:KR`;
  const cached = cacheGet<SteamAppDetails>(cacheKey);
  if (cached) return cached;

  // 비공식 API Rate Limit 준수
  await delay(STEAM_API_DELAY.appDetails);

  // cc=KR로 한국 지역 가격(KRW), l=koreana로 한국어 정보 요청
  const url = `${STEAM_STORE_BASE}/api/appdetails?appids=${appId}&cc=KR&l=koreana`;
  const res = await fetchJson<SteamAppDetailsResponse>(url);

  if (!res) return null;

  const appData = res[String(appId)];
  if (!appData?.success || !appData.data) return null;

  cacheSet(cacheKey, appData.data, CACHE_TTL.appInfo);
  // 가격은 별도 캐시로 짧은 TTL 분리 저장 (없으면 null로 저장하여 재호출 방지)
  cacheSet(
    `app:${appId}:price:KR`,
    appData.data.price_overview ?? null,
    CACHE_TTL.appPrice
  );
  return { data: appData.data, isStale: false };
}

/**
 * 가격 정보만 빠르게 조회한다.
 * 가격 캐시(`app:{appId}:price`, 1시간 TTL)를 우선 확인하고,
 * 미스 시 getAppDetails를 호출해 캐시를 채운다.
 *
 * 무료 게임 또는 가격 정보 없는 게임은 null 반환.
 *
 * @param appId Steam App ID
 * @returns 가격 정보. 없으면 null.
 */
export async function getAppPrice(
  appId: number
): Promise<SteamPriceOverview | null> {
  const cached = cacheGet<SteamPriceOverview | null>(`app:${appId}:price:KR`);
  if (cached) return cached.data;

  // 캐시 미스: getAppDetails가 두 캐시를 모두 채운다
  const details = await getAppDetails(appId);
  return details?.data.price_overview ?? null;
}

/**
 * 게임 리뷰를 가져온다.
 * store.steampowered.com/appreviews/{appid} (공식 문서화 API)
 *
 * Rate Limit: reviews 딜레이 적용.
 *
 * @param appId 게임 AppID
 * @param language 언어 코드 (예: "koreana", "english"). "all"이면 전체.
 * @param count 가져올 리뷰 수 (1~20, 기본 10)
 * @param dayRange 기간 필터 (일). 0이면 전체 기간. Steam API day_range 파라미터로 직접 전달.
 * @returns 리뷰 배열과 stale 여부. 실패 시 null.
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

  // 공식 문서화 API Rate Limit 준수
  await delay(STEAM_API_DELAY.reviews);

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
 * @param vanityUrl 커스텀 URL 문자열 (예: "migurazi")
 * @returns Steam64 ID 문자열. 변환 실패 시 null.
 */
export async function resolveVanityUrl(
  vanityUrl: string
): Promise<string | null> {
  const url =
    `${STEAM_API_BASE}/ISteamUser/ResolveVanityURL/v1/` +
    `?key=${getSteamApiKey()}&vanityurl=${encodeURIComponent(vanityUrl)}`;
  const res = await fetchJson<SteamVanityUrlResponse>(url);

  if (!res || res.response.success !== 1) return null;
  return res.response.steamid ?? null;
}

/**
 * 게임을 이름으로 검색한다.
 * store.steampowered.com/api/storesearch (비공식 API)
 *
 * @param query 검색어
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
 * 여러 appid의 메타를 캐시 우선으로 일괄 조회한다.
 *
 * 사용처: `app/api/recommend/route.ts`. 라이브러리/위시리스트 합산 수십~수백
 * 개의 appid에 대해 getAppDetails를 호출해야 하는데, 캐시 미스는 1초 딜레이가
 * 누적되므로 STREAM_CONCURRENCY 단위로 병렬화한다.
 *
 * 취소(`isCancelled() === true`)는 매 배치 시작 전 검사 — 선례
 * `app/api/reviews/stream/route.ts:228-264`의 패턴과 동일. 진행 중인 배치는
 * 완료를 기다리고(개별 호출에 abort signal 미주입), 다음 배치로 넘어가기 전에
 * 즉시 중단한다. delay()가 1초 단위로 짧아 큰 누수 없이 신속히 멈춘다.
 *
 * @param appIds 조회할 appid 배열. 중복은 호출 측에서 제거 권장.
 * @param onProgress (loaded, total) — 한 게임 완료 시마다 호출
 * @param isCancelled 취소 검사 함수. true 반환 시 즉시 return (지금까지 결과 반환).
 * @returns Map<appid, SteamAppDetails | null>. null이면 조회 실패 (삭제/이관 앱 등).
 */
export async function getAppDetailsBatch(
  appIds: number[],
  onProgress?: (loaded: number, total: number) => void,
  isCancelled: () => boolean = () => false
): Promise<Map<number, SteamAppDetails | null>> {
  const result = new Map<number, SteamAppDetails | null>();
  const total = appIds.length;
  let loaded = 0;

  for (let i = 0; i < appIds.length; i += STREAM_CONCURRENCY) {
    if (isCancelled()) return result;
    const batch = appIds.slice(i, i + STREAM_CONCURRENCY);
    const results = await Promise.allSettled(batch.map(id => getAppDetails(id)));
    for (let j = 0; j < batch.length; j++) {
      const appid = batch[j];
      const r = results[j];
      if (r.status === "fulfilled") {
        result.set(appid, r.value?.data ?? null);
      } else {
        // Promise rejection은 fetchJson이 null 반환으로 처리하므로 거의 도달 안 함.
        // 안전망: 거기서 실패하면 null로 기록하여 호출 측이 분기할 수 있도록.
        result.set(appid, null);
      }
      loaded++;
      onProgress?.(loaded, total);
      if (isCancelled()) return result;
    }
  }
  return result;
}

/**
 * Steam 사용자 프로필 정보를 가져온다 (닉네임, 아바타 등).
 * ISteamUser/GetPlayerSummaries/v2 (공식 API)
 *
 * @param steamId Steam64 ID
 * @returns 닉네임과 아바타 URL. 실패 시 null.
 */
export async function getPlayerSummary(
  steamId: string
): Promise<{ personaname: string; avatarfull: string } | null> {
  const url =
    `${STEAM_API_BASE}/ISteamUser/GetPlayerSummaries/v2/` +
    `?key=${getSteamApiKey()}&steamids=${steamId}`;
  const res = await fetchJson<{
    response: {
      players: Array<{ personaname: string; avatarfull: string }>;
    };
  }>(url);

  return res?.response?.players?.[0] ?? null;
}
