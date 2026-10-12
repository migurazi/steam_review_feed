/**
 * Steam API 클라이언트.
 *
 * 모든 Steam API 호출을 캐시 우선으로 처리한다.
 * 캐시 미스 시 API 호출 -> 캐시 저장. Rate Limit 딜레이 적용.
 *
 * API 분류 (기획서 7.1절):
 * - 공식 API (api.steampowered.com): IWishlistService, IPlayerService, ISteamUser,
 *   IStoreBrowseService/GetItems (키 불필요, 발굴 트랙)
 * - 공식 문서화 (store.steampowered.com): appreviews
 * - 비공식 (store.steampowered.com): appdetails, storesearch, search/results, featuredcategories
 *
 * 에러 처리:
 *   fetchJson은 모든 HTTP 오류를 null로 반환한다.
 *   상태별(429, 403, 5xx) 상세 메시지를 콘솔에 기록하여 디버깅이 가능하다.
 *   네트워크 오류, Content-Type 불일치, JSON 파싱 실패도 null 반환.
 */

import { cacheGet, cacheSet, CACHE_TTL, lastKnownPriceGet, lastKnownPriceSet } from "@/lib/cache";
import { getSteamApiKey } from "@/lib/env";
import {
  STEAM_API_DELAY,
  PRICE_BATCH_SIZE,
  PRICE_LAST_KNOWN_TTL_MS,
  DISCOVER_SEARCH_PAGE_SIZE,
  STORE_ITEMS_BATCH_SIZE,
} from "@/lib/constants";
import { parseSearchResultAppIds, countSearchResultRows, normalizeStoreItem } from "./deals";
import { steamStoreUrl } from "@/lib/bundle/parse";
import { setAppMeta, setAppMetaBatch, setAppMetaFromStoreBatch } from "@/lib/app-meta-cache";
import { getAppDetailsFromStore, setAppDetailsInStore } from "@/lib/app-details-store";
import { computeSchemaHash } from "@/lib/achievement-diff";
import { getStoreMetaFromStore, getStoreMetaIdsInStore, setStoreMetaInStore } from "@/lib/store-meta-store";
import { storeItemToAppDetails, storeItemPriceIsAppPrice, storeItemHeaderImage, STORE_META_DATA_REQUEST } from "./store-meta";
import { getGlobalFromStore, setGlobalInStore } from "@/lib/achievement-store";
import type {
  SteamWishlistItem,
  SteamWishlistResponse,
  SteamOwnedGame,
  SteamOwnedGamesResponse,
  SteamAppDetails,
  SteamAppDetailsResponse,
  SteamPriceOverview,
  SteamPriceBatchResponse,
  PriceSnapshot,
  SteamSearchResultsResponse,
  SteamFeaturedCategoriesResponse,
  SteamStoreBrowseResponse,
  SteamStoreBrowseItem,
  StoreItemRef,
  StoreItemSummary,
  SteamReview,
  SteamReviewsResponse,
  ReviewSummary,
  SteamVanityUrlResponse,
  SteamStoreSearchItem,
  SteamStoreSearchResponse,
  AchievementDef,
  SteamRawAchievementDef,
  SteamAchievementSchemaResponse,
  SteamPlayerAchievementsResponse,
  SteamGlobalPercentagesResponse,
} from "./types";
import type { GameRow, GameRowPrice } from "@/lib/bundle/types";

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
 *   - 마지막 429 이후 APPDETAILS_BACKOFF_IDLE_RESET_MS 동안 429가 없으면 0으로 초기화
 *   - delay(STEAM_API_DELAY.appDetails) 호출 측이 이 값을 추가로 sleep
 *
 * 시간 기반 초기화가 필요한 이유: 성공 응답에 의한 감소만 있으면, 429가 몰린 뒤 트래픽이 끊기면
 * backoff가 몇 시간이고 0보다 큰 채로 남는다(30s → 0까지 성공 60회 필요). 이 값을 "최근 429"
 * 신호로 쓰는 곳(getAppPriceSnapshot의 대기 생략, /recommend 가격 재시도 판정)이 Steam이 이미
 * 회복된 뒤에도 계속 장애 모드로 동작하게 된다 (/code-review 3차 #1).
 *
 * 동시에 한 process 내에서 발생하는 모든 appdetails 호출에 적용되는
 * "soft global rate-limit". Steam의 IP-level 한도를 자동 회피한다.
 */
let appDetailsBackoffMs = 0;
/** 마지막 429 시각 (Unix ms). 0이면 아직 없음. 시간 기반 초기화 판정용. */
let lastAppDetails429At = 0;
const APPDETAILS_BACKOFF_MAX_MS = 30_000;
const APPDETAILS_BACKOFF_429_INCREMENT_MS = 5_000;
const APPDETAILS_BACKOFF_SUCCESS_DECREMENT_MS = 500;
/**
 * 429 없이 이만큼 지나면 backoff를 0으로 되돌린다. Steam store의 IP 한도 창이 대략 5분 단위라
 * 그 이상 조용했으면 한도가 풀렸다고 본다. 다시 429가 오면 bump가 곧바로 올린다.
 */
const APPDETAILS_BACKOFF_IDLE_RESET_MS = 5 * 60 * 1000;

/**
 * 현재 유효한 backoff 값(ms). 마지막 429 이후 IDLE_RESET이 지났으면 여기서 0으로 초기화한다.
 * backoff를 읽는 모든 경로는 변수 대신 이 함수를 거친다.
 */
function currentAppDetailsBackoffMs(): number {
  if (appDetailsBackoffMs > 0 && Date.now() - lastAppDetails429At >= APPDETAILS_BACKOFF_IDLE_RESET_MS) {
    appDetailsBackoffMs = 0;
  }
  return appDetailsBackoffMs;
}

/** 현재 backoff 값을 sleep — 호출 측에서 base delay와 함께 사용. */
function appDetailsBackoffDelay(): Promise<void> {
  const ms = currentAppDetailsBackoffMs();
  if (ms <= 0) return Promise.resolve();
  return delay(ms);
}

function bumpAppDetailsBackoff(): void {
  // 오래된 backoff가 남아 있으면 먼저 초기화한 뒤 올린다 — 5분 전 30s에 5s를 더하지 않도록.
  appDetailsBackoffMs = Math.min(
    currentAppDetailsBackoffMs() + APPDETAILS_BACKOFF_429_INCREMENT_MS,
    APPDETAILS_BACKOFF_MAX_MS,
  );
  lastAppDetails429At = Date.now();
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
  lastAppDetails429At = 0;
}

/**
 * 현재 공유 store backoff 값(ms). 0이면 최근(IDLE_RESET 이내) 429가 없다.
 * 테스트와 /recommend의 가격 재시도 판단(최근 429 중이면 재시도 생략)에서 쓴다.
 */
export function getAppDetailsBackoffMs(): number {
  return currentAppDetailsBackoffMs();
}

/**
 * 공유 backoff 대상 URL인지 판정한다.
 *
 * store.steampowered.com의 비공식 엔드포인트(appdetails, 가격 배치, 검색, featured 등)는
 * 같은 IP-level Rate Limit을 공유하므로 어느 쪽의 429든 backoff를 올려야 한다.
 * appreviews는 공식 문서화 엔드포인트로 한도 체계가 달라 제외한다.
 * (작업 지시서 20261010_01 §1-1, Momus M7)
 */
export function isStoreRateLimited(url: string): boolean {
  // storesearch는 사용자 타이핑마다 딜레이 없이 호출되므로 제외한다 — 포함하면 검색
  // 입력의 429가 /recommend의 backoff를 30초까지 끌어올린다.
  return url.startsWith(`${STEAM_STORE_BASE}/`)
    && !url.includes("/appreviews/")
    && !url.includes("/api/storesearch");
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

    // store 비공식 엔드포인트에 한해 적응형 backoff 갱신 — Steam의 IP-level rate
    // limit 변동(시간대·평판)에 자동 적응. URL 기반 dispatch (공식 API·appreviews
    // 에는 영향 없게). 판정 기준은 isStoreRateLimited 참조.
    const isAppDetails = isStoreRateLimited(url);

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
  // 가격은 별도 캐시로 짧은 TTL 분리 저장 (없으면 null로 저장하여 재호출 방지).
  // last-known(24h)도 함께 기록해 가격 조회 장애 시 fallback이 되게 한다 (20261010_02 §1-1).
  writePriceCache(appId, appData.data.price_overview ?? null, CACHE_TTL.appPrice, Date.now());
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

/** 가격 캐시 키 (신선도 판단용, TTL appPrice=1h). getAppDetails 신규 조회와 가격 배치가 공유한다. */
function priceCacheKey(appId: number): string {
  return `app:${appId}:price:KR`;
}

/**
 * 가격을 신선도 키(메인 LRU, appPrice TTL)와 last-known(전용 LRU, 24h)에 함께 기록한다.
 * 가격을 받는 모든 경로가 이 헬퍼를 쓴다. 작업 지시서 20261010_02 §1-1.
 *
 * last-known을 따로 두는 이유: lru-cache(allowStale)는 만료 항목을 처음 get할 때 돌려주면서
 * 삭제한다. 그래서 가격 키의 stale 값은 정확히 한 번만 fallback으로 쓸 수 있었고, Steam 일시 장애가
 * 두 번 이어지면 가격이 사라졌다. last-known은 24시간 동안 여러 번 읽어도 남는다. 원래 fetchedAt을
 * 담아 클라이언트가 묵은 가격을 회색·"N시간 전 가격"으로 구분하게 한다. 메인 LRU를 압박하지 않도록
 * lib/cache.ts의 전용 인스턴스에 둔다 (/code-review 2차 R2).
 */
function writePriceCache(appId: number, price: SteamPriceOverview | null, ttl: number, fetchedAt: number): void {
  cacheSet(priceCacheKey(appId), price, ttl);
  lastKnownPriceSet<SteamPriceOverview | null>(appId, { price, fetchedAt });
}

/** last-known 가격 (24시간 이내에 마지막으로 확인한 가격). 없으면 null. */
function readLastKnownPrice(appId: number): PriceSnapshot | null {
  return lastKnownPriceGet<SteamPriceOverview | null>(appId);
}

/**
 * 같은 appid의 대화형 가격 재조회 진행 중 Promise (20261010_02 §2-1).
 * 만료 직후 여러 탭·사용자가 같은 게임을 열어도 store 호출은 한 번만 나가고 모두 그 결과를 공유한다.
 */
const priceRefreshInFlight = new Map<number, Promise<PriceSnapshot | undefined>>();

/**
 * 단건 가격 재조회 (dedupe). 대화형 경로라 base delay(1.5s)를 생략하고 공유 backoff만 따른다 —
 * 사용자 클릭당 1회 호출이라 배치처럼 연속 호출하지 않기 때문 (§2-2).
 * @returns 받은 스냅샷. 조회 실패면 undefined.
 */
function refreshPriceDeduped(appId: number): Promise<PriceSnapshot | undefined> {
  const running = priceRefreshInFlight.get(appId);
  if (running) return running;
  const p = getAppPricesBatch([appId], undefined, undefined, { skipBaseDelay: true })
    .then(m => m.get(appId))
    .catch(err => {
      console.warn(`[steam-api] price refresh failed for ${appId}:`, err);
      return undefined;
    })
    .finally(() => priceRefreshInFlight.delete(appId));
  priceRefreshInFlight.set(appId, p);
  return p;
}

/**
 * 가격 스냅샷을 조회한다 (게임 상세 화면용). 작업 지시서 20261010_02 §1-3, §2.
 *
 *   1) 가격 키가 fresh            → 그대로 (fetchedAt = 캐시 기록 시각).
 *   2) last-known(24h)이 있음     → 즉시 반환 + 백그라운드 재조회(dedupe).
 *   3) 최근 429로 backoff 중      → 기다리지 않는다. info LRU의 price_overview(최대 7일 묵음)가 있으면
 *                                   그 시각과 함께 즉시 반환 + 백그라운드 재조회.
 *   4) 그 외                       → 재조회를 기다린다(base delay 없음, dedupe).
 *
 * 묵은 값은 항상 원래 fetchedAt과 함께 반환한다 — 라우트가 priceFetchedAt으로 내려 화면이 회색 표시.
 * (단계 1의 이전 구현은 stale 첫 읽기 후 항목이 삭제되어, 백그라운드 재조회가 실패하면 다음 요청이
 * 완전 미스로 1.5s+backoff를 기다린 뒤 null을 반환했다.)
 *
 * @returns 스냅샷. price=null은 무료/미판매. 아무 정보도 얻지 못하면 null.
 */
export async function getAppPriceSnapshot(appId: number): Promise<PriceSnapshot | null> {
  const cached = cacheGet<SteamPriceOverview | null>(priceCacheKey(appId));
  if (cached && !cached.isStale) return { price: cached.data, fetchedAt: cached.fetchedAt };

  // 가격 키의 stale 값은 last-known이 없을 때(배포 직후·last-known만 밀려남)의 보조 fallback이다.
  // getAppPricesBatch와 같은 24시간 상한을 둔다 — 메인 LRU는 만료 항목을 읽힐 때까지 들고 있어서
  // 상한 없이 쓰면 며칠 묵은 "할인 중" 가격이 나갈 수 있다 (/code-review 3차 #3).
  const staleFallback = cached && Date.now() - cached.fetchedAt <= PRICE_STALE_FALLBACK_MAX_AGE_MS
    ? { price: cached.data, fetchedAt: cached.fetchedAt }
    : null;
  const lastKnown = readLastKnownPrice(appId) ?? staleFallback;
  if (lastKnown) {
    void refreshPriceDeduped(appId);
    return { ...lastKnown, fallback: true };
  }

  if (currentAppDetailsBackoffMs() > 0) {
    // info LRU 가격도 24시간 상한을 지킨다 — info는 7일 캐시라 그대로 쓰면 끝난 할인이 보일 수 있다.
    // (신규 조회 시 last-known도 함께 기록되므로, 실제로 이 경로가 쓰이는 것은 LRU가 last-known만
    // 밀어낸 경우 정도다.) 상한을 넘으면 기다리지 않고 미상으로 두고 백그라운드 재조회만 건다.
    const info = cacheGet<SteamAppDetails>(`app:${appId}:info:KR`);
    void refreshPriceDeduped(appId);
    if (info?.data.price_overview && Date.now() - info.fetchedAt <= PRICE_STALE_FALLBACK_MAX_AGE_MS) {
      return { price: info.data.price_overview, fetchedAt: info.fetchedAt, fallback: true };
    }
    return null;
  }

  return (await refreshPriceDeduped(appId)) ?? null;
}

/** 테스트용. 진행 중 재조회 맵을 비운다. */
export function resetPriceRefreshInFlight(): void {
  priceRefreshInFlight.clear();
}

/**
 * 가격 배치 응답의 한 항목을 정규화한다.
 * price_overview가 있으면 그 값, success=true인데 가격이 없거나(`data: []`) success=false면 null.
 */
function normalizePriceEntry(
  entry: SteamPriceBatchResponse[string] | undefined
): { price: SteamPriceOverview | null; ttl: number; unavailable: boolean } | undefined {
  // 응답에 appid 자체가 없음 → 미상(캐시 안 함).
  if (!entry) return undefined;
  // success=false: cc=KR에서 삭제·지역제한 앱은 매번 같은 답이라 "미상"으로 두면 매 분석마다
  // 재조회되고 가격 커버리지를 영구히 깎는다. 반대로 일시 이상일 수도 있으므로 판매 불가(null)
  // 로 보되 짧은 TTL로만 캐시한다. unavailable=true로 표시해 호출 측이 last-known을 덮지 않게 한다.
  if (!entry.success) return { price: null, ttl: PRICE_UNAVAILABLE_TTL_MS, unavailable: true };
  const data = entry.data;
  if (data && !Array.isArray(data) && data.price_overview) {
    return { price: data.price_overview, ttl: CACHE_TTL.appPrice, unavailable: false };
  }
  return { price: null, ttl: CACHE_TTL.appPrice, unavailable: false };
}

/** success=false(판매 불가) 가격 캐시 TTL. 일시 이상일 가능성을 고려해 짧게. */
const PRICE_UNAVAILABLE_TTL_MS = 10 * 60 * 1000;

/**
 * 재조회 실패 시 가격 키의 stale 값을 fallback으로 쓸 수 있는 최대 나이 (last-known이 없을 때의
 * 보조 경로 — 배포 직후 last-known이 아직 없는 항목용). last-known TTL과 같은 24시간.
 * 이보다 오래된 가격은 끝난 할인을 "할인 중"으로 보여줄 위험이 커서 미상으로 둔다.
 */
const PRICE_STALE_FALLBACK_MAX_AGE_MS = PRICE_LAST_KNOWN_TTL_MS;

/**
 * 여러 앱의 가격을 한 번에 조회한다 (작업 지시서 20261010_01 §1-1).
 *
 * - 가격 캐시가 fresh인 appid는 호출 없이 결과에 포함한다. stale은 미스로 취급.
 * - 미스분은 appdetails `filters=price_overview` 다중 appid로 PRICE_BATCH_SIZE씩 조회.
 *   배치마다 appDetails 딜레이 + 공유 backoff (같은 store 호스트 Rate Limit).
 * - fetch 실패한 배치의 appid는 캐시에 쓰지 않는다. 실패를 null로 캐시하면 1시간 동안
 *   "무료/미판매"로 오표시되기 때문. 대신 last-known(24h, 20261010_02 §1-2) → 가격 키의 stale
 *   값(24h 이내) 순으로 원래 fetchedAt과 함께 채운다(클라이언트가 회색 표시). 둘 다 없으면 미상(누락).
 *   last-known은 만료 전까지 삭제되지 않으므로 연속 실패에도 매번 채워진다.
 * - 영속 저장하지 않는다(가격은 짧은 수명).
 *
 * @param opts.skipBaseDelay 대화형 단건 조회용. base delay(1.5s)를 생략하고 공유 backoff만 따른다.
 * @returns appid → PriceSnapshot. 없는 appid는 가격 미상.
 */
export async function getAppPricesBatch(
  appIds: number[],
  onProgress?: (loaded: number, total: number) => void,
  isCancelled: () => boolean = () => false,
  opts: { skipBaseDelay?: boolean } = {}
): Promise<Map<number, PriceSnapshot>> {
  const result = new Map<number, PriceSnapshot>();
  const uniqueIds = Array.from(new Set(appIds));
  const total = uniqueIds.length;
  let loaded = 0;
  const misses: number[] = [];
  // 가격 키의 stale 항목은 lru-cache가 첫 get에서 삭제하므로 여기서 보관해 두고, 재조회에 실패했고
  // last-known도 없는 appid에만 보조 fallback으로 쓴다.
  const staleById = new Map<number, PriceSnapshot>();

  for (const id of uniqueIds) {
    const cached = cacheGet<SteamPriceOverview | null>(priceCacheKey(id));
    if (cached && !cached.isStale) {
      result.set(id, { price: cached.data, fetchedAt: cached.fetchedAt });
      loaded++;
    } else {
      if (cached) staleById.set(id, { price: cached.data, fetchedAt: cached.fetchedAt });
      misses.push(id);
    }
  }
  if (loaded > 0) onProgress?.(loaded, total);

  for (let i = 0; i < misses.length; i += PRICE_BATCH_SIZE) {
    if (isCancelled()) return result;
    const batch = misses.slice(i, i + PRICE_BATCH_SIZE);

    if (!opts.skipBaseDelay) await delay(STEAM_API_DELAY.appDetails);
    await appDetailsBackoffDelay();
    if (isCancelled()) return result;

    const url =
      `${STEAM_STORE_BASE}/api/appdetails?appids=${batch.join(",")}` +
      `&filters=price_overview&cc=KR`;
    const res = await fetchJson<SteamPriceBatchResponse>(url);
    const fetchedAt = Date.now();

    if (res) {
      for (const id of batch) {
        const normalized = normalizePriceEntry(res[String(id)]);
        if (normalized === undefined) continue;
        if (normalized.unavailable) {
          // success=false는 일시 이상일 수 있다. 최근(24h) 실제 가격을 본 적이 있으면 이번 응답을
          // 믿지 않고 조회 실패와 같게 취급한다 — 결과에서 빼면 아래 fallback이 last-known으로
          // 채운다(fallback=true라 커버리지에는 세지 않음). 다음 조회에서 다시 확인한다.
          // last-known이 없거나 이미 null(판매 불가)이면 판매 불가로 확정하되, last-known은 건드리지
          // 않고 짧은 TTL의 신선도 키만 쓴다. 이전 구현은 last-known까지 null로 덮어 24시간 동안
          // 실제 가격 fallback을 잃었다 (/code-review 3차 #2).
          if (readLastKnownPrice(id)?.price) continue;
          cacheSet(priceCacheKey(id), null, normalized.ttl);
          result.set(id, { price: null, fetchedAt });
          continue;
        }
        writePriceCache(id, normalized.price, normalized.ttl, fetchedAt);
        result.set(id, { price: normalized.price, fetchedAt });
      }
    }
    loaded += batch.length;
    onProgress?.(loaded, total);
  }
  // 조회하지 못한 미스분 fallback: last-known → 가격 키 stale(24h 이내). 취소로 중단된 경우에도
  // 위 루프의 return 전까지 도달하지 않으므로, 이 fallback은 끝까지 진행한 조회에만 적용된다.
  const now = Date.now();
  for (const id of misses) {
    if (result.has(id)) continue;
    const lastKnown = readLastKnownPrice(id);
    if (lastKnown) {
      result.set(id, { ...lastKnown, fallback: true });
      continue;
    }
    const stale = staleById.get(id);
    if (stale && now - stale.fetchedAt <= PRICE_STALE_FALLBACK_MAX_AGE_MS) result.set(id, { ...stale, fallback: true });
  }
  return result;
}

// --- 스토어 할인 발굴 (작업 지시서 20261010_01 단계 2) ---

const STORE_SPECIALS_CACHE_KEY = "store:specials:KR";

/** GetItems 요약 캐시 키. 가격을 담으므로 KR 고정 컨텍스트를 키에 명시한다. */
function storeItemCacheKey(appId: number): string {
  return `storeitem:${appId}:KR`;
}

/**
 * 지금 할인 중인 게임 appid 후보를 모은다 (발굴 트랙 후보 수집, §2-2).
 *
 * 소스 (단계 0 V3·V4, 부록 B 설계 확정 3):
 *   (a) 검색 specials — `specials=1&sort_by=Reviews_DESC&category1=998`(게임만, 리뷰순),
 *       DISCOVER_SEARCH_PAGE_SIZE(100)씩 maxItems까지 페이지 순회. results_html에서
 *       parseSearchResultAppIds로 appid만 추출(패키지·번들·다중 앱 행 제외).
 *   (b) (a)의 첫 페이지가 실패하면 featuredcategories specials(약 10개)로 fallback.
 *
 * 호출 규칙: 페이지마다 appDetails 딜레이 + 공유 store backoff (같은 store 호스트 한도).
 * 페이지 사이와 딜레이 직후에 shouldStop을 확인한다 — 발굴 시간 예산·탭 닫기 대응.
 *
 * 캐시: `store:specials:KR` (1시간, 사용자 무관 공유). (a)로 끝까지 모았을 때만 저장한다.
 *   - 실패·(b) fallback 결과는 저장하지 않는다 — 다음 분석에서 (a)를 다시 시도하도록.
 *   - shouldStop으로 중간에 끊긴 결과도 저장하지 않는다(불완전한 목록을 1시간 굳히지 않게).
 *   - 2페이지 이후 실패는 이미 모은 결과로 진행하되 저장하지 않는다.
 *
 * 파서 이상 감지: success 페이지인데 아직 결과가 남았으면서(start < total_count) 행을 하나도
 *   못 뽑으면 검색 HTML 구조 변경·일시적 빈 응답으로 본다(로그). 첫 페이지면 fallback, 후속
 *   페이지면 모은 만큼 degraded로 진행한다. 그렇지 않으면 짧거나 빈 목록이 "정상 완료"로 1시간
 *   캐시되어 모든 사용자에게 잘린 결과·"할인 게임 없음"이 보인다. 빈 목록은 어떤 경우에도 캐시하지 않는다.
 *
 * @returns ids = 후보 appid(순서 = 리뷰순). degraded = 계획한 소스를 끝까지 확인하지 못함
 *   (featured fallback, 후속 페이지 실패, shouldStop 중단) — 라우트가 "일부 후보만 확인"으로 알린다.
 *   두 소스 모두 실패하면 null.
 */
export async function getStoreSpecials(
  maxItems: number,
  shouldStop: () => boolean = () => false
): Promise<{ ids: number[]; degraded: boolean } | null> {
  const cached = cacheGet<number[]>(STORE_SPECIALS_CACHE_KEY);
  if (cached && !cached.isStale) return { ids: cached.data.slice(0, maxItems), degraded: false };

  const ids: number[] = [];
  const seen = new Set<number>();
  let complete = false;
  let firstPageFailed = false;

  for (let start = 0; ids.length < maxItems; start += DISCOVER_SEARCH_PAGE_SIZE) {
    if (shouldStop()) break;
    await delay(STEAM_API_DELAY.appDetails);
    await appDetailsBackoffDelay();
    if (shouldStop()) break;

    const url =
      `${STEAM_STORE_BASE}/search/results/?specials=1&infinite=1&json=1&cc=KR&l=koreana` +
      `&sort_by=Reviews_DESC&category1=998&start=${start}&count=${DISCOVER_SEARCH_PAGE_SIZE}`;
    const res = await fetchJson<SteamSearchResultsResponse>(url);
    if (!res || res.success !== 1 || typeof res.results_html !== "string") {
      if (start === 0) firstPageFailed = true;
      break;
    }
    const pageIds = parseSearchResultAppIds(res.results_html);
    // 행 수는 패키지·번들 행까지 센다. 단일 게임이 0개여도 행이 있으면 정상 페이지다.
    const pageRows = countSearchResultRows(res.results_html);
    // total_count가 숫자가 아니면(누락·문자열) "끝"을 판단할 근거가 없다. 0으로 보면 첫 페이지가
    // 곧 끝으로 판정되어 잘린 목록이 "정상 완료"로 1시간 캐시된다 (/code-review 2차 R6).
    // 모를 때는 maxItems를 채운 경우만 complete로 인정하고, 빈 페이지는 이상으로 본다.
    const totalKnown = typeof res.total_count === "number" && Number.isFinite(res.total_count);
    const totalCount = totalKnown ? res.total_count : Number.POSITIVE_INFINITY;
    // 아직 결과가 남았다는(start < total_count) 페이지에서 행을 하나도 못 찾으면 끝이 아니라 이상이다
    // (마크업 변경·일시적 빈 응답). 끝으로 보면 짧은 목록이 "정상 완료"로 1시간 캐시된다.
    //   - 첫 페이지: fallback 경로로 (firstPageFailed).
    //   - 후속 페이지: 모은 만큼으로 진행하되 complete가 아니므로 degraded·미캐시.
    // 판정 기준은 appid 수가 아니라 행 수다 — 패키지·번들 행만 있는 페이지(category1=998이 완전히
    // 거르지 못함)를 이상으로 보면 결과가 이유 없이 잘린다 (/code-review 3차 #7).
    if (pageRows === 0 && start < totalCount) {
      logThrottled(
        "store-specials-parse",
        "warn",
        `[steam-api] search specials: start=${start} total_count=${res.total_count} but 0 rows parsed — markup changed?`
      );
      if (start === 0) firstPageFailed = true;
      break;
    }
    for (const id of pageIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
    // 결과 끝: 이 페이지가 total_count를 덮었거나, total_count 이후라 행이 없는 경우(위 분기 제외분).
    const reachedEnd = pageRows === 0 || start + DISCOVER_SEARCH_PAGE_SIZE >= totalCount;
    if (reachedEnd || ids.length >= maxItems) {
      complete = true;
      break;
    }
  }

  if (complete) {
    const out = ids.slice(0, maxItems);
    if (out.length > 0) cacheSet(STORE_SPECIALS_CACHE_KEY, out, CACHE_TTL.storeDeals);
    return { ids: out, degraded: false };
  }
  // 중간 중단/후속 페이지 실패 — 모은 만큼, degraded.
  if (!firstPageFailed) return { ids: ids.slice(0, maxItems), degraded: true };

  // (b) fallback — 첫 페이지 실패 시에만.
  if (shouldStop()) return { ids: [], degraded: true };
  await delay(STEAM_API_DELAY.appDetails);
  await appDetailsBackoffDelay();
  if (shouldStop()) return { ids: [], degraded: true };
  const featured = await fetchJson<SteamFeaturedCategoriesResponse>(
    `${STEAM_STORE_BASE}/api/featuredcategories?cc=KR&l=koreana`
  );
  const items = featured?.specials?.items;
  if (!Array.isArray(items)) return null;
  // type 0 = 앱(게임/소프트웨어). 할인 중인 항목만. 패키지·번들은 type이 다르다.
  const fallbackIds = Array.from(new Set(
    items
      .filter(it => it.type === 0 && typeof it.id === "number" && (it.discount_percent ?? 0) > 0)
      .map(it => it.id)
  ));
  // fallback은 약 10개뿐이라 항상 degraded ("일부 후보만 확인").
  return { ids: fallbackIds.slice(0, maxItems), degraded: true };
}

/**
 * 여러 앱의 스토어 요약(가격·리뷰 요약·카테고리)을 GetItems로 한 번에 조회한다.
 * IStoreBrowseService/GetItems/v1 (공식 API 호스트, 키 불필요 — 단계 0 V2).
 *
 * 발굴 트랙의 pool 가격 재확인과 리뷰 하한·점수를 한 번에 처리하기 위해 쓴다
 * (부록 B 설계 확정 4). per-후보 appreviews 호출(0.5s × N)과 가격 배치가 필요 없어진다.
 *
 * - fresh 캐시(`storeitem:{id}:KR`, 1시간)는 호출 없이 포함. stale은 미스로 취급
 *   (가격을 담으므로 getAppPricesBatch와 같은 규칙).
 * - 미스분을 STORE_ITEMS_BATCH_SIZE(100)씩 조회, 호출 사이 reviews 딜레이(500ms).
 *   api.steampowered.com 호스트라 store backoff 대상이 아니다.
 * - 조회 실패한 배치, success!==1 항목은 결과에서 누락(=미상)하고 요약 캐시에 넣지 않는다.
 *   (success!==1 항목은 리뷰 요약 캐시에만 "리뷰 없음"(null)으로 넣는다 — seedReviewSummary.)
 * - context는 KR 고정 — storeItemToPrice가 통화를 KRW로 기록하는 전제.
 *
 * @returns appid → StoreItemSummary. 없는 appid는 미상.
 */
export async function getStoreItemsBatch(
  appIds: number[],
  onProgress?: (loaded: number, total: number) => void,
  shouldStop: () => boolean = () => false
): Promise<Map<number, StoreItemSummary>> {
  const result = new Map<number, StoreItemSummary>();
  const uniqueIds = Array.from(new Set(appIds));
  const total = uniqueIds.length;
  let loaded = 0;
  const misses: number[] = [];

  for (const id of uniqueIds) {
    const cached = cacheGet<StoreItemSummary>(storeItemCacheKey(id));
    if (cached && !cached.isStale) {
      result.set(id, cached.data);
      loaded++;
    } else {
      misses.push(id);
    }
  }
  if (loaded > 0) onProgress?.(loaded, total);

  for (let i = 0; i < misses.length; i += STORE_ITEMS_BATCH_SIZE) {
    if (shouldStop()) return result;
    const batch = misses.slice(i, i + STORE_ITEMS_BATCH_SIZE);
    await delay(STEAM_API_DELAY.reviews);
    if (shouldStop()) return result;

    const items = await fetchStoreItems(batch, { include_reviews: true });
    const fetchedAt = Date.now();
    for (const [appid, raw] of items ?? []) {
      const summary = normalizeStoreItem(raw, fetchedAt);
      // 같은 응답의 리뷰 요약을 리뷰 요약 캐시에도 넣어 둔다 — /recommend 블렌딩·배지가 appreviews를
      // 게임마다 따로 부르지 않고 재사용한다. success!==1(삭제·지역 제한)도 "요약 없음"으로 넣어
      // 다음 분석이 같은 앱을 다시 묻지 않게 한다 (seedReviewSummary 참조).
      seedReviewSummary(appid, summary?.review ?? null);
      if (!summary) continue;
      cacheSet(storeItemCacheKey(appid), summary, CACHE_TTL.storeDeals);
      result.set(appid, summary);
    }
    loaded += batch.length;
    onProgress?.(loaded, total);
  }
  return result;
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
 * 캐시에 있는 리뷰 요약만 들여다본다 (네트워크·딜레이 없음).
 * /recommend의 위시 주기 재블렌딩이 "캐시된 것은 바로, 미캐시는 상한만큼만 조회"를 정하는 데 쓴다
 * (작업 지시서 20261010_02 §3-1).
 * @returns 캐시된 요약. null = "리뷰 없음"이 캐시됨(seedReviewSummary). 캐시에 없으면 undefined.
 */
export function peekReviewSummary(appId: number): ReviewSummary | null | undefined {
  const cached = cacheGet<ReviewSummary | null>(reviewSummaryCacheKey(appId));
  return cached ? cached.data : undefined;
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
  const cacheKey = reviewSummaryCacheKey(appId);
  // null("리뷰 없음", GetItems 배치가 넣은 것)도 캐시 히트로 본다.
  const cached = cacheGet<ReviewSummary | null>(cacheKey);
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

// --- GetItems 일괄 조회 (성향 분석 속도 개선) ---

/** 리뷰 요약 캐시 키. getReviewSummary와 공유한다. */
function reviewSummaryCacheKey(appId: number): string {
  return `reviewsummary:${appId}`;
}

/**
 * "리뷰 없음"(리뷰 0개, 삭제·지역 제한 앱) 요약의 캐시 시간. 출시 직후 게임은 곧 리뷰가 붙으므로
 * 정상 요약(6h)보다 짧게 둔다.
 */
const REVIEW_SUMMARY_EMPTY_TTL_MS = 60 * 60 * 1000;

/**
 * GetItems 리뷰 요약을 리뷰 요약 캐시에 넣는다.
 *
 * 요약이 없으면(리뷰 0개 등) null을 1시간(REVIEW_SUMMARY_EMPTY_TTL_MS) 넣는다. 넣지 않으면 위시리스트의
 * 출시 예정 게임처럼 리뷰가 없는 앱을 매 분석·30초 재블렌딩마다 다시 조회하고, 그 결과(null)가 조회
 * 실패로 집계된다 (/code-review 4차 #5). 호출이 실패한 배치는 여기로 오지 않는다(캐시하지 않음).
 *
 * appreviews(filter=all) 집계와 GetItems(summary_filtered) 집계는 미세하게 다르다(호평률이 정수 반올림,
 * 리뷰 폭탄 필터 반영). 배지·블렌딩 용도로는 차이가 무시할 만하고, 게임마다 0.5초씩 따로 부르는
 * 비용을 없애는 이득이 훨씬 크다.
 */
function seedReviewSummary(appId: number, summary: ReviewSummary | null): void {
  cacheSet(reviewSummaryCacheKey(appId), summary, summary ? CACHE_TTL.reviewSummary : REVIEW_SUMMARY_EMPTY_TTL_MS);
}

/**
 * GetItems 항목 하나의 가격을 가격 캐시에 반영한다. getStoreMetaBatch·getStoreItemPricesBatch 공용.
 *
 *   - 게임 자신의 가격(단일 게임 옵션 또는 F2P, storeItemPriceIsAppPrice) → 가격 캐시 + last-known 기록.
 *   - 최저 구매 옵션이 묶음·세트 전용 → "bundle". 아무것도 쓰지 않는다. 게임은 팔리고 있지만 단품 가격을
 *     GetItems가 알려 주지 않는 경우라, 판매 불가(null)로 쓰면 할인 중인 게임이 가격 없음으로 보이고
 *     할인만 트랙에서 빠진다 (/code-review 5차 #1). 위시 가격 배치는 이런 appid만 appdetails로 보충한다.
 *   - 판매 정보가 없는 응답 — success!==1(삭제·지역 제한), 구매 옵션 없는 유료 게임(출시 예정·판매 중지):
 *     appdetails success=false와 같은 규칙. 최근(24h) 실제 가격을 본 적이 있으면 아무것도 쓰지 않는다
 *     (호출 측이 last-known fallback). 없으면 판매 불가(null)로 짧게(PRICE_UNAVAILABLE_TTL_MS) 신선도
 *     키에만 기록한다. last-known은 덮지 않는다 (/code-review 4차 #2).
 *
 * @returns 확정한 스냅샷 / "bundle"(appdetails 보충 대상) / undefined(last-known fallback 대상).
 */
function recordStoreItemPrice(
  appid: number,
  raw: SteamStoreBrowseItem,
  summary: StoreItemSummary | null,
  fetchedAt: number,
): PriceSnapshot | "bundle" | undefined {
  if (summary && storeItemPriceIsAppPrice(raw)) {
    writePriceCache(appid, summary.price, CACHE_TTL.appPrice, fetchedAt);
    return { price: summary.price, fetchedAt };
  }
  // success===1인데 구매 옵션이 있고 위에서 걸리지 않았다 = 묶음·세트 전용 옵션.
  if (summary && raw.best_purchase_option?.final_price_in_cents !== undefined) return "bundle";
  if (readLastKnownPrice(appid)?.price) return undefined;
  cacheSet(priceCacheKey(appid), null, PRICE_UNAVAILABLE_TTL_MS);
  return { price: null, fetchedAt };
}

/**
 * IStoreBrowseService/GetItems 한 번 호출 (KR 컨텍스트, 최대 STORE_ITEMS_BATCH_SIZE개).
 * refs는 `{appid}`·`{packageid}`·`{bundleid}`를 섞어 보낼 수 있다(패키지/번들 전개용).
 *
 * @returns 응답 store_items 배열 (success 값 무관). 호출 실패면 [].
 *   filterToRequested(기본 true)이고 refs가 모두 {appid}면 기존처럼 요청한 appid만 남긴다.
 *   그 외(packageid/bundleid 전개 — 응답에 요청 외 appid가 포함됨)는 전체를 그대로 반환한다.
 * (작업 지시서 20261012_01 단계 1-2 C1)
 */
async function fetchStoreItemsByRef(
  refs: readonly StoreItemRef[],
  dataRequest: Record<string, unknown>,
  opts: { filterToRequested?: boolean } = {},
): Promise<SteamStoreBrowseItem[]> {
  const filterToRequested = opts.filterToRequested ?? true;
  const input = {
    ids: refs,
    // KR 고정: storeItemToPrice가 통화를 KRW로 기록하는 전제.
    context: { language: "koreana", country_code: "KR" },
    data_request: dataRequest,
  };
  const url =
    `${STEAM_API_BASE}/IStoreBrowseService/GetItems/v1/` +
    `?input_json=${encodeURIComponent(JSON.stringify(input))}`;
  const res = await fetchJson<SteamStoreBrowseResponse>(url);
  const items = res?.response?.store_items;
  if (!Array.isArray(items)) return [];
  // refs가 모두 appid일 때만 요청 외 appid를 버린다 — 전개(package/bundle)는 요청 외 appid가 정상 결과다.
  const appidRefs = refs.every((r): r is { appid: number } => "appid" in r);
  if (!filterToRequested || !appidRefs) return items;
  const requested = new Set(appidRefs ? refs.map(r => (r as { appid: number }).appid) : []);
  return items.filter(raw => {
    const appid = raw.appid ?? raw.id;
    return typeof appid === "number" && requested.has(appid);
  });
}

/**
 * IStoreBrowseService/GetItems 한 번 호출 — appid만 요청하는 기존 호출부(getStoreItemsBatch·
 * getStoreMetaBatch·getStoreItemPricesBatch)의 계약(Map 반환)을 유지한다. 내부는 fetchStoreItemsByRef.
 *
 * @returns 요청한 appid → 원본 store_item (응답에 있는 것만, success 값 무관). 호출 실패·빈 응답이면
 *   빈 Map. (기존 구현의 null 반환과 호출부 동작은 같다 — 세 호출부 모두 `items ?? []`로 순회해
 *   null·빈 Map을 같게 취급한다.)
 */
async function fetchStoreItems(
  ids: readonly number[],
  dataRequest: Record<string, unknown>,
): Promise<Map<number, SteamStoreBrowseItem> | null> {
  const items = await fetchStoreItemsByRef(
    ids.map(appid => ({ appid })),
    dataRequest,
    { filterToRequested: true },
  );
  const requested = new Set(ids);
  const out = new Map<number, SteamStoreBrowseItem>();
  for (const raw of items) {
    const appid = raw.appid ?? raw.id;
    // 요청하지 않은 appid가 섞여 와도(리다이렉트 등) 결과·캐시에 넣지 않는다.
    if (typeof appid === "number" && requested.has(appid)) out.set(appid, raw);
  }
  return out;
}

/** 성향 분석용 스토어 메타 LRU 키. 값은 축약 SteamAppDetails 또는 null(메타 없음). */
function storeMetaCacheKey(appId: number): string {
  return `storemeta:${appId}:KR`;
}

const STORE_CATEGORY_LABELS_KEY = "store:categories:koreana";

/** 카테고리 이름 재조회 실패 시 이전 값을 다시 쓰는 시간 (이후 재시도). */
const STORE_CATEGORY_LABELS_RETRY_MS = 60 * 60 * 1000;

/** 카테고리 이름 없이 만든 메타의 LRU 시간. 짧게 두어 이름 조회가 회복되면 곧 다시 받는다. */
const STORE_META_UNLABELED_TTL_MS = 10 * 60 * 1000;

/**
 * 스토어 카테고리 id → 한국어 이름 (IStoreBrowseService/GetStoreCategories, 키 불필요).
 * 7일 캐시(만료돼도 재조회 실패 시 이전 값 사용).
 * @returns 이름 맵. 한 번도 받지 못했고 지금 조회도 실패했으면 null — 호출 측(getStoreMetaBatch)은
 *   이때 만든 메타를 영속 저장하지 않는다. "카테고리 {id}" 라벨이 7일 동안 굳지 않도록 (/code-review 4차 #3).
 */
export async function getStoreCategoryLabels(): Promise<Record<number, string> | null> {
  const cached = cacheGet<Record<number, string>>(STORE_CATEGORY_LABELS_KEY);
  if (cached && !cached.isStale) return cached.data;
  // 동시에 시작한 분석들이 하나의 조회를 공유한다. 그렇지 않으면 먼저 온 호출이 만료 항목을 읽으며
  // 지운 뒤 뒤에 온 호출은 이전 값 없이 실패해 null을 받는다 (/code-review 5차 재검토 L3).
  if (categoryLabelsInFlight) return categoryLabelsInFlight;
  if (cached) lastCategoryLabels = cached.data;
  categoryLabelsInFlight = fetchStoreCategoryLabels().finally(() => { categoryLabelsInFlight = null; });
  return categoryLabelsInFlight;
}

/** 진행 중인 카테고리 이름 조회 (getStoreCategoryLabels dedupe). */
let categoryLabelsInFlight: Promise<Record<number, string> | null> | null = null;
/** 마지막으로 받은 카테고리 이름. LRU에서 밀려나거나 만료 후 지워져도 조회 실패 시 fallback으로 쓴다. */
let lastCategoryLabels: Record<number, string> | null = null;

/** 테스트용: 카테고리 이름 모듈 상태 초기화. */
export function resetStoreCategoryLabelsState(): void {
  categoryLabelsInFlight = null;
  lastCategoryLabels = null;
}

async function fetchStoreCategoryLabels(): Promise<Record<number, string> | null> {
  const url =
    `${STEAM_API_BASE}/IStoreBrowseService/GetStoreCategories/v1/` +
    `?input_json=${encodeURIComponent(JSON.stringify({ language: "koreana" }))}`;
  const res = await fetchJson<{ response?: { categories?: { categoryid: number; display_name?: string }[] } }>(url);
  const list = res?.response?.categories;
  if (!Array.isArray(list) || list.length === 0) {
    // 만료된 이전 값이 있으면 그것을 짧게 다시 캐시해 쓴다. cacheGet은 만료 항목을 읽으면서 지우므로,
    // 다시 넣지 않으면 다음 호출부터는 null이 되어 메타 영속 저장이 계속 막히고 매번 재조회한다
    // (/code-review 5차 #2). 이름 목록은 거의 바뀌지 않아 묵은 값이 안전하다.
    if (lastCategoryLabels) {
      cacheSet(STORE_CATEGORY_LABELS_KEY, lastCategoryLabels, STORE_CATEGORY_LABELS_RETRY_MS);
      return lastCategoryLabels;
    }
    return null;
  }
  const labels: Record<number, string> = {};
  for (const c of list) {
    if (typeof c.categoryid === "number" && c.display_name) labels[c.categoryid] = c.display_name;
  }
  cacheSet(STORE_CATEGORY_LABELS_KEY, labels, CACHE_TTL.appInfo);
  lastCategoryLabels = labels;
  return labels;
}

/**
 * 여러 앱의 성향 분석용 메타를 GetItems로 일괄 조회한다 (getAppDetailsBatch 대체, /recommend 전용).
 *
 * 속도: appdetails는 store 호스트에서 게임당 1회·1.5초 직렬(+429 backoff)이었다. GetItems는 공식 API
 * 호스트에서 STORE_ITEMS_BATCH_SIZE(100)개를 한 번에 받고, 호출 사이 0.5초만 쉰다.
 * 예) 미캐시 5,000개: 약 2시간 → 약 50회 × 0.5초 ≈ 30초.
 * 트래픽: 필요한 필드만 요청해 게임당 1–2KB (appdetails는 20KB 이상).
 *
 * 캐시 계층: LRU(storemeta, 7일) → SQLite(store_meta_cache, 7일) → GetItems.
 * 조회 결과는 다른 기능도 쓰도록 같은 응답으로 함께 채운다:
 *   - 리뷰 요약(reviewsummary, 6h) — 블렌딩·배지 (appreviews 개별 호출 대체)
 *   - 가격(app:{id}:price, 1h + last-known 24h) — 위시 가격·게임 상세 (recordStoreItemPrice)
 *   - 이름·헤더 이미지(app_meta) — 도전과제 탭 등 (setAppMetaFromStoreBatch)
 *
 * 실패 처리: 호출이 실패한 배치·응답에 없는 appid는 만료된 이전 메타(LRU → SQLite 기간 무관)로 채우고,
 * 그것도 없으면 null(이번 분석에서 메타 누락). 어느 쪽도 캐시하지 않는다.
 * 응답에 success!==1(삭제·지역 제한)로 온 앱은 null로 캐시한다(negative — 매번 다시 묻지 않도록).
 * 카테고리 이름 조회가 실패했으면 메타를 LRU에만 짧게(STORE_META_UNLABELED_TTL_MS) 두고 영속 저장하지 않는다.
 *
 * onProgress: 캐시분 처리 후와 배치(100개)마다 (loaded, total, 지금까지의 결과). isCancelled: 배치 사이 확인.
 */
export async function getStoreMetaBatch(
  appIds: number[],
  onProgress?: (
    loaded: number,
    total: number,
    partial: ReadonlyMap<number, SteamAppDetails | null>
  ) => void,
  isCancelled: () => boolean = () => false
): Promise<Map<number, SteamAppDetails | null>> {
  const result = new Map<number, SteamAppDetails | null>();
  const uniqueIds = Array.from(new Set(appIds));
  const total = uniqueIds.length;

  // 1) LRU. 만료 항목은 미스로 보되 값을 보관한다 — GetItems가 실패하면 fallback으로 쓴다(아래 3).
  let rest: number[] = [];
  const staleMeta = new Map<number, SteamAppDetails | null>();
  for (const id of uniqueIds) {
    const cached = cacheGet<SteamAppDetails | null>(storeMetaCacheKey(id));
    if (cached && !cached.isStale) result.set(id, cached.data);
    else {
      if (cached) staleMeta.set(id, cached.data);
      rest.push(id);
    }
  }
  // 2) SQLite (재시작 후)
  if (rest.length > 0) {
    try {
      const stored = getStoreMetaFromStore(rest, Date.now() - CACHE_TTL.appInfo);
      for (const [id, entry] of stored) {
        result.set(id, entry.details);
        cacheSet(storeMetaCacheKey(id), entry.details, CACHE_TTL.appInfo);
      }
      rest = rest.filter(id => !stored.has(id));
    } catch (err) {
      console.warn("[steam-api] store_meta_cache read failed:", err);
    }
  }
  if (result.size > 0) onProgress?.(result.size, total, result);
  if (rest.length === 0) return result;

  // 3) GetItems — 카테고리 이름은 배치 전에 한 번 (7일 캐시).
  const labels = await getStoreCategoryLabels();
  const labelsOk = labels !== null;
  const metaTtl = labelsOk ? CACHE_TTL.appInfo : STORE_META_UNLABELED_TTL_MS;
  for (let i = 0; i < rest.length; i += STORE_ITEMS_BATCH_SIZE) {
    if (isCancelled()) return result;
    const batch = rest.slice(i, i + STORE_ITEMS_BATCH_SIZE);
    // 첫 배치는 바로, 이후는 호출 사이 간격(공식 API 호스트라 store backoff 대상 아님).
    if (i > 0) await delay(STEAM_API_DELAY.reviews);
    if (isCancelled()) return result;

    const items = await fetchStoreItems(batch, STORE_META_DATA_REQUEST);
    const fetchedAt = Date.now();
    const toPersist = new Map<number, SteamAppDetails | null>();
    const appMeta: { appId: number; name: string; headerImage: string }[] = [];
    for (const [appid, raw] of items ?? []) {
      const details = storeItemToAppDetails(raw, labels ?? {});
      result.set(appid, details);
      toPersist.set(appid, details);
      cacheSet(storeMetaCacheKey(appid), details, metaTtl);
      // 같은 응답으로 다른 기능의 캐시도 채운다 (함수 주석 참조).
      const summary = normalizeStoreItem(raw, fetchedAt);
      seedReviewSummary(appid, summary?.review ?? null);
      // 가격 규칙은 위시 가격 배치와 같다 (recordStoreItemPrice) — 여기서 확정해 두면 위시 가격 단계가
      // 출시 예정 게임 등을 다시 묻지 않는다.
      // (스토어 요약 storeitem은 채우지 않는다 — 발굴 트랙은 보유·위시 게임을 후보에서 빼므로 여기서
      // 받는 라이브러리·위시 게임의 요약을 읽지 않는다. 캐시만 차지한다, /code-review 5차 #5.)
      recordStoreItemPrice(appid, raw, summary, fetchedAt);
      if (!details) continue;
      // 이름이 응답에 있을 때만 — 없으면 details.name은 "AppID {id}" 자리표시라 좋은 이름을 덮는다.
      if (raw.name) appMeta.push({ appId: appid, name: raw.name, headerImage: details.header_image });
    }
    // 응답에 없거나 호출이 실패한 appid: 만료된 이전 메타가 있으면 그것을 쓴다(LRU → SQLite 7일 초과 row).
    // GetItems 장애 중 영속 캐시가 막 만료된 사용자의 분석이 "메타 전부 없음 → 분석 불가"가 되지 않도록
    // (/code-review 5차 #3). fallback 값은 다시 캐시하지 않는다 — 다음 분석이 새로 받도록. 없으면 null.
    const unresolved = batch.filter(id => !result.has(id));
    if (unresolved.length > 0) {
      const fallback = staleStoreMeta(unresolved, staleMeta);
      for (const id of unresolved) result.set(id, fallback.get(id) ?? null);
    }
    try {
      if (labelsOk) setStoreMetaInStore(toPersist, fetchedAt);
    } catch (err) {
      console.warn("[steam-api] store_meta_cache write failed:", err);
    }
    try {
      setAppMetaFromStoreBatch(appMeta);
    } catch (err) {
      console.warn("[steam-api] app_meta write failed:", err);
    }
    onProgress?.(result.size, total, result);
  }
  return result;
}

/**
 * 만료된 메타 fallback: LRU에서 보관한 값 → SQLite의 기간 무관 row. DB 오류는 무시(빈 결과).
 */
function staleStoreMeta(
  ids: readonly number[],
  fromLru: ReadonlyMap<number, SteamAppDetails | null>,
): Map<number, SteamAppDetails | null> {
  const out = new Map<number, SteamAppDetails | null>();
  const rest: number[] = [];
  for (const id of ids) {
    if (fromLru.has(id)) out.set(id, fromLru.get(id)!);
    else rest.push(id);
  }
  if (rest.length === 0) return out;
  try {
    for (const [id, entry] of getStoreMetaFromStore(rest, 0)) out.set(id, entry.details);
  } catch (err) {
    console.warn("[steam-api] store_meta_cache stale read failed:", err);
  }
  return out;
}

/**
 * 주어진 appid 중 성향 분석용 메타가 영속 캐시에 신선하게 있는 것 (= 즉시 처리 가능).
 * /recommend가 "캐시된 것 먼저" 순서를 정하는 데 쓴다. DB 오류 시 빈 집합.
 */
export function getCachedStoreMetaIds(appIds: readonly number[]): Set<number> {
  try {
    return getStoreMetaIdsInStore(appIds, Date.now() - CACHE_TTL.appInfo);
  } catch (err) {
    console.warn("[steam-api] store_meta_cache id scan failed:", err);
    return new Set();
  }
}

/**
 * 여러 앱의 리뷰 요약을 일괄로 얻는다 (getReviewSummary 개별 호출 대체).
 * 캐시(reviewsummary, 6h)를 먼저 보고, 없는 것만 GetItems 배치(getStoreItemsBatch, 100개/호출)로 받는다.
 * @returns appid → 요약. null = 조회 실패 또는 리뷰 없음 (호출 측은 중립 0.5).
 */
export async function getReviewSummariesBatch(
  appIds: number[],
  onProgress?: (loaded: number, total: number) => void,
  isCancelled: () => boolean = () => false
): Promise<Map<number, ReviewSummary | null>> {
  const out = new Map<number, ReviewSummary | null>();
  const uniqueIds = Array.from(new Set(appIds));
  const misses: number[] = [];
  for (const id of uniqueIds) {
    // null("리뷰 없음")도 캐시 히트 — 다시 조회하지 않는다.
    const cached = cacheGet<ReviewSummary | null>(reviewSummaryCacheKey(id));
    if (cached) out.set(id, cached.data);
    else misses.push(id);
  }
  if (out.size > 0) onProgress?.(out.size, uniqueIds.length);
  if (misses.length === 0) return out;
  const items = await getStoreItemsBatch(
    misses,
    (loaded) => onProgress?.(out.size + loaded, uniqueIds.length),
    isCancelled,
  );
  for (const id of misses) {
    if (isCancelled() && !items.has(id)) continue;
    out.set(id, items.get(id)?.review ?? null);
  }
  return out;
}

/**
 * 여러 앱의 가격을 GetItems로 일괄 조회한다 (/recommend 위시 가격 — getAppPricesBatch 대체).
 *
 * 속도: appdetails 가격 배치는 store 호스트라 100개마다 1.5초 + 공유 429 backoff를 기다렸고, 성향 분석의
 * 메타 조회·발굴과 같은 store 한도를 나눠 썼다. GetItems는 api.steampowered.com(별도 한도)에서 100개를
 * 한 번에 받고 호출 사이 0.5초만 쉰다. 같은 응답의 리뷰 요약·스토어 요약도 캐시에 채운다.
 *
 * 결과 계약은 getAppPricesBatch와 같다 (호출 측 커버리지·fallback 로직을 그대로 쓰도록):
 *   - 가격 키가 fresh면 호출 없이 포함. stale은 미스로 취급.
 *   - 응답 항목의 가격 반영은 recordStoreItemPrice (단일 게임 옵션·F2P만 확정, 묶음 전용은 appdetails로
 *     보충, 판매 정보 없음은 판매 불가 또는 last-known fallback).
 *   - 호출 실패 배치·응답에 없는 appid → last-known → 가격 키 stale(24h 이내) 순 fallback(fallback=true).
 *
 * 가격 차이: GetItems는 "가장 싼 단일 게임 구매 옵션", appdetails price_overview는 기본 패키지 가격이다.
 * 대부분 같고, 다르면 GetItems 쪽이 실제로 살 수 있는 더 싼 가격이다.
 *
 * @returns appid → PriceSnapshot. 없는 appid는 가격 미상.
 */
export async function getStoreItemPricesBatch(
  appIds: number[],
  onProgress?: (loaded: number, total: number) => void,
  isCancelled: () => boolean = () => false,
): Promise<Map<number, PriceSnapshot>> {
  const result = new Map<number, PriceSnapshot>();
  const uniqueIds = Array.from(new Set(appIds));
  const total = uniqueIds.length;
  let loaded = 0;
  const misses: number[] = [];
  // getAppPricesBatch와 같은 이유로 stale 값을 보관해 둔다(첫 get에서 삭제됨).
  const staleById = new Map<number, PriceSnapshot>();
  // 최저 구매 옵션이 묶음 전용이라 GetItems로 단품 가격을 알 수 없는 appid (recordStoreItemPrice).
  const bundleOnly: number[] = [];
  for (const id of uniqueIds) {
    const cached = cacheGet<SteamPriceOverview | null>(priceCacheKey(id));
    if (cached && !cached.isStale) {
      result.set(id, { price: cached.data, fetchedAt: cached.fetchedAt });
      loaded++;
    } else {
      if (cached) staleById.set(id, { price: cached.data, fetchedAt: cached.fetchedAt });
      misses.push(id);
    }
  }
  if (loaded > 0) onProgress?.(loaded, total);

  for (let i = 0; i < misses.length; i += STORE_ITEMS_BATCH_SIZE) {
    if (isCancelled()) return result;
    const batch = misses.slice(i, i + STORE_ITEMS_BATCH_SIZE);
    // 첫 배치는 바로, 이후는 호출 사이 간격 (공식 API 호스트라 store backoff 대상 아님).
    if (i > 0) await delay(STEAM_API_DELAY.reviews);
    if (isCancelled()) return result;

    const items = await fetchStoreItems(batch, { include_reviews: true });
    const fetchedAt = Date.now();
    for (const [appid, raw] of items ?? []) {
      const summary = normalizeStoreItem(raw, fetchedAt);
      seedReviewSummary(appid, summary?.review ?? null);
      // 확정하지 못하면(undefined) 아래 fallback이 last-known으로 채운다.
      const snap = recordStoreItemPrice(appid, raw, summary, fetchedAt);
      if (snap === "bundle") bundleOnly.push(appid);
      else if (snap) result.set(appid, snap);
    }
    loaded += batch.length;
    onProgress?.(loaded, total);
  }
  // 최저 옵션이 묶음 전용인 게임은 단품 가격을 appdetails(기본 패키지 가격)로 받는다. 보통 위시리스트의
  // 몇 개 이하라 store 호출은 1회 정도다. 실패분은 getAppPricesBatch가 last-known으로 채운다(fallback).
  //   - base delay(1.5초)는 생략한다 — 이 배치 전체에서 store 호출은 이것 하나뿐이다.
  //   - store 429 backoff 중이면 건너뛴다. backoff는 최대 30초라 분석 결과 전체가 그만큼 늦어진다.
  //     건너뛴 appid는 아래 fallback(last-known → stale)으로 채워지거나 가격 미상으로 남는다
  //     (/code-review 5차 재검토 L2).
  if (bundleOnly.length > 0 && !isCancelled() && getAppDetailsBackoffMs() === 0) {
    const viaAppDetails = await getAppPricesBatch(bundleOnly, undefined, isCancelled, { skipBaseDelay: true });
    for (const [id, snap] of viaAppDetails) result.set(id, snap);
  }
  // 조회하지 못한 미스분 fallback: last-known → 가격 키 stale(24h 이내). getAppPricesBatch와 같은 규칙.
  const now = Date.now();
  for (const id of misses) {
    if (result.has(id)) continue;
    const lastKnown = readLastKnownPrice(id);
    if (lastKnown) {
      result.set(id, { ...lastKnown, fallback: true });
      continue;
    }
    const stale = staleById.get(id);
    if (stale && now - stale.fetchedAt <= PRICE_STALE_FALLBACK_MAX_AGE_MS) result.set(id, { ...stale, fallback: true });
  }
  return result;
}

// ============================================================================
// 번들 차트 메이커 보강 (작업 지시서 20261012_01 단계 1-2)
// ============================================================================

/**
 * SteamPriceOverview(GetItems·appdetails, cents·KRW)를 번들 차트의 GameRowPrice로 매핑한다.
 * fallback은 호출 측이 PriceSnapshot.fallback으로 세팅한다.
 *
 * initialFormatted는 무할인 응답에서 initial_formatted가 빈 문자열이므로 final_formatted로 폴백한다
 * (정가 == 최종가라 표시가 같다).
 */
export function toGameRowPrice(p: SteamPriceOverview): GameRowPrice {
  return {
    currency: p.currency,
    initial: p.initial,
    final: p.final,
    discountPercent: p.discount_percent,
    initialFormatted: p.initial_formatted || p.final_formatted,
    finalFormatted: p.final_formatted,
  };
}

/**
 * getBundleGameRows의 GetItems data_request. 이름·헤더(assets)·리뷰 요약만 받아 응답을 작게 유지한다
 * (단계 0 V4). 가격은 getStoreItemPricesBatch가 따로 받으므로 여기서 받지 않는다.
 */
export const BUNDLE_ROW_DATA_REQUEST = {
  include_assets: true,
  include_reviews: true,
} as const;

/**
 * 번들 차트용 게임 행을 만든다 (입력 순서 보존, 중복 appid 제거).
 *
 *   - 가격: getStoreItemPricesBatch 재사용(묶음전용→appdetails 보충·last-known fallback 포함, M4).
 *   - 이름/헤더/리뷰: fetchStoreItemsByRef(BUNDLE_ROW_DATA_REQUEST)로 100개씩. seedReviewSummary도 채운다.
 *   - headerImage는 http/https 스킴일 때만 사용(M7), 아니면 "".
 *   - price/priceUnknown 분기(단계 1-2):
 *       · snapshot.price 있으면 toGameRowPrice + fallback.
 *       · snapshot 있고 price===null → 무료/미판매 확인(price:null, priceUnknown:false).
 *       · 맵에 snapshot 없음(조회 실패) → price:null, priceUnknown:true(미상).
 */
export async function getBundleGameRows(appIds: number[]): Promise<GameRow[]> {
  const uniqueIds = Array.from(new Set(appIds));
  if (uniqueIds.length === 0) return [];

  // 가격: 묶음전용→appdetails 보충·fallback 재사용.
  const prices = await getStoreItemPricesBatch(uniqueIds);

  // 이름·헤더·리뷰: 100개씩.
  const raws = new Map<number, SteamStoreBrowseItem>();
  for (let i = 0; i < uniqueIds.length; i += STORE_ITEMS_BATCH_SIZE) {
    if (i > 0) await delay(STEAM_API_DELAY.reviews);
    const batch = uniqueIds.slice(i, i + STORE_ITEMS_BATCH_SIZE);
    const items = await fetchStoreItemsByRef(
      batch.map(appid => ({ appid })),
      BUNDLE_ROW_DATA_REQUEST,
      { filterToRequested: true },
    );
    const now = Date.now();
    for (const raw of items) {
      const appid = raw.appid ?? raw.id;
      if (typeof appid !== "number" || !batch.includes(appid)) continue;
      raws.set(appid, raw);
      // 같은 응답의 리뷰 요약을 캐시에도 채운다 (getStoreItemsBatch와 같은 의도).
      seedReviewSummary(appid, normalizeStoreItem(raw, now)?.review ?? null);
    }
  }

  const now = Date.now();
  return uniqueIds.map(appId => {
    const raw = raws.get(appId);
    const snapshot = prices.get(appId);

    const name = raw?.name ?? `AppID ${appId}`;
    const header = raw ? storeItemHeaderImage(raw) : undefined;
    const headerImage = header && /^https?:\/\//i.test(header) ? header : "";

    // 리뷰: totalReviews 0이면 null.
    const summary = raw ? normalizeStoreItem(raw, now) : null;
    const r = summary?.review ?? null;
    const review =
      r && r.totalReviews > 0
        ? {
            positivePercent: Math.round((100 * r.totalPositive) / r.totalReviews),
            total: r.totalReviews,
            desc: r.reviewScoreDesc,
          }
        : null;

    // 가격/미상 분기.
    let price: GameRowPrice | null = null;
    let priceUnknown = false;
    if (snapshot) {
      if (snapshot.price) {
        price = toGameRowPrice(snapshot.price);
        if (snapshot.fallback) price.fallback = true;
      }
      // snapshot 있고 price===null → 무료/미판매 확인 (priceUnknown=false, price=null).
    } else {
      // 맵에 없음 = 조회 실패(미상).
      priceUnknown = true;
    }

    const row: GameRow = {
      appId,
      name,
      headerImage,
      storeUrl: steamStoreUrl(appId),
      type: "game",
      price,
      review,
    };
    if (priceUnknown) row.priceUnknown = true;
    return row;
  });
}

/** packagedetails 응답 중 사용하는 필드만 (data.apps[].id). */
interface SteamPackageDetailsResponse {
  [packageId: string]: { success?: boolean; data?: { apps?: { id?: number }[] } };
}

/**
 * Steam 패키지(sub)·스토어 번들을 포함 appid 배열로 전개한다 (작업 지시서 20261012_01 단계 1-2).
 *
 *   - package: store.steampowered.com/api/packagedetails?packageids={id}&cc=KR&l=koreana 의 data.apps[].id.
 *     store 호스트라 기존 appDetails 딜레이·공유 backoff를 존중한다.
 *   - bundle: fetchStoreItemsByRef([{bundleid:id}], {include_included_items:true})의 included_appids /
 *     included_items.items[].appid. 둘 다 없으면 [](V3b 미지원 — 호출 측이 "번들 전개 미지원" 안내).
 *
 * 어느 경우든 실패하면 [].
 */
export async function expandSteamCollection(
  kind: "package" | "bundle",
  id: number,
): Promise<number[]> {
  if (kind === "package") {
    await delay(STEAM_API_DELAY.appDetails);
    await appDetailsBackoffDelay();
    const url =
      `${STEAM_STORE_BASE}/api/packagedetails?packageids=${id}&cc=KR&l=koreana`;
    const res = await fetchJson<SteamPackageDetailsResponse>(url);
    const apps = res?.[String(id)]?.data?.apps;
    if (!Array.isArray(apps)) return [];
    const out: number[] = [];
    for (const a of apps) {
      if (typeof a?.id === "number" && a.id > 0) out.push(a.id);
    }
    return out;
  }
  // bundle
  const items = await fetchStoreItemsByRef(
    [{ bundleid: id }],
    { include_included_items: true },
    { filterToRequested: false },
  );
  const out = new Set<number>();
  for (const raw of items) {
    for (const appid of raw.included_appids ?? []) {
      if (typeof appid === "number" && appid > 0) out.add(appid);
    }
    for (const it of raw.included_items?.included_apps ?? []) {
      if (typeof it?.appid === "number" && it.appid > 0) out.add(it.appid);
    }
  }
  return Array.from(out);
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

// ============================================================================
// 도전과제 (ISteamUserStats) — 작업 지시서 20260825_01 §5.1
// ============================================================================

/**
 * fetchJson과 달리 **non-2xx 응답의 body도 파싱해 반환**한다.
 *
 * `GetPlayerAchievements`는 프로필 비공개 시 HTTP 403, 통계 없는 게임 시 HTTP 400을
 * 내면서 body의 `playerstats.error`로 사유를 구분한다(§3.5 실측). fetchJson은 모든
 * non-2xx를 null로 버려 이 구분이 불가능하므로, 이 헬퍼로 status+body를 함께 얻는다.
 * 로그 마스킹(maskUrl)은 동일하게 유지해 키 노출을 막는다.
 */
async function fetchJsonWithStatus<T>(
  url: string
): Promise<{ status: number; data: T | null }> {
  try {
    const res = await fetch(url);
    const contentType = res.headers.get("content-type") || "";
    let data: T | null = null;
    if (contentType.includes("application/json")) {
      try {
        data = (await res.json()) as T;
      } catch {
        data = null;
      }
    }
    if (!res.ok) {
      logThrottled(
        `status:${res.status}`,
        "warn",
        `[steam-api] HTTP ${res.status} for ${maskUrl(url)}`
      );
    }
    return { status: res.status, data };
  } catch (err) {
    logThrottled(
      "fetch-failure",
      "error",
      `[steam-api] Fetch failed for ${maskUrl(url)}: ${err instanceof Error ? err.message : String(err)}`
    );
    return { status: 0, data: null };
  }
}

/** icon URL에서 파일명만 추출한다. 이미 파일명이면 그대로. (§5.1.2, V1 실측) */
function extractIconFilename(iconUrl: string): string {
  if (!iconUrl) return "";
  const i = iconUrl.lastIndexOf("/");
  return i >= 0 ? iconUrl.slice(i + 1) : iconUrl;
}

/**
 * 원형 스키마 과제 배열을 정규화한다 (순수 함수 — 단위 테스트 대상).
 *   - hidden: 0|1 → boolean
 *   - description: 누락(undefined) → "" (숨김 과제는 description이 없을 수 있음, V1)
 *   - icon: URL 전체 → 파일명 (§5.1.2)
 */
export function normalizeAchievementDefs(
  raw: SteamRawAchievementDef[]
): AchievementDef[] {
  return raw.map((r) => ({
    name: r.name,
    displayName: r.displayName,
    description: r.description ?? "",
    hidden: r.hidden === 1,
    icon: extractIconFilename(r.icon),
  }));
}

/** 스키마 조회 결과 3분기 (§5.1.1). error와 none을 반드시 구분한다(C2). */
export type SchemaResult =
  | { status: "ok"; defs: AchievementDef[]; hash: string }
  | { status: "none" }
  | { status: "error" };

/**
 * 앱 스키마를 조회한다 (§5.1.1). **캐싱/스토어 저장은 caller(scan)가 담당**하며
 * 이 함수는 순수 fetch + 분류만 한다.
 *
 * - fetchJson이 null(429/403/5xx/네트워크/content-type 불일치) → `error`
 *   (V3 실측: 존재하지 않는 appid는 HTTP 400 → null → error)
 * - 200 + achievements 배열 비어있지 않음 → `ok`
 * - 200 + availableGameStats 부재/빈 achievements → `none` (V2 실측)
 */
export async function getAchievementSchema(appId: number): Promise<SchemaResult> {
  const url =
    `${STEAM_API_BASE}/ISteamUserStats/GetSchemaForGame/v2/` +
    `?key=${getSteamApiKey()}&appid=${appId}&l=english`;
  // fetchJson 대신 fetchJsonWithStatus를 써서 상태 코드를 구분한다:
  //   - 400/404: 존재하지 않거나 삭제/이관된 appid → 'none'(negative 캐시 대상).
  //     이렇게 해야 삭제된 게임이 매 스캔 재시도되지 않는다(§5.1.1, 코드리뷰 #5).
  //   - 0(네트워크)/429/403/5xx/비JSON: 일시 실패 → 'error'(재시도).
  const { status, data } =
    await fetchJsonWithStatus<SteamAchievementSchemaResponse>(url);
  if (status === 400 || status === 404) return { status: "none" };
  if (status !== 200 || !data) return { status: "error" };

  const achs = data.game?.availableGameStats?.achievements;
  if (Array.isArray(achs) && achs.length > 0) {
    const defs = normalizeAchievementDefs(achs);
    return { status: "ok", defs, hash: computeSchemaHash(defs) };
  }
  return { status: "none" };
}

/** 개인 진행률 조회 결과 4상태 (§5.1.4). */
export type PlayerResult =
  | {
      status: "ok";
      achievements: { name: string; achieved: boolean; unlockTime: number }[];
    }
  | { status: "private" }
  | { status: "unavailable" }
  | { status: "error" };

/**
 * GetPlayerAchievements 실패 응답을 private/unavailable/error로 분류한다
 * (순수 함수 — 단위 테스트 대상, R7 핵심).
 *
 * §3.5 실측: private = HTTP 403 "Profile is not public",
 *            unavailable = HTTP 400 "Requested app has no stats".
 * 문자열을 1차 근거로, HTTP 코드를 2차 근거로 쓴다. 둘 다 애매하면 `error`(재시도).
 */
export function classifyPlayerStatsError(
  httpStatus: number,
  body: SteamPlayerAchievementsResponse | null
): "private" | "unavailable" | "error" {
  const err = body?.playerstats?.error ?? "";
  if (/not public/i.test(err)) return "private";
  if (/no stats/i.test(err)) return "unavailable";
  if (httpStatus === 403) return "private";
  if (httpStatus === 400) return "unavailable";
  return "error";
}

/**
 * 본인 개인 진행률을 조회한다 (§5.1.4). `l` 파라미터를 붙이지 않는다(문구는 스키마
 * 에서 가져오므로 페이로드만 커진다). 원소 키는 `apiname`이며 정규화에서 `name`으로
 * 통일한다(§3.5 V4 확정).
 */
export async function getPlayerAchievements(
  steamId: string,
  appId: number
): Promise<PlayerResult> {
  const url =
    `${STEAM_API_BASE}/ISteamUserStats/GetPlayerAchievements/v1/` +
    `?key=${getSteamApiKey()}&steamid=${steamId}&appid=${appId}`;
  const { status, data } = await fetchJsonWithStatus<SteamPlayerAchievementsResponse>(url);
  if (status === 0) return { status: "error" }; // 네트워크 실패 — 재시도 대상

  const ps = data?.playerstats;
  if (ps?.success && Array.isArray(ps.achievements)) {
    return {
      status: "ok",
      achievements: ps.achievements.map((a) => ({
        name: a.apiname, // apiname → name (§3.5 V4)
        achieved: a.achieved === 1,
        unlockTime: a.unlocktime,
      })),
    };
  }
  return { status: classifyPlayerStatsError(status, data) };
}

/**
 * 전역 달성률(희귀도)을 조회한다 (Phase 2, §5.1.7). **API Key 불필요**(§3.1 실측).
 *
 * 반환: { [apiName]: percent(0~100 number) }. `percent`는 원본이 string이라
 * parseFloat하고 Number.isFinite 실패 항목은 제외한다. LRU(1일) → app_achievement_global
 * hydrate → API 순. 조회 실패/과제 없음이면 빈 객체.
 */
export async function getGlobalAchievementPercentages(
  appId: number
): Promise<Record<string, number>> {
  const cacheKey = `ach:global:${appId}`;
  const cached = cacheGet<Record<string, number>>(cacheKey);
  if (cached && !cached.isStale) return cached.data;

  // 영속 store hydrate (LRU가 재시작으로 비워졌을 때).
  try {
    const stored = getGlobalFromStore(appId);
    if (stored && Date.now() - stored.fetchedAt < CACHE_TTL.achievementGlobal) {
      cacheSet(cacheKey, stored.percentages, CACHE_TTL.achievementGlobal);
      return stored.percentages;
    }
  } catch (err) {
    console.warn(`[steam-api] app_achievement_global read failed for ${appId}:`, err);
  }

  // getSteamApiKey()를 호출하지 않는다 — 키 불필요(§5.1.7).
  const url =
    `${STEAM_API_BASE}/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v0002/` +
    `?gameid=${appId}`;
  const res = await fetchJson<SteamGlobalPercentagesResponse>(url);

  const list = res?.achievementpercentages?.achievements;
  const out: Record<string, number> = {};
  if (Array.isArray(list)) {
    for (const a of list) {
      const pct = parseFloat(a.percent);
      if (Number.isFinite(pct)) out[a.name] = pct;
    }
  }
  cacheSet(cacheKey, out, CACHE_TTL.achievementGlobal);
  try {
    setGlobalInStore(appId, out);
  } catch (err) {
    console.warn(`[steam-api] app_achievement_global write failed for ${appId}:`, err);
  }
  return out;
}

/**
 * 표시용 스키마를 로케일별로 조회한다 (Phase 2, §5.1.6). diff/hash용 en 스키마와
 * 달리 이건 **표시 전용**이라 LRU만 쓰고 영속 저장하지 않는다.
 *
 * @param lang 'ko'(koreana) | 'en'(english). 앱이 전면 한국어라 기본은 ko.
 * @returns 정규화된 AchievementDef[] (표시 문구가 해당 로케일). 과제 없음/조회 실패면 null.
 */
export async function getAchievementSchemaForDisplay(
  appId: number,
  lang: "ko" | "en"
): Promise<AchievementDef[] | null> {
  const l = lang === "ko" ? "koreana" : "english";
  const cacheKey = `ach:schema:${lang}:${appId}`;
  const cached = cacheGet<AchievementDef[] | null>(cacheKey);
  if (cached && !cached.isStale) return cached.data;

  const url =
    `${STEAM_API_BASE}/ISteamUserStats/GetSchemaForGame/v2/` +
    `?key=${getSteamApiKey()}&appid=${appId}&l=${l}`;
  const { status, data } =
    await fetchJsonWithStatus<SteamAchievementSchemaResponse>(url);

  // 400/404(삭제/이관) = 과제 없음으로 negative 캐시. 그 외 실패는 캐시하지 않음(재시도).
  if (status === 400 || status === 404) {
    cacheSet(cacheKey, null, CACHE_TTL.achievementSchemaMissing);
    return null;
  }
  if (status !== 200 || !data) return null;

  const achs = data.game?.availableGameStats?.achievements;
  if (Array.isArray(achs) && achs.length > 0) {
    const defs = normalizeAchievementDefs(achs);
    cacheSet(cacheKey, defs, CACHE_TTL.achievementSchema);
    return defs;
  }
  cacheSet(cacheKey, null, CACHE_TTL.achievementSchemaMissing);
  return null;
}
