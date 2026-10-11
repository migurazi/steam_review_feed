/**
 * GetItems(IStoreBrowseService) 응답 → 성향 분석용 메타 변환 (순수 함수).
 *
 * 배경 (속도 개선): 성향 분석은 게임마다 장르·카테고리 메타가 필요하다. 이전에는 store 호스트의
 * appdetails를 게임당 1회·1.5초 간격으로 직렬 조회했다(store IP 한도 ~200회/5분). 라이브러리 5,000개면
 * 첫 분석이 2시간 가까이 걸리고, 응답도 게임당 20KB 이상(설명·스크린샷 포함)이라 트래픽이 컸다.
 * GetItems는 api.steampowered.com(별도 한도, 키 불필요)에서 100개를 한 번에 받고, 필요한 필드만
 * 요청하면 게임당 1–2KB다. 리뷰 요약·가격·출시 여부·헤더 이미지도 같은 응답에 있다.
 *
 * 차이와 대응:
 *   - 장르: GetItems에는 appdetails의 genres가 없다. Steam 장르(액션·RPG 등)는 같은 이름의 "태그"로도
 *     존재하므로, 게임의 상위 태그 중 GENRE_TAG_LABELS에 있는 것을 장르로 쓴다. 장르 id 체계가
 *     appdetails 장르 id("1"=액션)에서 태그 id("19"=액션)로 바뀐다 — 성향 프로필은 매 분석마다 새로
 *     계산하므로 저장된 프로필과 섞이지 않는다(이전 결과 캐시의 프로필은 라벨로만 표시됨).
 *   - 카테고리: id 체계가 appdetails와 같다. 이름은 GetStoreCategories(한국어)로 따로 받는다.
 *   - 태그는 사용자 투표 상위 N개라, 개발사가 지정하는 appdetails 장르와 일부 다를 수 있다
 *     (예: 인디 표기). 추천 품질 차이는 미미하다고 보고 속도를 택했다.
 *
 * 결과는 기존 분석 코드가 그대로 쓰도록 SteamAppDetails 모양으로 만든다(필요한 필드만 채움).
 */

import type { SteamAppDetails, SteamStoreBrowseItem } from "./types";

/**
 * Steam 장르에 해당하는 태그 id → 한국어 이름.
 * GetTagList(koreana)로 확인한 값 (2026-10). 장르 태그는 거의 바뀌지 않아 고정 목록으로 둔다 —
 * 매 분석마다 태그 목록(446개)을 받을 필요가 없다.
 */
export const GENRE_TAG_LABELS: Readonly<Record<number, string>> = {
  19: "액션",
  21: "어드벤처",
  122: "RPG",
  9: "전략",
  599: "시뮬레이션",
  492: "인디",
  597: "캐주얼",
  701: "스포츠",
  699: "레이싱",
  128: "MMO",
  113: "무료 플레이",
  493: "앞서 해보기",
};

/** GetItems 메타 요청에 쓰는 data_request. 필요한 것만 받아 응답을 작게 유지한다. */
export const STORE_META_DATA_REQUEST = {
  include_tag_count: 20,
  include_assets: true,
  include_release: true,
  include_reviews: true,
} as const;

/** GetItems assets로 헤더 이미지 URL을 만든다. 없으면 undefined. */
export function storeItemHeaderImage(item: SteamStoreBrowseItem): string | undefined {
  const a = item.assets;
  if (!a?.header || !a.asset_url_format) return undefined;
  // asset_url_format 예: "steam/apps/292030/${FILENAME}?t=1700000000"
  const path = a.asset_url_format.replace("${FILENAME}", a.header);
  return `https://shared.akamai.steamstatic.com/store_item_assets/${path}`;
}

/**
 * 상시 무료(F2P) 게임인지. GetItems의 is_free만으로는 판단할 수 없다.
 *
 * GetItems is_free는 유료 게임의 100% 할인 배포(한정 무료)에도 true다(실응답 확인). 이를 F2P로 보면
 * excludeFree(F2P 노이즈 제거)가 가장 좋은 할인을 걸러 내고, 라이브러리·위시 게임도 무료로 잘못
 * 분류된다. appdetails의 is_free는 F2P만 true였으므로 그 의미에 맞춘다.
 *
 * 구분: 한정 무료 배포는 0원 구매 옵션에 할인(discount_pct > 0)이나 0보다 큰 정가
 * (original_price_in_cents)가 붙어 온다 — 이 경우만 F2P가 아니다. 그 밖의 is_free는 F2P로 본다:
 *   - 구매 옵션 없음 (Dota 2·TF2·Apex 등 — 2026-10 실응답에서 F2P는 모두 이 형태)
 *   - 0원 옵션, 할인 없음
 *   - 유료 옵션(서포터 팩 등 본편 포함 패키지가 최저 옵션으로 오는 경우, /code-review 4차 재검토) —
 *     그 가격은 게임 가격이 아니므로 storeItemPriceIsAppPrice가 F2P로 보고 null(무료)로 기록한다.
 * 참고: KR 지역 제한 F2P(Path of Exile 등)는 success=15로 와 메타 자체가 null이다(appdetails도 동일).
 */
export function storeItemIsFreeToPlay(item: SteamStoreBrowseItem): boolean {
  if (!item.is_free) return false;
  const opt = item.best_purchase_option;
  if (!opt) return true;
  const final = Number(opt.final_price_in_cents ?? 0);
  const original = Number(opt.original_price_in_cents ?? 0);
  const giveaway = final === 0 && ((opt.discount_pct ?? 0) > 0 || (Number.isFinite(original) && original > 0));
  return !giveaway;
}

/**
 * GetItems 구매 옵션 가격을 그 게임의 가격(appdetails price_overview와 같은 의미)으로 써도 되는지.
 *
 * best_purchase_option은 "가장 싼 구매 방법"이라 여러 게임 묶음(included_game_count > 1)이나 세트
 * 구매 전용(must_purchase_as_set) 옵션이 올 수 있다. 그런 가격을 게임 가격 캐시(app:{id}:price)에
 * 넣으면 위시·게임 상세에 묶음 가격이 표시된다. 그래서 단일 게임 옵션일 때만 가격 캐시에 넣는다.
 *
 * 구매 옵션이 없을 때(가격 null)는 F2P일 때만 "무료/미판매(null)"로 기록해도 된다. 유료 게임이
 * 옵션 없이 오는 경우(패키지 전용 판매, 일시 판매 중지)에 null을 쓰면 last-known(24h) 가격까지
 * 지워져 가격 장애 fallback이 사라진다 — 이때는 가격 캐시를 건드리지 않는다.
 */
export function storeItemPriceIsAppPrice(item: SteamStoreBrowseItem): boolean {
  // F2P는 가격 null(무료)로 기록한다 — 0원 구매 옵션이 와도 마찬가지 (normalizeStoreItem이 null로 만든다).
  if (storeItemIsFreeToPlay(item)) return true;
  const opt = item.best_purchase_option;
  if (!opt || opt.final_price_in_cents === undefined) return false;
  return (opt.included_game_count ?? 1) <= 1 && !opt.must_purchase_as_set;
}

/**
 * GetItems store_item → 성향 분석용 SteamAppDetails (필요 필드만).
 *
 * @param categoryLabels 카테고리 id → 이름 (GetStoreCategories). 없는 id는 "카테고리 {id}".
 *   이름 조회가 실패했으면 호출 측이 결과를 영속 저장하지 않는다 (getStoreMetaBatch 참조).
 * @returns success!==1(삭제·지역 제한 등)이거나 appid가 없으면 null (= 메타 미상).
 */
export function storeItemToAppDetails(
  item: SteamStoreBrowseItem,
  categoryLabels: Readonly<Record<number, string>>,
): SteamAppDetails | null {
  const appid = item.appid ?? item.id;
  if (item.success !== 1 || typeof appid !== "number" || appid <= 0) return null;
  const tagIds = item.tagids ?? item.tags?.map(t => t.tagid) ?? [];
  const genres = tagIds
    .filter(id => id in GENRE_TAG_LABELS)
    .map(id => ({ id: String(id), description: GENRE_TAG_LABELS[id] }));
  const c = item.categories;
  const categoryIds = Array.from(new Set([
    ...(c?.supported_player_categoryids ?? []),
    ...(c?.feature_categoryids ?? []),
    ...(c?.controller_categoryids ?? []),
  ]));
  const categories = categoryIds.map(id => ({ id, description: categoryLabels[id] ?? `카테고리 ${id}` }));
  return {
    name: item.name ?? `AppID ${appid}`,
    steam_appid: appid,
    is_free: storeItemIsFreeToPlay(item),
    header_image: storeItemHeaderImage(item) ?? "",
    short_description: "",
    type: "game",
    genres,
    categories,
    // 날짜 문자열은 분석에 쓰지 않는다 — 출시 예정 여부만.
    release_date: { coming_soon: !!item.release?.is_coming_soon, date: "" },
  };
}
