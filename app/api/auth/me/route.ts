/**
 * 현재 세션 정보 조회 API.
 * GET /api/auth/me → { steamId, displayName } 또는 { steamId: null }
 */

import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";

export async function GET() {
  const session = await getSession();
  return NextResponse.json({
    steamId: session.steamId || null,
    displayName: session.displayName || null,
    avatarUrl: session.avatarUrl || null,
  });
}
