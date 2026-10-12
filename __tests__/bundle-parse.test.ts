/**
 * lib/bundle/parse.ts 단위 테스트.
 *
 * Steam·ITAD 식별자 추출: URL 형식·맨숫자·혼합 텍스트·중복 제거·순서 보존을 검증한다.
 */

import { describe, it, expect } from "vitest";
import { parseBundleInput, steamStoreUrl } from "@/lib/bundle/parse";

// ---------------------------------------------------------------------------
// steamStoreUrl
// ---------------------------------------------------------------------------

describe("steamStoreUrl", () => {
  it("https://store.steampowered.com/app/{id}/ 형식을 반환한다", () => {
    expect(steamStoreUrl(440)).toBe("https://store.steampowered.com/app/440/");
    expect(steamStoreUrl(1)).toBe("https://store.steampowered.com/app/1/");
  });
});

// ---------------------------------------------------------------------------
// parseBundleInput — 기본 URL 형식
// ---------------------------------------------------------------------------

describe("parseBundleInput — 앱 URL", () => {
  it("store.steampowered.com/app/{id} → appIds", () => {
    const r = parseBundleInput("https://store.steampowered.com/app/440/");
    expect(r.appIds).toEqual([440]);
    expect(r.steamBundleIds).toEqual([]);
    expect(r.unresolved).toEqual([]);
  });

  it("www 서브도메인 없이도 파싱된다", () => {
    const r = parseBundleInput("https://steampowered.com/app/730/Counter_Strike_2/");
    expect(r.appIds).toEqual([730]);
  });

  it("http(s) 스킴 없이도 파싱된다", () => {
    const r = parseBundleInput("store.steampowered.com/app/570");
    expect(r.appIds).toEqual([570]);
  });

  it("꼬리 경로(이름 슬러그)가 있어도 첫 숫자만 추출한다", () => {
    // /app/440/Team_Fortress_2/ — 슬러그는 무시
    const r = parseBundleInput("https://store.steampowered.com/app/440/Team_Fortress_2/");
    expect(r.appIds).toEqual([440]);
  });

  it("쿼리스트링이 붙어 있어도 파싱된다", () => {
    const r = parseBundleInput("https://store.steampowered.com/app/1091500/?snr=1_7_7_151_150_1");
    expect(r.appIds).toEqual([1091500]);
  });
});

describe("parseBundleInput — 번들 URL", () => {
  it("store.steampowered.com/bundle/{id} → steamBundleIds", () => {
    const r = parseBundleInput("https://store.steampowered.com/bundle/12345/");
    expect(r.steamBundleIds).toEqual([12345]);
    expect(r.appIds).toEqual([]);
  });

  it("http 스킴도 파싱된다", () => {
    const r = parseBundleInput("http://store.steampowered.com/bundle/99/");
    expect(r.steamBundleIds).toEqual([99]);
  });
});

describe("parseBundleInput — sub(패키지) URL", () => {
  it("store.steampowered.com/sub/{id} → steamPackageIds", () => {
    const r = parseBundleInput("https://store.steampowered.com/sub/29197/");
    expect(r.steamPackageIds).toEqual([29197]);
    expect(r.appIds).toEqual([]);
    expect(r.steamBundleIds).toEqual([]);
  });
});

describe("parseBundleInput — ITAD 번들 URL", () => {
  it("/bundles/{id} 경로 → itadBundleIds", () => {
    const r = parseBundleInput("https://isthereanydeal.com/bundles/7890/");
    expect(r.itadBundleIds).toEqual([7890]);
    expect(r.appIds).toEqual([]);
  });

  it("/bundle/{id} 단수 경로도 파싱된다", () => {
    const r = parseBundleInput("https://isthereanydeal.com/bundle/1111/");
    expect(r.itadBundleIds).toEqual([1111]);
  });

  it("www 서브도메인 유무 모두 파싱된다", () => {
    const r = parseBundleInput("https://www.isthereanydeal.com/bundles/2222/");
    expect(r.itadBundleIds).toEqual([2222]);
  });
});

// ---------------------------------------------------------------------------
// 맨숫자 (순수 정수) → appIds
// ---------------------------------------------------------------------------

describe("parseBundleInput — 맨숫자", () => {
  it("순수 양의 정수 토큰은 appIds로 들어간다", () => {
    const r = parseBundleInput("440 730 570");
    expect(r.appIds).toEqual([440, 730, 570]);
  });

  it("1자리 ~ 9자리 모두 허용된다", () => {
    const r = parseBundleInput("1 999999999");
    expect(r.appIds).toEqual([1, 999999999]);
  });

  it("10자리 이상 숫자는 unresolved로 간다", () => {
    const r = parseBundleInput("1234567890");
    expect(r.appIds).toEqual([]);
    expect(r.unresolved).toEqual(["1234567890"]);
  });

  it("0은 appIds에 들어가지 않고 unresolved로 간다", () => {
    const r = parseBundleInput("0");
    expect(r.appIds).toEqual([]);
    expect(r.unresolved).toEqual(["0"]);
  });
});

// ---------------------------------------------------------------------------
// unresolved
// ---------------------------------------------------------------------------

describe("parseBundleInput — unresolved", () => {
  it("이름만 있는 토큰은 unresolved로 간다", () => {
    const r = parseBundleInput("Celeste Hollow_Knight");
    expect(r.unresolved).toEqual(["Celeste", "Hollow_Knight"]);
    expect(r.appIds).toEqual([]);
  });

  it("매칭 안 되는 URL도 unresolved로 간다", () => {
    const r = parseBundleInput("https://example.com/app/123/");
    expect(r.unresolved).toEqual(["https://example.com/app/123/"]);
    expect(r.appIds).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 토큰 구분자
// ---------------------------------------------------------------------------

describe("parseBundleInput — 구분자 처리", () => {
  it("쉼표로 구분된 토큰을 파싱한다", () => {
    const r = parseBundleInput("440,730,570");
    expect(r.appIds).toEqual([440, 730, 570]);
  });

  it("세미콜론으로 구분된 토큰을 파싱한다", () => {
    const r = parseBundleInput("440;730");
    expect(r.appIds).toEqual([440, 730]);
  });

  it("개행으로 구분된 토큰을 파싱한다", () => {
    const r = parseBundleInput("440\n730\n570");
    expect(r.appIds).toEqual([440, 730, 570]);
  });

  it("쉼표·개행·공백 혼합을 파싱한다", () => {
    const r = parseBundleInput("440, 730\n570;1091500");
    expect(r.appIds).toEqual([440, 730, 570, 1091500]);
  });

  it("연속 구분자(빈 토큰)를 무시한다", () => {
    const r = parseBundleInput("440,,, 730");
    expect(r.appIds).toEqual([440, 730]);
  });
});

// ---------------------------------------------------------------------------
// 중복 제거 + 순서 보존
// ---------------------------------------------------------------------------

describe("parseBundleInput — 중복 제거 + 순서 보존", () => {
  it("같은 appId가 여러 번 나와도 한 번만 포함된다", () => {
    const r = parseBundleInput("440 570 440 730 570");
    expect(r.appIds).toEqual([440, 570, 730]);
  });

  it("URL과 맨숫자가 같은 appId면 중복 제거된다", () => {
    const r = parseBundleInput("https://store.steampowered.com/app/440/ 440");
    expect(r.appIds).toEqual([440]);
  });

  it("steam 번들 중복 제거", () => {
    const r = parseBundleInput(
      "https://store.steampowered.com/bundle/100/ https://store.steampowered.com/bundle/100/",
    );
    expect(r.steamBundleIds).toEqual([100]);
  });

  it("입력 순서를 보존한다", () => {
    const r = parseBundleInput("730 440 570");
    expect(r.appIds).toEqual([730, 440, 570]);
  });
});

// ---------------------------------------------------------------------------
// 혼합 입력
// ---------------------------------------------------------------------------

describe("parseBundleInput — 혼합 입력", () => {
  it("앱 URL, 번들 URL, sub URL, ITAD URL, 맨숫자, 이름을 한 번에 파싱한다", () => {
    const input = [
      "https://store.steampowered.com/app/440/Team_Fortress_2/",
      "https://store.steampowered.com/bundle/12345/",
      "https://store.steampowered.com/sub/29197/",
      "https://isthereanydeal.com/bundles/7890/",
      "570",
      "SomeName",
    ].join("\n");

    const r = parseBundleInput(input);
    expect(r.appIds).toEqual([440, 570]);
    expect(r.steamBundleIds).toEqual([12345]);
    expect(r.steamPackageIds).toEqual([29197]);
    expect(r.itadBundleIds).toEqual([7890]);
    expect(r.unresolved).toEqual(["SomeName"]);
  });

  it("ITAD URL이 steampowered URL과 섞여 있어도 호스트로 올바르게 분기된다", () => {
    // steampowered.com/bundle → steamBundleIds, isthereanydeal.com/bundle → itadBundleIds
    const r = parseBundleInput(
      "https://store.steampowered.com/bundle/111/ https://isthereanydeal.com/bundle/222/",
    );
    expect(r.steamBundleIds).toEqual([111]);
    expect(r.itadBundleIds).toEqual([222]);
  });
});

// ---------------------------------------------------------------------------
// 대소문자 무시
// ---------------------------------------------------------------------------

describe("parseBundleInput — 대소문자 무시", () => {
  it("URL 경로 대소문자 무관하게 파싱된다", () => {
    const r = parseBundleInput("HTTPS://STORE.STEAMPOWERED.COM/APP/440/");
    expect(r.appIds).toEqual([440]);
  });
});
