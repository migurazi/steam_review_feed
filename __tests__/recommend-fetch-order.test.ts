/**
 * /recommend 메타 조회 순서 단위 테스트 (lib/recommend-fetch-order.ts).
 *
 * 회귀 배경: 위시리스트가 수천 개이고 미캐시면 "시드 + 위시 전체 → 후보" 순서에서 라이브러리
 * 트랙이 1시간 넘게 비었다. 캐시분 먼저, 미캐시는 후보 먼저 → 나머지·위시 번갈아.
 */

import { describe, it, expect } from "vitest";
import { orderMetaFetch } from "@/lib/recommend-fetch-order";

describe("orderMetaFetch", () => {
  const base = {
    seedIds: [1, 2],
    candidateIds: [10, 11, 12],
    wishlistIds: [20, 21, 22, 23],
    restIds: [30, 31],
  };

  it("phase A = 시드 전부 + 캐시된 후보·위시·나머지, phase B = 미캐시 후보 → 나머지·위시 번갈아", () => {
    const { phaseA, phaseB } = orderMetaFetch({ ...base, cachedIds: new Set([11, 21, 30]) });
    expect(phaseA).toEqual([1, 2, 11, 21, 30]);
    expect(phaseB).toEqual([10, 12, 31, 20, 22, 23]);
  });

  it("시드는 캐시 여부와 무관하게 phase A 맨 앞", () => {
    const { phaseA } = orderMetaFetch({ ...base, cachedIds: new Set() });
    expect(phaseA).toEqual([1, 2]);
  });

  it("거대한 미캐시 위시리스트가 미캐시 후보보다 앞서지 않는다 (회귀)", () => {
    const wishlistIds = Array.from({ length: 3000 }, (_, i) => 100000 + i);
    const { phaseA, phaseB } = orderMetaFetch({ ...base, wishlistIds, cachedIds: new Set([10, 11]) });
    expect(phaseA).toEqual([1, 2, 10, 11]);
    expect(phaseB[0]).toBe(12);
  });

  it("여러 목록에 있는 appid(소유한 위시 게임 등)는 처음 자리만", () => {
    const { phaseA, phaseB } = orderMetaFetch({
      seedIds: [1],
      candidateIds: [10, 20],
      wishlistIds: [20, 1, 21],
      restIds: [30],
      cachedIds: new Set([20]),
    });
    const all = [...phaseA, ...phaseB];
    expect(new Set(all).size).toBe(all.length);
    expect(phaseA).toEqual([1, 20]);
    expect(phaseB).toEqual([10, 30, 21]);
  });

  it("전부 캐시면 phase B가 비고, 위시 트랙 off(빈 위시)도 동작", () => {
    const { phaseA, phaseB } = orderMetaFetch({
      ...base, wishlistIds: [], cachedIds: new Set([10, 11, 12, 30, 31]),
    });
    expect(phaseA).toEqual([1, 2, 10, 11, 12, 30, 31]);
    expect(phaseB).toEqual([]);
  });
});
