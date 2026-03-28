/**
 * 사용자당 요청 Rate Limit.
 *
 * 기획서 7.1절: "사용자당 서비스 요청: 분당 30회"
 * 슬라이딩 윈도우 방식으로 IP 기반 제한.
 * 인메모리 카운터를 사용하며, 서버 재시작 시 초기화됨.
 *
 * 주의: x-forwarded-for 헤더를 신뢰한다.
 *       리버스 프록시(Nginx) 뒤에서 운영할 때만 IP가 정확하다.
 *       프록시 없이 직접 접근 시 헤더 조작으로 우회 가능.
 */

import { LRUCache } from "lru-cache";
import { RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX_REQUESTS } from "@/lib/constants";

/** 각 사용자의 요청 타임스탬프 기록 (LRU로 메모리 상한 관리) */
const requestLog = new LRUCache<string, number[]>({
  max: 5_000, // 최대 5,000명의 사용자 추적
  ttl: RATE_LIMIT_WINDOW_MS * 2, // 윈도우의 2배 후 자동 정리
});

/**
 * API Route에서 Rate Limit을 적용하는 헬퍼.
 * 제한 초과 시 429 응답을 반환하고, 통과 시 null을 반환한다.
 *
 * IP 추출 우선순위: x-forwarded-for (첫 번째 IP) > x-real-ip > "unknown"
 *
 * @param request 요청 객체 (headers.get 메서드가 필요)
 * @returns 429 Response 또는 null (통과)
 */
export function rateLimitResponse(
  request: { headers: { get(name: string): string | null }; nextUrl?: { pathname: string } }
): Response | null {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || request.headers.get("x-real-ip")
    || "unknown";
  const result = checkRateLimit(ip);
  if (!result.allowed) {
    return Response.json(
      { error: "요청이 너무 많습니다. 잠시 후 다시 시도해주세요." },
      {
        status: 429,
        headers: {
          "Retry-After": String(Math.ceil((result.retryAfterMs ?? 0) / 1000)),
        },
      }
    );
  }
  return null;
}

/**
 * 슬라이딩 윈도우 방식으로 요청 Rate Limit을 체크한다.
 *
 * 현재 윈도우(최근 1분) 내의 요청 수를 세어 MAX_REQUESTS와 비교한다.
 * 허용되면 현재 타임스탬프를 기록하고, 초과 시 재시도 대기 시간을 반환한다.
 *
 * @param identifier 사용자 식별자 (IP 또는 "ip:steamId" 조합)
 * @returns allowed=true + 남은 횟수, 또는 allowed=false + 재시도 대기 시간(ms)
 */
export function checkRateLimit(identifier: string): {
  allowed: boolean;
  retryAfterMs?: number;
  remaining?: number;
} {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;

  // 현재 윈도우 내의 요청 타임스탬프 가져오기
  let timestamps = requestLog.get(identifier) ?? [];

  // 윈도우 밖의 오래된 타임스탬프 제거
  timestamps = timestamps.filter((ts) => ts > windowStart);

  if (timestamps.length >= RATE_LIMIT_MAX_REQUESTS) {
    // 제한 초과: 가장 오래된 요청이 윈도우를 벗어나는 시점까지 대기
    const oldestInWindow = timestamps[0];
    const retryAfterMs = oldestInWindow + RATE_LIMIT_WINDOW_MS - now;
    return { allowed: false, retryAfterMs: Math.max(retryAfterMs, 0) };
  }

  // 요청 허용: 현재 타임스탬프 기록
  timestamps.push(now);
  requestLog.set(identifier, timestamps);

  return { allowed: true, remaining: RATE_LIMIT_MAX_REQUESTS - timestamps.length };
}
