/**
 * 성향 분석 + 추천 단위 테스트.
 *
 * 작업 지시서 3.7의 15개 케이스를 모두 커버한다.
 *
 * 핵심 검증:
 *   - classify 규칙의 세 구간 경계 (#14)
 *   - id 기반 매칭 (cc=KR 한국어 description에 비의존, #15)
 *   - 로그 가중치로 극단값 분산 (#5)
 *   - 옵션 검증 (#13)
 *   - 추천 동률 정렬 (#9, #11)
 *   - 두 트랙 통합 동작 (#11, #12)
 */

import { describe, it, expect } from "vitest";
import {
  analyzeTaste,
  recommendLibraryUnplayed,
  recommendFromWishlist,
  validateAnalyzeOptions,
  classify,
  computeReviewScore,
  buildReviewBadge,
  blendRecommendations,
  W_MATCH,
  W_REVIEW,
  DEFAULT_ANALYZE_OPTIONS,
  type OwnedAnalyzedGame,
  type WishlistAnalyzedGame,
  type AnalyzeOptions,
  type Recommendation,
} from "@/lib/steam/profile";

// ============================================================================
// 테스트 헬퍼 — 짧게 OwnedAnalyzedGame 만들기
// ============================================================================

function owned(args: Partial<OwnedAnalyzedGame> & { appid: number; playtime: number }): OwnedAnalyzedGame {
  const genreIds = args.genreIds ?? [];
  const categoryIds = args.categoryIds ?? [];
  return {
    appid: args.appid,
    name: args.name ?? `Game ${args.appid}`,
    playtimeMinutes: args.playtime,
    recent2wMinutes: args.recent2wMinutes ?? 0,
    genreIds,
    categoryIds,
    genreLabels: args.genreLabels ?? Object.fromEntries(genreIds.map(id => [id, `Genre ${id}`])),
    categoryLabels: args.categoryLabels ?? Object.fromEntries(categoryIds.map(id => [id, `Cat ${id}`])),
    isFree: args.isFree ?? false,
    headerImage: args.headerImage,
  };
}

function wish(args: Partial<WishlistAnalyzedGame> & { appid: number }): WishlistAnalyzedGame {
  const genreIds = args.genreIds ?? [];
  const categoryIds = args.categoryIds ?? [];
  return {
    appid: args.appid,
    name: args.name ?? `Wishlist ${args.appid}`,
    priority: args.priority ?? 0,
    dateAddedUnix: args.dateAddedUnix ?? 0,
    genreIds,
    categoryIds,
    genreLabels: args.genreLabels ?? Object.fromEntries(genreIds.map(id => [id, `Genre ${id}`])),
    categoryLabels: args.categoryLabels ?? Object.fromEntries(categoryIds.map(id => [id, `Cat ${id}`])),
    isFree: args.isFree ?? false,
    headerImage: args.headerImage,
  };
}

const opts = (o: Partial<AnalyzeOptions> = {}): AnalyzeOptions => ({
  ...DEFAULT_ANALYZE_OPTIONS,
  ...o,
});

// ============================================================================
// 케이스 1: 빈 라이브러리
// ============================================================================

describe("케이스 1: 빈 라이브러리", () => {
  it("analyzedGames=0, genres/categories 빈 배열, 두 트랙 빈 배열", () => {
    const profile = analyzeTaste([], opts());
    expect(profile.analyzedGames).toBe(0);
    expect(profile.genres).toHaveLength(0);
    expect(profile.categories).toHaveLength(0);
    expect(recommendLibraryUnplayed([], profile, opts())).toHaveLength(0);
    expect(recommendFromWishlist([], profile, opts())).toHaveLength(0);
  });
});

// ============================================================================
// 케이스 2: 모두 pt=30 (기본 unplayedMax=60) → unplayed 5게임, 분석 풀=0
// ============================================================================

describe("케이스 2: 모두 pt=30, default options", () => {
  it("30 ≤ 60 → 'unplayed' 5게임, analyzedGames=0, 트랙 A 후보 풀 5 but 점수 0", () => {
    const games = [1, 2, 3, 4, 5].map(i => owned({ appid: i, playtime: 30, genreIds: ["1"] }));
    const profile = analyzeTaste(games, opts());
    expect(profile.unplayedCount).toBe(5);
    expect(profile.cardFarmingExcluded).toBe(0);
    expect(profile.analyzedGames).toBe(0);
    // 분석 풀이 0 → profile.genres 빈 배열 → score 0 → 빈 추천
    expect(recommendLibraryUnplayed(games, profile, opts())).toHaveLength(0);
  });
});

// ============================================================================
// 케이스 3: 모두 pt=30, unplayedMax=0, cardMax=0 → 모두 analyzed
// ============================================================================

describe("케이스 3: 모두 pt=30, unplayedMax=0, cardMax=0", () => {
  it("모든 게임이 'analyzed', cardFarmingExcluded=0", () => {
    const games = [1, 2, 3, 4, 5].map(i => owned({ appid: i, playtime: 30, genreIds: ["1"] }));
    const profile = analyzeTaste(games, opts({ unplayedMaxMinutes: 0, cardFarmingMaxMinutes: 0 }));
    expect(profile.cardFarmingExcluded).toBe(0);
    expect(profile.unplayedCount).toBe(0);
    expect(profile.analyzedGames).toBe(5);
  });
});

// ============================================================================
// 케이스 4: pt=0 게임 다수 → unplayed 풀 후보
// ============================================================================

describe("케이스 4: pt=0 게임 다수", () => {
  it("unplayedCount 정확, 트랙 A 후보 풀에 들어감", () => {
    const games = [
      owned({ appid: 100, playtime: 0, genreIds: ["1"] }),
      owned({ appid: 101, playtime: 0, genreIds: ["2"] }),
      owned({ appid: 200, playtime: 500, genreIds: ["1"] }), // 분석 신호
    ];
    const profile = analyzeTaste(games, opts());
    expect(profile.unplayedCount).toBe(2);
    expect(profile.analyzedGames).toBe(1);
    // 장르 "1" 신호 형성 → pt=0 + 장르 "1" 게임이 추천에 진입
    const recs = recommendLibraryUnplayed(games, profile, opts());
    expect(recs.some(r => r.appid === 100)).toBe(true);
    expect(recs.some(r => r.appid === 101)).toBe(false); // 장르 "2"는 매칭 없음
  });
});

// ============================================================================
// 케이스 5: 로그 가중치로 극단값 분산
// ============================================================================

describe("케이스 5: 1게임 1000h + 5게임 10h 로그 가중치", () => {
  it("1000h 단일 게임이 장르 share를 압도하지 않는다 (60% 미만)", () => {
    // 1000h 게임은 장르 A 전용, 10h 5개 게임은 장르 B 전용
    // 로그 가중치 없이 선형이면 A가 1000*60 / (1000*60 + 50*60) = 95%로 압도
    // log(1+pt)로 가중치하면 A는 log(60001) ≈ 11.0, B 5개 합은 5 * log(601) ≈ 32.0
    // → B가 오히려 우위
    const games = [
      owned({ appid: 1, playtime: 60000, genreIds: ["A"] }), // 1000시간
      ...[2, 3, 4, 5, 6].map(i => owned({ appid: i, playtime: 600, genreIds: ["B"] })), // 10시간씩
    ];
    const profile = analyzeTaste(games, opts());
    expect(profile.analyzedGames).toBe(6);
    const a = profile.genres.find(e => e.key === "A");
    const b = profile.genres.find(e => e.key === "B");
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    // A의 share가 60% 미만 (실제로는 ~25%)
    expect(a!.share).toBeLessThan(0.6);
    // 두 share 합이 1.0 (이 차원에 두 장르만 존재)
    expect(a!.share + b!.share).toBeCloseTo(1.0, 9);
  });
});

// ============================================================================
// 케이스 6: 메타 누락 게임
// ============================================================================

describe("케이스 6: genres/categories 메타 누락", () => {
  it("metaMissing 카운트, 분석은 통과(0 기여), 추천 후보 자격 박탈", () => {
    const games = [
      owned({ appid: 1, playtime: 500, genreIds: [], categoryIds: [] }), // 메타 없음, analyzed
      owned({ appid: 2, playtime: 0, genreIds: [], categoryIds: [] }),   // 메타 없음, unplayed
      owned({ appid: 3, playtime: 500, genreIds: ["X"] }),               // 정상 신호
    ];
    const profile = analyzeTaste(games, opts());
    expect(profile.analyzedGames).toBe(2);
    expect(profile.metaMissing).toBe(1);
    expect(profile.genres.length).toBe(1); // "X"만
    // appid=2는 메타가 없어서 매칭 0 → 추천 후보지만 score 0 → 추천 안 됨
    const recs = recommendLibraryUnplayed(games, profile, opts());
    expect(recs.some(r => r.appid === 2)).toBe(false);
  });
});

// ============================================================================
// 케이스 7: excludeFree
// ============================================================================

describe("케이스 7: excludeFree", () => {
  it("무료 게임이 분석·트랙 A·트랙 B 모두에서 제외", () => {
    const owns = [
      owned({ appid: 1, playtime: 500, genreIds: ["X"], isFree: true }),  // 분석에서 빠짐
      owned({ appid: 2, playtime: 500, genreIds: ["X"], isFree: false }), // 분석 신호
      owned({ appid: 3, playtime: 0, genreIds: ["X"], isFree: true }),    // 트랙 A에서 빠짐
      owned({ appid: 4, playtime: 0, genreIds: ["X"], isFree: false }),   // 트랙 A 후보
    ];
    const ws = [
      wish({ appid: 11, genreIds: ["X"], isFree: true }),  // 트랙 B에서 빠짐
      wish({ appid: 12, genreIds: ["X"], isFree: false }), // 트랙 B 후보
    ];
    const o = opts({ excludeFree: true });
    const profile = analyzeTaste(owns, o);
    expect(profile.excludedFree).toBe(2); // appid 1, 3
    expect(profile.analyzedGames).toBe(1); // appid 2

    const ar = recommendLibraryUnplayed(owns, profile, o);
    expect(ar.some(r => r.appid === 3)).toBe(false); // 무료 제외
    expect(ar.some(r => r.appid === 4)).toBe(true);

    const br = recommendFromWishlist(ws, profile, o);
    expect(br.some(r => r.appid === 11)).toBe(false); // 무료 제외
    expect(br.some(r => r.appid === 12)).toBe(true);
  });
});

// ============================================================================
// 케이스 8: share 정규화
// ============================================================================

describe("케이스 8: share 정규화", () => {
  it("차원별 share 합 = 1.0 (ε=1e-9)", () => {
    const games = [
      owned({ appid: 1, playtime: 1000, genreIds: ["A", "B"], categoryIds: [1, 2] }),
      owned({ appid: 2, playtime: 2000, genreIds: ["B", "C"], categoryIds: [2, 3] }),
      owned({ appid: 3, playtime: 500, genreIds: ["A"], categoryIds: [1] }),
    ];
    const profile = analyzeTaste(games, opts());
    const gSum = profile.genres.reduce((s, e) => s + e.share, 0);
    const cSum = profile.categories.reduce((s, e) => s + e.share, 0);
    expect(gSum).toBeCloseTo(1.0, 9);
    expect(cSum).toBeCloseTo(1.0, 9);
  });
});

// ============================================================================
// 케이스 9: 추천 동률 정렬
// ============================================================================

describe("케이스 9: 추천 동률 정렬", () => {
  it("score 동일 시 playtime 내림차순 → appid 오름차순", () => {
    // 분석 풀: 장르 "X" 신호 만들기
    const analyzed = owned({ appid: 999, playtime: 1000, genreIds: ["X"] });
    // 후보 풀 (pt=0): 모두 장르 "X" 만 매칭 → 같은 score, playtime 모두 0
    //   → appid 오름차순
    const candidates = [
      owned({ appid: 50, playtime: 0, genreIds: ["X"] }),
      owned({ appid: 30, playtime: 0, genreIds: ["X"] }),
      owned({ appid: 70, playtime: 0, genreIds: ["X"] }),
    ];
    const profile = analyzeTaste([analyzed, ...candidates], opts());
    const recs = recommendLibraryUnplayed([analyzed, ...candidates], profile, opts());
    expect(recs.map(r => r.appid)).toEqual([30, 50, 70]);
  });
});

// ============================================================================
// 케이스 10: topNTaste cutoff
// ============================================================================

describe("케이스 10: topNTaste=3", () => {
  it("정확히 3개 반환", () => {
    // 6개의 서로 다른 장르 신호
    const games = ["A", "B", "C", "D", "E", "F"].map((g, i) =>
      owned({ appid: i + 1, playtime: 1000 - i * 100, genreIds: [g] })
    );
    const profile = analyzeTaste(games, opts({ topNTaste: 3 }));
    expect(profile.genres).toHaveLength(3);
    // weight 내림차순 → A, B, C
    expect(profile.genres.map(e => e.key)).toEqual(["A", "B", "C"]);
  });
});

// ============================================================================
// 케이스 11: 위시리스트 추천
// ============================================================================

describe("케이스 11: 위시리스트 추천 정렬", () => {
  it("score 동률 시 priority 오름차순 (낮은 숫자 = 더 갖고 싶음)", () => {
    // 라이브러리에서 장르 "X" 신호 형성
    const owns = [owned({ appid: 999, playtime: 1000, genreIds: ["X"] })];
    const ws = [
      wish({ appid: 1, genreIds: ["X"], priority: 5 }),
      wish({ appid: 2, genreIds: ["X"], priority: 2 }), // 더 갖고 싶음
      wish({ appid: 3, genreIds: ["X"], priority: 8 }),
    ];
    const profile = analyzeTaste(owns, opts());
    const recs = recommendFromWishlist(ws, profile, opts());
    expect(recs.map(r => r.appid)).toEqual([2, 1, 3]);
    expect(recs.every(r => r.source === "wishlist")).toBe(true);
  });

  it("매칭 없는 위시리스트 게임은 제외", () => {
    const owns = [owned({ appid: 999, playtime: 1000, genreIds: ["X"] })];
    const ws = [
      wish({ appid: 1, genreIds: ["X"] }), // 매칭
      wish({ appid: 2, genreIds: ["Y"] }), // 매칭 없음
    ];
    const profile = analyzeTaste(owns, opts());
    const recs = recommendFromWishlist(ws, profile, opts());
    expect(recs.map(r => r.appid)).toEqual([1]);
  });
});

// ============================================================================
// 케이스 12: 라이브러리 분석 풀 = 0이면 트랙 B도 빈 배열
// ============================================================================

describe("케이스 12: 분석 풀=0 + 위시리스트 존재", () => {
  it("profile.genres 빈 배열 → 모든 위시리스트 score 0 → 트랙 B 빈 배열", () => {
    const owns: OwnedAnalyzedGame[] = []; // 빈 라이브러리
    const ws = [wish({ appid: 1, genreIds: ["X"] })];
    const profile = analyzeTaste(owns, opts());
    expect(profile.analyzedGames).toBe(0);
    const recs = recommendFromWishlist(ws, profile, opts());
    expect(recs).toHaveLength(0);
  });
});

// ============================================================================
// 케이스 13: validateAnalyzeOptions
// ============================================================================

describe("케이스 13: validateAnalyzeOptions", () => {
  it("정상 옵션은 throw 안 함", () => {
    expect(() => validateAnalyzeOptions(DEFAULT_ANALYZE_OPTIONS)).not.toThrow();
  });
  it("unplayedMax > cardFarmingMax 위반 시 throw", () => {
    expect(() =>
      validateAnalyzeOptions({ ...DEFAULT_ANALYZE_OPTIONS, unplayedMaxMinutes: 200, cardFarmingMaxMinutes: 100 })
    ).toThrow(/unplayedMaxMinutes.*must be.*cardFarmingMaxMinutes/);
  });
  it("cardFarmingMax 범위 위반 시 throw", () => {
    expect(() =>
      validateAnalyzeOptions({ ...DEFAULT_ANALYZE_OPTIONS, cardFarmingMaxMinutes: -1 })
    ).toThrow(/cardFarmingMaxMinutes/);
    expect(() =>
      validateAnalyzeOptions({ ...DEFAULT_ANALYZE_OPTIONS, cardFarmingMaxMinutes: 1441 })
    ).toThrow(/cardFarmingMaxMinutes/);
  });
  it("unplayedMax 범위 위반 시 throw", () => {
    expect(() =>
      validateAnalyzeOptions({ ...DEFAULT_ANALYZE_OPTIONS, unplayedMaxMinutes: -1 })
    ).toThrow(/unplayedMaxMinutes/);
    expect(() =>
      validateAnalyzeOptions({ ...DEFAULT_ANALYZE_OPTIONS, unplayedMaxMinutes: 601 })
    ).toThrow(/unplayedMaxMinutes/);
  });
  it("topNTaste 범위 위반 시 throw", () => {
    expect(() =>
      validateAnalyzeOptions({ ...DEFAULT_ANALYZE_OPTIONS, topNTaste: 0 })
    ).toThrow(/topNTaste/);
    expect(() =>
      validateAnalyzeOptions({ ...DEFAULT_ANALYZE_OPTIONS, topNTaste: 13 })
    ).toThrow(/topNTaste/);
  });
  it("maxRecommendationsPerTrack 범위 위반 시 throw", () => {
    expect(() =>
      validateAnalyzeOptions({ ...DEFAULT_ANALYZE_OPTIONS, maxRecommendationsPerTrack: 0 })
    ).toThrow(/maxRecommendationsPerTrack/);
    expect(() =>
      validateAnalyzeOptions({ ...DEFAULT_ANALYZE_OPTIONS, maxRecommendationsPerTrack: 31 })
    ).toThrow(/maxRecommendationsPerTrack/);
  });
});

// ============================================================================
// 케이스 14: classify 경계값
// ============================================================================

describe("케이스 14: classify 경계값 (unplayedMax=60, cardMax=180)", () => {
  const o = opts({ unplayedMaxMinutes: 60, cardFarmingMaxMinutes: 180 });

  it("pt=0 → 'unplayed'", () => {
    expect(classify({ playtimeMinutes: 0, isFree: false }, o)).toBe("unplayed");
  });
  it("pt=60 → 'unplayed' (경계 포함)", () => {
    expect(classify({ playtimeMinutes: 60, isFree: false }, o)).toBe("unplayed");
  });
  it("pt=61 → 'card-farming'", () => {
    expect(classify({ playtimeMinutes: 61, isFree: false }, o)).toBe("card-farming");
  });
  it("pt=179 → 'card-farming' (cardMax 미만)", () => {
    expect(classify({ playtimeMinutes: 179, isFree: false }, o)).toBe("card-farming");
  });
  it("pt=180 → 'analyzed' (cardMax 경계 포함)", () => {
    expect(classify({ playtimeMinutes: 180, isFree: false }, o)).toBe("analyzed");
  });
  it("pt=1000 → 'analyzed'", () => {
    expect(classify({ playtimeMinutes: 1000, isFree: false }, o)).toBe("analyzed");
  });
  it("두 슬라이더 같으면 (60/60) 카드 농사 구간 빈 집합", () => {
    const eq = opts({ unplayedMaxMinutes: 60, cardFarmingMaxMinutes: 60 });
    expect(classify({ playtimeMinutes: 60, isFree: false }, eq)).toBe("unplayed");
    expect(classify({ playtimeMinutes: 61, isFree: false }, eq)).toBe("analyzed");
  });
  it("excludeFree=true 우선 처리", () => {
    const ef = opts({ excludeFree: true });
    expect(classify({ playtimeMinutes: 1000, isFree: true }, ef)).toBe("excluded-free");
  });
});

// ============================================================================
// 케이스 15: id 기반 매칭 (description 언어 무관)
// ============================================================================

describe("케이스 15: id 기반 매칭, 표시 label은 첫 등장", () => {
  it("같은 id의 description이 한국어/영어로 섞여 와도 매칭은 id로 합산", () => {
    // 같은 장르 id "1"인데 게임마다 description이 다름 (시뮬레이션)
    const games = [
      owned({ appid: 1, playtime: 500, genreIds: ["1"], genreLabels: { "1": "Action" } }),
      owned({ appid: 2, playtime: 500, genreIds: ["1"], genreLabels: { "1": "액션" } }),
      owned({ appid: 3, playtime: 500, genreIds: ["1"], genreLabels: { "1": "アクション" } }),
    ];
    const profile = analyzeTaste(games, opts());
    expect(profile.genres).toHaveLength(1);
    expect(profile.genres[0].key).toBe("1");
    // 첫 등장한 게임의 description ("Action") 채택
    expect(profile.genres[0].label).toBe("Action");
    // 3게임 모두 합산되어 가중치가 큼 (단일 항목이므로 share=1.0)
    expect(profile.genres[0].share).toBeCloseTo(1.0, 9);
  });

  it("후보의 label도 후보 자신의 genreLabels 우선 (없으면 profile label)", () => {
    const analyzed = owned({ appid: 999, playtime: 1000, genreIds: ["1"], genreLabels: { "1": "Action" } });
    const candidate = owned({ appid: 1, playtime: 0, genreIds: ["1"], genreLabels: { "1": "액션" } });
    const profile = analyzeTaste([analyzed, candidate], opts());
    const recs = recommendLibraryUnplayed([analyzed, candidate], profile, opts());
    expect(recs).toHaveLength(1);
    // 후보가 가진 label "액션"을 노출 (사용자가 보기에 같은 페이지의 다른 카드와 일관)
    expect(recs[0].matchedGenres[0].label).toBe("액션");
  });
});

// ============================================================================
// 케이스 16: 코사인 정규화 — 다태그 편향 제거 (작업 지시서 단계 1, 케이스 A)
// ============================================================================

describe("케이스 16: 코사인 정규화 다태그 편향 제거", () => {
  it("동일 매칭(G1,G2)이면 태그 수 많은 후보가 ‖b‖ 패널티로 더 낮은 matchScore", () => {
    // 프로필: 장르 G1(share 0.6), G2(share 0.4) 형성.
    //   두 장르에 서로 다른 가중치를 주려고 playtime을 다르게 설정한다.
    //   (share 절대값은 검증 대상이 아니라 X/Y 상대 순위만 본다)
    const g1Signal = owned({ appid: 900, playtime: 60000, genreIds: ["G1"] }); // 큰 가중
    const g2Signal = owned({ appid: 901, playtime: 600, genreIds: ["G2"] });   // 작은 가중
    // 후보 X: 2태그(G1,G2 둘 다 매칭). 후보 Y: 6태그(G1,G2 매칭 + 프로필 밖 N1~N4).
    const x = owned({ appid: 1, playtime: 0, genreIds: ["G1", "G2"] });
    const y = owned({ appid: 2, playtime: 0, genreIds: ["G1", "G2", "N1", "N2", "N3", "N4"] });
    const games = [g1Signal, g2Signal, x, y];
    const profile = analyzeTaste(games, opts());
    const recs = recommendLibraryUnplayed(games, profile, opts());
    const rx = recs.find(r => r.appid === 1)!;
    const ry = recs.find(r => r.appid === 2)!;
    expect(rx).toBeDefined();
    expect(ry).toBeDefined();
    // dot은 동일(G1,G2 share 합)이나 ‖b_X‖=√2 < ‖b_Y‖=√6 → X가 우위.
    expect(rx.matchScore).toBeGreaterThan(ry.matchScore);
    // 정렬 결과도 X가 Y보다 앞.
    expect(recs.findIndex(r => r.appid === 1)).toBeLessThan(recs.findIndex(r => r.appid === 2));
  });
});

// ============================================================================
// 케이스 17: 코사인 [0,1] 유계 — 카테고리 편중 (작업 지시서 케이스 B, C-NEW 회귀)
// ============================================================================

describe("케이스 17: matchScore [0,1] 유계 (카테고리 포함)", () => {
  it("카테고리 단일 차원 완전 정렬 시 matchScore=1.0 (3.33 폭주 회귀 가드)", () => {
    // 프로필: 카테고리 C1만 (share=1.0), 장르 없음.
    const signal = owned({ appid: 900, playtime: 1000, categoryIds: [1] });
    // 후보 Z: 카테고리 C1만 → dot=W_CAT, ‖a‖=W_CAT, ‖b‖=1 → matchScore=1.0.
    const z = owned({ appid: 1, playtime: 0, categoryIds: [1] });
    const games = [signal, z];
    const profile = analyzeTaste(games, opts());
    const recs = recommendLibraryUnplayed(games, profile, opts());
    const rz = recs.find(r => r.appid === 1)!;
    expect(rz).toBeDefined();
    // dot의 W_CAT¹와 norm의 W_CAT²가 어긋나면 여기서 3.33이 되어 실패한다.
    expect(rz.matchScore).toBeCloseTo(1.0, 9);
  });

  it("장르+카테고리 혼합 매칭도 matchScore ≤ 1.0", () => {
    const games = [
      owned({ appid: 900, playtime: 1000, genreIds: ["A", "B"], categoryIds: [1, 2] }),
      owned({ appid: 901, playtime: 2000, genreIds: ["B", "C"], categoryIds: [2, 3] }),
      owned({ appid: 1, playtime: 0, genreIds: ["A", "B", "C"], categoryIds: [1, 2, 3] }),
    ];
    const profile = analyzeTaste(games, opts());
    const recs = recommendLibraryUnplayed(games, profile, opts());
    for (const r of recs) {
      expect(r.matchScore).toBeGreaterThan(0);
      expect(r.matchScore).toBeLessThanOrEqual(1.0 + 1e-9);
    }
  });
});

// ============================================================================
// 케이스 18: computeReviewScore — 호평률 정규화 (작업 지시서 2-2)
// ============================================================================

describe("케이스 18: computeReviewScore", () => {
  it("요약 없음/표본 0 → 중립 0.5", () => {
    expect(computeReviewScore(null)).toBe(0.5);
    expect(computeReviewScore({ totalPositive: 0, totalReviews: 0 })).toBe(0.5);
  });
  it("표본 충분(≥50) 100% 호평 → 1.0, 0% 호평 → 0.0", () => {
    expect(computeReviewScore({ totalPositive: 100, totalReviews: 100 })).toBeCloseTo(1.0, 9);
    expect(computeReviewScore({ totalPositive: 0, totalReviews: 100 })).toBeCloseTo(0.0, 9);
  });
  it("표본 부족(10개) 100% 호평 → confidence=0.2로 0.5쪽 수축 (0.6)", () => {
    // positiveRatio=1.0, confidence=10/50=0.2 → 0.5 + 0.5·0.2 = 0.6
    expect(computeReviewScore({ totalPositive: 10, totalReviews: 10 })).toBeCloseTo(0.6, 9);
  });
  it("모든 반환값이 [0,1] 유계", () => {
    const cases = [
      { totalPositive: 3, totalReviews: 7 },
      { totalPositive: 45, totalReviews: 50 },
      { totalPositive: 1, totalReviews: 1000 },
    ];
    for (const c of cases) {
      const s = computeReviewScore(c);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });
  it("totalPositive > totalReviews(이상 데이터)여도 [0,1] 클램프 (code-review #1)", () => {
    // Steam filter=all이 total_reviews < total_positive를 줄 수 있는 케이스.
    // positiveRatio=1.2 → 클램프 1.0 → 0.5+(1.0-0.5)*1.0 = 1.0
    const s = computeReviewScore({ totalPositive: 120, totalReviews: 100 });
    expect(s).toBeLessThanOrEqual(1);
    expect(s).toBeCloseTo(1.0, 9);
  });
});

// ============================================================================
// 케이스 20: buildReviewBadge — 표시용 배지 (UI 호평률 배지)
// ============================================================================

describe("케이스 20: buildReviewBadge", () => {
  const summary = (totalPositive: number, totalReviews: number) => ({
    reviewScore: 0,
    reviewScoreDesc: "",
    totalPositive,
    totalNegative: totalReviews - totalPositive,
    totalReviews,
  });

  it("요약 없음/표본 0 → null (배지 미표시)", () => {
    expect(buildReviewBadge(null)).toBeNull();
    expect(buildReviewBadge(summary(0, 0))).toBeNull();
  });
  it("호평 비율을 반올림 %로, 표본 수를 그대로 담는다", () => {
    // 920/1000 = 92%
    expect(buildReviewBadge(summary(920, 1000))).toEqual({ positivePercent: 92, totalReviews: 1000 });
    // 2/3 = 66.67 → 67 (반올림)
    expect(buildReviewBadge(summary(2, 3))).toEqual({ positivePercent: 67, totalReviews: 3 });
    // 100% / 0%
    expect(buildReviewBadge(summary(50, 50))!.positivePercent).toBe(100);
    expect(buildReviewBadge(summary(0, 40))!.positivePercent).toBe(0);
  });
  it("totalPositive > totalReviews여도 positivePercent ≤ 100 클램프 (code-review #1)", () => {
    // 클램프 없으면 '호평 120%' 배지가 표시됨.
    expect(buildReviewBadge(summary(120, 100))!.positivePercent).toBe(100);
  });
});

// ============================================================================
// 케이스 19: blendRecommendations — 리뷰 블렌딩 재랭킹 (작업 지시서 2-3/2-4)
// ============================================================================

describe("케이스 19: blendRecommendations", () => {
  const rec = (args: Partial<Recommendation> & { appid: number; matchScore: number }): Recommendation => ({
    name: `Game ${args.appid}`,
    isFree: false,
    matchedGenres: [],
    matchedCategories: [],
    score: args.matchScore, // 기본 score = matchScore. args에 score 있으면 스프레드가 덮음
    source: "library-unplayed",
    playtimeMinutes: 0,
    // appid, matchScore(및 명시된 나머지)는 스프레드로 주입 — 중복 지정 없이 오버라이드
    ...args,
  });

  it("finalScore = W_MATCH·matchScore + W_REVIEW·reviewScore, reviewScore 채워짐", () => {
    const shortlist = [rec({ appid: 1, matchScore: 0.8 })];
    const reviewScores = new Map<number, number>([[1, 0.4]]);
    const out = blendRecommendations(shortlist, reviewScores, 10);
    expect(out).toHaveLength(1);
    expect(out[0].reviewScore).toBe(0.4);
    expect(out[0].score).toBeCloseTo(W_MATCH * 0.8 + W_REVIEW * 0.4, 9);
  });

  it("리뷰 점수가 순위를 뒤집을 수 있다 (매칭 근소 열위 + 호평 우위)", () => {
    // A: matchScore 0.60, review 0.95 → 0.65·0.6 + 0.35·0.95 = 0.7225
    // B: matchScore 0.62, review 0.30 → 0.65·0.62 + 0.35·0.30 = 0.508
    const shortlist = [
      rec({ appid: 1, matchScore: 0.60 }),
      rec({ appid: 2, matchScore: 0.62 }),
    ];
    const reviewScores = new Map<number, number>([[1, 0.95], [2, 0.30]]);
    const out = blendRecommendations(shortlist, reviewScores, 10);
    // 원래 matchScore로는 B(2)가 앞이지만, 블렌딩 후 A(1)가 앞선다.
    expect(out.map(r => r.appid)).toEqual([1, 2]);
  });

  it("맵에 없는 후보는 중립 0.5로 흡수 (탈락 없음)", () => {
    const shortlist = [rec({ appid: 1, matchScore: 0.8 })];
    const out = blendRecommendations(shortlist, new Map(), 10);
    expect(out).toHaveLength(1);
    expect(out[0].reviewScore).toBe(0.5);
    expect(out[0].score).toBeCloseTo(W_MATCH * 0.8 + W_REVIEW * 0.5, 9);
  });

  it("limit로 truncate", () => {
    const shortlist = [1, 2, 3, 4, 5].map(i => rec({ appid: i, matchScore: 0.9 - i * 0.1 }));
    const out = blendRecommendations(shortlist, new Map(), 3);
    expect(out).toHaveLength(3);
  });

  it("동점 시 2차 tiebreak: library는 playtime 내림차순, appid 오름차순", () => {
    // 동일 matchScore + 동일 reviewScore(맵 없음→0.5) → score 동점.
    const shortlist = [
      rec({ appid: 50, matchScore: 0.7, playtimeMinutes: 0 }),
      rec({ appid: 30, matchScore: 0.7, playtimeMinutes: 0 }),
      rec({ appid: 40, matchScore: 0.7, playtimeMinutes: 100 }), // playtime 큼 → 최우선
    ];
    const out = blendRecommendations(shortlist, new Map(), 10);
    expect(out.map(r => r.appid)).toEqual([40, 30, 50]);
  });

  it("wishlist source는 priority 오름차순으로 tiebreak (자기 source로 키잉, C1 회귀)", () => {
    // 혼합 source를 한 번에 넣어도 각 항목이 자기 source 기준으로 정렬되는지 검증.
    const shortlist: Recommendation[] = [
      rec({ appid: 1, matchScore: 0.5, source: "wishlist", wishlistPriority: 8, playtimeMinutes: undefined }),
      rec({ appid: 2, matchScore: 0.5, source: "wishlist", wishlistPriority: 2, playtimeMinutes: undefined }),
      rec({ appid: 3, matchScore: 0.5, source: "wishlist", wishlistPriority: 5, playtimeMinutes: undefined }),
    ];
    const out = blendRecommendations(shortlist, new Map(), 10);
    // priority 낮을수록 우선 → 2, 3, 8
    expect(out.map(r => r.appid)).toEqual([2, 3, 1]);
  });

  it("wishlist priority 동률 시 dateAdded 내림차순(최근 추가 우선) tiebreak (code-review #3)", () => {
    // score·matchScore·priority 모두 동일 → dateAdded로 결정. 최근(큰 값) 우선.
    const shortlist: Recommendation[] = [
      rec({ appid: 1, matchScore: 0.5, source: "wishlist", wishlistPriority: 3, wishlistDateAdded: 100, playtimeMinutes: undefined }),
      rec({ appid: 2, matchScore: 0.5, source: "wishlist", wishlistPriority: 3, wishlistDateAdded: 300, playtimeMinutes: undefined }),
      rec({ appid: 3, matchScore: 0.5, source: "wishlist", wishlistPriority: 3, wishlistDateAdded: 200, playtimeMinutes: undefined }),
    ];
    const out = blendRecommendations(shortlist, new Map(), 10);
    // dateAdded 300 → 200 → 100
    expect(out.map(r => r.appid)).toEqual([2, 3, 1]);
  });
});
