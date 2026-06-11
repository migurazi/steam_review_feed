/**
 * lib/app-meta-cache.ts 단위 테스트.
 *
 * 실제 SQLite DB를 사용한다. 테스트 간 격리를 위해 매우 큰 (충돌 가능성 낮은)
 * appId를 사용한다.
 */

import { describe, it, expect, afterAll } from "vitest";
import { stopCleanupScheduler } from "@/lib/db";
import { getAppMeta, setAppMeta, setAppMetaBatch } from "@/lib/app-meta-cache";

afterAll(() => {
  stopCleanupScheduler();
});

function uniqueAppId(): number {
  // app_meta는 INTEGER PRIMARY KEY. 충돌 회피를 위해 timestamp 기반 큰 값.
  return 1_000_000_000 + Math.floor(Math.random() * 1_000_000_000);
}

describe("app-meta-cache", () => {
  describe("setAppMeta + getAppMeta", () => {
    it("저장 후 조회 시 동일 entry 반환", () => {
      const appId = uniqueAppId();
      setAppMeta(appId, "Sample Game", "https://example.com/header.jpg");
      const got = getAppMeta(appId);
      expect(got).not.toBeNull();
      expect(got!.appId).toBe(appId);
      expect(got!.name).toBe("Sample Game");
      expect(got!.headerImage).toBe("https://example.com/header.jpg");
      expect(got!.updatedAt).toBeGreaterThan(0);
    });

    it("존재하지 않는 appId는 null 반환", () => {
      expect(getAppMeta(uniqueAppId())).toBeNull();
    });

    it("name이 빈 문자열이면 저장하지 않음", () => {
      const appId = uniqueAppId();
      setAppMeta(appId, "");
      expect(getAppMeta(appId)).toBeNull();
    });

    it("두 번째 setAppMeta가 name을 덮어쓴다", () => {
      const appId = uniqueAppId();
      setAppMeta(appId, "Old Name", "old.jpg");
      setAppMeta(appId, "New Name", "new.jpg");
      const got = getAppMeta(appId);
      expect(got!.name).toBe("New Name");
      expect(got!.headerImage).toBe("new.jpg");
    });

    it("headerImage가 undefined면 기존 값 유지 (COALESCE)", () => {
      const appId = uniqueAppId();
      setAppMeta(appId, "Name", "original.jpg");
      // 두 번째 호출에서 headerImage 생략
      setAppMeta(appId, "Updated Name");
      const got = getAppMeta(appId);
      expect(got!.name).toBe("Updated Name");
      // header_image는 기존 값 유지
      expect(got!.headerImage).toBe("original.jpg");
    });
  });

  describe("setAppMetaBatch", () => {
    it("여러 entry를 한 번에 upsert한다", () => {
      const ids = [uniqueAppId(), uniqueAppId(), uniqueAppId()];
      setAppMetaBatch([
        { appId: ids[0], name: "Game A" },
        { appId: ids[1], name: "Game B", headerImage: "b.jpg" },
        { appId: ids[2], name: "Game C" },
      ]);

      expect(getAppMeta(ids[0])!.name).toBe("Game A");
      expect(getAppMeta(ids[1])!.name).toBe("Game B");
      expect(getAppMeta(ids[1])!.headerImage).toBe("b.jpg");
      expect(getAppMeta(ids[2])!.name).toBe("Game C");
    });

    it("빈 이름 entry는 건너뛴다", () => {
      const ids = [uniqueAppId(), uniqueAppId()];
      setAppMetaBatch([
        { appId: ids[0], name: "Valid" },
        { appId: ids[1], name: "" },
      ]);
      expect(getAppMeta(ids[0])!.name).toBe("Valid");
      expect(getAppMeta(ids[1])).toBeNull();
    });

    it("빈 배열은 no-op", () => {
      expect(() => setAppMetaBatch([])).not.toThrow();
    });

    it("기존 row를 덮어쓰지 않는다 (INSERT OR IGNORE) — store 출처 보호", () => {
      // 단건 setAppMeta로 store-quality 데이터 미리 저장
      const appId = uniqueAppId();
      setAppMeta(appId, "Store-Quality Name", "store-header.jpg");

      // 라이브러리 출처 batch가 다른 name으로 같은 appId 시도
      setAppMetaBatch([{ appId, name: "Library-Variant Name" }]);

      // store 데이터가 그대로 유지되어야 함
      const got = getAppMeta(appId);
      expect(got!.name).toBe("Store-Quality Name");
      expect(got!.headerImage).toBe("store-header.jpg");
    });

    it("같은 batch에서 row가 없으면 INSERT는 정상 동작", () => {
      // 새 appId는 batch가 채우고, 두 번째 batch는 무시되는지 확인
      const appId = uniqueAppId();
      setAppMetaBatch([{ appId, name: "First Insert" }]);
      expect(getAppMeta(appId)!.name).toBe("First Insert");

      setAppMetaBatch([{ appId, name: "Second Insert (ignored)" }]);
      expect(getAppMeta(appId)!.name).toBe("First Insert");
    });
  });

  describe("header_image 빈 문자열 normalize (회귀 방지)", () => {
    it("setAppMeta가 headerImage=''로 좋은 이전 값을 덮어쓰지 않는다", () => {
      // 시나리오: Steam appdetails가 unreleased 게임에 대해 header_image=''
      // 반환 → setAppMeta(''); 가 호출되어도 이전에 저장된 정상 URL 유지.
      const appId = uniqueAppId();
      setAppMeta(appId, "GameX", "https://store.steam/header.jpg");
      // 두 번째 호출: 빈 문자열 (Steam 변종 응답)
      setAppMeta(appId, "GameX", "");
      const got = getAppMeta(appId);
      expect(got!.headerImage).toBe("https://store.steam/header.jpg");
    });

    it("setAppMeta(headerImage=null)도 동일하게 기존 값 유지", () => {
      const appId = uniqueAppId();
      setAppMeta(appId, "GameX", "https://store.steam/header.jpg");
      setAppMeta(appId, "GameX", null);
      expect(getAppMeta(appId)!.headerImage).toBe("https://store.steam/header.jpg");
    });

    it("setAppMeta(headerImage='') 신규 row는 NULL로 저장", () => {
      const appId = uniqueAppId();
      setAppMeta(appId, "FreshGame", "");
      // 빈 문자열은 NULL로 normalize됨 → getAppMeta가 null로 반환
      expect(getAppMeta(appId)!.headerImage).toBeNull();
    });

    it("setAppMetaBatch headerImage=''도 NULL로 저장", () => {
      const appId = uniqueAppId();
      setAppMetaBatch([{ appId, name: "BatchGame", headerImage: "" }]);
      expect(getAppMeta(appId)!.headerImage).toBeNull();
    });

    it("setAppMetaBatch는 기존 store row를 빈 headerImage로도 건드리지 않음", () => {
      // 시나리오: store appdetails로 좋은 데이터 저장됨 → 이후 라이브러리
      // batch가 같은 appId에 빈 headerImage로 시도. INSERT OR IGNORE 의미상
      // 기존 행이 그대로 보존돼야 함.
      const appId = uniqueAppId();
      setAppMeta(appId, "Store Name", "store-header.jpg");

      setAppMetaBatch([{ appId, name: "Library Variant", headerImage: "" }]);

      const got = getAppMeta(appId);
      expect(got!.name).toBe("Store Name");
      expect(got!.headerImage).toBe("store-header.jpg");
    });
  });
});
