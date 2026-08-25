/**
 * 게임 1건의 도전과제 상세 (Phase 2, 온디맨드). 작업 지시서 20260825_01 §5.5.2.
 * GET /api/achievements/{appId}?lang=ko|en
 *
 * 반환: 과제 목록(표시 문구 + 아이콘 + 전역 희귀도 %) + (로그인 시) 개인 획득 여부·일시.
 *
 * **비보호 라우트**(§5.6.4, C3): 비로그인도 전역 달성률을 볼 수 있어야 하므로
 *   미들웨어 PROTECTED_API에서 제외돼 있다. 개인 필드는 세션이 있을 때만 붙인다.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { rateLimitResponse } from "@/lib/rate-limit";
import {
  getAchievementSchemaForDisplay,
  getGlobalAchievementPercentages,
  getPlayerAchievements,
} from "@/lib/steam/api";

export const dynamic = "force-dynamic";

/** 아이콘 파일명 → 전체 URL 복원 (§5.1.2, V1 실측 도메인). */
const ICON_BASE =
  "https://steamcdn-a.akamaihd.net/steamcommunity/public/images/apps";

interface DetailAchievement {
  name: string;
  displayName: string;
  description: string;
  hidden: boolean;
  icon: string | null;
  globalPercent: number | null;
  achieved?: boolean;
  unlockTime?: number;
}
interface AchievementDetailResponse {
  appId: number;
  achievements: DetailAchievement[];
  personalUnavailable?: "private" | "unavailable" | "error";
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ appId: string }> }
) {
  const limited = rateLimitResponse(request);
  if (limited) return limited;

  const { appId: appIdRaw } = await params;
  const appId = Number.parseInt(appIdRaw, 10);
  if (!Number.isInteger(appId) || appId <= 0) {
    return NextResponse.json({ error: "잘못된 appId입니다." }, { status: 400 });
  }

  const lang = request.nextUrl.searchParams.get("lang") === "en" ? "en" : "ko";

  // 1) 표시용 스키마. null = 과제 없음/조회 실패 → 404.
  const defs = await getAchievementSchemaForDisplay(appId, lang);
  if (!defs) {
    return NextResponse.json(
      { error: "이 게임에는 도전과제가 없습니다." },
      { status: 404 }
    );
  }

  // 2) 전역 희귀도. 실패/누락은 각 항목 globalPercent: null로 흡수.
  const global = await getGlobalAchievementPercentages(appId);

  // 3) 개인 진행률 — 세션이 있을 때만.
  const session = await getSession();
  const hasSession = !!session.steamId;
  let personal: Map<string, { achieved: boolean; unlockTime: number }> | null = null;
  let personalUnavailable: "private" | "unavailable" | "error" | undefined;
  if (hasSession) {
    const player = await getPlayerAchievements(session.steamId!, appId);
    if (player.status === "ok") {
      personal = new Map(
        player.achievements.map((a) => [
          a.name,
          { achieved: a.achieved, unlockTime: a.unlockTime },
        ])
      );
    } else {
      personalUnavailable = player.status;
    }
  }

  const achievements: DetailAchievement[] = defs.map((d) => {
    const base: DetailAchievement = {
      name: d.name,
      displayName: d.displayName,
      description: d.description,
      hidden: d.hidden,
      icon: d.icon ? `${ICON_BASE}/${appId}/${d.icon}` : null,
      globalPercent: d.name in global ? global[d.name] : null,
    };
    // 개인 필드는 세션이 있을 때만 붙인다(§7.3). 비로그인엔 achieved/unlockTime 없음.
    if (hasSession) {
      const p = personal?.get(d.name);
      base.achieved = p?.achieved ?? false;
      // unlockTime은 Steam이 Unix 초로 주므로 ms로 통일(미획득/미상은 0).
      base.unlockTime = p?.unlockTime ? p.unlockTime * 1000 : 0;
    }
    return base;
  });

  const body: AchievementDetailResponse = { appId, achievements };
  if (personalUnavailable) body.personalUnavailable = personalUnavailable;
  return NextResponse.json(body);
}
