/**
 * lib/outbound-limit.ts 단위 테스트.
 *
 * 검증:
 *   - 동시 실행이 ACHIEVEMENT_GLOBAL_CONCURRENCY를 넘지 않는다
 *   - fn이 예외를 던져도 슬롯이 반납된다(finally) — 대기자가 이어받는다
 *   - 슬롯 대기 타임아웃 시 OutboundSlotTimeoutError로 거부된다
 *   - 일일 예산 카운터가 콜마다 증가하고 임계에서 초과 판정된다
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  withOutboundSlot,
  isDailyBudgetExceeded,
  getDailyCallCount,
  resetOutboundLimitForTest,
  OutboundSlotTimeoutError,
} from "@/lib/outbound-limit";
import { ACHIEVEMENT_GLOBAL_CONCURRENCY } from "@/lib/constants";

/** 외부에서 resolve할 수 있는 지연 프라미스. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** 대기 중인 마이크로태스크를 모두 흘려보낸다. */
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  resetOutboundLimitForTest();
});

describe("outbound-limit 세마포어", () => {
  it("동시 실행이 상한을 넘지 않는다", async () => {
    let running = 0;
    let maxRunning = 0;
    const gate = deferred();

    const tasks = Array.from({ length: ACHIEVEMENT_GLOBAL_CONCURRENCY + 12 }, () =>
      withOutboundSlot(async () => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await gate.promise;
        running -= 1;
      })
    );

    await flush(); // 즉시 획득 가능한 슬롯만큼만 body 진입
    expect(maxRunning).toBe(ACHIEVEMENT_GLOBAL_CONCURRENCY);

    gate.resolve();
    await Promise.all(tasks);
    expect(maxRunning).toBe(ACHIEVEMENT_GLOBAL_CONCURRENCY);
  });

  it("fn이 예외를 던져도 슬롯을 반납한다 — 대기자가 이어받는다", async () => {
    resetOutboundLimitForTest({ waitTimeoutMs: 1000 });
    const gate = deferred();

    // 상한만큼 슬롯을 점유하고 모두 예외로 종료.
    const failing = Array.from({ length: ACHIEVEMENT_GLOBAL_CONCURRENCY }, () =>
      withOutboundSlot(async () => {
        await gate.promise;
        throw new Error("boom");
      }).catch((e: Error) => e.message)
    );

    // 대기 큐에 걸리는 추가 작업.
    let ninthRan = false;
    const queued = withOutboundSlot(async () => {
      ninthRan = true;
      return "ok";
    });

    await flush();
    expect(ninthRan).toBe(false); // 슬롯이 없어 대기 중

    gate.resolve(); // 점유 8건이 예외로 종료 → finally 반납 → 대기자 진입
    expect(await Promise.all(failing)).toEqual(
      Array(ACHIEVEMENT_GLOBAL_CONCURRENCY).fill("boom")
    );
    await expect(queued).resolves.toBe("ok");
    expect(ninthRan).toBe(true);
  });

  it("슬롯 대기 타임아웃 시 OutboundSlotTimeoutError로 거부", async () => {
    resetOutboundLimitForTest({ waitTimeoutMs: 30 });
    const gate = deferred();

    // 상한만큼 슬롯을 오래 점유.
    const holders = Array.from({ length: ACHIEVEMENT_GLOBAL_CONCURRENCY }, () =>
      withOutboundSlot(() => gate.promise)
    );
    await flush();

    // 추가 작업은 슬롯을 못 얻고 30ms 후 타임아웃.
    await expect(withOutboundSlot(async () => 1)).rejects.toBeInstanceOf(
      OutboundSlotTimeoutError
    );

    gate.resolve();
    await Promise.all(holders);
  });
});

describe("outbound-limit 일일 예산", () => {
  it("콜마다 카운터가 증가하고 임계에서 초과 판정", async () => {
    expect(getDailyCallCount()).toBe(0);
    expect(isDailyBudgetExceeded(1)).toBe(false); // 0 >= 1 아님

    await withOutboundSlot(async () => 1);
    await withOutboundSlot(async () => 1);

    expect(getDailyCallCount()).toBe(2);
    expect(isDailyBudgetExceeded(2)).toBe(true); // 2 >= 2
    expect(isDailyBudgetExceeded(3)).toBe(false); // 2 >= 3 아님
  });
});
