/**
 * lib/rate-limit.ts 단위 테스트.
 * 분당 30회 제한, 슬라이딩 윈도우 동작을 검증한다.
 */

import { describe, it, expect } from "vitest";
import { checkRateLimit } from "@/lib/rate-limit";

describe("rate-limit", () => {
  // 각 테스트에서 고유한 identifier를 사용하여 간섭 방지
  const uniqueId = () => `test-user-${Date.now()}-${Math.random()}`;

  it("첫 요청은 허용된다", () => {
    const result = checkRateLimit(uniqueId());
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(29);
  });

  it("30회까지 허용, 31회째 거부된다", () => {
    const id = uniqueId();

    // 30회 요청
    for (let i = 0; i < 30; i++) {
      const result = checkRateLimit(id);
      expect(result.allowed).toBe(true);
    }

    // 31회째는 거부
    const denied = checkRateLimit(id);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThanOrEqual(0);
  });

  it("다른 사용자는 서로 영향을 주지 않는다", () => {
    const id1 = uniqueId();
    const id2 = uniqueId();

    // id1에 30회 사용
    for (let i = 0; i < 30; i++) {
      checkRateLimit(id1);
    }

    // id2는 여전히 허용
    const result = checkRateLimit(id2);
    expect(result.allowed).toBe(true);
  });
});
