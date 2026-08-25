/**
 * Next.js 미들웨어: 인증 체크 + Rate Limit.
 *
 * 보호된 경로에 대해 세션 쿠키 존재 여부를 확인한다.
 * iron-session의 쿠키를 직접 파싱하지 않고, 쿠키 존재 여부만 체크한다.
 * (실제 세션 검증은 각 Route Handler에서 getSession()으로 수행)
 */

import { NextRequest, NextResponse } from "next/server";

/** 인증이 필요한 경로 패턴 */
// E1: /recommend 가 보호 목록에 없던 기존 결함을 함께 수정. /achievements 추가.
const PROTECTED_PAGES = ["/feed", "/recommend", "/achievements"];
// E2/C3: /api/recommend 누락 수정 + 도전과제는 stream만 보호.
//   /api/achievements/[appId] 상세는 비로그인 접근이 필요하므로(§5.6.4) prefix를
//   /api/achievements/stream 으로 좁힌다 — reviews 예외 같은 조건 분기 불필요.
const PROTECTED_API = [
  "/api/wishlist",
  "/api/library",
  "/api/reviews",
  "/api/recommend",
  "/api/achievements/stream",
];

import { SESSION_COOKIE_NAME } from "@/lib/constants";

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
  // 정적 파일, _next 등은 제외.
  // matcher에 없으면 미들웨어가 실행조차 되지 않는다 — 보호 경로는 반드시 포함.
  // /api/achievements/:path* 전체를 넣되, PROTECTED_API 판정에서 stream만 걸리므로
  // 상세 라우트(/api/achievements/[appId])는 통과만 하고 401을 받지 않는다(C3).
  matcher: [
    "/feed/:path*",
    "/recommend/:path*",
    "/achievements/:path*",
    "/api/wishlist/:path*",
    "/api/library/:path*",
    "/api/reviews/:path*",
    "/api/recommend/:path*",
    "/api/achievements/:path*",
  ],
};
