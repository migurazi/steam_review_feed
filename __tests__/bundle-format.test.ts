/**
 * lib/bundle/totals.ts, lib/bundle/format.ts 단위 테스트.
 */

import { describe, it, expect } from "vitest";
import { computeChartTotals } from "@/lib/bundle/totals";
import { formatChart, formatMoney } from "@/lib/bundle/format";
import type { Chart, GameRow, GameRowPrice, GameReview, Tier } from "@/lib/bundle/types";

// ============================================================================
// 픽스처 헬퍼
// ============================================================================

function makePrice(final: number, initial?: number, discountPercent = 0): GameRowPrice {
  const ini = initial ?? final;
  return {
    currency: "KRW",
    initial: ini * 100,
    final: final * 100,
    discountPercent,
    initialFormatted: `₩${ini.toLocaleString("en-US")}`,
    finalFormatted: `₩${final.toLocaleString("en-US")}`,
  };
}

function makeReview(positivePercent: number, total: number): GameReview {
  return { positivePercent, total, desc: "매우 긍정적" };
}

function makeGame(
  appId: number,
  name: string,
  price: GameRowPrice | null,
  opts: { priceUnknown?: boolean; type?: "game" | "dlc"; review?: GameReview | null; uncertain?: boolean } = {}
): GameRow {
  return {
    appId,
    name,
    headerImage: `https://cdn.steamstatic.com/steam/apps/${appId}/header.jpg`,
    storeUrl: `https://store.steampowered.com/app/${appId}/`,
    type: opts.type ?? "game",
    price,
    review: opts.review ?? null,
    priceUnknown: opts.priceUnknown,
    uncertain: opts.uncertain,
  };
}

function makeTier(
  label: string,
  pricing: Tier["pricing"],
  games: GameRow[]
): Tier {
  return { id: `tier-${label}`, label, pricing, games };
}

function makeChart(title: string, tiers: Tier[]): Chart {
  return { title, tiers };
}

// ============================================================================
// 1. 단일 retail 티어: retail = 개별 final 합, pay = retail, savings 0%
// ============================================================================

describe("computeChartTotals — 단일 retail 티어", () => {
  const games = [
    makeGame(100, "게임A", makePrice(10000)),
    makeGame(101, "게임B", makePrice(20000)),
  ];
  const chart = makeChart("테스트", [makeTier("기본", { kind: "retail" }, games)]);
  const totals = computeChartTotals(chart);

  it("티어 retail = 개별 final 합", () => {
    expect(totals.tiers[0].retail).toBe(30000);
  });

  it("pay = retail(KRW)", () => {
    expect(totals.tiers[0].pay).toEqual({ currency: "KRW", amount: 30000 });
  });

  it("savings = 0%", () => {
    expect(totals.tiers[0].savings?.percent).toBe(0);
    expect(totals.tiers[0].savings?.amount).toBe(0);
  });

  it("차트 retail = 티어 retail (고유 appId)", () => {
    expect(totals.retail).toBe(30000);
    expect(totals.gameCount).toBe(2);
  });
});

// ============================================================================
// 2. 다중 flat 티어(USD): 차트 pay = 티어 금액 합, savings null(통화 KRW 아님)
// ============================================================================

describe("computeChartTotals — 다중 flat 티어(USD)", () => {
  const tier1 = makeTier("티어1", { kind: "flat", amount: 5.99, currency: "USD" }, [
    makeGame(200, "게임C", makePrice(15000)),
  ]);
  const tier2 = makeTier("티어2", { kind: "flat", amount: 9.99, currency: "USD" }, [
    makeGame(201, "게임D", makePrice(25000)),
  ]);
  const chart = makeChart("USD 번들", [tier1, tier2]);
  const totals = computeChartTotals(chart);

  it("티어별 pay는 USD flat 금액", () => {
    expect(totals.tiers[0].pay).toEqual({ currency: "USD", amount: 5.99 });
    expect(totals.tiers[1].pay).toEqual({ currency: "USD", amount: 9.99 });
  });

  it("차트 pay = USD 티어 합산", () => {
    expect(totals.pay).toEqual({ currency: "USD", amount: 5.99 + 9.99 });
  });

  it("savings는 KRW가 아니므로 null", () => {
    expect(totals.savings).toBeNull();
    expect(totals.tiers[0].savings).toBeNull();
  });
});

// ============================================================================
// 3. percent 티어: savings 계산 확인
// ============================================================================

describe("computeChartTotals — percent 티어", () => {
  const games = [
    makeGame(300, "게임E", makePrice(10000)),
    makeGame(301, "게임F", makePrice(10000)),
  ];
  // retail = 20000, 20% 할인 → pay = 16000, savings = 4000 (20%)
  const chart = makeChart("세트", [makeTier("세트", { kind: "percent", threshold: 2, percent: 20 }, games)]);
  const totals = computeChartTotals(chart);

  it("pay = retail * 0.8", () => {
    expect(totals.tiers[0].pay).toEqual({ currency: "KRW", amount: 16000 });
  });

  it("savings = 4000 (20%)", () => {
    expect(totals.tiers[0].savings).toEqual({ amount: 4000, percent: 20 });
  });

  it("차트 savings도 동일", () => {
    expect(totals.savings).toEqual({ amount: 4000, percent: 20 });
  });
});

// ============================================================================
// 4. 가격 미상 게임: retail/gameCount 제외, missingCount 반영
// ============================================================================

describe("computeChartTotals — 가격 미상 게임", () => {
  const games = [
    makeGame(400, "정상게임", makePrice(15000)),
    makeGame(401, "price null", null),
    makeGame(402, "priceUnknown", makePrice(5000), { priceUnknown: true }),
  ];
  const chart = makeChart("미상 포함", [makeTier("기본", { kind: "retail" }, games)]);
  const totals = computeChartTotals(chart);

  it("retail = 정상 게임만 합산", () => {
    expect(totals.tiers[0].retail).toBe(15000);
  });

  it("missingCount = 2 (null + priceUnknown)", () => {
    expect(totals.tiers[0].missingCount).toBe(2);
  });

  it("차트 gameCount = 3 (미상 포함 고유 appId)", () => {
    expect(totals.gameCount).toBe(3);
  });

  it("차트 retail = 15000 (미상 제외)", () => {
    expect(totals.retail).toBe(15000);
  });
});

// ============================================================================
// 5. 같은 appId가 두 티어에 중복: 차트 retail·gameCount는 한 번만
// ============================================================================

describe("computeChartTotals — 중복 appId 처리", () => {
  const sharedGame = makeGame(500, "공유게임", makePrice(20000));
  const tier1 = makeTier("티어1", { kind: "retail" }, [sharedGame]);
  const tier2 = makeTier("티어2", { kind: "retail" }, [
    sharedGame,
    makeGame(501, "고유게임", makePrice(10000)),
  ]);
  const chart = makeChart("중복 테스트", [tier1, tier2]);
  const totals = computeChartTotals(chart);

  it("차트 gameCount = 2 (고유 appId 수)", () => {
    expect(totals.gameCount).toBe(2);
  });

  it("차트 retail = 30000 (중복 제거 후 합산)", () => {
    expect(totals.retail).toBe(30000);
  });

  it("티어별 retail은 각자 독립 계산", () => {
    expect(totals.tiers[0].retail).toBe(20000);
    expect(totals.tiers[1].retail).toBe(30000);
  });
});

// ============================================================================
// 6. formatChart 4포맷: 비어있지 않은 문자열 + 핵심 토큰 포함
// ============================================================================

describe("formatChart — 4포맷 핵심 토큰 확인", () => {
  const game = makeGame(
    600,
    "테스트게임",
    makePrice(9000, 18000, 50),
    { review: makeReview(85, 1200) }
  );
  const chart = makeChart("포맷 테스트 번들", [
    makeTier("기본 티어", { kind: "flat", amount: 4.99, currency: "USD" }, [game]),
  ]);
  chart.source = {
    shop: "Fanatical",
    url: "https://fanatical.com/bundle/test",
    expires: "2026-11-01",
  };

  it("markdown — 비어있지 않음 + 게임명·₩ 포함", () => {
    const out = formatChart(chart, "markdown");
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain("테스트게임");
    expect(out).toContain("₩");
  });

  it("steamgifts — 비어있지 않음 + 게임명·₩·이미지 포함", () => {
    const out = formatChart(chart, "steamgifts");
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain("테스트게임");
    expect(out).toContain("₩");
    expect(out).toContain("![](");
  });

  it("bbcode — [table] 포함 + 게임명·₩", () => {
    const out = formatChart(chart, "bbcode");
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain("[table]");
    expect(out).toContain("테스트게임");
    expect(out).toContain("[img]");
  });

  it("html — <table 포함 + 게임명·₩", () => {
    const out = formatChart(chart, "html");
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain("<table");
    expect(out).toContain("테스트게임");
    expect(out).toContain("<img src");
  });

  it("html — 게임명에 스토어 링크(<a href>, 새 탭) 포함", () => {
    const out = formatChart(chart, "html");
    expect(out).toContain(
      '<a href="https://store.steampowered.com/app/600/" target="_blank" rel="noopener noreferrer">테스트게임</a>'
    );
  });

  it("html — 출처 상점명이 번들 URL 링크(새 탭)로, 별도 '링크:' 줄 없음", () => {
    const out = formatChart(chart, "html");
    // 상점명(Fanatical)에 url 링크.
    expect(out).toContain('상점: <a href="https://fanatical.com/bundle/test" target="_blank" rel="noopener noreferrer">Fanatical</a>');
    // 별도 "링크:" 줄은 없음.
    expect(out).not.toContain("링크:");
  });

  it("markdown — 출처 상점명이 [상점](url) 링크, 별도 '링크:' 줄 없음", () => {
    const out = formatChart(chart, "markdown");
    expect(out).toContain("상점: [Fanatical](https://fanatical.com/bundle/test)");
    expect(out).not.toContain("링크:");
  });

  it("모든 포맷에 출처 상점 이름 포함", () => {
    for (const fmt of ["markdown", "steamgifts", "bbcode", "html"] as const) {
      expect(formatChart(chart, fmt)).toContain("Fanatical");
    }
  });

  it("priceNote(자유 가격 메모)가 모든 포맷 출력에 포함된다", () => {
    const note = "품목당 5+개 ₩1,610 · 7+개 ₩1,556";
    const withNote = { ...chart, priceNote: note };
    for (const fmt of ["markdown", "steamgifts", "bbcode", "html"] as const) {
      expect(formatChart(withNote, fmt)).toContain("품목당 5+개");
    }
  });

  it("source 없이 priceNote만 있어도 출력에 포함된다", () => {
    const manual = makeChart("수동 번들", [makeTier("기본", { kind: "retail" }, [game])]);
    manual.priceNote = "품목당 ₩1,489";
    expect(formatChart(manual, "markdown")).toContain("품목당 ₩1,489");
  });

  it("uncertain 게임은 모든 포맷 출력에 '?' 마커가 붙는다", () => {
    const uncertainGame = makeGame(900, "모호한게임", makePrice(10000), { uncertain: true });
    const c = makeChart("불확실", [makeTier("기본", { kind: "retail" }, [uncertainGame])]);
    // 마커 "(?)"는 이스케이프하지 않으므로 모든 포맷에 그대로.
    for (const fmt of ["markdown", "steamgifts", "bbcode", "html"] as const) {
      expect(formatChart(c, fmt)).toContain("(?)");
    }
  });

  it("markdown/steamgifts는 게임명·제목의 마크다운 메타문자를 이스케이프한다(주입 방지)", () => {
    const evil = makeGame(901, "Game](http://evil)", makePrice(10000));
    const c = makeChart("Title | *bold*", [makeTier("기본", { kind: "retail" }, [evil])]);
    for (const fmt of ["markdown", "steamgifts"] as const) {
      const out = formatChart(c, fmt);
      // 원시 "](http://evil)" 링크 주입이 그대로 나오면 안 됨.
      expect(out).not.toContain("Game](http://evil)");
      expect(out).toContain("\\]\\(http");
      // 제목의 표 구분자·강조도 이스케이프.
      expect(out).toContain("Title \\| \\*bold\\*");
    }
  });
});

// ============================================================================
// 6b. DLC 표시 + 가격 미상 행
// ============================================================================

describe("formatChart — DLC 표시 및 미상 가격", () => {
  const dlcGame = makeGame(700, "확장팩", makePrice(5000), { type: "dlc" });
  const unknownGame = makeGame(701, "미상게임", null, { priceUnknown: true });
  const chart = makeChart("DLC 번들", [
    makeTier("기본", { kind: "retail" }, [dlcGame, unknownGame]),
  ]);

  it("markdown에 (DLC) 문자열 + 미상 포함", () => {
    const out = formatChart(chart, "markdown");
    expect(out).toContain("(DLC)");
    expect(out).toContain("미상");
  });
});

// ============================================================================
// 6c. totals 미전달 시 자동 계산
// ============================================================================

describe("formatChart — totals 미전달 시 자동 계산", () => {
  const chart = makeChart("자동", [
    makeTier("기본", { kind: "retail" }, [makeGame(800, "게임Z", makePrice(12000))]),
  ]);

  it("totals 없이 호출해도 문자열 반환", () => {
    const out = formatChart(chart, "markdown");
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// 7. formatMoney KRW/USD 포맷 확인
// ============================================================================

describe("formatMoney", () => {
  it("KRW — ₩ + 천단위 콤마 정수", () => {
    expect(formatMoney({ currency: "KRW", amount: 54900 })).toBe("₩54,900");
    expect(formatMoney({ currency: "KRW", amount: 1000000 })).toBe("₩1,000,000");
    expect(formatMoney({ currency: "KRW", amount: 0 })).toBe("₩0");
  });

  it("USD — $ + 소수 2자리", () => {
    expect(formatMoney({ currency: "USD", amount: 8.99 })).toBe("$8.99");
    expect(formatMoney({ currency: "USD", amount: 15 })).toBe("$15.00");
  });

  it("EUR — € + 소수 2자리", () => {
    expect(formatMoney({ currency: "EUR", amount: 4.99 })).toBe("€4.99");
  });

  it("GBP — £ + 소수 2자리", () => {
    expect(formatMoney({ currency: "GBP", amount: 3.49 })).toBe("£3.49");
  });

  it("기타 통화 — amount + 공백 + currency", () => {
    expect(formatMoney({ currency: "JPY", amount: 980 })).toBe("980 JPY");
  });
});

// ============================================================================
// 8. 환율(krwRates) KRW 환산 — computeChartTotals / formatChart 병기
// ============================================================================

describe("computeChartTotals — 환율 KRW 환산", () => {
  // USD flat $27.00 티어 + KRW 게임가 ₩50,000.
  const games = [makeGame(1000, "환산게임", makePrice(50000))];
  const chart = makeChart("USD 번들", [
    makeTier("티어1", { kind: "flat", amount: 27, currency: "USD" }, games),
  ]);
  // 1 USD = 1340 KRW → payKrw = 27 * 1340 = 36180.
  const rates = { USD: 1340, EUR: 1500, KRW: 1 };

  it("krwRates 주면 payKrw·approxFx·savings가 환산으로 계산된다", () => {
    const totals = computeChartTotals(chart, rates);
    const tt = totals.tiers[0];
    expect(tt.payKrw).toBe(36180);
    expect(tt.approxFx).toBe(true);
    // retail 50000 - 36180 = 13820, percent = round(100*13820/50000) = 28
    expect(tt.savings).toEqual({ amount: 13820, percent: 28 });
    // 차트 전체도 동일
    expect(totals.payKrw).toBe(36180);
    expect(totals.approxFx).toBe(true);
    expect(totals.savings).toEqual({ amount: 13820, percent: 28 });
    // native pay는 그대로 USD
    expect(totals.pay).toEqual({ currency: "USD", amount: 27 });
  });

  it("krwRates 없으면 기존대로 savings null · payKrw undefined · approxFx undefined", () => {
    const totals = computeChartTotals(chart);
    const tt = totals.tiers[0];
    expect(tt.payKrw).toBeUndefined();
    expect(tt.approxFx).toBeUndefined();
    expect(tt.savings).toBeNull();
    expect(totals.payKrw).toBeUndefined();
    expect(totals.approxFx).toBeUndefined();
    expect(totals.savings).toBeNull();
  });

  it("rates에 해당 통화가 없으면 환산하지 않는다", () => {
    const totals = computeChartTotals(chart, { EUR: 1500, KRW: 1 });
    const tt = totals.tiers[0];
    expect(tt.payKrw).toBeUndefined();
    expect(tt.approxFx).toBeUndefined();
    expect(tt.savings).toBeNull();
    expect(totals.payKrw).toBeUndefined();
    expect(totals.savings).toBeNull();
  });

  it("KRW 티어는 환율 전달과 무관하게 approxFx=undefined, savings 계산", () => {
    const krwChart = makeChart("KRW 번들", [
      makeTier("티어1", { kind: "flat", amount: 40000, currency: "KRW" }, games),
    ]);
    const totals = computeChartTotals(krwChart, rates);
    const tt = totals.tiers[0];
    expect(tt.payKrw).toBe(40000);
    expect(tt.approxFx).toBeUndefined();
    // retail 50000 - 40000 = 10000, 20%
    expect(tt.savings).toEqual({ amount: 10000, percent: 20 });
  });

  it("formatChart 출력에 '(≈₩' 환산 병기와 '≈' 절약%가 포함된다", () => {
    const totals = computeChartTotals(chart, rates);
    for (const fmt of ["markdown", "steamgifts", "bbcode", "html"] as const) {
      const out = formatChart(chart, fmt, totals);
      expect(out).toContain("(≈₩");
      expect(out).toContain("≈28%");
    }
  });

  it("krwRates 없으면 formatChart에 '(≈₩' 병기가 없다(회귀 금지)", () => {
    const totals = computeChartTotals(chart);
    const out = formatChart(chart, "markdown", totals);
    expect(out).not.toContain("(≈₩");
  });
});
