/**
 * lib/steam/api.ts의 logThrottled 동작 회귀 방지.
 *
 * 검증 사항:
 *   1. 첫 호출은 즉시 console emit (carrier).
 *   2. 5초 윈도우 내 같은 key의 추가 호출은 carrier 후 console emit 없이 누적.
 *   3. 윈도우 만료 시 단일 요약 line emit ("N건 추가 발생").
 *   4. 추가 호출이 carrier 한 번뿐(=count 1)이면 요약 line 생략.
 *   5. 다른 key는 독립 bucket — 한 key의 throttle이 다른 key를 막지 않음.
 *   6. resetLogThrottle 후 같은 key는 다시 carrier로 시작.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { logThrottled, resetLogThrottle } from "@/lib/steam/api";

describe("logThrottled", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetLogThrottle();
    vi.useFakeTimers();
    // console 출력은 spy로 가로채 카운트 검증. 실제 stdout으로 흐르지 않도록
    // mockImplementation(() => {}).
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    vi.useRealTimers();
    resetLogThrottle();
  });

  it("첫 호출은 carrier로 즉시 emit (warn)", () => {
    logThrottled("status:429", "warn", "first 429");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith("first 429");
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("첫 호출은 carrier로 즉시 emit (error)", () => {
    logThrottled("status:403", "error", "first 403");
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith("first 403");
  });

  it("같은 key의 두 번째 이후 호출은 console emit 없이 누적", () => {
    logThrottled("status:429", "warn", "first");
    logThrottled("status:429", "warn", "second");
    logThrottled("status:429", "warn", "third");
    // carrier 1회만 emit
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith("first");
  });

  it("5초 경과 시 'N건 추가 발생' 요약 line emit", () => {
    logThrottled("status:429", "warn", "first");
    logThrottled("status:429", "warn", "x");
    logThrottled("status:429", "warn", "x");
    logThrottled("status:429", "warn", "x"); // 총 4건, 추가 3건

    // 윈도우 만료
    vi.advanceTimersByTime(5000);

    // carrier 1 + summary 1 = 2회 warn
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy.mock.calls[1][0]).toMatch(/status:429 — 3건 추가 발생/);
  });

  it("carrier 한 번만 발생하면 요약 line skip", () => {
    logThrottled("status:429", "warn", "lonely");
    vi.advanceTimersByTime(5000);
    expect(warnSpy).toHaveBeenCalledTimes(1); // carrier만
  });

  it("다른 key는 독립 bucket — 동시 carrier 가능", () => {
    logThrottled("status:429", "warn", "rate limit");
    logThrottled("content-type", "error", "html response");
    logThrottled("fetch-failure", "error", "network down");

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(2);
  });

  it("resetLogThrottle 후 같은 key는 다시 carrier로 시작", () => {
    logThrottled("status:429", "warn", "first");
    logThrottled("status:429", "warn", "x");
    // 누적 상태
    resetLogThrottle();
    // reset 후 첫 호출은 다시 carrier
    logThrottled("status:429", "warn", "after reset");
    // carrier 2회 (reset 전 + reset 후)
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy.mock.calls[0][0]).toBe("first");
    expect(warnSpy.mock.calls[1][0]).toBe("after reset");
  });

  it("윈도우 만료 후 같은 key는 다시 carrier로 시작", () => {
    logThrottled("status:429", "warn", "burst-a-first");
    logThrottled("status:429", "warn", "x");
    vi.advanceTimersByTime(5000); // 윈도우 종료, summary emit
    expect(warnSpy).toHaveBeenCalledTimes(2);

    logThrottled("status:429", "warn", "burst-b-first");
    // 새 carrier
    expect(warnSpy).toHaveBeenCalledTimes(3);
    expect(warnSpy.mock.calls[2][0]).toBe("burst-b-first");
  });
});
