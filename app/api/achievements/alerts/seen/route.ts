/**
 * 도전과제 알림 확인 처리 (Phase 3). 배너를 닫을 때 호출.
 * POST /api/achievements/alerts/seen  →  { ok, seen }
 *
 * 미들웨어 PROTECTED_API에 없으므로(=stream만 보호) 여기서 직접 세션을 확인한다.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { rateLimitResponse } from "@/lib/rate-limit";
import { markAlertsSeen } from "@/lib/achievement-store";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const limited = rateLimitResponse(request);
  if (limited) return limited;

  const session = await getSession();
  if (!session.steamId) {
    return NextResponse.json({ error: "인증이 필요합니다." }, { status: 401 });
  }

  const seen = markAlertsSeen(session.steamId);
  return NextResponse.json({ ok: true, seen });
}
