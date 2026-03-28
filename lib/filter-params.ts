/**
 * 필터 상태 <-> URL 쿼리 파라미터 변환 유틸리티.
 *
 * 피드 페이지에서 필터 상태를 URL에 유지하여
 * 새로고침, 뒤로가기, URL 공유 시 필터가 보존되도록 한다.
 *
 * 기본값과 동일한 필터는 URL에서 생략하여 깔끔한 URL을 유지한다.
 */

import type { FilterState } from '@/components/FilterPanel';
import { DEFAULT_FILTERS } from '@/components/FilterPanel';

const STORAGE_KEY = 'steam-review-feed-filters';

/** source 유효값 */
const VALID_SOURCES = new Set(['wishlist', 'library', 'both']);
/** language 유효값 */
const VALID_LANGUAGES = new Set(['koreana', 'english', 'japanese', 'schinese', 'all']);
/** reviewType 유효값 */
const VALID_REVIEW_TYPES = new Set(['all', 'positive', 'negative']);
/** minPlaytime 유효값 */
const VALID_MIN_PLAYTIME = new Set([0, 1, 5, 10]);
/** minLength 유효값 */
const VALID_MIN_LENGTH = new Set([0, 50, 100]);
/** dayRange 유효값 */
const VALID_DAY_RANGE = new Set([7, 30, 90, 0]);

/**
 * URL 쿼리 파라미터에서 필터 상태를 복원한다.
 * 잘못된 값이나 없는 파라미터는 기본값으로 대체한다.
 *
 * @param params URLSearchParams 객체
 * @returns 유효성이 검증된 FilterState
 */
export function parseFiltersFromParams(params: URLSearchParams): FilterState {
  const source = params.get('source');
  const language = params.get('language');
  const rawMinPlaytime = params.get('minPlaytime');
  const rawMinLength = params.get('minLength');
  const reviewType = params.get('reviewType');
  const rawDayRange = params.get('dayRange');
  const excludeFree = params.get('excludeFree');

  // Number(null) === 0 이므로, 파라미터가 없는 경우(null)를 먼저 걸러내야
  // 유효값 0과 혼동되지 않는다.
  const minPlaytime = rawMinPlaytime !== null ? Number(rawMinPlaytime) : NaN;
  const minLength = rawMinLength !== null ? Number(rawMinLength) : NaN;
  const dayRange = rawDayRange !== null ? Number(rawDayRange) : NaN;

  return {
    source: VALID_SOURCES.has(source ?? '') ? (source as FilterState['source']) : DEFAULT_FILTERS.source,
    language: VALID_LANGUAGES.has(language ?? '') ? (language as FilterState['language']) : DEFAULT_FILTERS.language,
    minPlaytime: VALID_MIN_PLAYTIME.has(minPlaytime) ? (minPlaytime as FilterState['minPlaytime']) : DEFAULT_FILTERS.minPlaytime,
    minLength: VALID_MIN_LENGTH.has(minLength) ? (minLength as FilterState['minLength']) : DEFAULT_FILTERS.minLength,
    reviewType: VALID_REVIEW_TYPES.has(reviewType ?? '') ? (reviewType as FilterState['reviewType']) : DEFAULT_FILTERS.reviewType,
    dayRange: VALID_DAY_RANGE.has(dayRange) ? (dayRange as FilterState['dayRange']) : DEFAULT_FILTERS.dayRange,
    excludeFree: excludeFree !== null ? excludeFree !== 'false' : DEFAULT_FILTERS.excludeFree,
  };
}

/**
 * 필터 상태를 URL 쿼리 문자열로 변환한다.
 * 기본값과 동일한 항목은 URL에서 생략한다.
 *
 * @param filters 현재 필터 상태
 * @returns 쿼리 문자열 (예: "source=library&dayRange=7"). 기본값이면 빈 문자열.
 */
export function filtersToParams(filters: FilterState): string {
  const params = new URLSearchParams();
  if (filters.source !== DEFAULT_FILTERS.source) params.set('source', filters.source);
  if (filters.language !== DEFAULT_FILTERS.language) params.set('language', filters.language);
  if (filters.minPlaytime !== DEFAULT_FILTERS.minPlaytime) params.set('minPlaytime', String(filters.minPlaytime));
  if (filters.minLength !== DEFAULT_FILTERS.minLength) params.set('minLength', String(filters.minLength));
  if (filters.reviewType !== DEFAULT_FILTERS.reviewType) params.set('reviewType', filters.reviewType);
  if (filters.dayRange !== DEFAULT_FILTERS.dayRange) params.set('dayRange', String(filters.dayRange));
  if (filters.excludeFree !== DEFAULT_FILTERS.excludeFree) params.set('excludeFree', String(filters.excludeFree));
  return params.toString();
}

/**
 * 필터 상태를 localStorage에 저장한다.
 * 홈에서 /feed로 재진입할 때 이전 필터를 복원하기 위해 사용.
 */
export function saveFiltersToStorage(filters: FilterState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(filters));
  } catch {
    // localStorage 사용 불가 (private mode 등) 시 무시
  }
}

/**
 * localStorage에서 필터 상태를 복원한다.
 * 저장된 값이 없거나 파싱 실패 시 null을 반환한다.
 */
export function loadFiltersFromStorage(): FilterState | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return null;
    const parsed = JSON.parse(stored);
    // 유효성 검증: 각 필드가 존재하고 올바른 타입인지 확인
    if (
      typeof parsed === 'object' && parsed !== null &&
      VALID_SOURCES.has(parsed.source) &&
      VALID_LANGUAGES.has(parsed.language) &&
      VALID_MIN_PLAYTIME.has(parsed.minPlaytime) &&
      VALID_MIN_LENGTH.has(parsed.minLength) &&
      VALID_REVIEW_TYPES.has(parsed.reviewType) &&
      VALID_DAY_RANGE.has(parsed.dayRange) &&
      typeof parsed.excludeFree === 'boolean'
    ) {
      return parsed as FilterState;
    }
    return null;
  } catch {
    return null;
  }
}
