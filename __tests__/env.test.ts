/**
 * lib/env.ts 단위 테스트.
 *
 * 환경변수 검증 로직을 테스트한다:
 * - 필수 환경변수 존재 시 정상 반환
 * - 누락 시 명확한 에러 메시지와 함께 예외 발생
 * - 빈 문자열이나 공백만 있는 경우도 누락으로 처리
 */

import { describe, it, expect, afterEach } from "vitest";
import { validateEnv, getSteamApiKey, getSessionSecret } from "@/lib/env";

describe("env", () => {
  // 원본 환경변수를 백업하고 각 테스트 후 복원
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("validateEnv", () => {
    it("모든 필수 환경변수가 설정되면 예외 없이 통과한다", () => {
      process.env.STEAM_API_KEY = "test-key-123";
      process.env.SESSION_SECRET = "test-secret-at-least-32-characters-long";

      expect(() => validateEnv()).not.toThrow();
    });

    it("STEAM_API_KEY가 없으면 에러를 던진다", () => {
      delete process.env.STEAM_API_KEY;
      process.env.SESSION_SECRET = "test-secret";

      expect(() => validateEnv()).toThrow("STEAM_API_KEY");
    });

    it("SESSION_SECRET가 없으면 에러를 던진다", () => {
      process.env.STEAM_API_KEY = "test-key";
      delete process.env.SESSION_SECRET;

      expect(() => validateEnv()).toThrow("SESSION_SECRET");
    });

    it("빈 문자열인 환경변수는 누락으로 처리한다", () => {
      process.env.STEAM_API_KEY = "";
      process.env.SESSION_SECRET = "test-secret";

      expect(() => validateEnv()).toThrow("STEAM_API_KEY");
    });

    it("공백만 있는 환경변수는 누락으로 처리한다", () => {
      process.env.STEAM_API_KEY = "   ";
      process.env.SESSION_SECRET = "test-secret";

      expect(() => validateEnv()).toThrow("STEAM_API_KEY");
    });

    it("여러 변수가 누락되면 모두 에러 메시지에 포함한다", () => {
      delete process.env.STEAM_API_KEY;
      delete process.env.SESSION_SECRET;

      try {
        validateEnv();
        expect.unreachable("should have thrown");
      } catch (e: unknown) {
        const msg = (e as Error).message;
        expect(msg).toContain("STEAM_API_KEY");
        expect(msg).toContain("SESSION_SECRET");
      }
    });
  });

  describe("getSteamApiKey", () => {
    it("설정된 API Key를 반환한다", () => {
      process.env.STEAM_API_KEY = "my-api-key";

      expect(getSteamApiKey()).toBe("my-api-key");
    });

    it("미설정 시 에러를 던진다", () => {
      delete process.env.STEAM_API_KEY;

      expect(() => getSteamApiKey()).toThrow("STEAM_API_KEY");
    });

    it("앞뒤 공백을 제거한다", () => {
      process.env.STEAM_API_KEY = "  my-key  ";

      expect(getSteamApiKey()).toBe("my-key");
    });
  });

  describe("getSessionSecret", () => {
    it("설정된 Session Secret을 반환한다", () => {
      process.env.SESSION_SECRET = "my-secret";

      expect(getSessionSecret()).toBe("my-secret");
    });

    it("미설정 시 에러를 던진다", () => {
      delete process.env.SESSION_SECRET;

      expect(() => getSessionSecret()).toThrow("SESSION_SECRET");
    });
  });
});
