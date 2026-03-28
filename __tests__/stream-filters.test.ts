/**
 * 리뷰 스트리밍 필터 및 정렬 로직 단위 테스트.
 *
 * 테스트 대상:
 * - sortLibraryGames: 라이브러리 게임 정렬 (최근 플레이 우선)
 * - applyPostFilters: 리뷰 후처리 필터 (플레이타임, 글자수, 추천/비추천)
 */

import { describe, it, expect } from "vitest";
import { sortLibraryGames } from "@/lib/steam/sort";
import { applyPostFilters } from "@/lib/steam/filters";
import type { SteamOwnedGame, SteamReview } from "@/lib/steam/types";

/** 테스트용 게임 데이터 팩토리 */
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

/** 테스트용 리뷰 데이터 팩토리 */
function makeReview(overrides: Partial<SteamReview> & { playtime_at_review?: number } = {}): SteamReview {
  const { playtime_at_review, ...rest } = overrides;
  return {
    recommendationid: String(Math.random()),
    author: {
      steamid: "test",
      num_games_owned: 100,
      playtime_forever: 600,
      playtime_at_review: playtime_at_review ?? 120,
      playtime_last_two_weeks: 0,
    },
    review: "This is a test review",
    voted_up: true,
    votes_up: 0,
    votes_funny: 0,
    timestamp_created: Date.now() / 1000,
    timestamp_updated: Date.now() / 1000,
    language: "koreana",
    ...rest,
  };
}

// --- sortLibraryGames ---

describe("sortLibraryGames", () => {
  it("최근 2주 플레이가 있는 게임을 우선 정렬한다", () => {
    const games = [
      makeGame({ appid: 1, playtime_2weeks: 0, playtime_forever: 1000 }),
      makeGame({ appid: 2, playtime_2weeks: 60, playtime_forever: 100 }),
      makeGame({ appid: 3, playtime_2weeks: undefined, playtime_forever: 500 }),
    ];

    const sorted = sortLibraryGames(games);
    expect(sorted[0].appid).toBe(2);
  });

  it("최근 플레이가 모두 있으면 최근 플레이타임 높은 순으로 정렬한다", () => {
    const games = [
      makeGame({ appid: 1, playtime_2weeks: 30, playtime_forever: 500 }),
      makeGame({ appid: 2, playtime_2weeks: 120, playtime_forever: 100 }),
      makeGame({ appid: 3, playtime_2weeks: 60, playtime_forever: 300 }),
    ];

    const sorted = sortLibraryGames(games);
    expect(sorted.map((g) => g.appid)).toEqual([2, 3, 1]);
  });

  it("최근 플레이가 모두 없으면 총 플레이타임 높은 순으로 정렬한다", () => {
    const games = [
      makeGame({ appid: 1, playtime_forever: 100 }),
      makeGame({ appid: 2, playtime_forever: 500 }),
      makeGame({ appid: 3, playtime_forever: 300 }),
    ];

    const sorted = sortLibraryGames(games);
    expect(sorted.map((g) => g.appid)).toEqual([2, 3, 1]);
  });

  it("원본 배열을 변경하지 않는다 (immutable)", () => {
    const games = [
      makeGame({ appid: 1, playtime_forever: 100 }),
      makeGame({ appid: 2, playtime_forever: 500 }),
    ];
    const original = [...games];

    sortLibraryGames(games);
    expect(games.map((g) => g.appid)).toEqual(original.map((g) => g.appid));
  });

  it("빈 배열을 처리할 수 있다", () => {
    expect(sortLibraryGames([])).toEqual([]);
  });
});

// --- applyPostFilters ---

describe("applyPostFilters", () => {
  it("최소 플레이타임 필터: 시간 단위를 분 단위로 변환하여 비교한다", () => {
    const reviews = [
      makeReview({ playtime_at_review: 30 }),    // 0.5시간
      makeReview({ playtime_at_review: 120 }),   // 2시간
      makeReview({ playtime_at_review: 600 }),   // 10시간
    ];

    // 1시간(=60분) 이상만 통과
    const filtered = applyPostFilters(reviews, { minPlaytime: 1, minLength: 0, reviewType: "all" });
    expect(filtered).toHaveLength(2);
  });

  it("최소 글자수 필터", () => {
    const reviews = [
      makeReview({ review: "짧음" }),
      makeReview({ review: "이것은 충분히 긴 리뷰입니다. 게임이 정말 좋습니다. 추천합니다." }),
    ];

    const filtered = applyPostFilters(reviews, { minPlaytime: 0, minLength: 10, reviewType: "all" });
    expect(filtered).toHaveLength(1);
  });

  it("추천 필터: positive만 통과", () => {
    const reviews = [
      makeReview({ voted_up: true }),
      makeReview({ voted_up: false }),
      makeReview({ voted_up: true }),
    ];

    const filtered = applyPostFilters(reviews, { minPlaytime: 0, minLength: 0, reviewType: "positive" });
    expect(filtered).toHaveLength(2);
    expect(filtered.every((r) => r.voted_up)).toBe(true);
  });

  it("비추천 필터: negative만 통과", () => {
    const reviews = [
      makeReview({ voted_up: true }),
      makeReview({ voted_up: false }),
    ];

    const filtered = applyPostFilters(reviews, { minPlaytime: 0, minLength: 0, reviewType: "negative" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].voted_up).toBe(false);
  });

  it("전체 필터: reviewType=all이면 모든 리뷰 통과", () => {
    const reviews = [
      makeReview({ voted_up: true }),
      makeReview({ voted_up: false }),
    ];

    const filtered = applyPostFilters(reviews, { minPlaytime: 0, minLength: 0, reviewType: "all" });
    expect(filtered).toHaveLength(2);
  });

  it("복합 필터: 여러 조건을 동시에 적용", () => {
    const reviews = [
      makeReview({ playtime_at_review: 600, review: "좋은 게임입니다. 강력히 추천합니다!", voted_up: true }),
      makeReview({ playtime_at_review: 30, review: "좋아요", voted_up: true }),       // 플레이타임 부족
      makeReview({ playtime_at_review: 600, review: "별로", voted_up: false }),        // 비추천
      makeReview({ playtime_at_review: 600, review: "짧", voted_up: true }),           // 글자수 부족
    ];

    const filtered = applyPostFilters(reviews, {
      minPlaytime: 5,    // 5시간 = 300분
      minLength: 5,
      reviewType: "positive",
    });

    expect(filtered).toHaveLength(1);
  });

  it("빈 배열을 처리할 수 있다", () => {
    expect(applyPostFilters([], { minPlaytime: 0, minLength: 0, reviewType: "all" })).toEqual([]);
  });

  it("모든 필터가 0/all이면 원본과 동일한 결과를 반환한다", () => {
    const reviews = [makeReview(), makeReview(), makeReview()];
    const filtered = applyPostFilters(reviews, { minPlaytime: 0, minLength: 0, reviewType: "all" });
    expect(filtered).toHaveLength(3);
  });
});
