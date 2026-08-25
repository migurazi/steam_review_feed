/**
 * 도전과제 스캔 SSE 엔드포인트 (Phase 1). 작업 지시서 20260825_01 §5.5.1.
 * GET /api/achievements/stream?force=true&includeUnplayed=false
 *
 * 이벤트 시퀀스:
 *   cached    { games[], summary, computedAt }   0|1회, 가장 먼저 (저장된 progress)
 *   progress  { loaded, total }                  반복
 *   partial   { games[] }                        반복, 3초 throttle
 *   result    { games[], summary }               1회, 확정
 *   done      { scanned, skipped, remaining,
 *               profilePrivate, libraryFetchFailed, budgetExceeded } 1회
 *
 * 취소 패턴은 `/api/recommend`와 동일: cancelled 플래그 + ReadableStream cancel().
 * 실제 스캔/캐시/저장 로직은 `lib/achievement-scan.ts`가 담당하고, 이 라우트는
 * 콜백을 SSE 프레임으로 변환만 한다.
 */

import { NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { rateLimitResponse } from "@/lib/rate-limit";
import { logEvent } from "@/lib/logger";
import { sseEvent, sseResponse } from "@/lib/sse";
import { scanAchievements, buildCachedResult } from "@/lib/achievement-scan";
import { upsertUser } from "@/lib/db";
import { getUnseenAlerts } from "@/lib/achievement-store";

export const dynamic = "force-dynamic";

/** partial 이벤트 최소 간격(ms) — 수천 개 스캔 중 렌더 폭주 방지. */
const PARTIAL_THROTTLE_MS = 3000;

export async function GET(request: NextRequest) {
  const limited = rateLimitResponse(request);
  if (limited) return limited;

  const session = await getSession();
  if (!session.steamId) {
    return new Response("Unauthorized", { status: 401 });
  }
  const steamId = session.steamId;

  // 진행률 저장(upsertProgressBatch)은 users 행이 있어야 동작한다. 로그인은
  // 특정 DB에만 사용자를 만들 수 있으므로(로그인 DB ≠ 스캔 DB인 경우), 인증된
  // 사용자에 한해 여기서 사용자 행 존재를 보장한다 — 없으면 진행률이 저장되지
  // 않아 매 스캔이 처음부터 다시 돈다.
  upsertUser(steamId, session.displayName);

  const params = request.nextUrl.searchParams;
  const force = params.get("force") === "true";
  const includeUnplayed = params.get("includeUnplayed") === "true";

  logEvent("achievement_scan", { steamId, force, includeUnplayed });

  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const safeEnqueue = (event: string, data: unknown) => {
        if (cancelled) return;
        try {
          controller.enqueue(sseEvent(event, data));
        } catch {
          /* controller already closed */
        }
      };

      try {
        // 1) cached — 저장된 progress로 즉시 그려준다(있을 때만). 요약은 클라이언트가
        //    rows에서 파생하므로 games만 보낸다(#4).
        try {
          const cached = await buildCachedResult(steamId);
          if (cached.rows.length > 0) {
            safeEnqueue("cached", { games: cached.rows, computedAt: Date.now() });
          }
        } catch (err) {
          console.warn("[achievements] cached build failed:", err);
        }

        // 2) 스캔 — 진행률/부분결과 스트리밍.
        let lastPartial = 0;
        const result = await scanAchievements(
          steamId,
          { force, includeUnplayed },
          {
            isCancelled: () => cancelled,
            onProgress: (loaded, total) => safeEnqueue("progress", { loaded, total }),
            onPartial: (rows) => {
              const now = Date.now();
              if (now - lastPartial >= PARTIAL_THROTTLE_MS) {
                lastPartial = now;
                safeEnqueue("partial", { games: rows });
              }
            },
          }
        );
        if (cancelled) return;

        // 3) 확정 결과 + 완료 요약.
        safeEnqueue("result", { games: result.rows });
        // 4) 미확인 알림(Phase 3) — 이번 스캔에서 감지한 완벽달성 해제/변경 + 이전 미확인.
        try {
          const alerts = getUnseenAlerts(steamId, 50);
          if (alerts.length > 0) safeEnqueue("alerts", { items: alerts });
        } catch (err) {
          console.warn("[achievements] alerts load failed:", err);
        }
        safeEnqueue("done", result.done);
      } catch (err) {
        if (cancelled) return;
        console.error("[achievements] scan error:", err);
        safeEnqueue("error", { message: "도전과제 스캔 중 오류가 발생했습니다." });
      } finally {
        if (!cancelled) {
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      }
    },
    cancel() {
      cancelled = true;
    },
  });

  return sseResponse(stream);
}
