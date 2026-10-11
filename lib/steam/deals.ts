/**
 * 미보유 할인 게임 발굴 트랙의 순수 로직 (작업 지시서 20261010_01 단계 2-3).
 *
 * I/O 없음. 검색 HTML·GetItems 응답 같은 외부 데이터는 라우트/API 계층이 조회해 주입한다.
 * 취향 매칭(recommendStoreDeals)은 scoreAgainstProfile을 쓰므로 profile.ts에 있고,
 * 이 모듈은 후보 수집·정규화·선정만 담당한다.
 */

import { computeDealScore, isOnSale } from "./profile";
import { storeItemIsFreeToPlay, storeItemPriceIsAppPrice } from "./store-meta";
import type {
  SteamStoreBrowseItem,
  StoreItemSummary,
  ReviewSummary,
  SteamPriceOverview,
} from "./types";

// ============================================================================
// 검색 결과 HTML → appid
// ============================================================================

/** 검색 결과 행의 여는 <a> 태그. 속성 안에 '>'가 없다는 가정(실응답에서 성립)으로 태그 단위로 자른다. */
const ROW_TAG_RE = /<a\s[^>]*data-ds-appid="[^"]*"[^>]*>/g;
/**
 * 행 수 세기용: appid가 없는 행도 포함한다. 번들 행은 data-ds-appid 없이 data-ds-bundleid만
 * 있는 경우가 많아 ROW_TAG_RE로는 빠진다 — 그러면 번들만 있는 페이지를 "빈 페이지"로 보고 순회를
 * 멈춘다 (/code-review 4차 #6). 행 클래스(search_result_row)도 함께 본다.
 */
const ANY_ROW_TAG_RE = /<a\s[^>]*(?:data-ds-(?:appid|packageid|bundleid)="|class="[^"]*\bsearch_result_row\b)[^>]*>/g;
const APPID_ATTR_RE = /data-ds-appid="([^"]*)"/;

/**
 * 검색 specials 응답의 results_html에서 단일 게임 appid를 순서대로 추출한다.
 *
 * 제외 규칙 (단계 0 V3, fixtures/v4_reviews_p50.json):
 *   - data-ds-packageid / data-ds-bundleid 가 있는 행: 패키지·번들 (예: Sub_460).
 *   - appid 값에 쉼표가 있는 행: 다중 앱 패키지 ("4700,4780").
 *   - 양의 정수가 아닌 값.
 * 중복 appid는 첫 등장만 남긴다(페이지 경계 중복 방어). 빈·깨진 HTML은 빈 배열.
 *
 * HTML은 appid 정수 추출에만 쓰고, 다른 내용(이름·가격 문자열 등)은 읽지 않는다
 * (보안 제약 — 검색 HTML은 클라이언트로 전달·렌더하지 않음).
 */
export function parseSearchResultAppIds(html: string): number[] {
  if (typeof html !== "string" || html.length === 0) return [];
  const seen = new Set<number>();
  const out: number[] = [];
  for (const m of html.matchAll(ROW_TAG_RE)) {
    const tag = m[0];
    if (tag.includes("data-ds-packageid") || tag.includes("data-ds-bundleid")) continue;
    const raw = APPID_ATTR_RE.exec(tag)?.[1] ?? "";
    if (!/^\d+$/.test(raw)) continue; // 쉼표(다중 앱)·빈 값·비숫자 제외
    const appid = Number(raw);
    if (appid <= 0 || seen.has(appid)) continue;
    seen.add(appid);
    out.push(appid);
  }
  return out;
}

/**
 * results_html에 들어 있는 검색 결과 행 수 (패키지·번들·다중 앱 행 포함).
 *
 * getStoreSpecials가 "빈 페이지(마크업 이상·결과 끝)"와 "행은 있는데 단일 게임이 없는 페이지
 * (패키지·번들만)"를 구분하는 데 쓴다. parseSearchResultAppIds가 빈 배열이어도 행이 있으면
 * 정상 페이지이므로 다음 페이지로 넘어가야 한다 (/code-review 3차 #7).
 */
export function countSearchResultRows(html: string): number {
  if (typeof html !== "string" || html.length === 0) return 0;
  return Array.from(html.matchAll(ANY_ROW_TAG_RE)).length;
}

// ============================================================================
// GetItems 응답 정규화
// ============================================================================

/**
 * GetItems의 best_purchase_option을 appdetails price_overview 형식으로 변환한다.
 *
 * - 구매 옵션이 없으면(무료·미판매) null.
 * - 금액은 문자열 1/100 단위 → 숫자. 파싱 불가면 null(가격 미상과 같게 취급).
 * - 통화: GetItems는 통화 코드를 주지 않는다. 요청 context.country_code=KR로 고정하므로
 *   KRW로 기록한다 — 이 가정이 틀리면 priceToWon이 원 단위 환산을 잘못하므로, 호출부는
 *   반드시 KR 컨텍스트로만 조회해야 한다.
 * - 할인율: price_cannot_be_displayed_as_discount / hide_discount_pct_for_compliance가 켜진
 *   옵션은 Steam이 "할인"으로 표시하지 않는 가격(번들 차감 등)이라 할인 0으로 본다.
 *   그래야 할인 발굴 트랙에 "할인이 아닌 할인"이 섞이지 않는다.
 * - 무할인 응답은 original_price_in_cents가 없으므로 정가 = 최종가.
 */
export function storeItemToPrice(item: SteamStoreBrowseItem): SteamPriceOverview | null {
  const opt = item.best_purchase_option;
  if (!opt || opt.final_price_in_cents === undefined) return null;
  const final = Number(opt.final_price_in_cents);
  if (!Number.isFinite(final) || final < 0) return null;
  const originalRaw = opt.original_price_in_cents !== undefined ? Number(opt.original_price_in_cents) : final;
  const initial = Number.isFinite(originalRaw) && originalRaw >= final ? originalRaw : final;
  const discountHidden = !!opt.price_cannot_be_displayed_as_discount || !!opt.hide_discount_pct_for_compliance;
  const pct = discountHidden ? 0 : (opt.discount_pct ?? 0);
  // 정가가 최종가보다 클 때만 할인으로 인정한다 — 할인율만 있고 정가가 없으면 취소선 정가가
  // 빈 "할인" 카드가 되므로 무할인으로 본다.
  const discounted = pct > 0 && initial > final;
  return {
    currency: "KRW",
    initial: discounted ? initial : final,
    final,
    discount_percent: discounted ? pct : 0,
    // appdetails 관례와 맞춘다: 할인이 없으면 initial_formatted는 빈 문자열 (GamePrice가 처리).
    initial_formatted: discounted ? (opt.formatted_original_price ?? "") : "",
    final_formatted: opt.formatted_final_price ?? "",
  };
}

/**
 * GetItems의 리뷰 요약(summary_filtered)을 기존 ReviewSummary 형식으로 환산한다.
 *
 *   totalPositive = round(percent_positive · review_count / 100), totalReviews = review_count
 *
 * 그대로 computeReviewScore / buildReviewBadge에 넣을 수 있다. percent_positive가 정수 반올림
 * 값이라 appreviews(filter=all) 기반 위시/라이브러리 점수와 미세 차이가 있지만, store-deal 트랙
 * 내부 비교에만 쓰므로 수용한다 (부록 B 설계 확정 4).
 */
export function storeItemToReviewSummary(item: SteamStoreBrowseItem): ReviewSummary | null {
  const s = item.reviews?.summary_filtered;
  if (!s || !Number.isFinite(s.review_count) || s.review_count <= 0) return null;
  const pct = Number.isFinite(s.percent_positive) ? Math.min(Math.max(s.percent_positive, 0), 100) : 0;
  const totalPositive = Math.round((pct * s.review_count) / 100);
  return {
    reviewScore: s.review_score,
    reviewScoreDesc: s.review_score_label,
    totalPositive,
    totalNegative: s.review_count - totalPositive,
    totalReviews: s.review_count,
  };
}

/**
 * GetItems store_item 하나를 StoreItemSummary로 정규화한다.
 * success!==1 이거나 appid가 없으면 null(=미상).
 */
export function normalizeStoreItem(item: SteamStoreBrowseItem, fetchedAt: number): StoreItemSummary | null {
  const appid = item.appid ?? item.id;
  if (item.success !== 1 || typeof appid !== "number" || appid <= 0) return null;
  // 게임 자신의 가격일 때만 가격으로 쓴다 (storeItemPriceIsAppPrice). 묶음·세트 전용 옵션의 가격을 쓰면
  // 발굴 트랙에 묶음 가격·할인율이 그 게임의 할인처럼 보인다. F2P는 0원 옵션이 와도 null(무료).
  // 그 밖의 경우 null — 발굴 트랙은 할인(discount_percent > 0)만 보므로 자연히 빠진다.
  const price = !storeItemIsFreeToPlay(item) && storeItemPriceIsAppPrice(item) ? storeItemToPrice(item) : null;
  const c = item.categories;
  const categoryIds = Array.from(new Set([
    ...(c?.supported_player_categoryids ?? []),
    ...(c?.feature_categoryids ?? []),
    ...(c?.controller_categoryids ?? []),
  ]));
  // 종료 시각: 진행 중 할인 중 가장 이른 종료. 할인이 표시되지 않는 가격이면 의미 없으므로 생략.
  const ends = (item.best_purchase_option?.active_discounts ?? [])
    .map(d => d.discount_end_date)
    .filter((t): t is number => typeof t === "number" && t > 0);
  const discountEndsAt = price && price.discount_percent > 0 && ends.length > 0 ? Math.min(...ends) : undefined;
  return {
    appid,
    price,
    review: storeItemToReviewSummary(item),
    categoryIds,
    // 100% 할인 배포(한정 무료)는 F2P가 아니다 (storeItemIsFreeToPlay).
    isFree: storeItemIsFreeToPlay(item),
    ...(discountEndsAt !== undefined ? { discountEndsAt } : {}),
    fetchedAt,
  };
}

// ============================================================================
// 후보 선정
// ============================================================================

/**
 * 발굴 pool에서 이미 소유했거나 위시리스트에 있는 게임을 제외한다 (순서 보존).
 * 무료 게임은 이후 할인 조건(discount_percent > 0)에서 자연 탈락하므로 여기서 다루지 않는다.
 */
export function filterDiscoverPool(
  pool: number[],
  ownedIds: ReadonlySet<number>,
  wishIds: ReadonlySet<number>
): number[] {
  return pool.filter(id => !ownedIds.has(id) && !wishIds.has(id));
}

/**
 * 장르 메타(appdetails)를 조회할 후보를 고른다.
 *
 * 조건: GetItems 요약이 있고, 할인 중이며, 리뷰 표본이 minReviews 이상(M9 리뷰 하한을
 * 메타 조회 전에 적용 — 어차피 탈락할 후보에 1.5s 메타 호출을 쓰지 않도록).
 * 정렬: dealScore desc → appid asc. 상위 cap개.
 *
 * GetItems categories로 "매칭 0" 후보를 미리 거르지 않는다 — 매칭은 장르만으로도 성립하는데
 * 장르는 GetItems에 없어 카테고리 불일치만으로 탈락시키면 장르 매칭 후보를 잘못 버린다.
 * (pool 자체가 리뷰순 검색이라 품질은 이미 걸러져 있다.)
 */
export function selectDealCandidatesForMeta(
  ids: number[],
  items: ReadonlyMap<number, StoreItemSummary>,
  cap: number,
  minReviews: number
): number[] {
  if (cap <= 0) return [];
  return ids
    .map(id => items.get(id))
    .filter((s): s is StoreItemSummary =>
      !!s && isOnSale(s.price) && (s.review?.totalReviews ?? 0) >= minReviews)
    .map(s => ({ appid: s.appid, deal: computeDealScore(s.price) }))
    .sort((a, b) => (b.deal - a.deal) || (a.appid - b.appid))
    .slice(0, cap)
    .map(x => x.appid);
}
