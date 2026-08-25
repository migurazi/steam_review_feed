/**
 * lib/steam/api.ts 도전과제 정규화 순수 함수 테스트.
 *
 * - normalizeAchievementDefs: hidden 0/1→boolean, description 누락→"", icon URL→파일명
 * - classifyPlayerStatsError: private/unavailable/error 구분 (R7, §3.5 실측 기반)
 */

import { describe, it, expect } from "vitest";
import {
  normalizeAchievementDefs,
  classifyPlayerStatsError,
} from "@/lib/steam/api";
import type { SteamRawAchievementDef } from "@/lib/steam/types";

function raw(over: Partial<SteamRawAchievementDef> = {}): SteamRawAchievementDef {
  return {
    name: over.name ?? "ACH",
    displayName: over.displayName ?? "Achievement",
    description: over.description,
    hidden: over.hidden ?? 0,
    icon: over.icon ?? "https://steamcdn-a.akamaihd.net/steamcommunity/public/images/apps/220/abc.jpg",
    icongray: over.icongray ?? "gray.jpg",
    defaultvalue: over.defaultvalue ?? 0,
  };
}

describe("normalizeAchievementDefs", () => {
  it("hidden 0/1 → boolean", () => {
    const [a, b] = normalizeAchievementDefs([
      raw({ name: "a", hidden: 0 }),
      raw({ name: "b", hidden: 1 }),
    ]);
    expect(a.hidden).toBe(false);
    expect(b.hidden).toBe(true);
  });

  it("description 누락(undefined) → 빈 문자열", () => {
    const [a] = normalizeAchievementDefs([raw({ description: undefined })]);
    expect(a.description).toBe("");
  });

  it("icon URL → 파일명만 추출 (§5.1.2, V1 실측)", () => {
    const [a] = normalizeAchievementDefs([
      raw({ icon: "https://steamcdn-a.akamaihd.net/steamcommunity/public/images/apps/1145360/062a2b.jpg" }),
    ]);
    expect(a.icon).toBe("062a2b.jpg");
  });

  it("icon이 이미 파일명이면 그대로", () => {
    const [a] = normalizeAchievementDefs([raw({ icon: "plain.jpg" })]);
    expect(a.icon).toBe("plain.jpg");
  });

  it("name/displayName은 원형 그대로 보존", () => {
    const [a] = normalizeAchievementDefs([raw({ name: "ACH_X", displayName: "표시명" })]);
    expect(a.name).toBe("ACH_X");
    expect(a.displayName).toBe("표시명");
  });
});

describe("classifyPlayerStatsError", () => {
  it('private: "Profile is not public" (403)', () => {
    expect(
      classifyPlayerStatsError(403, { playerstats: { success: false, error: "Profile is not public" } })
    ).toBe("private");
  });

  it('unavailable: "Requested app has no stats" (400)', () => {
    expect(
      classifyPlayerStatsError(400, { playerstats: { success: false, error: "Requested app has no stats" } })
    ).toBe("unavailable");
  });

  it("문자열이 HTTP 코드보다 우선 — 403이라도 no-stats 문자열이면 unavailable", () => {
    expect(
      classifyPlayerStatsError(403, { playerstats: { success: false, error: "Requested app has no stats" } })
    ).toBe("unavailable");
  });

  it("문자열이 없으면 HTTP 코드로 폴백 (403→private, 400→unavailable)", () => {
    expect(classifyPlayerStatsError(403, null)).toBe("private");
    expect(classifyPlayerStatsError(400, null)).toBe("unavailable");
  });

  it("알 수 없는 상태는 error (재시도 대상)", () => {
    expect(classifyPlayerStatsError(500, null)).toBe("error");
    expect(classifyPlayerStatsError(0, null)).toBe("error");
  });
});
