/**
 * 사용자당 요청 Rate Limit.
 *
 * 기획서 7.1절: "사용자당 서비스 요청: 분당 30회"
 * 슬라이딩 윈도우 방식으로 IP 기반 제한.
 * 인메모리 카운터를 사용하며, 서버 재시작 시 초기화됨.
 */

import { LRUCache } from "lru-cache";

/** Rate limit 설정 */
const WINDOW_MS = 60 * 1000; // 1분
const MAX_REQUESTS = 30; // 분당 최대 요청 수

/** 각 사용자의 요청 타임스탬프 기록 */
const requestLog = new LRUCache<string, number[]>({
  max: 5_000, // 최대 5,000명의 사용자 추적
  ttl: WINDOW_MS * 2, // 윈도우의 2배 후 자동 정리
});

/**
 * 요청 Rate Limit을 체크한다.
 *
 * @param identifier 사용자 식별자 (IP 또는 "ip:steamId" 조합)
 * @returns { allowed: true } 또는 { allowed: false, retryAfterMs }
 */
/**
 * API Route에서 Rate Limit을 적용하는 헬퍼.
 * 제한 초과 시 429 응답을 반환하고, 통과 시 null을 반환한다.
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

export function checkRateLimit(identifier: string): {
  allowed: boolean;
  retryAfterMs?: number;
  remaining?: number;
} {
  const now = Date.now();
  const windowStart = now - WINDOW_MS;

  // 현재 윈도우 내의 요청 타임스탬프 가져오기
  let timestamps = requestLog.get(identifier) ?? [];

  // 윈도우 밖의 오래된 타임스탬프 제거
  timestamps = timestamps.filter((ts) => ts > windowStart);

  if (timestamps.length >= MAX_REQUESTS) {
    // 제한 초과: 가장 오래된 요청이 윈도우를 벗어나는 시점까지 대기
    const oldestInWindow = timestamps[0];
    const retryAfterMs = oldestInWindow + WINDOW_MS - now;
    return { allowed: false, retryAfterMs: Math.max(retryAfterMs, 0) };
  }

  // 요청 허용: 현재 타임스탬프 기록
  timestamps.push(now);
  requestLog.set(identifier, timestamps);

  return { allowed: true, remaining: MAX_REQUESTS - timestamps.length };
}
