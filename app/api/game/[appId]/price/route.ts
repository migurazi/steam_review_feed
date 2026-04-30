import { NextRequest, NextResponse } from "next/server";
import { getAppDetails, getAppPrice } from "@/lib/steam/api";
import { cacheGet } from "@/lib/cache";
import type { SteamAppDetails } from "@/lib/steam/types";

/**
 * 게임 가격 정보 전용 엔드포인트.
 * GET /api/game/{appId}/price
 *
 * 가격 캐시(`app:{appId}:price`, 1시간 TTL)를 우선 사용하므로
 * 세일 시작/종료에 빠르게 반응한다.
 *
 * 응답:
 *   { isFree: boolean, price: SteamPriceOverview | null }
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ appId: string }> }
) {
  const { appId: raw } = await params;
  const appId = Number(raw);

  if (!Number.isInteger(appId) || appId <= 0) {
    return NextResponse.json({ error: "Invalid appId" }, { status: 400 });
  }

  const price = await getAppPrice(appId);

  // is_free / release_date는 appInfo 캐시에서 확인. 캐시 미스면 getAppDetails 호출.
  let cachedInfo = cacheGet<SteamAppDetails>(`app:${appId}:info:KR`)?.data;
  if (!cachedInfo) {
    const details = await getAppDetails(appId);
    cachedInfo = details?.data;
  }

  return NextResponse.json({
    isFree: cachedInfo?.is_free ?? false,
    price: price ?? null,
    comingSoon: cachedInfo?.release_date?.coming_soon ?? false,
    releaseDate: cachedInfo?.release_date?.date ?? null,
  });
}
