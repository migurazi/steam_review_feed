/**
 * 번들 차트 포맷터 (formatChart, formatMoney).
 * markdown / steamgifts / bbcode / html 4가지 포맷을 지원한다.
 */

import type { Chart, ChartFormat, ChartTotals, GameRow, Money, Tier, TierTotals } from "@/lib/bundle/types";
import { computeChartTotals } from "@/lib/bundle/totals";

// ============================================================================
// formatMoney — 통화 심볼 + 천단위 콤마
// ============================================================================

/** KRW는 ₩ + 천단위 콤마 정수, USD/EUR/GBP는 심볼 + 소수 2자리, 그 외는 "amount CURRENCY". */
export function formatMoney(money: Money): string {
  const { currency, amount } = money;
  if (currency === "KRW") {
    return "₩" + Math.round(amount).toLocaleString("en-US");
  }
  const sym: Record<string, string> = { USD: "$", EUR: "€", GBP: "£" };
  const s = sym[currency];
  if (s) return s + amount.toFixed(2);
  return amount + " " + currency;
}

/** KRW 원 금액을 "₩" + 천단위 콤마 정수로. 환산 병기·절약 금액 표시용. */
function formatKrwAmount(amount: number): string {
  return "₩" + Math.round(amount).toLocaleString("en-US");
}

/**
 * pay가 비-KRW이고 payKrw가 있으면 " (≈₩x)" 환산 병기 문자열을, 아니면 "" 반환.
 * (pay가 KRW면 병기 불필요, payKrw 없으면 환산 불가.)
 */
function krwApproxSuffix(pay: Money | null, payKrw: number | undefined): string {
  if (!pay || pay.currency === "KRW" || payKrw == null) return "";
  return ` (≈${formatKrwAmount(payKrw)})`;
}

// ============================================================================
// 공통 헬퍼
// ============================================================================

/** 게임 행의 현재가 표시 문자열. */
function priceCell(game: GameRow): string {
  if (game.priceUnknown) return "미상";
  if (game.price === null) return "무료";
  return game.price.finalFormatted + (game.price.fallback ? "*" : "");
}

/** 게임 행의 정가 표시 문자열. */
function initialCell(game: GameRow): string {
  if (game.priceUnknown) return "미상";
  if (game.price === null) return "무료";
  return game.price.initialFormatted + (game.price.fallback ? "*" : "");
}

/** 할인율 표시. 0 또는 가격 없으면 "-". */
function discountCell(game: GameRow): string {
  if (!game.price || game.priceUnknown) return "-";
  if (game.price.discountPercent === 0) return "-";
  return `-${game.price.discountPercent}%`;
}

/** 평가 표시. */
function reviewCell(game: GameRow): string {
  if (!game.review) return "-";
  const { positivePercent, total } = game.review;
  return `${positivePercent}% (${total.toLocaleString("en-US")})`;
}

/**
 * 게임명 (DLC 여부 + 이름매칭 불확실 "?" 포함).
 * esc로 **게임 이름 부분만** 포맷별 이스케이프하고, "(DLC)"/"(?)" 마커는 우리가 넣는 고정 텍스트라
 * 그대로 둔다(마크다운에서 마커 괄호가 `\(DLC\)`로 깨지지 않게).
 */
function gameName(game: GameRow, esc: (s: string) => string = (s) => s): string {
  const base = game.type === "dlc" ? `${esc(game.name)} (DLC)` : esc(game.name);
  // uncertain: 이름 검색 매칭이라 다른 게임일 수 있음 — 출력에도 "(?)"로 표시해 링크 확인 유도.
  return game.uncertain ? `${base} (?)` : base;
}

/**
 * 마크다운 메타문자 이스케이프 — 표 셀·링크 텍스트에 들어가는 **서드파티 텍스트**(번들 제목·게임명)용.
 * `|`(표 구분)·`[]()`(링크)·`*_~`(강조)·`` ` ``·`<>#!` 등이 번들 데이터에 섞여 있어도 마크다운 구조가
 * 깨지거나 위장 링크/이미지가 주입되지 않게 한다. HTML/BBCode는 각자 htmlEscape/bbEscape로 처리.
 */
function mdEscape(s: string): string {
  return s.replace(/([\\`*_[\]()~|<>#!])/g, "\\$1");
}

/** 티어 헤더 텍스트. 비-KRW pay는 "(≈₩x)" 병기, savings 있으면 "(N% 절약)"(근사면 "≈N%") 표시. */
function tierHeadText(tier: Tier, totals: TierTotals): string {
  const pay = formatMoney(totals.pay) + krwApproxSuffix(totals.pay, totals.payKrw);
  const pct = totals.approxFx ? `≈${totals.savings?.percent}%` : `${totals.savings?.percent}%`;
  const savePart =
    totals.savings && totals.savings.percent > 0 ? ` (${pct} 절약)` : "";
  return `${tier.label} — ${pay}${savePart}`;
}

/** 티어 헤더를 생략해도 되는지 여부. 티어가 1개이고 label이 비었거나 "기본"이면 true. */
function shouldOmitTierHeader(chart: Chart, tier: Tier): boolean {
  if (chart.tiers.length !== 1) return false;
  return tier.label === "" || tier.label === "기본";
}

/** 소계 행 텍스트. 비-KRW pay는 "(≈₩x)" 병기, 절약 %는 근사면 "≈" 접두. */
function tierSummaryText(totals: TierTotals, missingNote: boolean): string {
  const parts: string[] = [
    `합계: ${formatMoney(totals.pay)}${krwApproxSuffix(totals.pay, totals.payKrw)}`,
  ];
  if (totals.savings && totals.savings.percent > 0) {
    const pct = totals.approxFx ? `≈${totals.savings.percent}%` : `${totals.savings.percent}%`;
    parts.push(`절약: ${formatKrwAmount(totals.savings.amount)} (${pct})`);
  }
  if (missingNote && totals.missingCount > 0) {
    parts.push(`가격 미상 ${totals.missingCount}개 제외`);
  }
  return parts.join(" / ");
}

/** 전체 합계 텍스트. */
function chartSummaryText(totals: ChartTotals): string {
  const parts: string[] = [
    `개별 현재가 합: ₩${Math.round(totals.retail).toLocaleString("en-US")}`,
  ];
  if (totals.pay) {
    parts.push(`지불: ${formatMoney(totals.pay)}${krwApproxSuffix(totals.pay, totals.payKrw)}`);
  }
  if (totals.savings && totals.savings.percent > 0) {
    parts.push(`절약: ${totals.approxFx ? "≈" : ""}${totals.savings.percent}%`);
  }
  return parts.join(" | ");
}

/** 출처/가격 메모 한 항목. url이 있으면 text를 링크로 렌더한다(상점명=링크). */
interface SourceItem {
  label: string;
  text: string;
  url?: string;
}

/**
 * 출처 + 가격 메모 항목 목록(상점/만료/비고/가격 메모). **상점은 번들 URL과 합쳐 상점명에 링크**를 건다
 * (별도 "링크:" 줄을 없애 한 줄 절약). 상점이 없고 url만 있으면 "링크" 항목으로 둔다.
 */
function sourceItems(chart: Chart): SourceItem[] {
  const items: SourceItem[] = [];
  const src = chart.source;
  if (src) {
    if (src.shop) items.push({ label: "상점", text: src.shop, url: src.url });
    else if (src.url) items.push({ label: "링크", text: src.url, url: src.url });
    if (src.expires) items.push({ label: "만료", text: src.expires });
    if (src.note) items.push({ label: "비고", text: src.note });
  }
  if (chart.priceNote) items.push({ label: "가격", text: chart.priceNote });
  return items;
}

/** 외부 링크는 새 탭에서 열리도록(HTML 출력·미리보기 공용). */
const HTML_LINK_ATTRS = ' target="_blank" rel="noopener noreferrer"';

/** 마크다운/SteamGifts 출처 줄 — url 있으면 text를 `[text](url)` 링크로. */
function mdSourceLine(it: SourceItem): string {
  return it.url ? `${it.label}: [${it.text}](${it.url})` : `${it.label}: ${it.text}`;
}

// ============================================================================
// Markdown 포맷 (GitHub/Reddit)
// ============================================================================

function formatMarkdown(chart: Chart, totals: ChartTotals): string {
  const lines: string[] = [];
  lines.push(`## ${mdEscape(chart.title)}`);
  lines.push("");

  const items = sourceItems(chart);
  if (items.length > 0) {
    // 항목마다 한 줄씩. 마크다운 하드 줄바꿈(끝 공백 2칸)으로 붙은 줄이 한 문단으로 합쳐지지 않게 한다.
    for (const it of items) lines.push(mdSourceLine(it) + "  ");
    lines.push("");
  }

  for (let i = 0; i < chart.tiers.length; i++) {
    const tier = chart.tiers[i];
    const tt = totals.tiers[i];

    if (!shouldOmitTierHeader(chart, tier)) {
      lines.push(`### ${tierHeadText(tier, tt)}`);
      lines.push("");
    }

    // 헤더 행
    lines.push("| 게임명 | 현재가 | 정가 | 할인 | 평가 |");
    lines.push("| --- | --- | --- | --- | --- |");

    for (const game of tier.games) {
      const name = `[${gameName(game, mdEscape)}](${game.storeUrl})`;
      lines.push(
        `| ${name} | ${priceCell(game)} | ${initialCell(game)} | ${discountCell(game)} | ${reviewCell(game)} |`
      );
    }

    lines.push("");
    lines.push(`> ${tierSummaryText(tt, true)}`);
    lines.push("");
  }

  lines.push(`**${chartSummaryText(totals)}**`);

  return lines.join("\n");
}

// ============================================================================
// SteamGifts 포맷 (마크다운 표 + 썸네일 컬럼)
// ============================================================================

function formatSteamgifts(chart: Chart, totals: ChartTotals): string {
  const lines: string[] = [];
  lines.push(`## ${mdEscape(chart.title)}`);
  lines.push("");

  const items = sourceItems(chart);
  if (items.length > 0) {
    // 항목마다 한 줄씩. 마크다운 하드 줄바꿈(끝 공백 2칸)으로 붙은 줄이 한 문단으로 합쳐지지 않게 한다.
    for (const it of items) lines.push(mdSourceLine(it) + "  ");
    lines.push("");
  }

  for (let i = 0; i < chart.tiers.length; i++) {
    const tier = chart.tiers[i];
    const tt = totals.tiers[i];

    if (!shouldOmitTierHeader(chart, tier)) {
      lines.push(`### ${tierHeadText(tier, tt)}`);
      lines.push("");
    }

    lines.push("| 썸네일 | 게임명 | 현재가 | 정가 | 할인 | 평가 |");
    lines.push("| --- | --- | --- | --- | --- | --- |");

    for (const game of tier.games) {
      const thumb = game.headerImage ? `![](${game.headerImage})` : "";
      const name = `[${gameName(game, mdEscape)}](${game.storeUrl})`;
      lines.push(
        `| ${thumb} | ${name} | ${priceCell(game)} | ${initialCell(game)} | ${discountCell(game)} | ${reviewCell(game)} |`
      );
    }

    lines.push("");
    lines.push(`> ${tierSummaryText(tt, true)}`);
    lines.push("");
  }

  lines.push(`**${chartSummaryText(totals)}**`);

  return lines.join("\n");
}

// ============================================================================
// BBCode 포맷
// ============================================================================

function bbEscape(s: string): string {
  return s.replace(/\[/g, "&#91;").replace(/]/g, "&#93;");
}

function formatBbcode(chart: Chart, totals: ChartTotals): string {
  const lines: string[] = [];
  lines.push(`[b][size=5]${bbEscape(chart.title)}[/size][/b]`);
  lines.push("");

  const items = sourceItems(chart);
  if (items.length > 0) {
    for (const it of items) {
      const text = it.url ? `[url=${it.url}]${bbEscape(it.text)}[/url]` : bbEscape(it.text);
      lines.push(`${bbEscape(it.label)}: ${text}`);
    }
    lines.push("");
  }

  for (let i = 0; i < chart.tiers.length; i++) {
    const tier = chart.tiers[i];
    const tt = totals.tiers[i];

    if (!shouldOmitTierHeader(chart, tier)) {
      lines.push(`[b][size=4]${bbEscape(tierHeadText(tier, tt))}[/size][/b]`);
      lines.push("");
    }

    lines.push("[table]");
    lines.push("[tr][th]썸네일[/th][th]게임명[/th][th]현재가[/th][th]정가[/th][th]할인[/th][th]평가[/th][/tr]");

    for (const game of tier.games) {
      const thumb = game.headerImage ? `[img]${game.headerImage}[/img]` : "";
      const name = `[url=${game.storeUrl}]${bbEscape(gameName(game))}[/url]`;
      lines.push(
        `[tr][td]${thumb}[/td][td]${name}[/td][td]${priceCell(game)}[/td][td]${initialCell(game)}[/td][td]${discountCell(game)}[/td][td]${reviewCell(game)}[/td][/tr]`
      );
    }

    lines.push("[/table]");
    lines.push("");
    lines.push(`[b]${bbEscape(tierSummaryText(tt, true))}[/b]`);
    lines.push("");
  }

  lines.push(`[b]${bbEscape(chartSummaryText(totals))}[/b]`);

  return lines.join("\n");
}

// ============================================================================
// HTML 포맷
// ============================================================================

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatHtml(chart: Chart, totals: ChartTotals): string {
  const lines: string[] = [];
  lines.push(`<h2>${htmlEscape(chart.title)}</h2>`);

  const items = sourceItems(chart);
  if (items.length > 0) {
    const htmlSourceLine = (it: SourceItem): string => {
      const text = it.url
        ? `<a href="${htmlEscape(it.url)}"${HTML_LINK_ATTRS}>${htmlEscape(it.text)}</a>`
        : htmlEscape(it.text);
      return `${htmlEscape(it.label)}: ${text}`;
    };
    lines.push(`<p>${items.map(htmlSourceLine).join("<br>")}</p>`);
  }

  for (let i = 0; i < chart.tiers.length; i++) {
    const tier = chart.tiers[i];
    const tt = totals.tiers[i];

    if (!shouldOmitTierHeader(chart, tier)) {
      lines.push(`<h3>${htmlEscape(tierHeadText(tier, tt))}</h3>`);
    }

    // border="1" cellspacing="0": CSS 없이 열어도(저장한 .html·포럼) 표 테두리가 보이게 한다.
    lines.push('<table border="1" cellspacing="0">');
    lines.push(
      "<thead><tr><th>썸네일</th><th>게임명</th><th>현재가</th><th>정가</th><th>할인</th><th>평가</th></tr></thead>"
    );
    lines.push("<tbody>");

    for (const game of tier.games) {
      const thumb = game.headerImage
        ? `<img src="${htmlEscape(game.headerImage)}" width="120" alt="">`
        : "";
      const name = `<a href="${htmlEscape(game.storeUrl)}"${HTML_LINK_ATTRS}>${htmlEscape(gameName(game))}</a>`;
      lines.push(
        `<tr><td>${thumb}</td><td>${name}</td><td>${htmlEscape(priceCell(game))}</td><td>${htmlEscape(initialCell(game))}</td><td>${htmlEscape(discountCell(game))}</td><td>${htmlEscape(reviewCell(game))}</td></tr>`
      );
    }

    lines.push("</tbody></table>");
    lines.push(`<p><strong>${htmlEscape(tierSummaryText(tt, true))}</strong></p>`);
  }

  lines.push(`<p><strong>${htmlEscape(chartSummaryText(totals))}</strong></p>`);

  return lines.join("\n");
}

// ============================================================================
// 진입점
// ============================================================================

/**
 * 차트를 지정 포맷으로 직렬화한다.
 * totals를 전달하지 않으면 내부에서 computeChartTotals를 호출해 계산한다.
 */
export function formatChart(
  chart: Chart,
  format: ChartFormat,
  totals?: ChartTotals
): string {
  const t = totals ?? computeChartTotals(chart);
  switch (format) {
    case "markdown":
      return formatMarkdown(chart, t);
    case "steamgifts":
      return formatSteamgifts(chart, t);
    case "bbcode":
      return formatBbcode(chart, t);
    case "html":
      return formatHtml(chart, t);
  }
}
