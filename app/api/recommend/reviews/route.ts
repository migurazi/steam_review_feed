import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { rateLimitResponse } from "@/lib/rate-limit";
import { getReviewSummariesBatch } from "@/lib/steam/api";
import type { ReviewSummary } from "@/lib/steam/types";

/**
 * 재정렬용 리뷰 요약 조회.
 * GET /api/recommend/reviews?ids=1,2,3
 *
 * /recommend 페이지가 가성비·할인만·개수를 바꿔 서버 재분석 없이 재정렬할 때(lib/recommend-rerank.ts),
 * 새로 블렌딩 대상이 된 후보 중 풀에 리뷰 요약이 없는 것만 받아 간다. 보통 수 개~수십 개다.
 *
 * - 로그인 필요 (/recommend와 같은 범위). 요청 수 제한은 공통 rate limit.
 * - ids: 양의 정수, 중복 제거 후 최대 MAX_IDS개. 형식이 틀리면 400.
 * - getReviewSummariesBatch: 6시간 캐시 → 미캐시분은 GetItems 배치(100개/호출). MAX_IDS ≤ 100이라
 *   요청 하나가 Steam 호출을 최대 1회만 만든다 — 게임마다 appreviews를 부르던 구현처럼 한 요청이
 *   수십 회의 외부 호출로 증폭되지 않는다 (/code-review M4).
 *
 * 응답: { summaries: { [appid]: ReviewSummary | null } } — null은 조회 실패(클라이언트는 중립 0.5).
 */
const MAX_IDS = 60;

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const limited = rateLimitResponse(request);
  if (limited) return limited;

  const session = await getSession();
  if (!session.steamId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const raw = request.nextUrl.searchParams.get("ids") ?? "";
  const parts = raw.split(",").map(s => s.trim()).filter(Boolean);
  if (parts.length === 0 || !parts.every(p => /^\d{1,10}$/.test(p))) {
    return NextResponse.json({ error: "Invalid ids" }, { status: 400 });
  }
  const ids = Array.from(new Set(parts.map(Number))).filter(id => id > 0);
  if (ids.length === 0 || ids.length > MAX_IDS) {
    return NextResponse.json({ error: `ids must contain 1..${MAX_IDS} appids` }, { status: 400 });
  }

  const summaries: Record<number, ReviewSummary | null> = {};
  try {
    const fetched = await getReviewSummariesBatch(ids, undefined, () => request.signal.aborted);
    for (const [id, summary] of fetched) summaries[id] = summary;
  } catch (err) {
    console.warn("[recommend/reviews] batch failed:", err);
  }
  return NextResponse.json({ summaries });
}
