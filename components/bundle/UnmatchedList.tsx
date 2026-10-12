'use client';

/**
 * 미매칭 게임 수습 목록 (작업 지시서 20261012_01 단계 3·6 — M1 왕복).
 *
 * ITAD 번들 변환 시 Steam appId를 찾지 못한 게임(UnmatchedGame)을 이름 검색으로 확정한다:
 *   이름 검색(GET /api/search) → appId 선택 → POST /api/bundle/resolve(단건 appIds:[id])로 GameRow 보강
 *   → 부모 콜백(onResolve)으로 원래 tierIndex 티어에 삽입. 건너뛰기(onSkip)로 목록에서 제거.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { GameRow, UnmatchedGame } from '@/lib/bundle/types';

interface SearchResult {
  appId: number;
  name: string;
  imageUrl: string;
}

export interface UnmatchedListProps {
  unmatched: UnmatchedGame[];
  tierLabels: string[];
  /** uuid 게임이 appId로 확정돼 보강됨. 부모가 tierIndex 티어에 row를 삽입하고 목록에서 제거. */
  onResolve: (uuid: string, tierIndex: number, row: GameRow) => void;
  /** uuid 게임을 건너뛴다(목록에서 제거). */
  onSkip: (uuid: string) => void;
}

export default function UnmatchedList({ unmatched, tierLabels, onResolve, onSkip }: UnmatchedListProps) {
  if (unmatched.length === 0) return null;

  return (
    <section className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg p-4 space-y-3">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold text-amber-900 dark:text-amber-200">
          Steam에서 찾지 못한 게임 ({unmatched.length})
        </h2>
        <p className="text-xs text-amber-800 dark:text-amber-300">
          ITAD 번들의 일부 게임을 Steam AppID로 매칭하지 못했습니다. 이름으로 검색해 추가하거나 건너뛰세요.
        </p>
      </div>
      <ul className="space-y-2">
        {unmatched.map((g) => (
          <UnmatchedRow
            key={g.uuid}
            game={g}
            tierLabel={tierLabels[g.tierIndex] ?? `티어 ${g.tierIndex + 1}`}
            onResolve={onResolve}
            onSkip={onSkip}
          />
        ))}
      </ul>
    </section>
  );
}

function UnmatchedRow({
  game,
  tierLabel,
  onResolve,
  onSkip,
}: {
  game: UnmatchedGame;
  tierLabel: string;
  onResolve: (uuid: string, tierIndex: number, row: GameRow) => void;
  onSkip: (uuid: string) => void;
}) {
  const [query, setQuery] = useState(game.title);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const search = useCallback(async (q: string) => {
    if (!q.trim()) {
      setResults([]);
      setOpen(false);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      if (res.ok) {
        const data = await res.json();
        setResults(data.results ?? []);
        setOpen(true);
      }
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  function onQueryChange(v: string) {
    setQuery(v);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => search(v), 300);
  }

  async function pick(result: SearchResult) {
    setOpen(false);
    setResolving(true);
    setError(null);
    try {
      const res = await fetch('/api/bundle/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appIds: [result.appId] }),
      });
      if (!res.ok) {
        setError('게임 정보를 불러오지 못했습니다.');
        return;
      }
      const data = (await res.json()) as { rows: GameRow[] };
      const row = data.rows?.[0];
      if (!row) {
        setError('게임 정보를 불러오지 못했습니다.');
        return;
      }
      // 이름 검색으로 매칭 — 정확한 appid가 아닐 수 있으므로 uncertain 표시.
      onResolve(game.uuid, game.tierIndex, { ...row, uncertain: true });
    } catch {
      setError('요청 중 오류가 발생했습니다.');
    } finally {
      setResolving(false);
    }
  }

  return (
    <li className="bg-white dark:bg-gray-800 border border-amber-200 dark:border-amber-800 rounded-lg p-2.5 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm text-gray-700 dark:text-gray-200 truncate" title={game.title}>
          {game.title}
        </span>
        <span className="shrink-0 text-[11px] text-gray-500 dark:text-gray-400">{tierLabel}</span>
      </div>
      <div className="flex items-start gap-2">
        <div ref={containerRef} className="relative flex-1 min-w-0">
          <div className="relative">
            <input
              type="text"
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
              onFocus={() => {
                if (results.length > 0) setOpen(true);
              }}
              aria-label={`${game.title} 대체 게임 검색`}
              className="w-full px-2.5 py-1.5 text-sm bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded focus:outline-none focus:border-[#1b6fa8] dark:focus:border-[#66c0f4]"
            />
            {(loading || resolving) && (
              <div className="absolute right-2.5 top-1/2 -translate-y-1/2">
                <div className="w-4 h-4 border-2 border-[#1b6fa8] dark:border-[#66c0f4] border-t-transparent rounded-full animate-spin" />
              </div>
            )}
          </div>
          {open && results.length > 0 && (
            <ul className="absolute top-full left-0 right-0 z-50 mt-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl overflow-hidden max-h-72 overflow-y-auto">
              {results.map((result) => (
                <li key={result.appId}>
                  <button
                    type="button"
                    onClick={() => pick(result)}
                    disabled={resolving}
                    className="w-full flex items-center gap-2 px-3 py-2 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors text-left disabled:opacity-60"
                  >
                    {result.imageUrl && (
                      <img src={result.imageUrl} alt="" className="w-10 h-6 object-cover rounded shrink-0" />
                    )}
                    <span className="text-sm truncate">{result.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {open && !loading && results.length === 0 && query.trim() && (
            <div className="absolute top-full left-0 right-0 z-50 mt-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl px-3 py-2 text-gray-500 dark:text-gray-400 text-sm">
              검색 결과가 없습니다.
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => onSkip(game.uuid)}
          disabled={resolving}
          className="shrink-0 px-2.5 py-1.5 text-xs text-gray-500 dark:text-gray-400 border border-gray-300 dark:border-gray-600 rounded hover:text-gray-700 dark:hover:text-gray-200 hover:border-gray-400 dark:hover:border-gray-500 transition-colors disabled:opacity-50"
        >
          건너뛰기
        </button>
      </div>
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
    </li>
  );
}
