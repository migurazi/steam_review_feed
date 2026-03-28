/**
 * 라이브러리(소유 게임) 조회 API.
 * GET /api/library?offset=0
 *
 * 세션의 steamId로 GetOwnedGames 호출 (캐시 우선).
 * 정렬: playtime_2weeks > 0인 게임 우선 -> playtime_forever 높은 순.
 * PAGE_SIZE개 상한, offset으로 페이지네이션.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { getOwnedGames } from "@/lib/steam/api";
import { rateLimitResponse } from "@/lib/rate-limit";
import { sortLibraryGames } from "@/lib/steam/sort";
import { PAGE_SIZE } from "@/lib/constants";

export async function GET(request: NextRequest) {
  const limited = rateLimitResponse(request);
  if (limited) return limited;

  const session = await getSession();
  if (!session.steamId) {
    return NextResponse.json({ error: "인증이 필요합니다." }, { status: 401 });
  }

  const offset = parseInt(request.nextUrl.searchParams.get("offset") || "0", 10);

  const result = await getOwnedGames(session.steamId);
  if (!result) {
    return NextResponse.json(
      { error: "라이브러리를 가져올 수 없습니다." },
      { status: 502 }
    );
  }

  // 정렬: 최근 2주 플레이 게임 우선 -> 총 플레이타임 높은 순
  const sorted = sortLibraryGames(result.data);

  // 페이지네이션
  const page = sorted.slice(offset, offset + PAGE_SIZE);

  return NextResponse.json({
    games: page,
    total: sorted.length,
    offset,
    hasMore: offset + PAGE_SIZE < sorted.length,
    isStale: result.isStale,
  });
}
