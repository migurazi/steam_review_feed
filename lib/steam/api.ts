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
import { setAppMeta, setAppMetaBatch } from "@/lib/app-meta-cache";
import { getAppDetailsFromStore, setAppDetailsInStore } from "@/lib/app-details-store";
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
  ReviewSummary,
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

/**
 * fetchJson의 로그를 카테고리별 N초 윈도우로 요약한다.
 *
 * 배경: 5000+ 라이브러리의 /recommend 분석이 Steam Rate Limit에 부딪히면
 * fetchJson의 console.warn/error가 분당 수백~수천 건 발생. Next.js 16 dev
 * 서버가 모든 console output을 JSON 직렬화 + 파일 write + 터미널 stream으로
 * 가로채는데, 이 폭주가 Turbopack 컴파일 worker의 event loop를 마비시켜
 * "Jest worker encountered child process exceptions, exceeding retry limit"
 * 으로 dev UX가 깨진다. (.next/dev/logs/next-development.log의 429 폭주 직후
 * worker 충돌이 일관 관측됨)
 *
 * 정책:
 *   - 카테고리 키(`status:429` / `content-type` / `fetch-failure` 등)별
 *     bucket. status 코드만으로는 모든 실패 path를 커버 못 하므로 string key.
 *   - 첫 발생은 즉시 emit (carrier) — 디버깅 정보(URL 등) 즉시 노출.
 *   - 같은 윈도우 내 추가 발생은 count만 누적. 윈도우 종료 시 단일 요약 line.
 *   - timer는 Node에서 unref() 호출 — script/test 종료를 막지 않도록.
 *   - resetLogThrottle()은 vitest 격리용 export.
 */
const LOG_WINDOW_MS = 5000;
type Bucket = { count: number; level: "warn" | "error" };
const logBuckets = new Map<string, Bucket>();

/**
 * 카테고리 key 기준 throttled 로깅. 같은 key의 첫 호출은 즉시 emit하고,
 * 5초 이내 추가 호출은 counter만 증가시켜 윈도우 종료 시 요약 line emit.
 *
 * @param key 카테고리 식별자 (예: "status:429", "content-type", "fetch-failure")
 * @param level "warn" | "error" — 첫 호출의 level이 윈도우 내내 유지됨.
 *              같은 key에 대해 다른 level을 섞어 부르지 말 것 (불일치 시
 *              첫 level 우선, 본 throttle은 의도된 동작이지만 caller가
 *              일관성 유지 필요).
 * @param message 첫 호출 시 표시할 carrier 메시지 (URL/구체적 컨텍스트 포함)
 */
/**
 * @internal — 테스트 외 외부 사용 금지. fetchJson 내부 호출자만 가정.
 *   외부 모듈이 사용하면 카테고리 key 네임스페이스 충돌·일관성 깨질 위험.
 */
export function logThrottled(key: string, level: "warn" | "error", message: string): void {
  const existing = logBuckets.get(key);
  if (existing) {
    // carrier 활성 중 — 카운트만 누적. message/level 갱신 안 함(첫 호출 win).
    existing.count += 1;
    return;
  }
  // 첫 발생: 즉시 emit + 윈도우 시작
  if (level === "error") console.error(message);
  else console.warn(message);

  // setTimeout의 반환값은 NodeJS에서는 Timeout 객체, browser/edge에서는 number.
  // .unref()는 Timeout에만 존재하며 호출 시 event loop의 keep-alive 기여를
  // 제거한다. 미존재 환경(edge runtime 등)에선 try/catch로 흡수.
  const timer: unknown = setTimeout(() => {
    const b = logBuckets.get(key);
    logBuckets.delete(key);
    if (!b) return;
    if (b.count <= 1) return; // 윈도우 내 추가 발생 없으면 요약 skip
    const summary = `[steam-api] ${key} — ${b.count - 1}건 추가 발생 (최근 ${LOG_WINDOW_MS / 1000}초)`;
    if (b.level === "error") console.error(summary);
    else console.warn(summary);
  }, LOG_WINDOW_MS);
  if (timer && typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }
  logBuckets.set(key, { count: 1, level });
}

/**
 * 테스트 격리용. vitest의 각 테스트가 throttle 상태를 초기화할 수 있도록
 * pending timer를 cancel하고 bucket map을 비운다.
 *
 * 운영 코드에선 절대 호출 금지 — pending 요약 line이 사라진다.
 */
export function resetLogThrottle(): void {
  logBuckets.clear();
  // 주: setTimeout 핸들은 timer 콜백 클로저에 가비지 수집 의존. clearTimeout을
  // 위해선 핸들을 보관해야 하지만, 테스트 reset은 vi.useFakeTimers + vi.runAll
  // Timers로 처리하는 게 일반적. clear()만으로도 다음 호출이 정상 carrier로
  // 시작하므로 격리는 충분.
}

// --- Rate Limit 딜레이 ---

/** 지정된 시간(ms)만큼 대기한다. Steam API Rate Limit 준수용. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 적응형 Steam appdetails backoff.
 *
 * Steam appdetails의 Rate Limit은 정적이지 않다 — 부하·IP 평판·시간대에 따라
 * 변한다. 정적 delay만으론 충분치 않을 수 있어 429 응답을 감지해 동적으로 추가
 * 대기를 늘린다.
 *
 * 정책:
 *   - 429를 받으면 backoff에 5초 추가 (최대 30초까지)
 *   - 성공 응답(2xx)을 받으면 backoff를 500ms 감소 (최소 0)
 *   - delay(STEAM_API_DELAY.appDetails) 호출 측이 이 값을 추가로 sleep
 *
 * 동시에 한 process 내에서 발생하는 모든 appdetails 호출에 적용되는
 * "soft global rate-limit". Steam의 IP-level 한도를 자동 회피한다.
 */
let appDetailsBackoffMs = 0;
const APPDETAILS_BACKOFF_MAX_MS = 30_000;
const APPDETAILS_BACKOFF_429_INCREMENT_MS = 5_000;
const APPDETAILS_BACKOFF_SUCCESS_DECREMENT_MS = 500;

/** 현재 backoff 값을 sleep — 호출 측에서 base delay와 함께 사용. */
function appDetailsBackoffDelay(): Promise<void> {
  if (appDetailsBackoffMs <= 0) return Promise.resolve();
  return delay(appDetailsBackoffMs);
}

function bumpAppDetailsBackoff(): void {
  appDetailsBackoffMs = Math.min(
    appDetailsBackoffMs + APPDETAILS_BACKOFF_429_INCREMENT_MS,
    APPDETAILS_BACKOFF_MAX_MS,
  );
}

function relaxAppDetailsBackoff(): void {
  appDetailsBackoffMs = Math.max(
    appDetailsBackoffMs - APPDETAILS_BACKOFF_SUCCESS_DECREMENT_MS,
    0,
  );
}

/** 테스트용. 운영 코드에서 호출 금지. */
export function resetAppDetailsBackoff(): void {
  appDetailsBackoffMs = 0;
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

    // appdetails 호출에 한해 적응형 backoff 갱신 — Steam의 IP-level rate limit
    // 변동(시간대·평판)에 자동 적응. URL 기반 dispatch (fetchJson을 share하는
    // 다른 endpoint에는 영향 없게).
    const isAppDetails = url.includes("/api/appdetails");

    if (!res.ok) {
      const masked = maskUrl(url);
      // 상태별 상세 경고 메시지 — 동일 카테고리는 5초 윈도우로 요약하여 로그
      // 폭주에 의한 dev server worker 압박을 회피.
      if (res.status === 429) {
        if (isAppDetails) bumpAppDetailsBackoff();
        logThrottled("status:429", "warn", `[steam-api] Rate limited (429) for ${masked}`);
      } else if (res.status === 403) {
        logThrottled("status:403", "error", `[steam-api] Unauthorized (403) for ${masked} - API Key가 만료되었거나 유효하지 않습니다`);
      } else if (res.status >= 500) {
        logThrottled(`status:${res.status}`, "error", `[steam-api] Server error (${res.status}) for ${masked}`);
      } else {
        logThrottled(`status:${res.status}`, "error", `[steam-api] HTTP ${res.status} for ${masked}`);
      }
      return null;
    }

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      // Steam 점검 시 200 status로 HTML 응답이 오는 경우 흔함 — 동일 throttle
      // 정책 적용해 worker 충돌 회귀(이전 PR이 막은 시나리오)를 다른 경로로
      // 재현하지 않도록 한다.
      logThrottled("content-type", "error", `[steam-api] Unexpected content-type "${contentType}" for ${maskUrl(url)}`);
      return null;
    }

    // 정상 응답 — backoff를 조금 완화. 일관된 성공이 누적되면 결국 0으로 수렴.
    if (isAppDetails) relaxAppDetailsBackoff();

    return (await res.json()) as T;
  } catch (err) {
    // 네트워크 장애·DNS 일시 실패·abort 등도 동일 throttle. err 객체의 stringify
    // 비용 (분당 수천 건이면 측정 가능)도 함께 회피된다.
    logThrottled(
      "fetch-failure",
      "error",
      `[steam-api] Fetch failed for ${maskUrl(url)}: ${err instanceof Error ? err.message : String(err)}`
    );
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
  // 라이브러리 응답은 include_appinfo=true로 name을 동봉한다. 이 이름은 가장
  // 권위 있는 출처이므로 영속 메타에 일괄 저장한다. header_image는 라이브러리
  // 응답에 없으므로 기존값 유지(COALESCE).
  try {
    setAppMetaBatch(
      games.map(g => ({ appId: g.appid, name: g.name }))
    );
  } catch (err) {
    console.warn("[steam-api] app_meta batch write failed for library:", err);
  }
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
  // 1) 인메모리 LRU 체크 — 가장 빠른 경로 (process 내 sub-ms).
  const cached = cacheGet<SteamAppDetails>(cacheKey);
  if (cached) return cached;

  // 2) SQLite 영속 캐시 hydrate — LRU가 dev HMR/재시작으로 비워졌어도 1주 내
  //    fetched_at의 row가 있으면 즉시 사용. 5000+ 라이브러리의 cold-restart
  //    회귀를 막는 핵심 단계.
  //    price_overview는 의도적으로 빠진 상태로 저장돼 있으므로 별도 price
  //    캐시(짧은 TTL)가 가격 정보를 책임진다.
  try {
    const stored = getAppDetailsFromStore(appId);
    if (stored) {
      const ageMs = Date.now() - stored.fetchedAt;
      if (ageMs < CACHE_TTL.appInfo) {
        // 인메모리 LRU 채워두기 — 같은 process 내 후속 호출은 1)에서 hit.
        cacheSet(cacheKey, stored.details, CACHE_TTL.appInfo);
        return { data: stored.details, isStale: false };
      }
      // 만료된 row는 fall-through하여 API 재호출. 다음 setAppDetailsInStore가
      // INSERT OR REPLACE로 덮어쓴다.
    }
  } catch (err) {
    console.warn(`[steam-api] app_details_cache read failed for ${appId}:`, err);
  }

  // 3) API 호출 — Rate Limit 준수
  await delay(STEAM_API_DELAY.appDetails);
  // 최근 429를 본 적이 있으면 적응형 backoff 추가 sleep. 429이 누적되면 최대
  // 30초까지 확장되어 Steam IP-rate-limit이 풀릴 시간을 준다. 성공이 누적되면
  // 다시 0으로 수렴.
  await appDetailsBackoffDelay();

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
  // 영속 메타 캐시 — 재시작·Rate Limit 시 fallback 용도.
  // DB I/O 실패가 API 흐름을 막지 않도록 try/catch.
  try {
    setAppMeta(appId, appData.data.name, appData.data.header_image);
  } catch (err) {
    console.warn(`[steam-api] app_meta write failed for ${appId}:`, err);
  }
  // SQLite 영속 SteamAppDetails 캐시 — LRU의 백업.
  // price_overview는 의도적으로 stripping해 저장: 7일 지난 stale 가격이 다음
  // hydrate에서 잘못 표시되는 회귀 방지. 가격은 별도 짧은 TTL 캐시가 담당.
  try {
    const { price_overview: _, ...detailsNoPrice } = appData.data;
    void _; // eslint: 의도된 비사용 (price stripping 의도 명시)
    setAppDetailsInStore(appId, detailsNoPrice as SteamAppDetails);
  } catch (err) {
    console.warn(`[steam-api] app_details_cache write failed for ${appId}:`, err);
  }
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
 * 게임의 리뷰 호평률 요약(query_summary)을 조회한다.
 * store.steampowered.com/appreviews/{appid} (공식 문서화 API)
 *
 * getReviews와 목적이 다르다: 본문 리뷰가 아니라 전체 기간 누적 집계
 * (total_positive/total_negative/total_reviews)만 필요하므로
 *   - num_per_page=0 : 본문 리뷰 0개 요청 → 페이로드 최소화
 *   - filter=all     : 전체 기간 누적 요약 (getReviews의 filter=recent는 롤링 요약이라 부적합)
 * 로 호출한다. /recommend 추천 랭킹의 리뷰 블렌딩(작업 지시서 단계 2)에 사용.
 *
 * 캐시: `reviewsummary:{appId}` 키 + CACHE_TTL.reviewSummary(6h). getReviews의
 *   `reviews:*` 키와 분리하여 서로 무효화에 영향 주지 않는다.
 *
 * Rate Limit: reviews 딜레이(500ms) 적용.
 *
 * @param appId 게임 AppID
 * @returns 요약. 조회 실패 / success!==1 / query_summary 누락(num_per_page=0 미지원 등)
 *   시 null. 호출 측은 null을 중립(0.5)으로 흡수한다.
 */
export async function getReviewSummary(appId: number): Promise<ReviewSummary | null> {
  const cacheKey = `reviewsummary:${appId}`;
  const cached = cacheGet<ReviewSummary>(cacheKey);
  if (cached) return cached.data;

  await delay(STEAM_API_DELAY.reviews);

  const url =
    `${STEAM_STORE_BASE}/appreviews/${appId}?json=1` +
    `&num_per_page=0&language=all&purchase_type=all&filter=all`;

  const res = await fetchJson<SteamReviewsResponse>(url);

  // success 플래그 또는 query_summary 누락 시 조회 실패로 처리 (getReviews:454 패턴).
  if (!res || res.success !== 1 || !res.query_summary) return null;

  const qs = res.query_summary;
  const summary: ReviewSummary = {
    reviewScore: qs.review_score,
    reviewScoreDesc: qs.review_score_desc,
    totalPositive: qs.total_positive,
    totalNegative: qs.total_negative,
    totalReviews: qs.total_reviews,
  };
  cacheSet(cacheKey, summary, CACHE_TTL.reviewSummary);
  return summary;
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
 * @param onProgress (loaded, total, partial) — 한 게임 완료 시마다 호출.
 *   partial은 지금까지 채워진 결과 Map (읽기 전용으로 다루기). 호출 측이
 *   진행 중 부분 결과로 잠정 분석/추천을 emit하는 데 사용한다.
 * @param isCancelled 취소 검사 함수. true 반환 시 즉시 return (지금까지 결과 반환).
 * @returns Map<appid, SteamAppDetails | null>. null이면 조회 실패 (삭제/이관 앱 등).
 */
export async function getAppDetailsBatch(
  appIds: number[],
  onProgress?: (
    loaded: number,
    total: number,
    partial: ReadonlyMap<number, SteamAppDetails | null>
  ) => void,
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
      onProgress?.(loaded, total, result);
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
