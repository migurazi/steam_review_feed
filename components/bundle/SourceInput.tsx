'use client';

/**
 * 수동 입력 소스 (작업 지시서 20261012_01 단계 3·2).
 *
 * 두 경로:
 *   1) 붙여넣기 textarea → parseBundleInput
 *      - itadBundleIds: 각각 POST /api/bundle/itad/resolve → 차트로 로드(onChartResolved)
 *      - appIds·steamPackageIds·steamBundleIds: POST /api/bundle/resolve → rows를 단일 티어로(onRowsResolved)
 *      - unresolved 토큰은 사용자에게 표시
 *   2) 이름 검색(GET /api/search) → 결과 선택 → 그 appId를 /api/bundle/resolve 로 보강 → onRowsResolved
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { parseBundleInput } from '@/lib/bundle/parse';
import type { Chart, GameRow, UnmatchedGame } from '@/lib/bundle/types';

interface SearchResult {
  appId: number;
  name: string;
  imageUrl: string;
}

export interface SourceInputProps {
  /** Steam/수동 경로로 보강된 게임 행들. 부모가 단일(또는 기본) 티어에 추가한다. */
  onRowsResolved: (rows: GameRow[], notes?: string[]) => void;
  /** ITAD 번들 URL 경로로 받은 차트. 부모가 차트 전체를 교체한다. */
  onChartResolved: (chart: Chart, unmatched: UnmatchedGame[]) => void;
}

export default function SourceInput({ onRowsResolved, onChartResolved }: SourceInputProps) {
  const [text, setText] = useState('');
  const [parsing, setParsing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function resolveSteam(ids: {
    appIds?: number[];
    steamPackageIds?: number[];
    steamBundleIds?: number[];
  }): Promise<{ rows: GameRow[]; notes?: string[] } | null> {
    const res = await fetch('/api/bundle/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ids),
    });
    if (!res.ok) return null;
    return (await res.json()) as { rows: GameRow[]; notes?: string[] };
  }

  async function handleParse() {
    if (!text.trim()) return;
    setParsing(true);
    setMessage(null);
    setError(null);

    const parsed = parseBundleInput(text);
    const notes: string[] = [];

    try {
      // 1) ITAD 번들 URL → 각각 차트로 로드. 첫 성공을 차트로 반영한다.
      let itadLoaded = 0;
      for (const bundleId of parsed.itadBundleIds) {
        const res = await fetch('/api/bundle/itad/resolve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bundleId }),
        });
        const data = await res.json().catch(() => null);
        if (res.ok && data?.chart) {
          onChartResolved(data.chart as Chart, (data.unmatched ?? []) as UnmatchedGame[]);
          itadLoaded++;
        } else {
          notes.push(`ITAD 번들 ${bundleId}: ${data?.error ?? '불러오지 못했습니다.'}`);
        }
      }

      // 2) Steam/수동 → rows 단일 티어로.
      const hasSteam =
        parsed.appIds.length > 0 ||
        parsed.steamPackageIds.length > 0 ||
        parsed.steamBundleIds.length > 0;
      let steamRows = 0;
      if (hasSteam) {
        const result = await resolveSteam({
          appIds: parsed.appIds,
          steamPackageIds: parsed.steamPackageIds,
          steamBundleIds: parsed.steamBundleIds,
        });
        if (result) {
          if (result.rows.length > 0) {
            onRowsResolved(result.rows, result.notes);
            steamRows = result.rows.length;
          }
          if (result.notes) notes.push(...result.notes);
        } else {
          notes.push('Steam 게임 정보를 불러오지 못했습니다.');
        }
      }

      if (parsed.unresolved.length > 0) {
        notes.push(`인식하지 못한 입력: ${parsed.unresolved.join(', ')}`);
      }

      if (itadLoaded === 0 && steamRows === 0 && notes.length === 0) {
        setError('인식할 수 있는 Steam/ITAD 링크 또는 AppID가 없습니다.');
      } else {
        const summary: string[] = [];
        if (itadLoaded > 0) summary.push(`ITAD 번들 ${itadLoaded}개 로드`);
        if (steamRows > 0) summary.push(`게임 ${steamRows}개 추가`);
        setMessage(summary.length > 0 ? summary.join(' · ') : '처리했습니다.');
        if (itadLoaded > 0 || steamRows > 0) setText('');
      }
      if (notes.length > 0) setError(notes.join('\n'));
    } catch {
      setError('요청 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.');
    } finally {
      setParsing(false);
    }
  }

  async function handleAddSearchResult(appId: number) {
    setError(null);
    setMessage(null);
    const result = await resolveSteam({ appIds: [appId] });
    if (!result || result.rows.length === 0) {
      setError('선택한 게임 정보를 불러오지 못했습니다.');
      return;
    }
    // 이름 검색으로 추가 — 정확한 appid가 아닐 수 있으므로 uncertain 표시.
    onRowsResolved(result.rows.map((r) => ({ ...r, uncertain: true })), result.notes);
    setMessage(`${result.rows[0].name} 추가됨`);
  }

  return (
    <div className="space-y-4">
      {/* 붙여넣기 */}
      <div className="space-y-2">
        <label className="block text-xs text-gray-500 dark:text-gray-400" htmlFor="source-paste">
          스토어 URL · AppID · ITAD 번들 URL 붙여넣기 (공백·줄바꿈·쉼표로 구분)
        </label>
        <textarea
          id="source-paste"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
          placeholder={
            'https://store.steampowered.com/app/440/\n220 400\nhttps://store.steampowered.com/sub/12345/\nhttps://isthereanydeal.com/bundles/1234/'
          }
          className="w-full px-3 py-2 font-mono text-sm bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-lg placeholder-gray-400 dark:placeholder-gray-600 focus:outline-none focus:border-[#1b6fa8] dark:focus:border-[#66c0f4] transition-colors resize-y"
        />
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleParse}
            disabled={parsing || !text.trim()}
            className="px-4 py-2 bg-[#1b6fa8] dark:bg-[#1b2838] border border-[#1b6fa8] dark:border-[#4c6b8a] text-white text-sm rounded-lg hover:bg-[#155a8a] dark:hover:bg-[#2a475e] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {parsing ? '처리 중...' : '불러오기'}
          </button>
          {message && <span className="text-xs text-green-700 dark:text-green-400">{message}</span>}
        </div>
        {error && (
          <p className="text-xs text-amber-700 dark:text-amber-400 whitespace-pre-line">{error}</p>
        )}
      </div>

      {/* 이름 검색 추가 */}
      <div className="space-y-2">
        <p className="block text-xs text-gray-500 dark:text-gray-400">이름으로 검색해 게임 추가</p>
        <SearchAdd onAdd={handleAddSearchResult} />
      </div>
    </div>
  );
}

/** 이름 검색(디바운스) → 결과에서 선택 시 appId를 부모로 넘긴다. */
function SearchAdd({ onAdd }: { onAdd: (appId: number) => void | Promise<void> }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState<number | null>(null);
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
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => search(query), 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, search]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  async function select(result: SearchResult) {
    setOpen(false);
    setAdding(result.appId);
    try {
      await onAdd(result.appId);
    } finally {
      setAdding(null);
    }
  }

  return (
    <div ref={containerRef} className="relative w-full max-w-md">
      <div className="relative">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="게임 검색..."
          onFocus={() => {
            if (results.length > 0) setOpen(true);
          }}
          className="w-full px-3 py-2 text-sm bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-lg placeholder-gray-400 dark:placeholder-gray-600 focus:outline-none focus:border-[#1b6fa8] dark:focus:border-[#66c0f4] transition-colors"
        />
        {(loading || adding !== null) && (
          <div className="absolute right-3 top-1/2 -translate-y-1/2">
            <div className="w-4 h-4 border-2 border-[#1b6fa8] dark:border-[#66c0f4] border-t-transparent rounded-full animate-spin" />
          </div>
        )}
      </div>

      {open && results.length > 0 && (
        <ul className="absolute top-full left-0 right-0 z-50 mt-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl overflow-hidden max-h-80 overflow-y-auto">
          {results.map((result) => (
            <li key={result.appId}>
              <button
                type="button"
                onClick={() => select(result)}
                disabled={adding !== null}
                className="w-full flex items-center gap-3 px-3 py-2 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors text-left disabled:opacity-60"
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
  );
}
