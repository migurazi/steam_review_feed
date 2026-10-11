import { NextRequest, NextResponse } from "next/server";
import { getAppDetails, getAppPriceSnapshot } from "@/lib/steam/api";
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
 *   { isFree: boolean, price: SteamPriceOverview | null, priceFetchedAt: number | null,
 *     comingSoon: boolean, releaseDate: string | null }
 *   priceFetchedAt: 가격을 확인한 시각(Unix ms). 조회 장애 시 마지막으로 확인한 가격이 원래 시각과
 *   함께 온다 — 화면이 1시간 초과분을 회색으로 구분 (작업 지시서 20261010_02 §2-2).
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

  // is_free / release_date는 appInfo 캐시에서 확인. 캐시 미스면 getAppDetails 호출.
  // 가격보다 먼저 한다 — getAppDetails가 store를 새로 조회한 경우에는 가격 캐시도 함께 채우므로,
  // 이어지는 getAppPriceSnapshot이 캐시 히트가 되어 store 호출이 한 번으로 끝난다.
  // 단, SQLite 영속 캐시에서 hydrate한 경우(재시작 직후 흔함)는 price_overview를 뺀 채 저장돼
  // 있어 가격 캐시를 채우지 않는다 — 그때는 getAppPriceSnapshot이 따로 store를 조회한다.
  let cachedInfo = cacheGet<SteamAppDetails>(`app:${appId}:info:KR`)?.data;
  if (!cachedInfo) {
    const details = await getAppDetails(appId);
    cachedInfo = details?.data;
  }

  // 스냅샷: 캐시가 있으면 즉시(묵었으면 원래 시각과 함께), 없을 때만 store를 기다린다
  // (작업 지시서 20261010_02 §2). priceFetchedAt으로 화면이 묵은 가격을 회색 처리한다.
  const snapshot = await getAppPriceSnapshot(appId);

  return NextResponse.json({
    isFree: cachedInfo?.is_free ?? false,
    price: snapshot?.price ?? null,
    priceFetchedAt: snapshot?.fetchedAt ?? null,
    comingSoon: cachedInfo?.release_date?.coming_soon ?? false,
    releaseDate: cachedInfo?.release_date?.date ?? null,
  });
}
