/**
 * ITAD 번들 → 번들 차트(Chart) 변환 (작업 지시서 20261012_01 단계 1-3).
 *
 * 흐름:
 *   1. 전 티어의 game UUID를 모아 lookupSteamAppIds로 Steam appid를 찾는다.
 *   2. 매핑된 고유 appid를 getBundleGameRows로 보강(이름·헤더·가격·리뷰)한다.
 *   3. 티어를 ITAD 순서대로 Chart.tiers로 만든다. 매핑 안 된 UUID는 unmatched로 모아 UI가 수습한다.
 *
 * URL(url·details)은 http/https 스킴만 통과시킨다(M7 — javascript: 등 제거).
 */

import { lookupSteamAppIds } from "@/lib/itad/client";
import { getBundleGameRows } from "@/lib/steam/api";
import type { ItadBundle } from "@/lib/itad/types";
import type { Chart, GameRow, Tier, UnmatchedGame } from "@/lib/bundle/types";

/** http/https 스킴만 통과. 그 외(javascript:·data: 등)·빈 값은 undefined. */
function httpsOnly(url: string | undefined): string | undefined {
  if (!url) return undefined;
  return /^https?:\/\//i.test(url) ? url : undefined;
}

/**
 * ITAD 번들을 Chart로 변환한다. 매핑 실패 게임은 unmatched로 반환한다.
 */
export async function itadBundleToChart(
  bundle: ItadBundle,
): Promise<{ chart: Chart; unmatched: UnmatchedGame[] }> {
  // 1. 전 티어 UUID 수집.
  const allUuids: string[] = [];
  for (const tier of bundle.tiers) {
    for (const g of tier.games) allUuids.push(g.id);
  }

  // 2. UUID → appid, 그리고 매핑된 고유 appid → GameRow.
  const uuidToAppId = await lookupSteamAppIds(allUuids);
  const uniqueAppIds = Array.from(new Set(uuidToAppId.values()));
  const rows = await getBundleGameRows(uniqueAppIds);
  const rowByAppId = new Map<number, GameRow>();
  for (const row of rows) rowByAppId.set(row.appId, row);

  // 3. 티어 구성 + unmatched 수집.
  const tiers: Tier[] = [];
  const unmatched: UnmatchedGame[] = [];

  bundle.tiers.forEach((tier, tierIndex) => {
    const games: GameRow[] = [];
    for (const g of tier.games) {
      const appId = uuidToAppId.get(g.id);
      const base = appId !== undefined ? rowByAppId.get(appId) : undefined;
      if (base) {
        // ITAD가 구분한 type(game/dlc)을 Steam 행 위에 덮어쓴다.
        games.push({ ...base, type: g.type === "dlc" ? "dlc" : "game" });
      } else {
        unmatched.push({ uuid: g.id, title: g.title, slug: g.slug, tierIndex });
      }
    }

    // 가격이 null이면(Fanatical "Build Your Own" 등 품목당 가격 번들) 고정 티어가가 없다.
    // flat 0으로 두면 "지불 0"으로 깨지므로 retail(개별가 합)로 둔다 — 사용자가 편집기에서
    // 품목당 단가(예: 5+ ₩1,610/개)를 직접 지정할 수 있다.
    tiers.push({
      id: crypto.randomUUID(),
      label: tier.addon ? "애드온" : `티어 ${tierIndex + 1}`,
      pricing: tier.price
        ? { kind: "flat", amount: tier.price.amount, currency: tier.price.currency }
        : { kind: "retail" },
      games,
    });
  });

  const chart: Chart = {
    title: bundle.title,
    source: {
      // 실측 필드명: page.name (이전 예시의 shop.name 아님).
      shop: bundle.page?.name,
      url: httpsOnly(bundle.url),
      details: httpsOnly(bundle.details),
      // 실측 필드명: expiry (이전 예시의 expires 아님).
      expires: bundle.expiry,
      note: bundle.note,
    },
    tiers,
  };

  return { chart, unmatched };
}
