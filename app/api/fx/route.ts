/**
 * 환율 조회 API — 번들 차트 메이커(/bundle)의 KRW 환산용.
 *
 * GET /api/fx → 200 { rates: Record<string, number> | null }
 *
 * 설계:
 *   - 페이지 로드 시 1회 호출되는 GET이라, 조회 실패도 **에러가 아니라** 200 + { rates: null }로
 *     응답한다(UI는 null이면 기존 "환산 불가"로 degrade). 전역 rate limit만 적용.
 */

import { NextRequest, NextResponse } from "next/server";
import { rateLimitResponse } from "@/lib/rate-limit";
import { getKrwRates } from "@/lib/fx";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const limited = rateLimitResponse(request);
  if (limited) return limited;

  const rates = await getKrwRates();
  return NextResponse.json({ rates });
}
