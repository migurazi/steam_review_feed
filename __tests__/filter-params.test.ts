/**
 * lib/filter-params.ts 단위 테스트.
 *
 * URL 쿼리 파라미터 <-> 필터 상태 변환을 검증한다:
 * - 기본값 복원 (파라미터 없을 때)
 * - 유효한 파라미터 파싱
 * - 잘못된 파라미터 무시 (기본값 대체)
 * - 기본값과 동일한 필터는 URL에서 생략
 * - 왕복 변환 (parse -> serialize -> parse) 일관성
 */

import { describe, it, expect } from "vitest";
import { parseFiltersFromParams, filtersToParams } from "@/lib/filter-params";
import { DEFAULT_FILTERS } from "@/components/FilterPanel";

describe("parseFiltersFromParams", () => {
  it("파라미터가 없으면 기본값을 반환한다", () => {
    const params = new URLSearchParams();
    const result = parseFiltersFromParams(params);
    expect(result).toEqual(DEFAULT_FILTERS);
  });

  it("유효한 source 파라미터를 파싱한다", () => {
    const params = new URLSearchParams("source=library");
    const result = parseFiltersFromParams(params);
    expect(result.source).toBe("library");
  });

  it("유효한 language 파라미터를 파싱한다", () => {
    const params = new URLSearchParams("language=english");
    const result = parseFiltersFromParams(params);
    expect(result.language).toBe("english");
  });

  it("유효한 숫자 파라미터를 파싱한다", () => {
    const params = new URLSearchParams("minPlaytime=5&minLength=100&dayRange=7");
    const result = parseFiltersFromParams(params);
    expect(result.minPlaytime).toBe(5);
    expect(result.minLength).toBe(100);
    expect(result.dayRange).toBe(7);
  });

  it("excludeFree=false를 올바르게 파싱한다", () => {
    const params = new URLSearchParams("excludeFree=false");
    const result = parseFiltersFromParams(params);
    expect(result.excludeFree).toBe(false);
  });

  it("excludeFree=true를 올바르게 파싱한다", () => {
    const params = new URLSearchParams("excludeFree=true");
    const result = parseFiltersFromParams(params);
    expect(result.excludeFree).toBe(true);
  });

  it("잘못된 source 값은 기본값으로 대체한다", () => {
    const params = new URLSearchParams("source=invalid");
    const result = parseFiltersFromParams(params);
    expect(result.source).toBe(DEFAULT_FILTERS.source);
  });

  it("잘못된 language 값은 기본값으로 대체한다", () => {
    const params = new URLSearchParams("language=french");
    const result = parseFiltersFromParams(params);
    expect(result.language).toBe(DEFAULT_FILTERS.language);
  });

  it("잘못된 숫자 값은 기본값으로 대체한다", () => {
    const params = new URLSearchParams("minPlaytime=99&dayRange=-1");
    const result = parseFiltersFromParams(params);
    expect(result.minPlaytime).toBe(DEFAULT_FILTERS.minPlaytime);
    expect(result.dayRange).toBe(DEFAULT_FILTERS.dayRange);
  });

  it("NaN 값은 기본값으로 대체한다", () => {
    const params = new URLSearchParams("minPlaytime=abc");
    const result = parseFiltersFromParams(params);
    expect(result.minPlaytime).toBe(DEFAULT_FILTERS.minPlaytime);
  });

  it("모든 파라미터를 동시에 파싱한다", () => {
    const params = new URLSearchParams(
      "source=both&language=japanese&minPlaytime=10&minLength=50&reviewType=negative&dayRange=90&excludeFree=false"
    );
    const result = parseFiltersFromParams(params);
    expect(result).toEqual({
      source: "both",
      language: "japanese",
      minPlaytime: 10,
      minLength: 50,
      reviewType: "negative",
      dayRange: 90,
      excludeFree: false,
    });
  });
});

describe("filtersToParams", () => {
  it("기본값이면 빈 문자열을 반환한다", () => {
    const result = filtersToParams(DEFAULT_FILTERS);
    expect(result).toBe("");
  });

  it("기본값과 다른 항목만 포함한다", () => {
    const filters = { ...DEFAULT_FILTERS, source: "library" as const };
    const result = filtersToParams(filters);
    expect(result).toBe("source=library");
  });

  it("여러 변경 항목을 포함한다", () => {
    const filters = {
      ...DEFAULT_FILTERS,
      source: "both" as const,
      language: "english" as const,
      dayRange: 7 as const,
    };
    const result = filtersToParams(filters);
    const params = new URLSearchParams(result);
    expect(params.get("source")).toBe("both");
    expect(params.get("language")).toBe("english");
    expect(params.get("dayRange")).toBe("7");
    // 기본값 항목은 없어야 한다
    expect(params.has("minPlaytime")).toBe(false);
    expect(params.has("excludeFree")).toBe(false);
  });

  it("excludeFree=false를 올바르게 직렬화한다", () => {
    const filters = { ...DEFAULT_FILTERS, excludeFree: false };
    const result = filtersToParams(filters);
    expect(result).toContain("excludeFree=false");
  });
});

describe("왕복 변환 일관성", () => {
  it("serialize -> parse 왕복 시 동일한 결과를 반환한다", () => {
    const original = {
      source: "both" as const,
      language: "japanese" as const,
      minPlaytime: 10 as const,
      minLength: 50 as const,
      reviewType: "negative" as const,
      dayRange: 90 as const,
      excludeFree: false,
    };
    const serialized = filtersToParams(original);
    const parsed = parseFiltersFromParams(new URLSearchParams(serialized));
    expect(parsed).toEqual(original);
  });

  it("기본값의 왕복 변환", () => {
    const serialized = filtersToParams(DEFAULT_FILTERS);
    const parsed = parseFiltersFromParams(new URLSearchParams(serialized));
    expect(parsed).toEqual(DEFAULT_FILTERS);
  });
});
