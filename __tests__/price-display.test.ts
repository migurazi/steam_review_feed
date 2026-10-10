/**
 * 가격·시각 표시 공용 헬퍼 단위 테스트 (lib/price-display.ts, /code-review 2차 R8).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { isPriceStale, formatRelativeTime, formatPriceAge } from "@/lib/price-display";
import { PRICE_STALE_MS } from "@/lib/constants";

const NOW = new Date("2026-10-10T12:00:00+09:00").getTime();

describe("price-display", () => {
  afterEach(() => vi.useRealTimers());

  it("isPriceStale: PRICE_STALE_MS 초과만 true, 시각 미상은 false", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    expect(isPriceStale(NOW - PRICE_STALE_MS - 1)).toBe(true);
    expect(isPriceStale(NOW - PRICE_STALE_MS)).toBe(false);
    expect(isPriceStale(NOW)).toBe(false);
    expect(isPriceStale(undefined)).toBe(false);
    expect(isPriceStale(null)).toBe(false);
  });

  it("formatRelativeTime: 분·시간·일·절대 날짜", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    expect(formatRelativeTime(NOW - 30 * 1000)).toBe("방금 전");
    expect(formatRelativeTime(NOW - 5 * 60 * 1000)).toBe("5분 전");
    expect(formatRelativeTime(NOW - 3 * 60 * 60 * 1000)).toBe("3시간 전");
    expect(formatRelativeTime(NOW - 2 * 24 * 60 * 60 * 1000)).toBe("2일 전");
    expect(formatRelativeTime(NOW - 10 * 24 * 60 * 60 * 1000)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("formatPriceAge: 'N시간 전 가격', 시각 미상이면 undefined", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    expect(formatPriceAge(NOW - 2 * 60 * 60 * 1000)).toBe("2시간 전 가격");
    expect(formatPriceAge(undefined)).toBeUndefined();
    expect(formatPriceAge(null)).toBeUndefined();
  });
});
