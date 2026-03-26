/**
 * Steam ID 직접 입력 (fallback) 인증 엔드포인트.
 * POST /api/auth/manual { steamId: "76561198056932899" | "migurazi" }
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveVanityUrl, getPlayerSummary } from "@/lib/steam/api";
import { createSession } from "@/lib/session";
import { upsertUser } from "@/lib/db";
import { logEvent } from "@/lib/logger";

/** Steam64 ID 형식: 17자리 숫자 */
const STEAM64_REGEX = /^\d{17}$/;
/** Steam 커스텀 URL 허용 패턴: 영숫자, 언더스코어, 하이픈 (최대 32자) */
const VANITY_URL_REGEX = /^[a-zA-Z0-9_-]{1,32}$/;

export async function POST(request: NextRequest) {
  let body: { steamId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "잘못된 요청 형식입니다." },
      { status: 400 }
    );
  }

  const input = body.steamId?.trim();
  if (!input) {
    return NextResponse.json(
      { error: "Steam ID를 입력해주세요." },
      { status: 400 }
    );
  }

  let steamId: string;

  if (STEAM64_REGEX.test(input)) {
    steamId = input;
  } else if (!VANITY_URL_REGEX.test(input)) {
    return NextResponse.json(
      { error: "올바른 Steam ID 또는 커스텀 URL을 입력해주세요." },
      { status: 400 }
    );
  } else {
    const resolved = await resolveVanityUrl(input);
    if (!resolved) {
      return NextResponse.json(
        { error: "해당하는 Steam 계정을 찾을 수 없습니다." },
        { status: 404 }
      );
    }
    steamId = resolved;
  }

  // 프로필 존재 여부 검증 — 실존하지 않는 Steam ID로 세션 생성 방지
  const profile = await getPlayerSummary(steamId);
  if (!profile) {
    return NextResponse.json(
      { error: "해당하는 Steam 계정을 찾을 수 없습니다." },
      { status: 404 }
    );
  }

  const displayName = profile.personaname || undefined;

  upsertUser(steamId, displayName);
  await createSession(steamId, displayName, profile.avatarfull);

  logEvent("login", { steamId, displayName, method: "manual" });

  return NextResponse.json({ success: true, steamId, displayName });
}
