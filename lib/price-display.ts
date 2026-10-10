/**
 * 가격·시각 표시 공용 헬퍼 (클라이언트 안전 — lib/constants만 의존).
 *
 * 추천 페이지와 게임 상세 페이지가 같은 "묵은 가격" 규칙과 상대 시각 문구를 쓰도록 한 곳에 둔다
 * (/code-review 2차 R8 — 두 페이지에 같은 함수가 따로 있어 null 처리·문구가 어긋나기 시작했다).
 */

import { PRICE_STALE_MS } from "@/lib/constants";

/**
 * 가격이 PRICE_STALE_MS(=가격 캐시 TTL, 1시간)보다 오래됐는지. 시각 미상(undefined/null)이면 false.
 * true면 GamePrice를 회색으로 그리고 할인 강조를 끈다.
 */
export function isPriceStale(fetchedAt: number | null | undefined): boolean {
  return typeof fetchedAt === "number" && Date.now() - fetchedAt > PRICE_STALE_MS;
}

/**
 * Unix ms 시각을 "방금 전", "5분 전", "2시간 전", "3일 전", "2026-05-25" 등 한국어 상대 시각으로 표시.
 * 7일 이상 지나면 절대 날짜.
 */
export function formatRelativeTime(unixMs: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - unixMs) / 1000));
  if (diffSec < 60) return "방금 전";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}분 전`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}시간 전`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}일 전`;
  const d = new Date(unixMs);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 묵은 가격 툴팁 문구 ("3시간 전 가격"). 시각 미상이면 undefined. */
export function formatPriceAge(fetchedAt: number | null | undefined): string | undefined {
  return typeof fetchedAt === "number" ? `${formatRelativeTime(fetchedAt)} 가격` : undefined;
}
