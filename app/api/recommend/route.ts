/**
 * 성향 분석 + 추천 SSE 엔드포인트.
 * GET /api/recommend?cardMin=180&unplayedMax=60&excludeFree=false&topN=6&max=12&tracks=lib,wish
 *
 * 작업 지시서 3.3절 구현. 두 트랙 추천을 모두 반환:
 *   - 트랙 A (library-unplayed): classify가 'unplayed'로 분류한 라이브러리 게임
 *   - 트랙 B (wishlist):         위시리스트 중 성향 매칭 게임
 *
 * SSE 이벤트 시퀀스:
 *   progress { phase: "fetching-meta", loaded, total }   (반복)
 *   progress { phase: "analyzing",     loaded, total }   (1회)
 *   result   { profile, libraryUnplayed, wishlist }      (1회)
 *   done     { ownedGames, wishlistGames, cacheHitRate,
 *              wishlistFetchFailed, analysisInsufficient } (1회)
 *
 * 취소 패턴은 `app/api/reviews/stream/route.ts:116-138, 228-264` 와 동일:
 *   cancelled 플래그 + ReadableStream cancel() 콜백. 배치 시작 전 isCancelled
 *   체크. delay는 abortable이 아니지만 1초 단위로 짧다.
 */

import { NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getOwnedGames, getWishlist, getAppDetailsBatch } from "@/lib/steam/api";
import { rateLimitResponse } from "@/lib/rate-limit";
import { logEvent } from "@/lib/logger";
import {
  analyzeTaste,
  recommendLibraryUnplayed,
  recommendFromWishlist,
  buildOwnedAnalyzedGame,
  buildWishlistAnalyzedGame,
  validateAnalyzeOptions,
  DEFAULT_ANALYZE_OPTIONS,
  type AnalyzeOptions,
} from "@/lib/steam/profile";

export const dynamic = "force-dynamic";

const encoder = new TextEncoder();
function sseEvent(event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * 쿼리 파라미터 파싱 + 검증.
 * 잘못된 값은 throw → 호출 측에서 400 반환.
 */
function parseOptions(params: URLSearchParams): {
  options: AnalyzeOptions;
  tracks: { lib: boolean; wish: boolean };
} {
  const num = (key: string, fallback: number, min: number, max: number): number => {
    const raw = params.get(key);
    if (raw === null) return fallback;
    const n = parseInt(raw, 10);
    if (Number.isNaN(n) || n < min || n > max) {
      throw new Error(`Invalid ${key}: ${raw} (expected integer in [${min}, ${max}])`);
    }
    return n;
  };

  const options: AnalyzeOptions = {
    cardFarmingMaxMinutes: num("cardMin", DEFAULT_ANALYZE_OPTIONS.cardFarmingMaxMinutes, 0, 1440),
    unplayedMaxMinutes: num("unplayedMax", DEFAULT_ANALYZE_OPTIONS.unplayedMaxMinutes, 0, 600),
    excludeFree: params.get("excludeFree") === "true",
    topNTaste: num("topN", DEFAULT_ANALYZE_OPTIONS.topNTaste, 1, 12),
    maxRecommendationsPerTrack: num("max", DEFAULT_ANALYZE_OPTIONS.maxRecommendationsPerTrack, 1, 30),
  };
  validateAnalyzeOptions(options);

  const tracksParam = params.get("tracks") ?? "lib,wish";
  const tracksList = tracksParam.split(",").map(s => s.trim()).filter(Boolean);
  const allowed = new Set(["lib", "wish"]);
  for (const t of tracksList) {
    if (!allowed.has(t)) {
      throw new Error(`Invalid tracks: "${t}" (allowed: lib, wish)`);
    }
  }
  if (tracksList.length === 0) {
    throw new Error(`Invalid tracks: must contain at least one of "lib", "wish"`);
  }
  return {
    options,
    tracks: { lib: tracksList.includes("lib"), wish: tracksList.includes("wish") },
  };
}

export async function GET(request: NextRequest) {
  const limited = rateLimitResponse(request);
  if (limited) return limited;

  const session = await getSession();
  if (!session.steamId) {
    return new Response("Unauthorized", { status: 401 });
  }

  let parsed: ReturnType<typeof parseOptions>;
  try {
    parsed = parseOptions(request.nextUrl.searchParams);
  } catch (err) {
    return new Response((err as Error).message, { status: 400 });
  }

  logEvent("recommend_analyze", {
    steamId: session.steamId,
    options: parsed.options,
    tracks: parsed.tracks,
  });

  let cancelled = false;
  const stream = new ReadableStream({
    async start(controller) {
      try {
        await runAnalysis(controller, session.steamId!, parsed.options, parsed.tracks, () => cancelled);
      } catch (err) {
        if (cancelled) return;
        console.error("[recommend] Analysis error:", err);
        try {
          controller.enqueue(sseEvent("error", { message: "분석 중 오류가 발생했습니다." }));
        } catch { /* controller already closed */ }
      } finally {
        if (!cancelled) {
          try { controller.close(); } catch { /* already closed */ }
        }
      }
    },
    cancel() { cancelled = true; },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

/**
 * 분석 메인 로직.
 *
 * 1) 라이브러리 + 위시리스트 동시 fetch (라이브러리 실패 시 종료)
 * 2) 유니크 appid 합집합에 대해 getAppDetailsBatch (캐시 우선, 진행률 SSE)
 * 3) 라이브러리는 분석, 두 트랙 모두 추천 산출
 * 4) result + done 이벤트 전송
 */
async function runAnalysis(
  controller: ReadableStreamDefaultController,
  steamId: string,
  options: AnalyzeOptions,
  tracks: { lib: boolean; wish: boolean },
  isCancelled: () => boolean,
) {
  // 1. 라이브러리/위시리스트 fetch (병렬)
  const [ownedRes, wishlistRes] = await Promise.all([
    getOwnedGames(steamId),
    getWishlist(steamId),
  ]);

  if (isCancelled()) return;

  if (!ownedRes) {
    // 라이브러리 조회 실패 → 분석 자체가 불가. result 없이 done에 플래그로 알린다.
    // EventSource는 named "error" 이벤트의 data를 일반 핸들러로 받지만,
    // 클라이언트가 명확히 분기하려면 done 플래그가 더 안정적이다.
    controller.enqueue(sseEvent("done", {
      ownedGames: 0,
      wishlistGames: 0,
      cacheHitRate: 0,
      wishlistFetchFailed: false,
      analysisInsufficient: false,
      libraryFetchFailed: true,
    }));
    return;
  }

  const owned = ownedRes.data;
  const wishlistFetchFailed = wishlistRes === null;
  const wishlist = wishlistRes?.data ?? [];

  // 2. 메타 일괄 조회 (라이브러리 ∪ 위시리스트 유니크 appid)
  const uniqueIds = Array.from(new Set([...owned.map(g => g.appid), ...wishlist.map(w => w.appid)]));
  const total = uniqueIds.length;

  controller.enqueue(sseEvent("progress", { phase: "fetching-meta", loaded: 0, total }));

  // 캐시 히트 통계: getAppDetailsBatch가 한 게임 끝낼 때마다 onProgress 호출.
  // 캐시 히트율을 측정하려면 캐시 인스턴스 노출이 필요한데 1차 범위에선 생략.
  // done 이벤트의 cacheHitRate는 0(미측정)으로 둔다.
  const detailsMap = await getAppDetailsBatch(
    uniqueIds,
    (loaded, t) => {
      // 매 게임마다 progress 보내면 SSE 트래픽이 많음. 5게임마다 또는 마지막에만 전송.
      if (loaded % 5 === 0 || loaded === t) {
        try {
          controller.enqueue(sseEvent("progress", { phase: "fetching-meta", loaded, total: t }));
        } catch { /* closed */ }
      }
    },
    isCancelled,
  );

  if (isCancelled()) return;

  // 3. 분석 입력 결합
  controller.enqueue(sseEvent("progress", { phase: "analyzing", loaded: total, total }));

  const analyzedOwned = owned.map(g => buildOwnedAnalyzedGame(g, detailsMap.get(g.appid) ?? null));
  const analyzedWishlist = wishlist.map(w => buildWishlistAnalyzedGame(w, detailsMap.get(w.appid) ?? null));

  const profile = analyzeTaste(analyzedOwned, options);
  const libraryUnplayed = tracks.lib ? recommendLibraryUnplayed(analyzedOwned, profile, options) : [];
  const wishlistRecs = tracks.wish ? recommendFromWishlist(analyzedWishlist, profile, options) : [];

  if (isCancelled()) return;

  // 4. result + done
  controller.enqueue(sseEvent("result", {
    profile,
    libraryUnplayed,
    wishlist: wishlistRecs,
  }));

  // analysisInsufficient: 작업 지시서 R5b — 분석에 기여한 게임이 0.
  // 메타 누락이 많아 분석 풀은 있지만 신호가 없는 케이스는 별도 플래그(metaMissingDominant).
  const analysisInsufficient = profile.analyzedGames === 0;
  const metaMissingDominant = profile.analyzedGames > 0
    && profile.genres.length === 0
    && profile.categories.length === 0;

  controller.enqueue(sseEvent("done", {
    ownedGames: owned.length,
    wishlistGames: wishlist.length,
    cacheHitRate: 0,
    wishlistFetchFailed,
    analysisInsufficient,
    metaMissingDominant,
    libraryFetchFailed: false,
  }));
}
