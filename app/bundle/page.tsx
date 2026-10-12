'use client';

/**
 * 번들 차트 메이커 (/bundle) — 오케스트레이터 (작업 지시서 20261012_01 단계 3).
 *
 * 세 입력 소스로 차트를 채우고 티어 편집·합계·4포맷 출력을 렌더한다. 비로그인 접근 가능(세션 불필요).
 *   ① ITAD 최신 번들 목록(BundleBrowser) → /api/bundle/itad/resolve
 *   ② 붙여넣기/검색(SourceInput) → /api/bundle/resolve 또는 ITAD URL resolve
 *   ③ 미매칭 수습(UnmatchedList) → 검색 → 단건 보강 → 원래 티어 삽입
 *
 * 상태: chart(Chart) + unmatched(UnmatchedGame[]). 티어/게임 이동·삭제·가격규칙은 TierEditor가 돌려주는
 *       새 Chart로 갱신한다. 드래그 라이브러리 없이 드롭다운 + 위/아래 버튼.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import ThemeToggle from '@/components/ThemeToggle';
import AppNav from '@/components/AppNav';
import AppFooter from '@/components/AppFooter';
import BundleBrowser from '@/components/bundle/BundleBrowser';
import SourceInput from '@/components/bundle/SourceInput';
import TierEditor from '@/components/bundle/TierEditor';
import UnmatchedList from '@/components/bundle/UnmatchedList';
import FormatOutput from '@/components/bundle/FormatOutput';
import { computeChartTotals } from '@/lib/bundle/totals';
import type { Chart, GameRow, Tier, UnmatchedGame } from '@/lib/bundle/types';

/** 수동 추가 게임을 담는 기본 티어 라벨. */
const MANUAL_TIER_LABEL = '게임';

function emptyChart(): Chart {
  return { title: '번들 차트', tiers: [] };
}

/** chart 내 이미 존재하는 appId 집합(중복 추가 방지). */
function existingAppIds(chart: Chart): Set<number> {
  const ids = new Set<number>();
  for (const tier of chart.tiers) {
    for (const g of tier.games) ids.add(g.appId);
  }
  return ids;
}

export default function BundlePage() {
  const [chart, setChart] = useState<Chart>(emptyChart);
  const [unmatched, setUnmatched] = useState<UnmatchedGame[]>([]);
  // KRW 환율 맵(각 통화 1단위당 KRW). 마운트 시 1회 조회, 실패 시 null → 환산 없이 기존 동작.
  const [krwRates, setKrwRates] = useState<Record<string, number> | null>(null);
  // 세션(선택) — 로그인 상태면 헤더에 프로필·로그아웃 표시. 비로그인이어도 리다이렉트하지 않는다(공개 페이지).
  const router = useRouter();
  const [steamId, setSteamId] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/fx')
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { rates: Record<string, number> | null } | null) => {
        if (!cancelled && body && body.rates) setKrwRates(body.rates);
      })
      .catch(() => {
        // 환율 조회 실패는 무시(환산 불가로 degrade).
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 로그인 상태면 프로필·로그아웃 표시(공개 페이지라 비로그인이어도 리다이렉트하지 않음).
  useEffect(() => {
    let cancelled = false;
    fetch('/api/auth/me')
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { steamId?: string; displayName?: string; avatarUrl?: string } | null) => {
        if (cancelled || !data?.steamId) return;
        setSteamId(data.steamId);
        setDisplayName(data.displayName ?? null);
        setAvatarUrl(data.avatarUrl ?? null);
      })
      .catch(() => {
        // 세션 조회 실패는 무시(비로그인으로 취급).
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const totals = useMemo(
    () => computeChartTotals(chart, krwRates ?? undefined),
    [chart, krwRates]
  );
  const tierLabels = useMemo(
    () => chart.tiers.map((t, i) => t.label || `티어 ${i + 1}`),
    [chart]
  );
  const hasContent = chart.tiers.some((t) => t.games.length > 0);

  // ── 입력 ① / ②(ITAD URL): 차트 전체 교체 ────────────────────────────────
  function handleChartResolved(next: Chart, nextUnmatched: UnmatchedGame[]) {
    setChart(next);
    setUnmatched(nextUnmatched);
  }

  // ── 입력 ②(Steam/수동): rows를 기본 티어에 추가(중복 appId 제외) ──────────
  function handleRowsResolved(rows: GameRow[]) {
    setChart((prev) => {
      const seen = existingAppIds(prev);
      const fresh = rows.filter((r) => !seen.has(r.appId));
      if (fresh.length === 0) return prev;

      const tiers = prev.tiers.slice();
      // 기본 티어를 찾거나(라벨 일치) 없으면 만든다. 티어가 하나도 없으면 그 티어를 기본으로 쓴다.
      let idx = tiers.findIndex((t) => t.label === MANUAL_TIER_LABEL);
      if (idx === -1 && tiers.length === 1 && tiers[0].games.length === 0) idx = 0;
      if (idx === -1) {
        const tier: Tier = {
          id: crypto.randomUUID(),
          label: MANUAL_TIER_LABEL,
          pricing: { kind: 'retail' },
          games: fresh,
        };
        return { ...prev, tiers: [...tiers, tier] };
      }
      tiers[idx] = { ...tiers[idx], games: [...tiers[idx].games, ...fresh] };
      return { ...prev, tiers };
    });
  }

  // ── 입력 ③: 미매칭 게임을 원래 티어에 삽입하고 목록에서 제거 ───────────────
  function handleUnmatchedResolve(uuid: string, tierIndex: number, row: GameRow) {
    setChart((prev) => {
      if (tierIndex < 0 || tierIndex >= prev.tiers.length) return prev;
      const seen = existingAppIds(prev);
      if (seen.has(row.appId)) return prev; // 이미 있으면 티어 변경만 생략(중복 방지)
      const tiers = prev.tiers.slice();
      tiers[tierIndex] = { ...tiers[tierIndex], games: [...tiers[tierIndex].games, row] };
      return { ...prev, tiers };
    });
    setUnmatched((prev) => prev.filter((g) => g.uuid !== uuid));
  }

  function handleUnmatchedSkip(uuid: string) {
    setUnmatched((prev) => prev.filter((g) => g.uuid !== uuid));
  }

  function handleReset() {
    setChart(emptyChart());
    setUnmatched([]);
  }

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
      router.push('/');
    } catch {
      setLoggingOut(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header (recommend 페이지 패턴) */}
      <header className="sticky top-0 z-40 bg-white/95 dark:bg-gray-900/95 backdrop-blur border-b border-gray-200 dark:border-gray-800 px-4 py-3">
        <div className="max-w-5xl mx-auto flex items-center justify-between gap-4 flex-wrap">
          <Link href="/" className="text-[#1b6fa8] dark:text-[#66c0f4] font-bold text-base shrink-0">
            Steam Review Feed
          </Link>
          <AppNav current="bundle" />
          <div className="flex items-center gap-3">
            {steamId && (
              <a
                href={`https://steamcommunity.com/profiles/${steamId}`}
                target="_blank"
                rel="noopener noreferrer"
                className="hidden sm:flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400 hover:text-[#1b6fa8] dark:hover:text-[#66c0f4] transition-colors"
                title={steamId}
              >
                {avatarUrl && <img src={avatarUrl} alt="" className="w-6 h-6 rounded-full" />}
                <span className="truncate max-w-[120px]">{displayName || steamId}</span>
              </a>
            )}
            <ThemeToggle />
            {steamId && (
              <button
                type="button"
                onClick={handleLogout}
                disabled={loggingOut}
                className="px-3 py-1.5 text-sm text-gray-500 dark:text-gray-400 border border-gray-300 dark:border-gray-700 rounded-lg hover:text-gray-700 dark:hover:text-gray-200 hover:border-gray-400 dark:hover:border-gray-600 transition-colors disabled:opacity-50"
              >
                {loggingOut ? '...' : '로그아웃'}
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-5xl mx-auto w-full px-4 py-6 space-y-6">
        <div className="space-y-1">
          <h1 className="text-xl font-bold">번들 차트 메이커</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Steam 게임 번들의 가격·평가·링크를 표로 만들어 게시판에 붙여넣을 수 있습니다. 로그인 없이 사용할 수
            있습니다.
          </p>
        </div>

        {/* 차트 제목 */}
        <section className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4 space-y-3">
          <div className="flex items-end gap-2 flex-wrap">
            <div className="flex-1 min-w-[200px]">
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1" htmlFor="chart-title">
                차트 제목
              </label>
              <input
                id="chart-title"
                type="text"
                value={chart.title}
                onChange={(e) => setChart((prev) => ({ ...prev, title: e.target.value }))}
                className="w-full px-3 py-2 text-sm bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:border-[#1b6fa8] dark:focus:border-[#66c0f4]"
              />
            </div>
            {hasContent && (
              <button
                type="button"
                onClick={handleReset}
                className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400 border border-gray-300 dark:border-gray-600 rounded-lg hover:text-red-600 dark:hover:text-red-400 hover:border-red-400 dark:hover:border-red-500 transition-colors"
              >
                차트 초기화
              </button>
            )}
          </div>
          <div>
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1" htmlFor="chart-price-note">
              가격 메모 (선택)
            </label>
            <input
              id="chart-price-note"
              type="text"
              value={chart.priceNote ?? ''}
              onChange={(e) => setChart((prev) => ({ ...prev, priceNote: e.target.value || undefined }))}
              placeholder="정형 티어가로 표현 못 하는 가격. 예: 품목당 5+개 ₩1,610 · 7+개 ₩1,556 · 12+개 ₩1,489"
              className="w-full px-3 py-2 text-sm bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:border-[#1b6fa8] dark:focus:border-[#66c0f4]"
            />
            <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
              Fanatical &quot;Build Your Own&quot;처럼 ITAD에 가격이 없는 번들의 품목당 단가를 적으면 출력 상단에 함께 표시됩니다.
            </p>
          </div>
          {chart.source && (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {chart.source.shop && <span>출처: {chart.source.shop}</span>}
              {chart.source.url && (
                <>
                  {' · '}
                  <a
                    href={chart.source.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[#1b6fa8] dark:text-[#66c0f4] underline"
                  >
                    번들 링크
                  </a>
                </>
              )}
            </p>
          )}
        </section>

        {/* 입력 ①: ITAD 최신 번들 */}
        <section className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4 space-y-3">
          <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">최신 번들 목록 (ITAD)</h2>
          <BundleBrowser onResolved={handleChartResolved} />
        </section>

        {/* 입력 ②: 붙여넣기 / 검색 */}
        <section className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4 space-y-3">
          <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">직접 입력 / 검색</h2>
          <SourceInput onRowsResolved={handleRowsResolved} onChartResolved={handleChartResolved} />
        </section>

        {/* 입력 ③: 미매칭 수습 */}
        <UnmatchedList
          unmatched={unmatched}
          tierLabels={tierLabels}
          onResolve={handleUnmatchedResolve}
          onSkip={handleUnmatchedSkip}
        />

        {/* 티어 편집 */}
        <TierEditor chart={chart} totals={totals} onChange={setChart} />

        {/* 출력 — 내용이 있을 때만 */}
        {hasContent && <FormatOutput chart={chart} totals={totals} />}
      </main>

      <AppFooter />
    </div>
  );
}
