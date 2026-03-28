/**
 * iron-session 기반 세션 관리.
 *
 * 서명된 쿠키로 세션을 유지한다. 서버 사이드에서만 읽기/쓰기 가능.
 * 세션에는 Steam64 ID와 표시 이름만 저장하며, 비밀번호/토큰은 저장하지 않는다.
 */

import { getIronSession, type IronSession } from "iron-session";
import { cookies } from "next/headers";
import { getSessionSecret } from "@/lib/env";
import { SESSION_COOKIE_NAME } from "@/lib/constants";

/** 세션에 저장되는 데이터 구조 */
export interface SessionData {
  steamId?: string;
  displayName?: string;
  avatarUrl?: string;
}

function getSessionOptions() {
  return {
    password: getSessionSecret(),
    cookieName: SESSION_COOKIE_NAME,
    cookieOptions: {
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
      sameSite: "lax" as const,
      maxAge: 7 * 24 * 60 * 60,
    },
  };
}

/**
 * 현재 요청의 세션을 가져온다.
 * Next.js App Router의 Route Handler 및 Server Component에서 사용.
 */
export async function getSession(): Promise<IronSession<SessionData>> {
  const cookieStore = await cookies();
  return getIronSession<SessionData>(cookieStore, getSessionOptions());
}

/**
 * 세션에 로그인 정보를 저장한다.
 */
export async function createSession(
  steamId: string,
  displayName?: string,
  avatarUrl?: string
): Promise<void> {
  const session = await getSession();
  session.steamId = steamId;
  session.displayName = displayName;
  session.avatarUrl = avatarUrl;
  await session.save();
}

/**
 * 세션을 파괴(로그아웃)한다.
 */
export async function destroySession(): Promise<void> {
  const session = await getSession();
  session.destroy();
}
