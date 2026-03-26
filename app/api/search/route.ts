/**
 * 게임 검색 API.
 * GET /api/search?q=검색어     → 이름으로 검색 (storesearch)
 * GET /api/search?appId=12345  → AppID로 조회 (appdetails)
 *
 * 세션 불필요 (비로그인 접근 가능, 플로우 C).
 */

import { NextRequest, NextResponse } from "next/server";
import { searchGames, getAppDetails } from "@/lib/steam/api";
import { rateLimitResponse } from "@/lib/rate-limit";

export async function GET(request: NextRequest) {
  const limited = rateLimitResponse(request);
  if (limited) return limited;

  const q = request.nextUrl.searchParams.get("q");
  const appId = request.nextUrl.searchParams.get("appId");

  if (appId) {
    // AppID로 직접 조회
    const id = parseInt(appId, 10);
    if (isNaN(id) || id <= 0) {
      return NextResponse.json(
        { error: "올바른 AppID를 입력해주세요." },
        { status: 400 }
      );
    }

    const result = await getAppDetails(id);
    if (!result) {
      return NextResponse.json(
        { error: `AppID ${id}에 해당하는 게임을 찾을 수 없습니다.` },
        { status: 404 }
      );
    }

    return NextResponse.json({
      results: [
        {
          appId: result.data.steam_appid,
          name: result.data.name,
          imageUrl: result.data.header_image,
        },
      ],
    });
  }

  if (q && q.trim().length > 0) {
    // 이름으로 검색
    const items = await searchGames(q.trim());
    return NextResponse.json({
      results: items.map((item) => ({
        appId: item.id,
        name: item.name,
        imageUrl: item.tiny_image,
      })),
    });
  }

  return NextResponse.json(
    { error: "검색어(q) 또는 AppID(appId)를 입력해주세요." },
    { status: 400 }
  );
}
