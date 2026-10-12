/**
 * 수동/Steam 입력 → 게임 행 보강 API — 번들 차트 메이커(/bundle)의 입력 ③ (작업 지시서 20261012_01 단계 2).
 *
 * POST /api/bundle/resolve
 *   body: { appIds?: number[], steamPackageIds?: number[], steamBundleIds?: number[] }
 *   → 200 { rows: GameRow[], notes?: string[] }
 *
 * 설계:
 *   - ITAD 키가 없어도 동작한다(Steam 호출만 사용 — graceful degrade).
 *   - 패키지/번들은 expandSteamCollection으로 appid를 전개한다. Steam 번들(store bundle) 전개는
 *     미지원일 수 있어(V3b), 번들을 요청했는데 전개 결과가 비면 notes로 안내한다.
 *   - 입력 방어: 각 배열 길이 ≤ BUNDLE_INPUT_MAX_IDS, 원소 양의 정수. 전개 후 합쳐진 appid 총수도
 *     상한을 넘지 않게 자른다(익명 남용 방어).
 *   - unmatched 단건 보강도 이 라우트를 appIds:[하나]로 호출한다(M1 왕복).
 */

import { NextRequest, NextResponse } from "next/server";
import { rateLimitResponse } from "@/lib/rate-limit";
import { getBundleGameRows, expandSteamCollection } from "@/lib/steam/api";
import { BUNDLE_INPUT_MAX_IDS, BUNDLE_EXPAND_MAX_COLLECTIONS } from "@/lib/constants";

export const dynamic = "force-dynamic";

const BUNDLE_EXPAND_UNSUPPORTED_NOTE =
  "Steam 번들 전개는 지원되지 않습니다. ITAD 목록/수동 입력을 사용하세요.";

/**
 * 입력 배열을 검증한다. 배열이 아니면 undefined로 "미제공" 취급. 길이 초과·비정수·비양수는 null(400 신호).
 */
function validateIdArray(
  value: unknown,
  field: string
): { ok: true; ids: number[] } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, ids: [] };
  if (!Array.isArray(value)) {
    return { ok: false, error: `${field}는 숫자 배열이어야 합니다.` };
  }
  if (value.length > BUNDLE_INPUT_MAX_IDS) {
    return {
      ok: false,
      error: `${field}는 최대 ${BUNDLE_INPUT_MAX_IDS}개까지 가능합니다.`,
    };
  }
  const ids: number[] = [];
  for (const v of value) {
    if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
      return { ok: false, error: `${field}의 원소는 모두 양의 정수여야 합니다.` };
    }
    ids.push(v);
  }
  return { ok: true, ids };
}

export async function POST(request: NextRequest) {
  const limited = rateLimitResponse(request);
  if (limited) return limited;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청입니다." }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;

  const appIdsV = validateIdArray(b.appIds, "appIds");
  if (!appIdsV.ok) return NextResponse.json({ error: appIdsV.error }, { status: 400 });
  const pkgV = validateIdArray(b.steamPackageIds, "steamPackageIds");
  if (!pkgV.ok) return NextResponse.json({ error: pkgV.error }, { status: 400 });
  const bundleV = validateIdArray(b.steamBundleIds, "steamBundleIds");
  if (!bundleV.ok) return NextResponse.json({ error: bundleV.error }, { status: 400 });

  // 전개 대상(패키지+번들) 수 상한 — 전개 1건당 직렬 Steam 호출이 따르므로 요청당 호출량을 묶는다.
  // (appid 직접 입력은 전개가 없어 아래 BUNDLE_INPUT_MAX_IDS 상한만 적용.)
  if (pkgV.ids.length + bundleV.ids.length > BUNDLE_EXPAND_MAX_COLLECTIONS) {
    return NextResponse.json(
      {
        error: `패키지·번들 URL은 합쳐서 최대 ${BUNDLE_EXPAND_MAX_COLLECTIONS}개까지 전개할 수 있습니다.`,
      },
      { status: 400 }
    );
  }

  const notes: string[] = [];
  const collected = new Set<number>();
  for (const id of appIdsV.ids) collected.add(id);

  // 패키지 전개.
  for (const pkgId of pkgV.ids) {
    const apps = await expandSteamCollection("package", pkgId);
    for (const a of apps) collected.add(a);
  }

  // 번들 전개 — 미지원(빈 결과)이면 안내 1회.
  let bundleExpandFailed = false;
  for (const bundleId of bundleV.ids) {
    const apps = await expandSteamCollection("bundle", bundleId);
    if (apps.length === 0) bundleExpandFailed = true;
    for (const a of apps) collected.add(a);
  }
  if (bundleExpandFailed) notes.push(BUNDLE_EXPAND_UNSUPPORTED_NOTE);

  // 전체 appid 합 상한 — 중복 제거 후에도 상한을 넘으면 초과분을 자르고 안내.
  let allAppIds = Array.from(collected);
  if (allAppIds.length > BUNDLE_INPUT_MAX_IDS) {
    allAppIds = allAppIds.slice(0, BUNDLE_INPUT_MAX_IDS);
    notes.push(
      `게임이 ${BUNDLE_INPUT_MAX_IDS}개를 초과해 앞 ${BUNDLE_INPUT_MAX_IDS}개만 처리했습니다.`
    );
  }

  const rows = await getBundleGameRows(allAppIds);
  return NextResponse.json(notes.length > 0 ? { rows, notes } : { rows });
}
