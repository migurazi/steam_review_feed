/**
 * 로그아웃 엔드포인트.
 * POST /api/auth/logout → 세션 파괴 후 랜딩 페이지로 리다이렉트.
 */

import { NextResponse } from "next/server";
import { destroySession } from "@/lib/session";

export async function POST() {
  await destroySession();

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";
  return NextResponse.redirect(`${baseUrl}/`, { status: 303 });
}
