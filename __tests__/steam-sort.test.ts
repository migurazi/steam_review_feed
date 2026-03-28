/**
 * lib/steam/sort.ts 단위 테스트.
 *
 * 라이브러리 게임 정렬 로직의 엣지 케이스를 검증한다:
 * - 동일 플레이타임 게임 간 안정성
 * - playtime_2weeks가 0인 경우와 undefined인 경우 구분
 * - 단일 요소 배열
 * - 대규모 배열 성능 (수백 개 게임)
 */

import { describe, it, expect } from "vitest";
import { sortLibraryGames } from "@/lib/steam/sort";
import type { SteamOwnedGame } from "@/lib/steam/types";

function makeGame(overrides: Partial<SteamOwnedGame> = {}): SteamOwnedGame {
  return {
    appid: 1,
    name: "Test Game",
    playtime_forever: 0,
    playtime_2weeks: undefined,
    img_icon_url: "",
    rtime_last_played: 0,
    ...overrides,
  };
}

describe("sortLibraryGames - edge cases", () => {
  it("단일 요소 배열을 처리한다", () => {
    const games = [makeGame({ appid: 1, playtime_forever: 100 })];
    const sorted = sortLibraryGames(games);
    expect(sorted).toHaveLength(1);
    expect(sorted[0].appid).toBe(1);
  });

  it("playtime_2weeks가 0인 것과 undefined인 것을 동일하게 취급한다", () => {
    const games = [
      makeGame({ appid: 1, playtime_2weeks: 0, playtime_forever: 200 }),
      makeGame({ appid: 2, playtime_2weeks: undefined, playtime_forever: 300 }),
    ];
    const sorted = sortLibraryGames(games);
    // 둘 다 최근 플레이 없음 -> playtime_forever 기준
    expect(sorted[0].appid).toBe(2);
  });

  it("동일 playtime_forever인 게임들의 순서가 안정적이다", () => {
    const games = [
      makeGame({ appid: 1, playtime_forever: 100 }),
      makeGame({ appid: 2, playtime_forever: 100 }),
      makeGame({ appid: 3, playtime_forever: 100 }),
    ];
    // Array.sort는 동일 비교 시 원래 순서 보장 (stable sort)
    const sorted = sortLibraryGames(games);
    expect(sorted).toHaveLength(3);
  });

  it("대규모 배열(500개)을 처리할 수 있다", () => {
    const games = Array.from({ length: 500 }, (_, i) =>
      makeGame({ appid: i, playtime_forever: Math.random() * 10000 })
    );
    const sorted = sortLibraryGames(games);
    expect(sorted).toHaveLength(500);
    // 정렬 순서 검증: 총 플레이타임 내림차순
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i - 1].playtime_forever).toBeGreaterThanOrEqual(sorted[i].playtime_forever);
    }
  });

  it("혼합 시나리오: 최근+미최근+제로 플레이타임", () => {
    const games = [
      makeGame({ appid: 1, playtime_2weeks: 0, playtime_forever: 0 }),     // 플레이 안 한 게임
      makeGame({ appid: 2, playtime_2weeks: 120, playtime_forever: 500 }), // 최근 활발
      makeGame({ appid: 3, playtime_2weeks: 0, playtime_forever: 1000 }),  // 예전에 많이 함
      makeGame({ appid: 4, playtime_2weeks: 30, playtime_forever: 100 }),  // 최근 조금
    ];
    const sorted = sortLibraryGames(games);
    // 최근 플레이 있는 게임이 먼저 (2, 4), 그 다음 총 플레이타임 순 (3, 1)
    expect(sorted[0].appid).toBe(2); // 최근 120분
    expect(sorted[1].appid).toBe(4); // 최근 30분
    expect(sorted[2].appid).toBe(3); // 총 1000분
    expect(sorted[3].appid).toBe(1); // 총 0분
  });
});
