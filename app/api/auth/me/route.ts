/**
 * 현재 세션 정보 조회 API.
 * GET /api/auth/me -> { steamId, displayName, avatarUrl } 또는 { steamId: null }
 *
 * 클라이언트가 페이지 로드 시 가장 먼저 호출하는 API이므로
 * 서버 초기화(환경변수 검증, DB 스케줄러)를 여기서 트리거한다.
 */

import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { initServer } from "@/lib/init";

// Node.js Runtime에서 서버 초기화 (Edge Runtime이 아닌 곳에서만 가능)
initServer();

export async function GET() {
  const session = await getSession();
  return NextResponse.json({
    steamId: session.steamId || null,
    displayName: session.displayName || null,
    avatarUrl: session.avatarUrl || null,
  });
}
