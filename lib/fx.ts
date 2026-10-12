/**
 * 환율 조회 (getKrwRates) — 번들 차트 메이커의 KRW 환산용.
 *
 * 번들/티어 가격이 USD 등 비-KRW일 때, 게임가(KRW)와 통화가 달라 절약%를 못 구하는 걸
 * KRW로 환산해 병기·계산하기 위한 환율 맵을 제공한다. open.er-api.com(무키)을 쓴다.
 *
 * 반환은 "각 통화 1단위당 KRW 값" 맵이다(예: { USD: 1340.7, EUR: 1502.0, KRW: 1 }).
 * 조회 실패 시 null → 호출 측은 기존 "환산 불가"로 graceful degrade.
 */

import { cacheGet, cacheSet } from "@/lib/cache";

/** 캐시 키·TTL. 사용자 무관 공유 데이터이므로 길게(12시간) 둔다. */
const FX_CACHE_KEY = "fx:krw-rates";
const FX_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
/** 외부 호출 타임아웃(ms). */
const FX_FETCH_TIMEOUT_MS = 8_000;
/** open.er-api.com 최신 환율(base USD). */
const FX_URL = "https://open.er-api.com/v6/latest/USD";

/** open.er-api.com 응답 중 우리가 쓰는 필드. */
interface ErApiResponse {
  result?: unknown;
  rates?: Record<string, unknown>;
}

/**
 * 각 통화 1단위당 KRW 값 맵을 반환한다. 실패 시 null.
 *
 * 변환: open.er-api.com은 base=USD라 rates[C]는 "USD 1단위당 C 값"이다. 통화 C의 KRW 환산 단가는
 * `krwPer[C] = rates.KRW / rates[C]` (USD는 rates.KRW/1, EUR는 rates.KRW/rates.EUR …). KRW는 1로 고정.
 * result !== "success" 이거나 rates.KRW가 없으면 null.
 *
 * 캐시: fx:krw-rates(TTL 12시간). stale여도 그대로 재사용(끝난 할인 같은 민감도 없음).
 */
export async function getKrwRates(): Promise<Record<string, number> | null> {
  const cached = cacheGet<Record<string, number>>(FX_CACHE_KEY);
  if (cached) return cached.data;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FX_FETCH_TIMEOUT_MS);
  const t = timer as unknown as { unref?: () => void };
  if (typeof t.unref === "function") t.unref();

  try {
    const res = await fetch(FX_URL, { signal: controller.signal });
    if (!res.ok) {
      console.warn(`[fx] HTTP ${res.status} for ${FX_URL}`);
      return null;
    }
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      console.warn(`[fx] non-JSON response for ${FX_URL}`);
      return null;
    }
    let body: ErApiResponse;
    try {
      body = (await res.json()) as ErApiResponse;
    } catch {
      console.warn(`[fx] JSON parse failed for ${FX_URL}`);
      return null;
    }

    if (body.result !== "success" || !body.rates) {
      console.warn(`[fx] result not success for ${FX_URL}`);
      return null;
    }
    const rates = body.rates;
    const krw = rates.KRW;
    if (typeof krw !== "number" || !Number.isFinite(krw)) {
      console.warn(`[fx] missing rates.KRW for ${FX_URL}`);
      return null;
    }

    const krwPer: Record<string, number> = {};
    for (const [currency, value] of Object.entries(rates)) {
      if (typeof value !== "number" || !Number.isFinite(value) || value === 0) continue;
      krwPer[currency] = krw / value;
    }
    krwPer.KRW = 1;

    cacheSet(FX_CACHE_KEY, krwPer, FX_CACHE_TTL_MS);
    return krwPer;
  } catch (err) {
    console.warn(
      `[fx] fetch failed for ${FX_URL}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}
