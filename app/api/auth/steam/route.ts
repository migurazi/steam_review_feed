/**
 * Steam OpenID 인증 시작 엔드포인트.
 * GET /api/auth/steam → Steam 로그인 페이지로 리다이렉트.
 */

import { NextResponse } from "next/server";
import { getAuthUrl } from "@/lib/steam/openid";

export async function GET() {
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";
  const returnUrl = `${baseUrl}/api/auth/callback`;

  try {
    const authUrl = await getAuthUrl(returnUrl, baseUrl);
    return NextResponse.redirect(authUrl);
  } catch (err) {
    console.error("[auth/steam] Failed to generate auth URL:", err);
    return NextResponse.json(
      { error: "Steam 로그인을 시작할 수 없습니다." },
      { status: 500 }
    );
  }
}
