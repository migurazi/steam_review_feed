/**
 * ITAD 최신 번들 목록 API — 번들 차트 메이커(/bundle)의 입력 ① (작업 지시서 20261012_01 단계 2).
 *
 * GET /api/bundle/itad/list?country=US&limit=20&offset=0&expired=false
 *   → 200 { configured: boolean, bundles: ItadListItem[] }
 *
 * 설계:
 *   - 페이지 로드 시 자동 호출되는 GET이라, ITAD 키 미설정(configured:false)도 **에러가 아니라**
 *     200 + 빈 목록으로 응답한다(M5). UI가 발급 안내만 띄운다.
 *   - ITAD 외부 호출 라우트라 전역 rate limit(rateLimitResponse)에 더해 itad:{ip} 식별자로 추가
 *     rate limit을 적용한다(C6 — 외부 호출 남용 방어).
 *   - 응답은 경량 ItadListItem으로 매핑(전체 tiers/games는 resolve 때 가져온다).
 */

import { NextRequest, NextResponse } from "next/server";
import { rateLimitResponse, checkRateLimit } from "@/lib/rate-limit";
import { itadConfigured, getRecentBundles } from "@/lib/itad/client";
import type { ItadBundle } from "@/lib/itad/types";

export const dynamic = "force-dynamic";

/** 목록 응답의 경량 번들 항목. 상세(tiers·games)는 resolve에서 가져온다. */
interface ItadListItem {
  id: number;
  title: string;
  shop?: string;
  url?: string;
  expires?: string;
  /** 고유 게임 수(티어 간 중복 제거) 또는 counts.games. */
  gameCount: number;
  /** 각 티어의 가격. */
  tierPrices: { amount: number; currency: string }[];
}

/** rate-limit.ts와 동일한 우선순위로 클라이언트 IP를 추출한다. */
function clientIp(request: NextRequest): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

/** ItadBundle → 경량 ItadListItem. gameCount는 티어 간 고유 UUID 수, 없으면 counts.games. */
function toListItem(bundle: ItadBundle): ItadListItem {
  const uuids = new Set<string>();
  for (const tier of bundle.tiers) {
    for (const g of tier.games) uuids.add(g.id);
  }
  const gameCount = uuids.size > 0 ? uuids.size : bundle.counts?.games ?? 0;
  // price가 null인 티어(Fanatical "Build Your Own" 등 품목당 가격)는 고정가가 없으므로 제외한다.
  const tierPrices = bundle.tiers
    .map((t) => t.price)
    .filter((p): p is { amount: number; currency: string } => p !== null)
    .map((p) => ({ amount: p.amount, currency: p.currency }));
  return {
    id: bundle.id,
    title: bundle.title,
    // 실측 필드명: page.name (이전 예시의 shop.name 아님).
    shop: bundle.page?.name,
    url: bundle.url,
    // 실측 필드명: expiry (이전 예시의 expires 아님).
    expires: bundle.expiry,
    gameCount,
    tierPrices,
  };
}

export async function GET(request: NextRequest) {
  const limited = rateLimitResponse(request);
  if (limited) return limited;

  // ITAD 외부 호출 라우트 추가 rate limit.
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

  // 미설정은 에러가 아니라 빈 목록(페이지 로드용 GET — M5).
  if (!itadConfigured()) {
    return NextResponse.json({ configured: false, bundles: [] });
  }

  const sp = request.nextUrl.searchParams;
  const country = (sp.get("country") || "US").trim() || "US";

  // limit: 정수 1~50 클램프.
  let limit = 20;
  const limitRaw = sp.get("limit");
  if (limitRaw !== null) {
    const n = parseInt(limitRaw, 10);
    if (Number.isInteger(n)) limit = Math.min(Math.max(n, 1), 50);
  }

  // offset: 정수 ≥0.
  let offset = 0;
  const offsetRaw = sp.get("offset");
  if (offsetRaw !== null) {
    const n = parseInt(offsetRaw, 10);
    if (Number.isInteger(n) && n > 0) offset = n;
  }

  // expired: "true"/"1"만 참.
  const expiredRaw = sp.get("expired");
  const expired = expiredRaw === "true" || expiredRaw === "1";

  const bundles = await getRecentBundles({ country, limit, offset, expired });
  return NextResponse.json({
    configured: true,
    bundles: bundles.map(toListItem),
  });
}
