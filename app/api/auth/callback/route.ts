/**
 * Steam OpenID 콜백 엔드포인트.
 * GET /api/auth/callback → Steam에서 리다이렉트, 서명 검증 후 세션 생성.
 */

import { NextRequest, NextResponse } from "next/server";
import { verifyCallback } from "@/lib/steam/openid";
import { getPlayerSummary } from "@/lib/steam/api";
import { createSession } from "@/lib/session";
import { upsertUser } from "@/lib/db";
import { logEvent } from "@/lib/logger";

export async function GET(request: NextRequest) {
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";

  // standalone 모드에서 request.url이 내부 주소(0.0.0.0 등)로 올 수 있다.
  // Steam OpenID 콜백 URL은 반드시 baseUrl 기준이어야 검증이 통과한다.
  const rawUrl = request.url;
  const parsed = new URL(rawUrl);
  const expectedOrigin = new URL(baseUrl).origin;

  // origin이 불일치하면 baseUrl 기준으로 교정
  let callbackUrl = rawUrl;
  if (parsed.origin !== expectedOrigin) {
    callbackUrl = `${expectedOrigin}${parsed.pathname}${parsed.search}`;
    console.log(`[auth/callback] URL corrected: ${parsed.origin} -> ${expectedOrigin}`);
  }

  const steamId = await verifyCallback(callbackUrl, baseUrl);
  if (!steamId) {
    return NextResponse.redirect(
      `${baseUrl}/?error=steam_auth_failed`
    );
  }

  // 닉네임 가져오기
  const profile = await getPlayerSummary(steamId);
  const displayName = profile?.personaname || undefined;

  // DB에 사용자 upsert (닉네임 포함)
  upsertUser(steamId, displayName);

  await createSession(steamId, displayName, profile?.avatarfull);

  logEvent("login", { steamId, displayName, method: "openid" });

  return NextResponse.redirect(`${baseUrl}/feed`);
}
