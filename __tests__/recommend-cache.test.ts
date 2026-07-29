/**
 * lib/recommend-cache.ts 단위 테스트.
 *
 * SQLite DB를 실제로 사용하므로 격리를 위해 고유 Steam ID 생성.
 * 사용자가 없으면 cache 함수는 cache miss로 처리되어야 한다.
 */

import { describe, it, expect, afterAll } from "vitest";
import { upsertUser, stopCleanupScheduler } from "@/lib/db";
import {
  hashOptions,
  getRecommendationCache,
  setRecommendationCache,
  deleteRecommendationCache,
  type RecommendationCachePayload,
} from "@/lib/recommend-cache";
import { DEFAULT_ANALYZE_OPTIONS, type AnalyzeOptions } from "@/lib/steam/profile";

afterAll(() => {
  stopCleanupScheduler();
});

function uniqueSteamId(): string {
  return `test_rc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function samplePayload(): RecommendationCachePayload {
  return {
    profile: {
      totalWeight: 12.34,
      analyzedGames: 5,
      cardFarmingExcluded: 2,
      unplayedCount: 100,
      metaMissing: 0,
      excludedFree: 1,
      genres: [
        { key: "1", label: "Action", weight: 5.0, share: 0.5, topGames: [] },
      ],
      categories: [
        { key: 2, label: "Single-player", weight: 4.0, share: 0.8, topGames: [] },
      ],
    },
    libraryUnplayed: [
      {
        appid: 12345,
        name: "Sample Game",
        isFree: false,
        matchedGenres: [{ id: "1", label: "Action" }],
        matchedCategories: [],
        matchScore: 0.5,
        score: 0.5,
        source: "library-unplayed",
        playtimeMinutes: 10,
      },
    ],
    wishlist: [],
    ownedGames: 200,
    wishlistGames: 30,
    wishlistFetchFailed: false,
  };
}

const defaultTracks: { lib: boolean; wish: boolean } = { lib: true, wish: true };
const h = (opts: AnalyzeOptions, tracks: { lib: boolean; wish: boolean } = defaultTracks) =>
  hashOptions({ options: opts, tracks });

describe("hashOptions", () => {
  it("같은 입력은 같은 해시", () => {
    expect(h({ ...DEFAULT_ANALYZE_OPTIONS })).toBe(h({ ...DEFAULT_ANALYZE_OPTIONS }));
  });

  it("필드 하나만 달라도 해시가 달라진다", () => {
    const base = h(DEFAULT_ANALYZE_OPTIONS);
    expect(h({ ...DEFAULT_ANALYZE_OPTIONS, cardFarmingMaxMinutes: 200 })).not.toBe(base);
    expect(h({ ...DEFAULT_ANALYZE_OPTIONS, unplayedMaxMinutes: 30 })).not.toBe(base);
    expect(h({ ...DEFAULT_ANALYZE_OPTIONS, excludeFree: true })).not.toBe(base);
    expect(h({ ...DEFAULT_ANALYZE_OPTIONS, topNTaste: 12 })).not.toBe(base);
    expect(h({ ...DEFAULT_ANALYZE_OPTIONS, maxRecommendationsPerTrack: 30 })).not.toBe(base);
  });

  it("excludeFree true/false를 구분한다", () => {
    expect(h({ ...DEFAULT_ANALYZE_OPTIONS, excludeFree: true }))
      .not.toBe(h({ ...DEFAULT_ANALYZE_OPTIONS, excludeFree: false }));
  });

  it("tracks 조합이 다르면 해시가 달라진다", () => {
    const both = h(DEFAULT_ANALYZE_OPTIONS, { lib: true, wish: true });
    const libOnly = h(DEFAULT_ANALYZE_OPTIONS, { lib: true, wish: false });
    const wishOnly = h(DEFAULT_ANALYZE_OPTIONS, { lib: false, wish: true });
    expect(both).not.toBe(libOnly);
    expect(both).not.toBe(wishOnly);
    expect(libOnly).not.toBe(wishOnly);
  });

  it("키 순서에 영향받지 않는다 (객체 spread 순서 무관)", () => {
    // 키 순서가 다른 객체 두 개를 만들 때 JS 엔진은 보통 키 순서를 보존하지만,
    // hashOptions가 sort 후 직렬화하므로 결과가 같아야 한다는 invariant 검증.
    const a: AnalyzeOptions = {
      cardFarmingMaxMinutes: 180,
      unplayedMaxMinutes: 60,
      excludeFree: false,
      topNTaste: 6,
      maxRecommendationsPerTrack: 12,
    };
    const b: AnalyzeOptions = {
      maxRecommendationsPerTrack: 12,
      topNTaste: 6,
      excludeFree: false,
      unplayedMaxMinutes: 60,
      cardFarmingMaxMinutes: 180,
    };
    expect(h(a)).toBe(h(b));
  });
});

describe("setRecommendationCache + getRecommendationCache", () => {
  it("roundtrip — 저장 후 같은 옵션으로 조회 시 동일 payload 반환", () => {
    const steamId = uniqueSteamId();
    upsertUser(steamId);
    const hash = h(DEFAULT_ANALYZE_OPTIONS);
    const payload = samplePayload();

    const written = setRecommendationCache(steamId, hash, payload);
    expect(written).toBe(true);

    const got = getRecommendationCache(steamId, hash);
    expect(got).not.toBeNull();
    expect(got!.payload).toEqual(payload);
    expect(got!.computedAt).toBeGreaterThan(0);
  });

  it("options_hash 불일치 시 null 반환 (cache miss)", () => {
    const steamId = uniqueSteamId();
    upsertUser(steamId);
    setRecommendationCache(steamId, "hash-A", samplePayload());

    const got = getRecommendationCache(steamId, "hash-B");
    expect(got).toBeNull();
  });

  it("같은 사용자에 두 번 저장하면 마지막이 이긴다 (1행만 유지)", () => {
    const steamId = uniqueSteamId();
    upsertUser(steamId);
    const p1 = samplePayload();
    const p2 = { ...samplePayload(), ownedGames: 999 };

    setRecommendationCache(steamId, "hash-X", p1);
    setRecommendationCache(steamId, "hash-Y", p2);

    // hash-X로 조회하면 miss — 1행만 유지되며 마지막 저장의 hash로 덮어쓰여 있음
    expect(getRecommendationCache(steamId, "hash-X")).toBeNull();
    // hash-Y로는 hit
    const got = getRecommendationCache(steamId, "hash-Y");
    expect(got).not.toBeNull();
    expect(got!.payload.ownedGames).toBe(999);
  });

  it("DB에 사용자가 없으면 set은 false, get은 null을 반환한다", () => {
    const ghost = uniqueSteamId();
    // upsertUser 호출 안 함

    expect(setRecommendationCache(ghost, "any-hash", samplePayload())).toBe(false);
    expect(getRecommendationCache(ghost, "any-hash")).toBeNull();
  });

  it("deleteRecommendationCache로 캐시를 명시적으로 지운다", () => {
    const steamId = uniqueSteamId();
    upsertUser(steamId);
    setRecommendationCache(steamId, "hash-D", samplePayload());
    expect(getRecommendationCache(steamId, "hash-D")).not.toBeNull();

    deleteRecommendationCache(steamId);
    expect(getRecommendationCache(steamId, "hash-D")).toBeNull();
  });
});
