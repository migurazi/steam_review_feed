/**
 * 아웃바운드(Steam API로 나가는) 동시성 세마포어 + 일일 콜 예산 가드.
 *
 * `lib/rate-limit.ts`는 **인바운드** IP 제한이라 우리 서버가 Steam으로 내보내는
 * 요청 수를 제어하지 못한다. 사용자 N명이 동시에 첫 스캔을 돌리면
 * N × ACHIEVEMENT_CONCURRENCY 동시 요청이 나가 429/일 한도 소진을 유발한다.
 * 이 모듈이 **프로세스 전역**으로 동시성 상한을 걸고, 일일 콜 수를 카운트한다.
 *
 * 작업 지시서 20260825_01 §5.8, M11.
 *
 * 단일 프로세스(standalone node server.js) 배포를 가정한 soft guard다 — 카운터는
 * 프로세스 재시작 시 리셋된다.
 */

import {
  ACHIEVEMENT_GLOBAL_CONCURRENCY,
  ACHIEVEMENT_DAILY_CALL_BUDGET,
} from "@/lib/constants";

/** 슬롯 대기 상한. 초과하면 해당 작업은 skip된다(전체 스캔은 실패시키지 않음). */
const DEFAULT_WAIT_TIMEOUT_MS = 60_000;

/** 일일 예산 윈도우. */
const BUDGET_WINDOW_MS = 24 * 60 * 60 * 1000;

/** 슬롯 대기 타임아웃 시 던지는 에러 — caller가 skip 분기에 사용. */
export class OutboundSlotTimeoutError extends Error {
  constructor() {
    super("아웃바운드 슬롯 대기 시간이 초과되었습니다.");
    this.name = "OutboundSlotTimeoutError";
  }
}

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// --- 모듈 전역 상태 ---
let active = 0;
const waiters: Waiter[] = [];
let waitTimeoutMs = DEFAULT_WAIT_TIMEOUT_MS;

// 일일 예산 카운터.
let callsInWindow = 0;
let windowStart = Date.now();

/** 24시간 경과 시 예산 윈도우를 굴린다. */
function rollWindowIfNeeded(): void {
  const now = Date.now();
  if (now - windowStart >= BUDGET_WINDOW_MS) {
    windowStart = now;
    callsInWindow = 0;
  }
}

/**
 * 슬롯을 획득한다. 여유가 있으면 즉시, 없으면 대기 큐에 넣고 슬롯이 나거나
 * 타임아웃될 때까지 기다린다.
 */
function acquire(): Promise<void> {
  if (active < ACHIEVEMENT_GLOBAL_CONCURRENCY) {
    active += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const waiter: Waiter = {
      resolve,
      reject,
      // setTimeout은 unref로 프로세스 종료를 막지 않게 한다(logThrottled 선례).
      timer: setTimeout(() => {
        const i = waiters.indexOf(waiter);
        if (i >= 0) waiters.splice(i, 1);
        reject(new OutboundSlotTimeoutError());
      }, waitTimeoutMs),
    };
    const t = waiter.timer as unknown as { unref?: () => void };
    if (typeof t.unref === "function") t.unref();
    waiters.push(waiter);
  });
}

/**
 * 슬롯을 반납한다. 대기자가 있으면 슬롯 소유권을 그대로 넘기고(active 유지),
 * 없으면 active를 줄인다.
 */
function release(): void {
  const next = waiters.shift();
  if (next) {
    clearTimeout(next.timer);
    next.resolve();
  } else {
    active -= 1;
  }
}

/**
 * 슬롯을 획득한 아웃바운드 시도 1건을 예산 카운터에 기록한다.
 *
 * fn 실행 '전'(슬롯 획득 직후)에 센다 — fn이 즉시 실패/취소돼도 카운트된다.
 * 이는 의도된 보수적 가드다: 예산의 목적은 "Steam 서버에 성공적으로 도달한
 * 요청 수"가 아니라 "우리가 내보내려 시도한(=한도를 소진할 수 있는) 요청 수"의
 * 상한이다. fn 내부에서 세면 cancel 타이밍에 따라 누락이 생겨 가드가 느슨해진다.
 */
function noteOutboundCall(): void {
  rollWindowIfNeeded();
  callsInWindow += 1;
}

/**
 * 슬롯을 획득해 fn을 실행하고, 성공·실패·취소와 무관하게 **반드시** 반납한다.
 *
 * 반납은 `finally`로 보장한다 — SSE `cancel()`로 스캔이 중단돼도 슬롯이 물린 채
 * 남지 않는다. 슬롯 획득 자체가 타임아웃되면(OutboundSlotTimeoutError) fn은 실행
 * 되지 않으며 반납할 슬롯도 없다(try 진입 전이므로 finally 미실행).
 *
 * @throws OutboundSlotTimeoutError 대기 상한 초과 시.
 */
export async function withOutboundSlot<T>(fn: () => Promise<T>): Promise<T> {
  await acquire();
  noteOutboundCall();
  try {
    return await fn();
  } finally {
    release();
  }
}

/**
 * 일일 콜 예산 초과 여부. 스캔 시작 전에 검사해 새 스캔을 거부하는 데 쓴다
 * (§5.8, done.budgetExceeded).
 *
 * @param limit 상한 (기본 ACHIEVEMENT_DAILY_CALL_BUDGET). 테스트에서 작은 값으로
 *   주입해 임계 동작을 검증할 수 있다.
 */
export function isDailyBudgetExceeded(
  limit: number = ACHIEVEMENT_DAILY_CALL_BUDGET
): boolean {
  rollWindowIfNeeded();
  return callsInWindow >= limit;
}

/** 현재 윈도우의 누적 콜 수 (관측/테스트용). */
export function getDailyCallCount(): number {
  rollWindowIfNeeded();
  return callsInWindow;
}

/**
 * 테스트 전용 — 전역 상태를 초기화한다. 운영 코드에서 호출 금지.
 * (resetLogThrottle / resetAppDetailsBackoff 선례.)
 *
 * @param config.waitTimeoutMs 슬롯 대기 타임아웃 재설정(테스트에서 짧게).
 */
export function resetOutboundLimitForTest(config?: {
  waitTimeoutMs?: number;
}): void {
  // 대기 중인 타이머 정리 후 큐 비우기.
  for (const w of waiters) clearTimeout(w.timer);
  waiters.length = 0;
  active = 0;
  callsInWindow = 0;
  windowStart = Date.now();
  waitTimeoutMs = config?.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
}
