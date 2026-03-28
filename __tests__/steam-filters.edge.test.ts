/**
 * lib/steam/filters.ts 엣지 케이스 테스트.
 *
 * 기본 동작은 stream-filters.test.ts에서 커버.
 * 여기서는 경계값, 극단적 입력, 유니코드 글자수 등을 테스트한다.
 */

import { describe, it, expect } from "vitest";
import { applyPostFilters } from "@/lib/steam/filters";
import type { SteamReview } from "@/lib/steam/types";

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
    review: "Default review text for testing",
    voted_up: true,
    votes_up: 0,
    votes_funny: 0,
    timestamp_created: Date.now() / 1000,
    timestamp_updated: Date.now() / 1000,
    language: "koreana",
    ...rest,
  };
}

describe("applyPostFilters - edge cases", () => {
  it("playtime_at_review가 정확히 임계값(60분=1시간)이면 통과한다", () => {
    const reviews = [makeReview({ playtime_at_review: 60 })];
    const filtered = applyPostFilters(reviews, { minPlaytime: 1, minLength: 0, reviewType: "all" });
    expect(filtered).toHaveLength(1);
  });

  it("playtime_at_review가 임계값보다 1분 적으면 거부된다", () => {
    const reviews = [makeReview({ playtime_at_review: 59 })];
    const filtered = applyPostFilters(reviews, { minPlaytime: 1, minLength: 0, reviewType: "all" });
    expect(filtered).toHaveLength(0);
  });

  it("review 글자수가 정확히 minLength이면 통과한다", () => {
    const review = makeReview({ review: "12345" }); // 5글자
    const filtered = applyPostFilters([review], { minPlaytime: 0, minLength: 5, reviewType: "all" });
    expect(filtered).toHaveLength(1);
  });

  it("review 글자수가 minLength-1이면 거부된다", () => {
    const review = makeReview({ review: "1234" }); // 4글자
    const filtered = applyPostFilters([review], { minPlaytime: 0, minLength: 5, reviewType: "all" });
    expect(filtered).toHaveLength(0);
  });

  it("한글 리뷰의 글자수를 올바르게 센다", () => {
    const review = makeReview({ review: "재미있는 게임" }); // 7글자 (공백 포함)
    const filtered = applyPostFilters([review], { minPlaytime: 0, minLength: 7, reviewType: "all" });
    expect(filtered).toHaveLength(1);
  });

  it("이모지가 포함된 리뷰의 글자수", () => {
    // 이모지는 JS에서 2 code unit이지만 .length는 surrogate pair를 2로 센다
    const review = makeReview({ review: "좋아요👍" }); // .length = 5 (👍는 2)
    const filtered = applyPostFilters([review], { minPlaytime: 0, minLength: 5, reviewType: "all" });
    expect(filtered).toHaveLength(1);
  });

  it("빈 문자열 리뷰는 minLength > 0이면 거부된다", () => {
    const review = makeReview({ review: "" });
    const filtered = applyPostFilters([review], { minPlaytime: 0, minLength: 1, reviewType: "all" });
    expect(filtered).toHaveLength(0);
  });

  it("playtime_at_review가 0이고 minPlaytime > 0이면 거부된다", () => {
    const review = makeReview({ playtime_at_review: 0 });
    const filtered = applyPostFilters([review], { minPlaytime: 1, minLength: 0, reviewType: "all" });
    expect(filtered).toHaveLength(0);
  });

  it("대규모 배열(1000개)을 필터링할 수 있다", () => {
    const reviews = Array.from({ length: 1000 }, (_, i) =>
      makeReview({ playtime_at_review: i * 10, voted_up: i % 2 === 0 })
    );
    const filtered = applyPostFilters(reviews, {
      minPlaytime: 5, // 300분 이상
      minLength: 0,
      reviewType: "positive",
    });
    // 300분 이상 + positive만
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.every((r) => r.author.playtime_at_review >= 300 && r.voted_up)).toBe(true);
  });
});
