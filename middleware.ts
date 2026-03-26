/**
 * Next.js 미들웨어: 인증 체크 + Rate Limit.
 *
 * 보호된 경로에 대해 세션 쿠키 존재 여부를 확인한다.
 * iron-session의 쿠키를 직접 파싱하지 않고, 쿠키 존재 여부만 체크한다.
 * (실제 세션 검증은 각 Route Handler에서 getSession()으로 수행)
 */

import { NextRequest, NextResponse } from "next/server";

/** 인증이 필요한 경로 패턴 */
const PROTECTED_PAGES = ["/feed"];
const PROTECTED_API = ["/api/wishlist", "/api/library", "/api/reviews"];

const SESSION_COOKIE_NAME = "steam_review_feed_session";

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // 세션 쿠키 존재 여부 확인 (간이 체크)
  const hasSession = request.cookies.has(SESSION_COOKIE_NAME);

  // 보호된 페이지: 미인증 시 랜딩 페이지로 리다이렉트
  if (PROTECTED_PAGES.some((p) => pathname.startsWith(p))) {
    if (!hasSession) {
      return NextResponse.redirect(new URL("/", request.url));
    }
  }

  // 보호된 API: 미인증 시 401 반환
  // 단, /api/reviews/stream?appId=xxx 는 비로그인 허용 (게임별 페이지, 플로우 C)
  if (PROTECTED_API.some((p) => pathname.startsWith(p))) {
    const isGameSpecific =
      pathname.startsWith("/api/reviews") &&
      request.nextUrl.searchParams.has("appId");

    if (!hasSession && !isGameSpecific) {
      return NextResponse.json(
        { error: "인증이 필요합니다." },
        { status: 401 }
      );
    }
  }

  return NextResponse.next();
}

export const config = {
  // 정적 파일, _next 등은 제외
  matcher: ["/feed/:path*", "/api/wishlist/:path*", "/api/library/:path*", "/api/reviews/:path*"],
};
