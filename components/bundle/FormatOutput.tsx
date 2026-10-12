'use client';

/**
 * 포맷 출력 (작업 지시서 20261012_01 단계 3·7).
 *
 * - 상단: computeChartTotals 합계 요약(티어별·전체 retail=개별합/pay=지불/savings).
 *   통화 혼재로 savings가 null이면 "환산 불가"로 표기(정상 — M3).
 * - 포맷 탭 4종(steamgifts/bbcode/markdown/html) → formatChart 결과를 <pre> 코드블록 + 복사/다운로드.
 *   복사·다운로드 모두 **그 포맷의 출력 문자열만** 내보낸다(페이지 전체 복사와 혼동 주의 — 사용자가
 *   Ctrl+A로 페이지를 통째 복사하면 <pre>의 HTML 원문까지 섞여 저장되므로, 버튼 사용을 유도한다).
 */

import { useMemo, useState } from 'react';
import type { Chart, ChartFormat, ChartTotals } from '@/lib/bundle/types';
import { formatChart, formatMoney } from '@/lib/bundle/format';

const FORMATS: { value: ChartFormat; label: string }[] = [
  { value: 'steamgifts', label: 'SteamGifts' },
  { value: 'bbcode', label: 'BBCode' },
  { value: 'markdown', label: '마크다운' },
  { value: 'html', label: 'HTML' },
];

/** 포맷별 다운로드 파일 확장자·MIME. */
const FILE_META: Record<ChartFormat, { ext: string; mime: string }> = {
  html: { ext: 'html', mime: 'text/html' },
  markdown: { ext: 'md', mime: 'text/markdown' },
  steamgifts: { ext: 'md', mime: 'text/markdown' },
  bbcode: { ext: 'txt', mime: 'text/plain' },
};

/** 파일명으로 안전한 문자열로 바꾼다(제목 → 파일명). */
function safeFileName(title: string): string {
  const base = title.trim().replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, '_').slice(0, 60);
  return base || 'bundle-chart';
}

/** 클립보드 복사. Clipboard API가 없거나 실패하면(비보안 컨텍스트 등) execCommand로 폴백. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 폴백으로 진행
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export interface FormatOutputProps {
  chart: Chart;
  totals: ChartTotals;
}

export default function FormatOutput({ chart, totals }: FormatOutputProps) {
  const [format, setFormat] = useState<ChartFormat>('steamgifts');
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [view, setView] = useState<'source' | 'preview'>('source');

  const output = useMemo(() => formatChart(chart, format, totals), [chart, format, totals]);
  const htmlPreview = useMemo(() => formatChart(chart, 'html', totals), [chart, totals]);

  /** 이 포맷의 출력 문자열만 클립보드로. 실패 시 폴백(execCommand) → 그래도 실패면 명시 표시. */
  async function copy() {
    const ok = await copyText(output);
    setCopyState(ok ? 'copied' : 'failed');
    setTimeout(() => setCopyState('idle'), 1800);
  }

  /** 이 포맷의 출력만 파일로 저장(export). HTML은 .html, 그 외는 .md/.txt. */
  function download() {
    const { ext, mime } = FILE_META[format];
    const blob = new Blob([output], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safeFileName(chart.title)}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="space-y-4">
      <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">출력</h2>

      <TotalsSummary totals={totals} />

      {/* 포맷 탭 + 미리보기 토글 + 복사 */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <div
            role="tablist"
            aria-label="출력 포맷"
            className="flex items-center gap-1 text-sm bg-gray-100 dark:bg-gray-800 rounded-lg p-1"
          >
            {FORMATS.map((f) => (
              <button
                key={f.value}
                type="button"
                role="tab"
                aria-selected={format === f.value}
                onClick={() => setFormat(f.value)}
                className={
                  format === f.value
                    ? 'px-3 py-1.5 rounded bg-white dark:bg-[#1b2838] text-[#1b6fa8] dark:text-[#66c0f4] border border-gray-300 dark:border-[#4c6b8a] shadow-sm font-medium'
                    : 'px-3 py-1.5 rounded text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors'
                }
              >
                {f.label}
              </button>
            ))}
          </div>
          <div
            role="group"
            aria-label="보기 모드"
            className="flex items-center gap-1 text-sm bg-gray-100 dark:bg-gray-800 rounded-lg p-1"
          >
            <button
              type="button"
              aria-pressed={view === 'source'}
              onClick={() => setView('source')}
              className={
                view === 'source'
                  ? 'px-3 py-1.5 rounded bg-white dark:bg-[#1b2838] text-[#1b6fa8] dark:text-[#66c0f4] border border-gray-300 dark:border-[#4c6b8a] shadow-sm font-medium'
                  : 'px-3 py-1.5 rounded text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors'
              }
            >
              원문
            </button>
            <button
              type="button"
              aria-pressed={view === 'preview'}
              onClick={() => setView('preview')}
              className={
                view === 'preview'
                  ? 'px-3 py-1.5 rounded bg-white dark:bg-[#1b2838] text-[#1b6fa8] dark:text-[#66c0f4] border border-gray-300 dark:border-[#4c6b8a] shadow-sm font-medium'
                  : 'px-3 py-1.5 rounded text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors'
              }
            >
              미리보기
            </button>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={copy}
            className="px-3 py-1.5 text-sm bg-[#1b6fa8] dark:bg-[#1b2838] border border-[#1b6fa8] dark:border-[#4c6b8a] text-white rounded-lg hover:bg-[#155a8a] dark:hover:bg-[#2a475e] transition-colors"
          >
            {copyState === 'copied' ? '복사됨' : copyState === 'failed' ? '복사 실패' : '복사'}
          </button>
          <button
            type="button"
            onClick={download}
            className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 rounded-lg hover:text-gray-800 dark:hover:text-gray-100 hover:border-gray-400 dark:hover:border-gray-500 transition-colors"
            title={`이 포맷만 .${FILE_META[format].ext} 파일로 저장`}
          >
            다운로드
          </button>
        </div>
      </div>

      <p className="text-xs text-gray-400 dark:text-gray-500">
        복사·다운로드는 <strong>이 포맷의 결과만</strong> 내보냅니다. 페이지를 전체 선택(Ctrl+A)해 복사하면
        페이지 글과 표 원문이 함께 들어가므로 위 버튼을 쓰세요.
      </p>

      {view === 'source' ? (
        <pre className="max-h-96 overflow-auto bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg p-3 text-xs text-gray-700 dark:text-gray-300 whitespace-pre-wrap break-words">
          {output}
        </pre>
      ) : (
        <div className="overflow-auto max-h-[600px] border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900">
          {format !== 'html' && (
            <p className="px-4 pt-3 pb-2 text-xs text-gray-400 dark:text-gray-500 border-b border-gray-100 dark:border-gray-800">
              실제 표시는 포럼/뷰어마다 다릅니다. HTML 기준 근사 미리보기입니다.
            </p>
          )}
          <div
            className="bundle-html-preview p-4"
            // formatChart가 모든 텍스트 필드를 htmlEscape해 생성하며 table/img/a/h2/h3/p 태그만 포함합니다.
            dangerouslySetInnerHTML={{ __html: htmlPreview }}
          />
          <style>{`
            /* 이 앱은 class 기반 다크모드(.dark on html)라 prefers-color-scheme가 아니라 .dark로 분기한다.
               th/td에 명시적 color를 줘, 밝은 글자가 밝은 th 배경에 묻히는 문제를 막는다. */
            .bundle-html-preview { color: #111827; }
            .bundle-html-preview table { border-collapse: collapse; width: 100%; font-size: 0.8125rem; }
            .bundle-html-preview th,
            .bundle-html-preview td { border: 1px solid #9ca3af; padding: 0.375rem 0.625rem; text-align: left; vertical-align: top; color: inherit; }
            .bundle-html-preview th { background: #f3f4f6; color: #111827; font-weight: 600; }
            .bundle-html-preview img { max-width: 48px; height: auto; display: block; }
            .bundle-html-preview a { color: #1b6fa8; text-decoration: none; }
            .bundle-html-preview a:hover { text-decoration: underline; }
            .bundle-html-preview h2,
            .bundle-html-preview h3 { margin: 0.75rem 0 0.375rem; font-weight: 600; }
            .dark .bundle-html-preview { color: #e5e7eb; }
            .dark .bundle-html-preview th { background: #1f2937; color: #e5e7eb; }
            .dark .bundle-html-preview th,
            .dark .bundle-html-preview td { border-color: #374151; }
            .dark .bundle-html-preview a { color: #66c0f4; }
          `}</style>
        </div>
      )}
    </section>
  );
}

function TotalsSummary({ totals }: { totals: ChartTotals }) {
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4 space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="text-gray-500 dark:text-gray-400">
          게임 <strong className="text-gray-700 dark:text-gray-200">{totals.gameCount}</strong>개
        </span>
        <span className="text-gray-500 dark:text-gray-400">
          개별 현재가 합{' '}
          <strong className="text-gray-700 dark:text-gray-200">
            {formatMoney({ currency: 'KRW', amount: totals.retail })}
          </strong>
        </span>
        <span className="text-gray-500 dark:text-gray-400">
          지불{' '}
          <strong className="text-gray-700 dark:text-gray-200">
            {totals.pay ? formatMoney(totals.pay) : '환산 불가'}
            {totals.pay && totals.pay.currency !== 'KRW' && totals.payKrw != null && (
              <span className="ml-1 font-normal text-gray-400 dark:text-gray-500">
                (≈{formatMoney({ currency: 'KRW', amount: totals.payKrw })})
              </span>
            )}
          </strong>
        </span>
        <span className="text-gray-500 dark:text-gray-400">
          절약{' '}
          <strong className="text-[#5a8a1a] dark:text-[#beee11]">
            {totals.savings ? `${totals.approxFx ? '≈' : ''}${totals.savings.percent}%` : '환산 불가'}
          </strong>
        </span>
      </div>
      {totals.pay === null && totals.payKrw == null && (
        <p className="text-xs text-gray-400 dark:text-gray-500">
          티어 통화가 섞여 있어(예: USD 티어 + KRW 게임가) 전체 지불·절약은 환산할 수 없습니다. 티어별 금액은
          위 편집기와 아래 출력에 표시됩니다.
        </p>
      )}
    </div>
  );
}
