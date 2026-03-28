/**
 * 리뷰 후처리 필터 유틸리티.
 *
 * Steam API에서 가져온 리뷰에 추가적인 서버 사이드 필터를 적용한다.
 * Steam API의 language, day_range 파라미터로 처리되지 않는 필터를 담당:
 * - 최소 플레이타임 (작성 시점 기준)
 * - 최소 글자수
 * - 추천/비추천 필터
 */

import type { SteamReview } from "./types";

/** 후처리 필터 조건 */
export interface PostFilterOptions {
  /** 최소 플레이타임 (시간 단위). 0이면 비활성. */
  minPlaytime: number;
  /** 최소 리뷰 글자수. 0이면 비활성. */
  minLength: number;
  /** "all"=전체, "positive"=추천만, "negative"=비추천만 */
  reviewType: string;
}

/**
 * 리뷰 배열에 후처리 필터를 적용한다.
 *
 * @param reviews 원본 리뷰 배열
 * @param filters 필터 조건
 * @returns 필터를 통과한 리뷰 배열 (원본 변경 없음)
 */
export function applyPostFilters(
  reviews: SteamReview[],
  filters: PostFilterOptions
): SteamReview[] {
  return reviews.filter((r) => {
    // 최소 플레이타임: 시간 단위를 분 단위로 변환하여 비교
    // (사용자는 "5시간 이상"을 선택하지만, API는 분 단위)
    if (
      filters.minPlaytime > 0 &&
      r.author.playtime_at_review < filters.minPlaytime * 60
    ) {
      return false;
    }

    // 최소 글자수
    if (filters.minLength > 0 && r.review.length < filters.minLength) {
      return false;
    }

    // 추천/비추천 필터
    if (filters.reviewType === "positive" && !r.voted_up) return false;
    if (filters.reviewType === "negative" && r.voted_up) return false;

    return true;
  });
}
