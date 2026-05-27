/**
 * 라이브러리 플레이타임 기반 성향 분석 및 추천 모듈.
 *
 * 외부 의존 없는 순수 함수만 노출한다. Steam API 호출이나 캐시 접근은
 * 호출 측이 책임지고, 본 모듈은 결합된 입력만 받아 결정론적으로 동작한다.
 *
 * 핵심 개념 (작업 지시서 3.2.3):
 *   classify(game, opts)가 게임을 정확히 하나의 풀로 분류한다.
 *     - 'unplayed'      : 0 ≤ pt ≤ unplayedMax — 추천 후보
 *     - 'card-farming'  : unplayedMax < pt < cardFarmingMax — 분석/추천 양쪽 제외
 *     - 'analyzed'      : pt ≥ cardFarmingMax — 성향 신호로 분석에 기여
 *     - 'excluded-free' : opts.excludeFree=true 이고 무료 게임 — 양쪽 제외
 *
 * 가중치 산식:
 *   weight(game) = log(1 + playtimeMinutes)
 *     선형 합산이면 한 게임의 1000h+ 플레이가 전체 신호를 압도하므로, 단조
 *     증가하면서 극단값을 완만하게 만드는 자연로그를 쓴다.
 *
 * 매칭은 항상 id 기반 (작업 지시서 4.3, Momus C3).
 *   Steam API를 cc=KR&l=koreana 로 호출하면 description이 한국어로 오므로,
 *   description 문자열 비교로 집계하면 같은 장르가 분산된다. id로 합산하고
 *   표시명(label)은 첫 등장한 description을 사용한다.
 *
 * 점수 산식:
 *   score = sum(matchedGenre.share) + W_CAT * sum(matchedCategory.share)
 *     W_CAT 기본 0.5. 단계 0 사전 측정 결과에 따라 조정 가능
 *     (작업 지시서 5절 단계 0 조정 룰).
 */

import type { SteamOwnedGame, SteamWishlistItem, SteamAppDetails } from "./types";

// ============================================================================
// 옵션
// ============================================================================

export interface AnalyzeOptions {
  /**
   * 카드 농사 상한 (분).
   * unplayedMax < pt < cardFarmingMaxMinutes 인 게임은 분석/추천 양쪽 제외.
   *
   * Steam 트레이딩 카드는 게임당 평균 2~5시간에 발급이 끝나므로
   * 기본값 180분(3시간)으로 보수적으로 잡는다. 사용자가 슬라이더로 조정 가능.
   */
  cardFarmingMaxMinutes: number;
  /**
   * 미플레이 상한 (분).
   * pt ≤ unplayedMaxMinutes 인 게임은 'unplayed'로 분류되어 추천 후보가 된다.
   *
   * 1시간 이하는 사용자 입장에서 "안 해본 거나 다름없음"으로 보고 60분 기본.
   * 정확히 0분만 미플레이로 보려면 슬라이더를 0으로 내린다.
   *
   * 제약: unplayedMaxMinutes ≤ cardFarmingMaxMinutes
   *   (validateAnalyzeOptions에서 강제, UI에서도 자동 클램프)
   */
  unplayedMaxMinutes: number;
  /** 무료 게임을 분석·추천 모두에서 제외 */
  excludeFree: boolean;
  /** 성향 상위 N개 (장르·카테고리 각각). 1 ≤ N ≤ 12 */
  topNTaste: number;
  /** 추천 개수 상한 (트랙별 각각 적용). 1 ≤ N ≤ 30 */
  maxRecommendationsPerTrack: number;
}

/**
 * 분석 옵션 기본값.
 *
 * 단계 0 사전 측정(scripts/measure-profile.ts) 결과가 부록 A의 조정 룰을
 * 트리거하면 이 값이 변경될 수 있다.
 */
export const DEFAULT_ANALYZE_OPTIONS: AnalyzeOptions = {
  cardFarmingMaxMinutes: 180,
  unplayedMaxMinutes: 60,
  excludeFree: false,
  topNTaste: 6,
  maxRecommendationsPerTrack: 12,
};

/**
 * 옵션 검증. 위반 시 throw Error.
 *
 * 핵심 제약: unplayedMaxMinutes ≤ cardFarmingMaxMinutes
 *   (이게 깨지면 classify의 두 구간이 겹쳐 정의가 무너진다)
 */
export function validateAnalyzeOptions(o: AnalyzeOptions): void {
  if (o.cardFarmingMaxMinutes < 0 || o.cardFarmingMaxMinutes > 1440) {
    throw new Error(`cardFarmingMaxMinutes out of range [0, 1440]: ${o.cardFarmingMaxMinutes}`);
  }
  if (o.unplayedMaxMinutes < 0 || o.unplayedMaxMinutes > 600) {
    throw new Error(`unplayedMaxMinutes out of range [0, 600]: ${o.unplayedMaxMinutes}`);
  }
  if (o.unplayedMaxMinutes > o.cardFarmingMaxMinutes) {
    throw new Error(
      `unplayedMaxMinutes (${o.unplayedMaxMinutes}) must be ≤ cardFarmingMaxMinutes (${o.cardFarmingMaxMinutes})`
    );
  }
  if (o.topNTaste < 1 || o.topNTaste > 12) {
    throw new Error(`topNTaste out of range [1, 12]: ${o.topNTaste}`);
  }
  if (o.maxRecommendationsPerTrack < 1 || o.maxRecommendationsPerTrack > 30) {
    throw new Error(`maxRecommendationsPerTrack out of range [1, 30]: ${o.maxRecommendationsPerTrack}`);
  }
}

// ============================================================================
// 입력 데이터 모델
// ============================================================================

export interface OwnedAnalyzedGame {
  appid: number;
  name: string;
  playtimeMinutes: number;
  recent2wMinutes: number;
  genreIds: string[];
  categoryIds: number[];
  /** id → description 매핑 (표시용). 같은 id의 description이 다르면 첫 등장 우선. */
  genreLabels: Record<string, string>;
  categoryLabels: Record<number, string>;
  isFree: boolean;
  headerImage?: string;
}

export interface WishlistAnalyzedGame {
  appid: number;
  name: string;
  priority: number;
  dateAddedUnix: number;
  genreIds: string[];
  categoryIds: number[];
  genreLabels: Record<string, string>;
  categoryLabels: Record<number, string>;
  isFree: boolean;
  headerImage?: string;
}

// ============================================================================
// 출력 데이터 모델
// ============================================================================

export interface TasteEntry {
  /** 매칭 키 (장르는 string, 카테고리는 number) */
  key: string | number;
  /** 표시명 (첫 등장한 description) */
  label: string;
  /** 누적 weight */
  weight: number;
  /** 차원(장르 또는 카테고리) 내 정규화 비율, sum=1.0 */
  share: number;
  /** 이 항목에 기여한 대표 게임 상위 3 */
  topGames: { appid: number; name: string; playtimeMinutes: number }[];
}

export interface TasteProfile {
  totalWeight: number;
  /** 'analyzed'로 분류되어 실제로 신호에 기여한 게임 수 */
  analyzedGames: number;
  cardFarmingExcluded: number;
  /** 'unplayed'로 분류된 게임 수 (라이브러리 미플레이 후보 풀 크기와 동일) */
  unplayedCount: number;
  /** 메타 누락(genres/categories 빈 배열)으로 분석에 기여 못한 'analyzed' 게임 수 */
  metaMissing: number;
  /** excludeFree=true 일 때 제외된 무료 게임 수 */
  excludedFree: number;
  genres: TasteEntry[];
  categories: TasteEntry[];
}

export interface Recommendation {
  appid: number;
  name: string;
  headerImage?: string;
  isFree: boolean;
  matchedGenres: { id: string; label: string }[];
  matchedCategories: { id: number; label: string }[];
  score: number;
  source: "library-unplayed" | "wishlist";
  /** 라이브러리 미플레이 후보일 때만 */
  playtimeMinutes?: number;
  /** 위시리스트 후보일 때만 */
  wishlistPriority?: number;
}

// ============================================================================
// 풀 분류
// ============================================================================

export type Classification = "unplayed" | "card-farming" | "analyzed" | "excluded-free";

/**
 * 게임을 정확히 하나의 풀로 분류한다.
 *
 * 우선순위 및 구간 (작업 지시서 3.2.3):
 *   1) excludeFree=true 이고 isFree=true     → 'excluded-free'
 *   2) 0 ≤ pt ≤ unplayedMaxMinutes           → 'unplayed'        (경계 포함)
 *   3) unplayedMaxMinutes < pt < cardFarmingMaxMinutes → 'card-farming'
 *   4) pt ≥ cardFarmingMaxMinutes            → 'analyzed'        (경계 포함)
 *
 * 두 슬라이더가 같으면 (unplayedMax == cardFarmingMax) 카드 농사 구간은
 * 빈 집합이 되어 분류는 'unplayed' 또는 'analyzed' 둘 뿐이다.
 *
 * 호출 측 책임: 사전에 validateAnalyzeOptions로 옵션을 검증할 것.
 */
export function classify(
  game: { playtimeMinutes: number; isFree: boolean },
  opts: AnalyzeOptions
): Classification {
  if (opts.excludeFree && game.isFree) return "excluded-free";
  const pt = game.playtimeMinutes;
  if (pt <= opts.unplayedMaxMinutes) return "unplayed";
  if (pt < opts.cardFarmingMaxMinutes) return "card-farming";
  return "analyzed";
}

// ============================================================================
// 성향 분석
// ============================================================================

/**
 * 라이브러리 게임만으로 성향 프로필을 추출한다. 위시리스트는 플레이타임이
 * 없어 신호가 없으므로 별도 함수(recommendFromWishlist)에서만 사용한다.
 *
 * 처리:
 *   1) classify로 각 게임을 분류, 카운트 누적.
 *   2) 'analyzed' 게임만 가중치(log(1+pt))를 장르·카테고리 id별로 누적.
 *      메타가 비어있는('genreIds.length === 0 && categoryIds.length === 0')
 *      'analyzed' 게임은 metaMissing 카운트.
 *   3) 각 차원에서 weight 내림차순 정렬 → topNTaste 컷 → share 정규화.
 *   4) 각 entry의 topGames는 가중치 기여 상위 3 게임 (playtime 내림차순 동률 처리).
 *
 * @returns 분석 풀이 0이거나 메타가 모두 누락이면 genres/categories 빈 배열.
 */
export function analyzeTaste(
  owned: OwnedAnalyzedGame[],
  opts: AnalyzeOptions
): TasteProfile {
  let analyzedGames = 0;
  let cardFarmingExcluded = 0;
  let unplayedCount = 0;
  let metaMissing = 0;
  let excludedFree = 0;
  let totalWeight = 0;

  // id → { label, weight, contributions[] }
  const genreAcc = new Map<string, { label: string; weight: number; contributions: { appid: number; name: string; playtimeMinutes: number; weight: number }[] }>();
  const catAcc = new Map<number, { label: string; weight: number; contributions: { appid: number; name: string; playtimeMinutes: number; weight: number }[] }>();

  for (const g of owned) {
    const cls = classify(g, opts);
    if (cls === "excluded-free") { excludedFree++; continue; }
    if (cls === "unplayed") { unplayedCount++; continue; }
    if (cls === "card-farming") { cardFarmingExcluded++; continue; }
    // 'analyzed'
    analyzedGames++;
    const hasMeta = g.genreIds.length > 0 || g.categoryIds.length > 0;
    if (!hasMeta) { metaMissing++; continue; }

    const w = Math.log(1 + g.playtimeMinutes);
    totalWeight += w;

    for (const id of g.genreIds) {
      const existing = genreAcc.get(id);
      if (existing) {
        existing.weight += w;
        existing.contributions.push({ appid: g.appid, name: g.name, playtimeMinutes: g.playtimeMinutes, weight: w });
      } else {
        // 첫 등장 description을 label로 채택 (작업 지시서 케이스 #15)
        const label = g.genreLabels[id] ?? id;
        genreAcc.set(id, { label, weight: w, contributions: [{ appid: g.appid, name: g.name, playtimeMinutes: g.playtimeMinutes, weight: w }] });
      }
    }
    for (const id of g.categoryIds) {
      const existing = catAcc.get(id);
      if (existing) {
        existing.weight += w;
        existing.contributions.push({ appid: g.appid, name: g.name, playtimeMinutes: g.playtimeMinutes, weight: w });
      } else {
        const label = g.categoryLabels[id] ?? String(id);
        catAcc.set(id, { label, weight: w, contributions: [{ appid: g.appid, name: g.name, playtimeMinutes: g.playtimeMinutes, weight: w }] });
      }
    }
  }

  return {
    totalWeight,
    analyzedGames,
    cardFarmingExcluded,
    unplayedCount,
    metaMissing,
    excludedFree,
    genres: buildTopEntries(genreAcc, opts.topNTaste),
    categories: buildTopEntries(catAcc, opts.topNTaste),
  };
}

/**
 * 가중치 맵을 상위 N개 TasteEntry로 변환하고 share를 정규화한다.
 *
 * 정규화 분모는 차원 내 누적 weight 합(전체 — topN 컷 후가 아닌 컷 전)을 쓴다.
 * 이렇게 해야 "상위 6개가 차원의 몇 %를 차지한다"가 의미를 가진다. 컷 후로
 * 정규화하면 항상 합이 1이 되어 "주요 장르 6개가 전체의 80%"같은 신호가 사라진다.
 *
 * 단, 작업 지시서 케이스 #8 "share 합=1.0"은 일관성을 위해 컷 후 정규화로
 * 한다. 즉 분모는 topN 안의 weight 합. (호출 측은 share를 차원 내 "상대" 비중
 * 으로만 해석해야 한다 — 차원 전체 대비 절대 비중은 weight를 직접 보라.)
 */
function buildTopEntries<K extends string | number>(
  acc: Map<K, { label: string; weight: number; contributions: { appid: number; name: string; playtimeMinutes: number; weight: number }[] }>,
  topN: number
): TasteEntry[] {
  // weight 내림차순 → 동률 시 key 오름차순(결정론)
  const sorted = Array.from(acc.entries()).sort((a, b) => {
    if (b[1].weight !== a[1].weight) return b[1].weight - a[1].weight;
    // 동률: key를 문자열로 비교
    return String(a[0]).localeCompare(String(b[0]));
  });
  const top = sorted.slice(0, topN);
  const topSum = top.reduce((s, [, v]) => s + v.weight, 0);
  return top.map(([key, v]) => ({
    key,
    label: v.label,
    weight: v.weight,
    share: topSum > 0 ? v.weight / topSum : 0,
    // topGames: contributions를 playtime 내림차순 정렬 후 상위 3
    topGames: v.contributions
      .slice()
      .sort((a, b) => b.playtimeMinutes - a.playtimeMinutes || a.appid - b.appid)
      .slice(0, 3)
      .map(c => ({ appid: c.appid, name: c.name, playtimeMinutes: c.playtimeMinutes })),
  }));
}

// ============================================================================
// 추천
// ============================================================================

/**
 * 카테고리 가중치.
 *
 * 단계 0 사전 측정 결과 (부록 A): 장르 엔트로피 2.962 ≥ 2.5 → 조정 룰에 따라
 * 0.5 → 0.3 하향. 장르 신호가 충분히 풍부하므로 카테고리(싱글/멀티/도전과제
 * 등 거의 보편적인 신호)의 영향을 줄였다.
 */
export const W_CAT = 0.3;

/**
 * 매칭 점수 계산. id 기반.
 *
 * @returns { score, matchedGenres, matchedCategories }
 */
function scoreAgainstProfile(
  candidate: { genreIds: string[]; categoryIds: number[]; genreLabels: Record<string, string>; categoryLabels: Record<number, string> },
  profile: TasteProfile
): { score: number; matchedGenres: { id: string; label: string }[]; matchedCategories: { id: number; label: string }[] } {
  let score = 0;
  const matchedGenres: { id: string; label: string }[] = [];
  const matchedCategories: { id: number; label: string }[] = [];

  // 장르 매칭
  const profileGenreMap = new Map(profile.genres.map(e => [String(e.key), e]));
  for (const id of candidate.genreIds) {
    const hit = profileGenreMap.get(id);
    if (hit) {
      score += hit.share;
      matchedGenres.push({ id, label: candidate.genreLabels[id] ?? hit.label });
    }
  }
  // 카테고리 매칭
  const profileCatMap = new Map(profile.categories.map(e => [Number(e.key), e]));
  for (const id of candidate.categoryIds) {
    const hit = profileCatMap.get(id);
    if (hit) {
      score += W_CAT * hit.share;
      matchedCategories.push({ id, label: candidate.categoryLabels[id] ?? hit.label });
    }
  }
  return { score, matchedGenres, matchedCategories };
}

/**
 * 트랙 A: classify가 'unplayed'로 분류한 후보(0 ≤ pt ≤ unplayedMax) 중에서
 * 성향 프로필과 일치하는 게임을 점수순으로 추천한다.
 *
 * 처리:
 *   - 후보 = classify(g, opts) === 'unplayed' 인 game (excludeFree 자동 적용)
 *   - 각 후보의 (genreIds, categoryIds)를 profile.genres/categories와 매칭
 *   - score = sum(matchedGenre.share) + W_CAT * sum(matchedCategory.share)
 *   - score=0(매칭 없음)인 후보는 제외
 *   - 정렬: score 내림차순 → playtime 내림차순(같은 점수면 그래도 더 가까운 것) → appid 오름차순
 *   - 상한: maxRecommendationsPerTrack
 *
 * 분석 풀이 0이면 모든 후보의 score가 0이라 빈 배열.
 */
export function recommendLibraryUnplayed(
  owned: OwnedAnalyzedGame[],
  profile: TasteProfile,
  opts: AnalyzeOptions
): Recommendation[] {
  const results: Recommendation[] = [];
  for (const g of owned) {
    if (classify(g, opts) !== "unplayed") continue;
    const { score, matchedGenres, matchedCategories } = scoreAgainstProfile(g, profile);
    // 메타 누락 후보(genreIds=[], categoryIds=[])는 score=0이 되어 여기서 탈락.
    // 작업 지시서 케이스 #6 — "메타 누락 게임은 추천 후보 자격 박탈".
    if (score <= 0) continue;
    results.push({
      appid: g.appid,
      name: g.name,
      headerImage: g.headerImage,
      isFree: g.isFree,
      matchedGenres,
      matchedCategories,
      score,
      source: "library-unplayed",
      playtimeMinutes: g.playtimeMinutes,
    });
  }
  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // 동률 — playtime 내림차순(같은 점수면 살짝이라도 친숙한 것 우선)
    const ap = a.playtimeMinutes ?? 0;
    const bp = b.playtimeMinutes ?? 0;
    if (bp !== ap) return bp - ap;
    return a.appid - b.appid;
  });
  return results.slice(0, opts.maxRecommendationsPerTrack);
}

/**
 * 트랙 B: 위시리스트 게임 중 성향과 일치하는 것을 추천한다.
 *
 * 위시리스트 자체는 플레이타임이 없으므로 모든 위시리스트 게임이 후보.
 * 단 excludeFree=true 면 무료 게임 제외 (위시리스트에 무료 게임이 들어오는
 * 경우는 드물지만 가능).
 *
 * 정렬: score 내림차순 → priority 오름차순(낮은 숫자가 더 갖고 싶은 것)
 *      → dateAddedUnix 내림차순(최근 추가 우선) → appid 오름차순.
 */
export function recommendFromWishlist(
  wishlist: WishlistAnalyzedGame[],
  profile: TasteProfile,
  opts: AnalyzeOptions
): Recommendation[] {
  const results: Recommendation[] = [];
  for (const g of wishlist) {
    if (opts.excludeFree && g.isFree) continue;
    const { score, matchedGenres, matchedCategories } = scoreAgainstProfile(g, profile);
    if (score <= 0) continue;
    results.push({
      appid: g.appid,
      name: g.name,
      headerImage: g.headerImage,
      isFree: g.isFree,
      matchedGenres,
      matchedCategories,
      score,
      source: "wishlist",
      wishlistPriority: g.priority,
    });
  }
  // 위시리스트는 후처리에서 priority 활용 가능하도록 원본 priority/dateAdded 유지
  // (현재 Recommendation에는 priority만 보존, dateAdded는 정렬에만 사용)
  const dateMap = new Map(wishlist.map(g => [g.appid, g.dateAddedUnix]));
  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ap = a.wishlistPriority ?? Number.MAX_SAFE_INTEGER;
    const bp = b.wishlistPriority ?? Number.MAX_SAFE_INTEGER;
    if (ap !== bp) return ap - bp;
    const ad = dateMap.get(a.appid) ?? 0;
    const bd = dateMap.get(b.appid) ?? 0;
    if (bd !== ad) return bd - ad;
    return a.appid - b.appid;
  });
  return results.slice(0, opts.maxRecommendationsPerTrack);
}

// ============================================================================
// 결합 헬퍼 (Steam API 응답 → 분석 입력)
// ============================================================================

/**
 * SteamOwnedGame + 메타 맵 → OwnedAnalyzedGame.
 * 메타가 없으면 빈 배열 fallback (분석 통과, 점수 0 기여).
 *
 * 호출 측에서 한 차례에 결합하여 분석 함수에 넘긴다.
 */
export function buildOwnedAnalyzedGame(
  owned: SteamOwnedGame,
  details: SteamAppDetails | null
): OwnedAnalyzedGame {
  const genres = details?.genres ?? [];
  const categories = details?.categories ?? [];
  const genreLabels: Record<string, string> = {};
  const categoryLabels: Record<number, string> = {};
  for (const g of genres) genreLabels[g.id] = g.description;
  for (const c of categories) categoryLabels[c.id] = c.description;
  return {
    appid: owned.appid,
    name: owned.name || details?.name || `AppID ${owned.appid}`,
    playtimeMinutes: owned.playtime_forever,
    recent2wMinutes: owned.playtime_2weeks ?? 0,
    genreIds: genres.map(g => g.id),
    categoryIds: categories.map(c => c.id),
    genreLabels,
    categoryLabels,
    isFree: details?.is_free ?? false,
    headerImage: details?.header_image,
  };
}

/**
 * SteamWishlistItem + 메타 맵 → WishlistAnalyzedGame.
 *
 * 위시리스트 응답은 name이 없어 details에서 가져온다. 메타 조회 실패 시
 * name은 "AppID {appid}" fallback (UI에서 그래도 표시 가능).
 */
export function buildWishlistAnalyzedGame(
  item: SteamWishlistItem,
  details: SteamAppDetails | null
): WishlistAnalyzedGame {
  const genres = details?.genres ?? [];
  const categories = details?.categories ?? [];
  const genreLabels: Record<string, string> = {};
  const categoryLabels: Record<number, string> = {};
  for (const g of genres) genreLabels[g.id] = g.description;
  for (const c of categories) categoryLabels[c.id] = c.description;
  return {
    appid: item.appid,
    name: details?.name ?? `AppID ${item.appid}`,
    priority: item.priority,
    dateAddedUnix: item.date_added,
    genreIds: genres.map(g => g.id),
    categoryIds: categories.map(c => c.id),
    genreLabels,
    categoryLabels,
    isFree: details?.is_free ?? false,
    headerImage: details?.header_image,
  };
}
