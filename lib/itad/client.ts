/**
 * IsThereAnyDeal(ITAD) API 클라이언트 (작업 지시서 20261012_01 단계 1-1).
 *
 * base: https://api.isthereanydeal.com, 인증 쿼리 key=<ITAD_API_KEY>, 무료. Steam shopId=61.
 *
 * - 모든 외부 호출은 withOutboundSlot로 감싸 전역 동시성 상한을 받고, 호출 전 isDailyBudgetExceeded()면
 *   즉시 빈 결과/null을 돌려 아웃바운드를 아낀다.
 * - ITAD 키가 없으면(getItadApiKey()===null) 모든 조회는 빈 결과(graceful degrade).
 * - by-id 엔드포인트가 없어 findBundle은 최신 번들 목록을 ITAD_BUNDLE_SCAN_PAGES 페이지까지 스캔한다.
 *
 * 캐시 키(모두 일반 10k LRU로 라우팅 — per-game 접두가 아님, 의도):
 *   - itad:bundles:{country}:{sort}:{expired}:{offset}:{limit}  (ITAD_LIST_CACHE_TTL_MS)
 *   - itad:bundle:{id}            발견분    (ITAD_BUNDLE_CACHE_TTL_MS)
 *   - itad:bundle:miss:{id}       미발견 음성 (ITAD_BUNDLE_MISS_TTL_MS)
 *   - itad:appid:{uuid}           UUID→appid(음성 0 포함) (ITAD_APPID_CACHE_TTL_MS)
 */

import {
  ITAD_BUNDLE_SCAN_PAGES,
  ITAD_LIST_CACHE_TTL_MS,
  ITAD_BUNDLE_CACHE_TTL_MS,
  ITAD_BUNDLE_MISS_TTL_MS,
  ITAD_APPID_CACHE_TTL_MS,
} from "@/lib/constants";
import { getItadApiKey } from "@/lib/env";
import { cacheGet, cacheSet } from "@/lib/cache";
import { withOutboundSlot, isDailyBudgetExceeded } from "@/lib/outbound-limit";
import type { ItadBundle, ItadTier, ItadTierGame } from "@/lib/itad/types";

const ITAD_BASE = "https://api.isthereanydeal.com";

/** 외부 fetch 타임아웃 (ms). ITAD 응답은 보통 빠르지만 느린 상점 데이터도 있어 넉넉히. */
const ITAD_FETCH_TIMEOUT_MS = 10_000;

/** 목록 조회 기본값. */
const DEFAULT_COUNTRY = "US";
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const DEFAULT_SORT = "-publish";

/** 로그에서 key 쿼리를 가린다. */
function maskKey(url: string): string {
  return url.replace(/([?&])key=[^&]+/, "$1key=***");
}

/** ITAD 키가 설정되어 있는지. false면 ITAD 경로는 전부 비활성. */
export function itadConfigured(): boolean {
  return getItadApiKey() !== null;
}

/**
 * ITAD 전용 fetch 래퍼 — 타임아웃·JSON 파싱·실패 시 null. 모든 호출을 withOutboundSlot로 감싼다.
 * 호출 전 일일 예산 초과면 네트워크를 건드리지 않고 null.
 *
 * @param path   base 이후 경로 (예: "/bundles/v1"). 선행 "/" 포함.
 * @param params key 외 쿼리 파라미터 (key는 자동 부착).
 * @param init   method/body 등 추가 옵션.
 */
async function itadFetch<T>(
  path: string,
  params: Record<string, string | number | boolean | undefined>,
  init?: { method?: string; body?: unknown },
): Promise<T | null> {
  const key = getItadApiKey();
  if (key === null) return null;
  if (isDailyBudgetExceeded()) return null;

  const qs = new URLSearchParams();
  qs.set("key", key);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) qs.set(k, String(v));
  }
  const url = `${ITAD_BASE}${path}?${qs.toString()}`;

  return withOutboundSlot(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ITAD_FETCH_TIMEOUT_MS);
    const t = timer as unknown as { unref?: () => void };
    if (typeof t.unref === "function") t.unref();
    try {
      const res = await fetch(url, {
        method: init?.method ?? "GET",
        signal: controller.signal,
        ...(init?.body !== undefined
          ? {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(init.body),
            }
          : {}),
      });
      if (!res.ok) {
        console.warn(`[itad] HTTP ${res.status} for ${maskKey(url)}`);
        return null;
      }
      const contentType = res.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) {
        console.warn(`[itad] non-JSON response for ${maskKey(url)}`);
        return null;
      }
      try {
        return (await res.json()) as T;
      } catch {
        return null;
      }
    } catch (err) {
      console.warn(
        `[itad] fetch failed for ${maskKey(url)}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  });
}

// ---------------------------------------------------------------------------
// 방어적 파싱
// ---------------------------------------------------------------------------

function toNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function toStr(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** 외부 응답 1건을 ItadTierGame으로 정규화. id가 문자열이 아니면 버린다(상위에서 필터). */
function parseTierGame(raw: unknown): ItadTierGame | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const id = toStr(o.id);
  if (!id) return null;
  return {
    id,
    slug: toStr(o.slug) ?? "",
    title: toStr(o.title) ?? "",
    type: toStr(o.type) ?? "game",
  };
}

/**
 * 외부 응답 1건을 ItadTier로 정규화.
 * price는 **null 보존** — Fanatical "Build Your Own"은 price:null로 오고(고정 티어가 없음), 이를
 * amount 0으로 뭉개면 차트가 "지불 0"으로 깨진다. amount가 숫자인 유효 price 객체만 담는다.
 */
function parseTier(raw: unknown): ItadTier {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const priceRaw = (o.price && typeof o.price === "object" ? o.price : null) as Record<string, unknown> | null;
  const amount = priceRaw ? toNumber(priceRaw.amount) : undefined;
  const gamesRaw = Array.isArray(o.games) ? o.games : [];
  const games: ItadTierGame[] = [];
  for (const g of gamesRaw) {
    const parsed = parseTierGame(g);
    if (parsed) games.push(parsed);
  }
  return {
    price: amount !== undefined ? { amount, currency: toStr(priceRaw!.currency) ?? "" } : null,
    addon: typeof o.addon === "boolean" ? o.addon : undefined,
    games,
  };
}

/** 외부 응답 1건을 ItadBundle로 정규화. id/title이 없으면 null(버린다). */
function parseBundle(raw: unknown): ItadBundle | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const id = toNumber(o.id);
  if (id === undefined) return null;
  const tiersRaw = Array.isArray(o.tiers) ? o.tiers : [];
  // 실측 필드명: page (이전 예시의 shop 아님).
  const pageRaw = o.page && typeof o.page === "object" ? (o.page as Record<string, unknown>) : undefined;
  const countsRaw = o.counts && typeof o.counts === "object" ? (o.counts as Record<string, unknown>) : undefined;
  return {
    id,
    title: toStr(o.title) ?? "",
    page: pageRaw
      ? {
          id: toNumber(pageRaw.id),
          name: toStr(pageRaw.name),
          shopId: toNumber(pageRaw.shopId),
        }
      : undefined,
    url: toStr(o.url),
    details: toStr(o.details),
    isMature: typeof o.isMature === "boolean" ? o.isMature : undefined,
    publish: toStr(o.publish),
    // 실측 필드명: expiry (이전 예시의 expires 아님).
    expiry: toStr(o.expiry),
    note: toStr(o.note),
    counts: countsRaw
      ? { games: toNumber(countsRaw.games), media: toNumber(countsRaw.media) }
      : undefined,
    tiers: tiersRaw.map(parseTier),
  };
}

/** 응답(배열 기대)을 ItadBundle[]로 정규화. 배열이 아니면 []. */
function parseBundleList(raw: unknown): ItadBundle[] {
  if (!Array.isArray(raw)) return [];
  const out: ItadBundle[] = [];
  for (const b of raw) {
    const parsed = parseBundle(b);
    if (parsed) out.push(parsed);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 공개 API
// ---------------------------------------------------------------------------

export interface GetRecentBundlesOptions {
  country?: string;
  limit?: number;
  offset?: number;
  expired?: boolean;
  sort?: string;
}

/**
 * 번들 목록 한 페이지 조회. GET /bundles/v1.
 *
 * 반환값으로 **fetch 실패와 소진을 구분**한다:
 *   - null:  itadFetch 실패(네트워크/HTTP/예산 초과 등). **캐시하지 않는다** → 재시도 가능.
 *   - 배열:  정상 응답(배열 아니면 []). cacheSet 후 반환.
 *
 * 키 없으면 [](정상 degrade — 실패가 아님). findBundle은 null/[] 구분으로 음성 캐시 오염을 막는다.
 */
async function fetchBundlesPage(
  opts: GetRecentBundlesOptions = {},
): Promise<ItadBundle[] | null> {
  if (!itadConfigured()) return [];

  const country = opts.country ?? DEFAULT_COUNTRY;
  const sort = opts.sort ?? DEFAULT_SORT;
  const expired = opts.expired ?? false;
  const offset = opts.offset ?? 0;
  const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

  const cacheKey = `itad:bundles:${country}:${sort}:${expired}:${offset}:${limit}`;
  const cached = cacheGet<ItadBundle[]>(cacheKey);
  if (cached) return cached.data;

  const raw = await itadFetch<unknown>("/bundles/v1", {
    country,
    sort,
    expired,
    offset,
    limit,
  });
  // fetch 실패면 캐시하지 않고 null을 올려 호출부가 실패를 알게 한다.
  if (raw === null) return null;
  const bundles = parseBundleList(raw);
  cacheSet(cacheKey, bundles, ITAD_LIST_CACHE_TTL_MS);
  return bundles;
}

/**
 * 최신 번들 목록. GET /bundles/v1. 캐시 TTL ITAD_LIST_CACHE_TTL_MS. 키 없으면 []. 배열 아니면 [].
 * fetch 실패도 []로 평탄화한다(기존 동작 보존 — 목록 UI는 실패와 빈 목록을 같게 취급).
 */
export async function getRecentBundles(
  opts: GetRecentBundlesOptions = {},
): Promise<ItadBundle[]> {
  return (await fetchBundlesPage(opts)) ?? [];
}

/**
 * id로 번들을 찾는다. by-id 엔드포인트가 없어 최신 번들 목록을 스캔한다.
 * expired=false 페이지를 먼저, 못 찾으면 expired=true 페이지를, 각각 limit 50 × 최대 ITAD_BUNDLE_SCAN_PAGES.
 * 한 페이지 fetch가 실패하면(fetchBundlesPage가 null) 소진이 아니므로 음성 캐시 없이 즉시 null(재시도 가능).
 * 발견 시 itad:bundle:{id} 캐시. 스캔 소진 후 미발견 시 itad:bundle:miss:{id} 음성 캐시 + 경고 로그.
 */
export async function findBundle(
  id: number,
  country?: string,
): Promise<ItadBundle | null> {
  if (!itadConfigured()) return null;

  const hitKey = `itad:bundle:${id}`;
  const cachedHit = cacheGet<ItadBundle>(hitKey);
  if (cachedHit) return cachedHit.data;

  const missKey = `itad:bundle:miss:${id}`;
  const cachedMiss = cacheGet<true>(missKey);
  if (cachedMiss) return null;

  const cc = country ?? DEFAULT_COUNTRY;
  const scanLimit = MAX_LIMIT;

  for (const expired of [false, true]) {
    for (let page = 0; page < ITAD_BUNDLE_SCAN_PAGES; page++) {
      const batch = await fetchBundlesPage({
        country: cc,
        sort: DEFAULT_SORT,
        expired,
        offset: page * scanLimit,
        limit: scanLimit,
      });
      // fetch 실패(null)는 소진이 아니다 — 존재하는 번들을 못 찾았다고 음성 캐시하면
      // 다음 요청까지 10분간 404로 막힌다. 실패면 음성 캐시 없이 즉시 null(재시도 가능).
      if (batch === null) {
        console.warn(`[itad] bundle ${id} scan aborted: page fetch failed (no negative cache)`);
        return null;
      }
      const found = batch.find(b => b.id === id);
      if (found) {
        cacheSet(hitKey, found, ITAD_BUNDLE_CACHE_TTL_MS);
        return found;
      }
      // 빈/미달 페이지면 진짜 소진 — 다음 페이지는 없다.
      if (batch.length < scanLimit) break;
    }
  }

  console.warn(`[itad] bundle ${id} not found within scan cap (${ITAD_BUNDLE_SCAN_PAGES} pages)`);
  cacheSet(missKey, true, ITAD_BUNDLE_MISS_TTL_MS);
  return null;
}

/** POST /lookup 1회 분할 크기 (지시서: 100개씩). */
const LOOKUP_BATCH_SIZE = 100;

/**
 * UUID 배열 → Steam appid Map. 매핑된 것만(appid>0) 담는다.
 *
 * 개별 캐시 itad:appid:{uuid} (값: appid 또는 음성 0). 미스 UUID만 POST /lookup/shop/61/id/v1로
 * 100개씩 조회. 응답 {uuid:["app/<n>",...]}에서 첫 app-item의 appid를 선택(단계 1-3). 매핑 없으면 음성 0.
 */
export async function lookupSteamAppIds(uuids: string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (!itadConfigured()) return result;

  // 중복 제거 + 캐시 우선.
  const misses: string[] = [];
  const seen = new Set<string>();
  for (const uuid of uuids) {
    if (!uuid || seen.has(uuid)) continue;
    seen.add(uuid);
    const cached = cacheGet<number>(`itad:appid:${uuid}`);
    if (cached) {
      if (cached.data > 0) result.set(uuid, cached.data);
      continue;
    }
    misses.push(uuid);
  }
  if (misses.length === 0) return result;

  for (let i = 0; i < misses.length; i += LOOKUP_BATCH_SIZE) {
    const batch = misses.slice(i, i + LOOKUP_BATCH_SIZE);
    const resp = await itadFetch<unknown>("/lookup/shop/61/id/v1", {}, {
      method: "POST",
      body: batch,
    });
    // fetch 실패(null)와 "ITAD가 매핑 없음"을 구분한다. 실패면 이 배치는 캐시하지 않고 건너뛴다
    // (다음 호출에서 재시도 가능) — 전체 배치를 appid=0으로 7일 음성 캐시하는 사고를 막는다.
    if (resp === null) continue;
    const map = resp && typeof resp === "object" ? (resp as Record<string, unknown>) : {};
    for (const uuid of batch) {
      const items = map[uuid];
      const appid = pickAppId(items);
      cacheSet(`itad:appid:${uuid}`, appid, ITAD_APPID_CACHE_TTL_MS);
      if (appid > 0) result.set(uuid, appid);
    }
  }
  return result;
}

/**
 * lookup 응답 항목 배열에서 첫 "app/<n>" 항목의 appid를 고른다(단계 1-3 app-item 선택 규칙).
 * 없으면 0(음성 — 매핑 없음).
 */
function pickAppId(items: unknown): number {
  if (!Array.isArray(items)) return 0;
  for (const item of items) {
    if (typeof item !== "string") continue;
    const m = item.match(/^app\/(\d+)$/);
    if (m) {
      const n = Number(m[1]);
      if (Number.isInteger(n) && n > 0) return n;
    }
  }
  return 0;
}
