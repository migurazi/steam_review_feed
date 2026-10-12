/**
 * 번들 차트 합계 계산 (computeChartTotals).
 * 금액 단위: GameRowPrice.final은 cents(1/100) → major 변환 시 /100.
 */

import type { Chart, ChartTotals, Money, TierTotals } from "@/lib/bundle/types";

/**
 * Money를 KRW(원, 정수)로 환산한다.
 *   - currency === "KRW" → amount 그대로.
 *   - rates에 해당 통화의 단가(1단위당 KRW)가 있으면 Math.round(amount * rates[currency]).
 *   - 그 외(환율 없음) → null.
 */
function toKrw(money: Money, rates?: Record<string, number>): number | null {
  if (money.currency === "KRW") return money.amount;
  const per = rates?.[money.currency];
  if (typeof per === "number" && Number.isFinite(per)) {
    return Math.round(money.amount * per);
  }
  return null;
}

/**
 * 티어 하나의 합계를 계산한다.
 * retail = 가격이 확인된 게임들의 현재가(major) 합.
 * missingCount = 가격 미상(null 또는 priceUnknown) 게임 수.
 * krwRates 전달 시 비-KRW pay를 KRW로 환산해 payKrw·approxFx·savings를 채운다.
 */
function computeTierTotals(
  tier: import("@/lib/bundle/types").Tier,
  krwRates?: Record<string, number>
): TierTotals {
  let retail = 0;
  let missingCount = 0;

  for (const game of tier.games) {
    if (game.price === null || game.priceUnknown) {
      missingCount++;
    } else {
      retail += game.price.final / 100;
    }
  }

  const pricing = tier.pricing;
  let pay: Money;

  if (pricing.kind === "retail") {
    pay = { currency: "KRW", amount: retail };
  } else if (pricing.kind === "flat") {
    pay = { currency: pricing.currency, amount: pricing.amount };
  } else if (pricing.kind === "choice") {
    pay = { currency: pricing.currency, amount: pricing.amount };
  } else {
    // percent
    pay = { currency: "KRW", amount: Math.round(retail * (1 - pricing.percent / 100)) };
  }

  // pay를 KRW로 환산(KRW면 그대로, 비-KRW면 환율, 불가면 null).
  const payKrw = toKrw(pay, krwRates);
  const approxFx = pay.currency !== "KRW" && payKrw != null;

  // savings: payKrw != null(KRW거나 환산 가능), choice 제외, retail>0 일 때만. 음수도 그대로.
  let savings: TierTotals["savings"] = null;
  if (pricing.kind !== "choice" && payKrw != null && retail > 0) {
    const savedAmount = retail - payKrw;
    savings = {
      amount: savedAmount,
      percent: Math.round((100 * savedAmount) / retail),
    };
  }

  return {
    retail,
    missingCount,
    pay,
    payKrw: payKrw ?? undefined,
    approxFx: approxFx || undefined,
    savings,
  };
}

/**
 * 차트 전체 합계를 계산한다.
 * - 고유 appId 기준으로 retail·gameCount를 집계(중복 appId는 한 번만).
 * - 모든 티어 pay 통화가 같을 때만 차트 pay를 합산.
 */
export function computeChartTotals(
  chart: Chart,
  krwRates?: Record<string, number>
): ChartTotals {
  const tiers = chart.tiers.map((t) => computeTierTotals(t, krwRates));

  // 고유 appId 기준 집계
  const seen = new Map<number, number>(); // appId → final(major)
  for (const tier of chart.tiers) {
    for (const game of tier.games) {
      if (seen.has(game.appId)) continue;
      if (game.price !== null && !game.priceUnknown) {
        seen.set(game.appId, game.price.final / 100);
      } else {
        // 가격 미상이지만 고유 appId로는 등록(gameCount에는 포함)
        seen.set(game.appId, NaN);
      }
    }
  }

  let retail = 0;
  let gameCount = 0;
  for (const [, val] of seen) {
    gameCount++;
    if (!Number.isNaN(val)) retail += val;
  }

  // 모든 티어 pay의 통화가 동일하면 합산
  let pay: Money | null = null;
  if (tiers.length > 0) {
    const firstCurrency = tiers[0].pay.currency;
    const allSame = tiers.every((t) => t.pay.currency === firstCurrency);
    if (allSame) {
      const total = tiers.reduce((sum, t) => sum + t.pay.amount, 0);
      pay = { currency: firstCurrency, amount: total };
    }
  }

  // 차트 payKrw: 모든 티어가 payKrw != null 이면 그 합, 아니면 undefined.
  let payKrw: number | undefined;
  if (tiers.length > 0 && tiers.every((t) => t.payKrw != null)) {
    payKrw = tiers.reduce((sum, t) => sum + (t.payKrw as number), 0);
  }
  // approxFx: 티어 중 하나라도 환산을 썼으면 true.
  const approxFx = tiers.some((t) => t.approxFx) || undefined;

  // 차트 savings: payKrw != null(환산 포함) 이고 retail>0일 때만. 음수도 그대로.
  let savings: ChartTotals["savings"] = null;
  if (payKrw != null && retail > 0) {
    const savedAmount = retail - payKrw;
    savings = {
      amount: savedAmount,
      percent: Math.round((100 * savedAmount) / retail),
    };
  }

  return { tiers, retail, gameCount, pay, payKrw, approxFx, savings };
}
