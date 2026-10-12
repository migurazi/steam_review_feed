'use client';

/**
 * ITAD 최신 번들 브라우저 (작업 지시서 20261012_01 단계 3·2).
 *
 * GET /api/bundle/itad/list 로 목록을 받아 카드로 표시한다(제목 클라이언트 필터).
 * 각 항목은 상점·만료·게임수·티어 가격을 보여주고, 클릭 시 POST /api/bundle/itad/resolve 로
 * 차트를 불러와 부모 콜백(onResolved)에 넘긴다.
 *
 * configured:false 면 ITAD 키 발급 안내 + /setup 링크만 표시한다(목록 없음).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { formatMoney } from '@/lib/bundle/format';
import type { Chart, UnmatchedGame } from '@/lib/bundle/types';

interface ItadListItem {
  id: number;
  title: string;
  shop?: string;
  url?: string;
  expires?: string;
  gameCount: number;
  tierPrices: { amount: number; currency: string }[];
}

export interface BundleBrowserProps {
  /** resolve 성공 시 호출. 부모가 chart/unmatched를 상태로 반영한다. */
  onResolved: (chart: Chart, unmatched: UnmatchedGame[]) => void;
}

function formatExpires(iso?: string): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const diffMs = t - Date.now();
  if (diffMs <= 0) return '종료됨';
  const days = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  if (days >= 1) return `${days}일 남음`;
  const hours = Math.floor(diffMs / (60 * 60 * 1000));
  return hours >= 1 ? `${hours}시간 남음` : '곧 종료';
}

export default function BundleBrowser({ onResolved }: BundleBrowserProps) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [bundles, setBundles] = useState<ItadListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [resolvingId, setResolvingId] = useState<number | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/bundle/itad/list?limit=30');
      if (!res.ok) {
        setError('번들 목록을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.');
        return;
      }
      const data = (await res.json()) as { configured: boolean; bundles: ItadListItem[] };
      setConfigured(data.configured);
      setBundles(Array.isArray(data.bundles) ? data.bundles : []);
    } catch {
      setError('번들 목록을 불러오지 못했습니다. 네트워크 연결을 확인해 주세요.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadList();
  }, [loadList]);

  async function handleResolve(id: number) {
    setResolvingId(id);
    setResolveError(null);
    try {
      const res = await fetch('/api/bundle/itad/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bundleId: id }),
      });
      const data = await res.json();
      if (!res.ok) {
        setResolveError(data?.error ?? '번들을 불러오지 못했습니다.');
        return;
      }
      onResolved(data.chart as Chart, (data.unmatched ?? []) as UnmatchedGame[]);
    } catch {
      setResolveError('번들을 불러오는 중 오류가 발생했습니다.');
    } finally {
      setResolvingId(null);
    }
  }

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return bundles;
    return bundles.filter((b) => b.title.toLowerCase().includes(q));
  }, [bundles, filter]);

  if (loading && configured === null) {
    return (
      <div className="flex justify-center py-8">
        <div className="w-5 h-5 border-2 border-[#1b6fa8] dark:border-[#66c0f4] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (configured === false) {
    return (
      <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg p-4 space-y-2 text-sm">
        <p className="font-medium text-amber-900 dark:text-amber-200">ITAD API 키가 필요합니다</p>
        <p className="text-amber-800 dark:text-amber-300">
          최신 번들 목록을 불러오려면 IsThereAnyDeal API 키를 등록해야 합니다. 키 없이도 아래에서 게임을 직접
          붙여넣거나 검색해 차트를 만들 수 있습니다.
        </p>
        <div className="flex flex-wrap items-center gap-3 pt-1">
          <a
            href="https://isthereanydeal.com/apps/my/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[#1b6fa8] dark:text-[#66c0f4] underline"
          >
            ITAD API 키 발급
          </a>
          <Link href="/setup" className="text-[#1b6fa8] dark:text-[#66c0f4] underline">
            /setup 에서 키 등록
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <label className="sr-only" htmlFor="bundle-filter">
          번들 제목 필터
        </label>
        <input
          id="bundle-filter"
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="제목으로 필터..."
          className="flex-1 min-w-[180px] px-3 py-2 text-sm bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:border-[#1b6fa8] dark:focus:border-[#66c0f4]"
        />
        <button
          type="button"
          onClick={loadList}
          disabled={loading}
          className="px-3 py-2 text-sm text-gray-600 dark:text-gray-300 border border-gray-300 dark:border-gray-600 rounded-lg hover:border-gray-400 dark:hover:border-gray-500 transition-colors disabled:opacity-50"
        >
          {loading ? '불러오는 중...' : '새로고침'}
        </button>
      </div>

      {error && (
        <p className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded-lg p-3">
          {error}
        </p>
      )}
      {resolveError && (
        <p className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded-lg p-3">
          {resolveError}
        </p>
      )}

      {!error && filtered.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-800/50 rounded-lg p-4">
          {bundles.length === 0 ? '표시할 최신 번들이 없습니다.' : '필터와 일치하는 번들이 없습니다.'}
        </p>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2">
          {filtered.map((b) => {
            const expires = formatExpires(b.expires);
            const resolving = resolvingId === b.id;
            return (
              <li key={b.id}>
                <button
                  type="button"
                  onClick={() => handleResolve(b.id)}
                  disabled={resolvingId !== null}
                  aria-label={`${b.title} 차트로 불러오기`}
                  className="w-full h-full text-left bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-3 space-y-1.5 hover:border-[#1b6fa8] dark:hover:border-[#66c0f4] hover:shadow-sm transition-all disabled:opacity-60 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1b6fa8] dark:focus-visible:ring-[#66c0f4]"
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-sm font-medium text-gray-800 dark:text-gray-100 line-clamp-2">
                      {b.title}
                    </span>
                    {resolving && (
                      <span className="shrink-0 w-4 h-4 border-2 border-[#1b6fa8] dark:border-[#66c0f4] border-t-transparent rounded-full animate-spin" />
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
                    {b.shop && <span>{b.shop}</span>}
                    <span>게임 {b.gameCount}개</span>
                    {expires && <span>{expires}</span>}
                  </div>
                  {b.tierPrices.length > 0 && (
                    <div className="flex flex-wrap gap-1 pt-0.5">
                      {b.tierPrices.map((p, i) => (
                        <span
                          key={i}
                          className="text-xs px-1.5 py-0.5 bg-[#1b6fa8]/10 dark:bg-[#66c0f4]/15 text-[#1b6fa8] dark:text-[#66c0f4] rounded"
                        >
                          {formatMoney({ currency: p.currency, amount: p.amount })}
                        </span>
                      ))}
                    </div>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
