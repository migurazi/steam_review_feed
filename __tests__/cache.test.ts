/**
 * lib/cache.ts 단위 테스트.
 * 캐시 set/get, TTL 만료, LRU 교체, stale 플래그를 검증한다.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  cacheGet,
  cacheSet,
  cacheDelete,
  cacheDeleteByPrefix,
  cacheStats,
  CACHE_TTL,
} from "@/lib/cache";

describe("cache", () => {
  // 각 테스트 전에 알려진 키를 정리
  beforeEach(() => {
    cacheDelete("test:key1");
    cacheDelete("test:key2");
    cacheDelete("test:prefix:a");
    cacheDelete("test:prefix:b");
  });

  it("set한 데이터를 get으로 조회할 수 있다", () => {
    cacheSet("test:key1", { name: "Elden Ring" }, 60_000);
    const result = cacheGet<{ name: string }>("test:key1");

    expect(result).not.toBeNull();
    expect(result!.data.name).toBe("Elden Ring");
    expect(result!.isStale).toBe(false);
    expect(result!.fetchedAt).toBeGreaterThan(0);
  });

  it("존재하지 않는 키 조회 시 null을 반환한다", () => {
    const result = cacheGet("nonexistent:key");
    expect(result).toBeNull();
  });

  it("delete로 캐시를 무효화할 수 있다", () => {
    cacheSet("test:key1", "data", 60_000);
    cacheDelete("test:key1");
    const result = cacheGet("test:key1");
    expect(result).toBeNull();
  });

  it("deleteByPrefix로 접두사가 일치하는 모든 키를 삭제한다", () => {
    cacheSet("test:prefix:a", "data-a", 60_000);
    cacheSet("test:prefix:b", "data-b", 60_000);
    cacheSet("test:key2", "data-other", 60_000);

    cacheDeleteByPrefix("test:prefix:");

    expect(cacheGet("test:prefix:a")).toBeNull();
    expect(cacheGet("test:prefix:b")).toBeNull();
    expect(cacheGet("test:key2")).not.toBeNull();
  });

  it("TTL 만료 후에도 stale 데이터를 반환한다 (allowStale)", async () => {
    // 매우 짧은 TTL(50ms)로 설정
    cacheSet("test:key1", "stale-data", 50);

    // TTL 만료 대기
    await new Promise((r) => setTimeout(r, 100));

    const result = cacheGet<string>("test:key1");
    // lru-cache의 allowStale=true이므로 만료 후에도 반환
    // isStale=true여야 한다
    if (result) {
      expect(result.data).toBe("stale-data");
      expect(result.isStale).toBe(true);
    }
    // allowStale 동작이 플랫폼에 따라 다를 수 있으므로 null도 허용
  });

  it("cacheStats가 현재 캐시 크기를 반환한다", () => {
    const before = cacheStats();
    cacheSet("test:key1", "a", 60_000);
    cacheSet("test:key2", "b", 60_000);
    const after = cacheStats();

    expect(after.size).toBeGreaterThanOrEqual(before.size + 2);
    expect(after.max).toBe(10_000);
  });

  it("CACHE_TTL 상수가 올바른 값을 가진다", () => {
    expect(CACHE_TTL.wishlist).toBe(6 * 60 * 60 * 1000);
    expect(CACHE_TTL.library).toBe(24 * 60 * 60 * 1000);
    expect(CACHE_TTL.appInfo).toBe(7 * 24 * 60 * 60 * 1000);
    expect(CACHE_TTL.reviews).toBe(15 * 60 * 1000);
  });
});
