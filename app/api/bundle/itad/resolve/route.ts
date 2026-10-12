/**
 * ITAD 번들 → 차트 변환 API — 번들 차트 메이커(/bundle)의 입력 ①·② (작업 지시서 20261012_01 단계 2).
 *
 * POST /api/bundle/itad/resolve   body: { bundleId: number }
 *   → 200 { chart, unmatched }
 *
 * 설계:
 *   - 사용자가 명시적으로 번들을 선택/붙여넣는 액션이므로, ITAD 키 미설정은 503(명시 액션 — M5).
 *   - findBundle은 by-id 엔드포인트 부재로 목록을 스캔하는 비싼 호출이라 전역 rate limit에 더해
 *     itad:{ip} 추가 rate limit을 적용한다(C6).
 *   - 못 찾으면 404 + 대체 수단 안내(목록 선택·수동 입력).
 */

import { NextRequest, NextResponse } from "next/server";
import { rateLimitResponse, checkRateLimit } from "@/lib/rate-limit";
import { itadConfigured, findBundle } from "@/lib/itad/client";
import { itadBundleToChart } from "@/lib/itad/chart";

export const dynamic = "force-dynamic";

/** rate-limit.ts와 동일한 우선순위로 클라이언트 IP를 추출한다. */
function clientIp(request: NextRequest): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

export async function POST(request: NextRequest) {
  const limited = rateLimitResponse(request);
  if (limited) return limited;

  // ITAD 스캔 호출 라우트 추가 rate limit.
  const itadLimit = checkRateLimit(`itad:${clientIp(request)}`);
  if (!itadLimit.allowed) {
    return NextResponse.json(
      { error: "요청이 너무 많습니다. 잠시 후 다시 시도해주세요." },
      {
        status: 429,
        headers: {
          "Retry-After": String(Math.ceil((itadLimit.retryAfterMs ?? 0) / 1000)),
        },
      }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청입니다." }, { status: 400 });
  }

  const bundleIdRaw = (body as { bundleId?: unknown })?.bundleId;
  if (
    typeof bundleIdRaw !== "number" ||
    !Number.isInteger(bundleIdRaw) ||
    bundleIdRaw <= 0
  ) {
    return NextResponse.json(
      { error: "bundleId는 양의 정수여야 합니다." },
      { status: 400 }
    );
  }
  const bundleId = bundleIdRaw;

  // 명시 액션이라 미설정은 503.
  if (!itadConfigured()) {
    return NextResponse.json(
      { error: "ITAD API 키가 설정되지 않았습니다. /setup에서 키를 등록하세요." },
      { status: 503 }
    );
  }

  const bundle = await findBundle(bundleId);
  if (!bundle) {
    return NextResponse.json(
      {
        error:
          "최근 번들에서 찾지 못했습니다(오래됐거나 ITAD 미수록). 목록에서 선택하거나 수동 입력하세요.",
      },
      { status: 404 }
    );
  }

  const { chart, unmatched } = await itadBundleToChart(bundle);
  return NextResponse.json({ chart, unmatched });
}
