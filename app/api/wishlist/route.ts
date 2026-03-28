/**
 * 위시리스트 조회 API.
 * GET /api/wishlist?offset=0
 *
 * 세션의 steamId로 IWishlistService 호출 (캐시 우선).
 * date_added 최신순 정렬, PAGE_SIZE개 상한, offset으로 페이지네이션.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { getWishlist } from "@/lib/steam/api";
import { rateLimitResponse } from "@/lib/rate-limit";
import { PAGE_SIZE } from "@/lib/constants";

export async function GET(request: NextRequest) {
  const limited = rateLimitResponse(request);
  if (limited) return limited;

  const session = await getSession();
  if (!session.steamId) {
    return NextResponse.json({ error: "인증이 필요합니다." }, { status: 401 });
  }

  const offset = parseInt(request.nextUrl.searchParams.get("offset") || "0", 10);

  const result = await getWishlist(session.steamId);
  if (!result) {
    return NextResponse.json(
      { error: "위시리스트를 가져올 수 없습니다." },
      { status: 502 }
    );
  }

  // date_added 최신순 정렬
  const sorted = [...result.data].sort((a, b) => b.date_added - a.date_added);

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
