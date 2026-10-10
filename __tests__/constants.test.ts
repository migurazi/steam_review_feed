/**
 * lib/constants.ts 단위 테스트.
 *
 * 전역 상수의 값이 기획서 및 사용처와 일치하는지 검증한다.
 * 상수 변경 시 의도치 않은 영향을 방지하기 위한 스냅샷 역할.
 */

import { describe, it, expect } from "vitest";
import {
  PAGE_SIZE,
  MAX_REVIEWS_PER_GAME,
  REVIEW_RETRY_THRESHOLD,
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX_REQUESTS,
  STEAM_API_DELAY,
  STREAM_CONCURRENCY,
  DEFAULT_FILTER_VALUES,
  PRICE_STALE_MS,
  PRICE_BATCH_SIZE,
} from "@/lib/constants";
import { CACHE_TTL } from "@/lib/cache";

describe("constants", () => {
  it("PAGE_SIZE는 50이다 (기획서 기반)", () => {
    expect(PAGE_SIZE).toBe(50);
  });

  it("MAX_REVIEWS_PER_GAME은 20이다 (Steam API 최대값)", () => {
    expect(MAX_REVIEWS_PER_GAME).toBe(20);
  });

  it("REVIEW_RETRY_THRESHOLD는 2이다 (필터 후 부족 시 재요청 기준)", () => {
    expect(REVIEW_RETRY_THRESHOLD).toBe(2);
  });

  it("Rate Limit은 분당 30회이다 (기획서 7.1절)", () => {
    expect(RATE_LIMIT_WINDOW_MS).toBe(60_000);
    expect(RATE_LIMIT_MAX_REQUESTS).toBe(30);
  });

  it("Steam API 딜레이가 올바르다 (appdetails Rate Limit 회피)", () => {
    // appdetails는 비공식 API라 Rate Limit이 엄격(~40 req/min). STREAM_CONCURRENCY=1
    // 과 조합해 1500ms 간격으로 호출 (= 40 req/min). reviews는 별도 endpoint로
    // 더 너그러움.
    expect(STEAM_API_DELAY.appDetails).toBe(1500);
    expect(STEAM_API_DELAY.reviews).toBe(500);
  });

  it("STREAM_CONCURRENCY는 양수이다", () => {
    expect(STREAM_CONCURRENCY).toBeGreaterThan(0);
  });

  it("DEFAULT_FILTER_VALUES가 기획서 기본값과 일치한다", () => {
    expect(DEFAULT_FILTER_VALUES.source).toBe("wishlist");
    expect(DEFAULT_FILTER_VALUES.language).toBe("koreana");
    expect(DEFAULT_FILTER_VALUES.dayRange).toBe(30);
    expect(DEFAULT_FILTER_VALUES.excludeFree).toBe(true);
    expect(DEFAULT_FILTER_VALUES.minPlaytime).toBe(0);
    expect(DEFAULT_FILTER_VALUES.minLength).toBe(0);
    expect(DEFAULT_FILTER_VALUES.reviewType).toBe("all");
    expect(DEFAULT_FILTER_VALUES.offset).toBe(0);
  });

  it("가격 신선도 기준은 1시간이고 가격 캐시 TTL과 같다 (작업 지시서 20261010_01 §1-5)", () => {
    expect(PRICE_STALE_MS).toBe(60 * 60 * 1000);
    expect(CACHE_TTL.appPrice).toBe(PRICE_STALE_MS);
  });

  it("가격 배치 크기는 100이다 (단계 0 V1: 191개까지 동작 확인)", () => {
    expect(PRICE_BATCH_SIZE).toBe(100);
  });
});
