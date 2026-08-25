'use client';

/**
 * 도전과제 (/achievements) 페이지.
 *
 * /api/achievements/stream SSE 를 구독해 라이브러리 전체 도전과제 진행률을
 * 실시간으로 표시한다.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import ThemeToggle from '@/components/ThemeToggle';
import ProgressBar from '@/components/ProgressBar';
import AchievementProgress from '@/components/AchievementProgress';
import AchievementRow, { type AchievementItem } from '@/components/AchievementRow';
import AppNav from '@/components/AppNav';
import AppFooter from '@/components/AppFooter';
import { PAGE_SIZE } from '@/lib/constants';

// ============================================================================
// 타입
// ============================================================================

interface Row {
  appId: number;
  name: string;
  headerImage: string | null;
  unlocked: number;
  total: number;
  lastUnlockAt: number | null;
  unlocked30d: number;
  fetchedAt: number;
}

interface Summary {
  totalUnlocked: number;
  totalAchievements: number;
  perfectGames: number;
  avgRate: number;
  recent30d: number;
}

interface ProgressData {
  loaded: number;
  total: number;
}

interface DoneData {
  scanned: number;
  skipped: number;
  remaining: number;
  profilePrivate: boolean;
  libraryFetchFailed: boolean;
  budgetExceeded: boolean;
}

// 변경 알림 (Phase 3)
interface AlertItem {
  alertId: number;
  appId: number;
  kind: 'perfect_broken' | 'changed';
  detectedAt: number;
  payload: { gameName?: string; added?: number; removed?: number };
}

// 게임별 상세 펼침 상태
type DetailSortKey = 'default' | 'rarity-asc';

interface DetailState {
  loading: boolean;
  error: string | null;
  data: AchievementItem[] | null;
  sort: DetailSortKey;
  onlyMissing: boolean;
  revealed: Set<string>;
  personalUnavailable?: 'private' | 'unavailable' | 'error';
}

type SortKey =
  | 'rate-desc'
  | 'remaining-asc'
  | 'remaining-desc'
  | 'recent-desc'
  | 'name-asc';

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: 'rate-desc', label: '달성률순' },
  { value: 'remaining-asc', label: '남은 개수 적은 순' },
  { value: 'remaining-desc', label: '남은 개수 많은 순' },
  { value: 'recent-desc', label: '최근 획득순' },
  { value: 'name-asc', label: '이름순' },
];

// ============================================================================
// 유틸
// ============================================================================

function formatRelativeTime(unixMs: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - unixMs) / 1000));
  if (diffSec < 60) return '방금 전';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}분 전`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}시간 전`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}일 전`;
  const d = new Date(unixMs);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 알림 1건을 사용자 문구로 변환한다 (Phase 3, §5.4.4). */
function formatAlert(a: AlertItem): string {
  const name = a.payload.gameName ?? `AppID ${a.appId}`;
  const added = a.payload.added ?? 0;
  const removed = a.payload.removed ?? 0;
  if (a.kind === 'perfect_broken') {
    const removedNote = removed > 0 ? ` (삭제 ${removed})` : '';
    return `100% 달성했던 ${name}에 과제 ${added}개가 추가되어 완벽 달성이 해제되었습니다${removedNote}.`;
  }
  // changed
  const parts: string[] = [];
  if (added > 0) parts.push(`추가 ${added}`);
  if (removed > 0) parts.push(`삭제 ${removed}`);
  const detail = parts.length > 0 ? ` (${parts.join(', ')})` : '';
  return `${name}의 도전과제 구성이 변경되었습니다${detail}.`;
}

function sortRows(rows: Row[], sort: SortKey): Row[] {
  return [...rows].sort((a, b) => {
    switch (sort) {
      case 'rate-desc': {
        const ra = a.total > 0 ? a.unlocked / a.total : 0;
        const rb = b.total > 0 ? b.unlocked / b.total : 0;
        return rb - ra;
      }
      case 'remaining-asc':
        return (a.total - a.unlocked) - (b.total - b.unlocked);
      case 'remaining-desc':
        return (b.total - b.unlocked) - (a.total - a.unlocked);
      case 'recent-desc': {
        if (a.lastUnlockAt === null && b.lastUnlockAt === null) return 0;
        if (a.lastUnlockAt === null) return 1;
        if (b.lastUnlockAt === null) return -1;
        return b.lastUnlockAt - a.lastUnlockAt;
      }
      case 'name-asc':
        return a.name.localeCompare(b.name, 'ko');
    }
  });
}

// ============================================================================
// 페이지
// ============================================================================

export default function AchievementsPage() {
  const router = useRouter();

  // 인증/설정 상태
  const [authChecked, setAuthChecked] = useState(false);
  const [steamId, setSteamId] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);

  // SSE 데이터
  const [rows, setRows] = useState<Row[]>([]);
  const [progress, setProgress] = useState<ProgressData | null>(null);
  const [doneData, setDoneData] = useState<DoneData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  // Unix ms: cached/result 이벤트에서 받은 fetchedAt 최댓값. "마지막 갱신" 표시용.
  const [lastFetchedAt, setLastFetchedAt] = useState<number | null>(null);

  // 필터/정렬
  const [sort, setSort] = useState<SortKey>('rate-desc');
  const [hidePerfect, setHidePerfect] = useState(false);
  const [includeUnplayed, setIncludeUnplayed] = useState(false);

  // 페이지네이션
  const [page, setPage] = useState(1);

  // 게임별 상세 펼침 상태 (appId → DetailState)
  const [detailMap, setDetailMap] = useState<Map<number, DetailState>>(new Map());
  // 펼쳐진 appId 집합
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());

  // 변경 알림 (Phase 3)
  const [alerts, setAlerts] = useState<AlertItem[]>([]);

  const esRef = useRef<EventSource | null>(null);

  // ------------------------------------------------------------------
  // 인증/설정 확인
  // ------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const setup = await (await fetch('/api/setup')).json();
        if (cancelled) return;
        if (!setup.configured) {
          router.replace('/setup');
          return;
        }
      } catch {
        // 설정 확인 실패는 치명적이지 않음
      }
      try {
        const data: { steamId: string | null; displayName?: string; avatarUrl?: string } =
          await (await fetch('/api/auth/me')).json();
        if (cancelled) return;
        if (!data.steamId) {
          router.replace('/');
          return;
        }
        setSteamId(data.steamId);
        setDisplayName(data.displayName ?? null);
        setAvatarUrl(data.avatarUrl ?? null);
        setAuthChecked(true);
      } catch {
        if (!cancelled) router.replace('/');
      }
    })();
    return () => { cancelled = true; };
  }, [router]);

  // ------------------------------------------------------------------
  // SSE 연결
  // ------------------------------------------------------------------
  const connect = useCallback((force: boolean, unplayed: boolean) => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    setProgress(null);
    setDoneData(null);
    setError(null);
    // 재연결 시 이전 스캔의 알림 배너를 비운다(#1). 새 스캔이 미확인 알림을 보내면
    // alerts 이벤트로 다시 채워지고, 없으면(=이벤트 미emit) 비운 채로 유지된다.
    setAlerts([]);
    setScanning(true);
    setPage(1);

    const params = new URLSearchParams({
      force: String(force),
      includeUnplayed: String(unplayed),
    });
    const es = new EventSource(`/api/achievements/stream?${params.toString()}`);
    esRef.current = es;

    es.addEventListener('cached', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as { games: Row[]; computedAt: number };
        setRows(data.games);
        if (data.games.length > 0) {
          setLastFetchedAt(Math.max(...data.games.map((g) => g.fetchedAt)));
        }
      } catch { /* ignore */ }
    });

    es.addEventListener('progress', (e: MessageEvent) => {
      try { setProgress(JSON.parse(e.data) as ProgressData); } catch { /* ignore */ }
    });

    es.addEventListener('partial', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as { games: Row[] };
        setRows(data.games);
      } catch { /* ignore */ }
    });

    es.addEventListener('result', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as { games: Row[] };
        setRows(data.games);
        if (data.games.length > 0) {
          setLastFetchedAt(Math.max(...data.games.map((g) => g.fetchedAt)));
        }
        setScanning(false);
        setProgress(null);
      } catch { /* ignore */ }
    });

    es.addEventListener('alerts', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as { items: AlertItem[] };
        setAlerts(data.items);
      } catch { /* ignore */ }
    });

    es.addEventListener('done', (e: MessageEvent) => {
      try { setDoneData(JSON.parse(e.data) as DoneData); } catch { /* ignore */ }
      setScanning(false);
      setProgress(null);
      es.close();
      esRef.current = null;
    });

    es.addEventListener('error', (e: MessageEvent) => {
      if (!esRef.current) return;
      let message = '도전과제를 불러오는 중 오류가 발생했습니다.';
      try {
        const data = JSON.parse(e.data) as { message?: string };
        if (data && typeof data.message === 'string') message = data.message;
      } catch { /* native error event */ }
      setError(message);
      setScanning(false);
      setProgress(null);
      es.close();
      esRef.current = null;
    });
  }, []);

  // 인증 완료 후 SSE 연결. 첫 이벤트인 `cached`가 저장된 결과를 즉시 그려주고,
  // 이어서 신선하지 않은(24h 초과/미스캔) 게임만 스캔한다(§5.3.4 재개). 따라서:
  //   - 중단 후 재방문 → 그동안 스캔한 게 즉시 보이고, 남은 것만 이어서 채운다
  //   - 완료 상태로 재방문 → 후보 0개라 실제 재스캔 없이 즉시 확정
  // (별도 /api/achievements/cached 조회는 SSE cached 이벤트와 중복이라 제거함, #8)
  useEffect(() => {
    if (authChecked) connect(false, includeUnplayed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authChecked]);

  // 언마운트 정리
  useEffect(() => () => {
    if (esRef.current) esRef.current.close();
  }, []);

  // includeUnplayed 변경 시 재연결
  const handleIncludeUnplayedChange = useCallback((checked: boolean) => {
    setIncludeUnplayed(checked);
    setRows([]);
    connect(false, checked);
  }, [connect]);

  // 강제 새로고침
  const handleRefresh = useCallback(() => {
    setRows([]);
    connect(true, includeUnplayed);
  }, [connect, includeUnplayed]);

  // 펼쳐진 상세를 모두 접는다.
  const handleCollapseAll = useCallback(() => {
    setExpandedIds(new Set());
  }, []);

  // 알림 배너 닫기 → 서버에 확인 처리(seen).
  const handleDismissAlerts = useCallback(() => {
    setAlerts([]);
    fetch('/api/achievements/alerts/seen', { method: 'POST' }).catch(() => {});
  }, []);

  // 정렬/필터 시 페이지 리셋
  useEffect(() => { setPage(1); }, [sort, hidePerfect]);

  // ------------------------------------------------------------------
  // 상세 펼침 토글 / fetch
  // ------------------------------------------------------------------
  const fetchDetail = useCallback(async (appId: number) => {
    // 이미 데이터 있으면 재fetch 안 함
    const existing = detailMap.get(appId);
    if (existing?.data !== null && existing !== undefined && !existing.loading) return;

    setDetailMap((prev) => {
      const next = new Map(prev);
      const cur = next.get(appId);
      next.set(appId, {
        loading: true,
        error: null,
        data: cur?.data ?? null,
        sort: cur?.sort ?? 'default',
        onlyMissing: cur?.onlyMissing ?? false,
        revealed: cur?.revealed ?? new Set(),
        personalUnavailable: cur?.personalUnavailable,
      });
      return next;
    });

    try {
      const res = await fetch(`/api/achievements/${appId}?lang=ko`);
      if (res.status === 404) {
        setDetailMap((prev) => {
          const next = new Map(prev);
          const cur = next.get(appId);
          next.set(appId, {
            loading: false,
            error: '이 게임에는 도전과제가 없습니다.',
            data: null,
            sort: cur?.sort ?? 'default',
            onlyMissing: cur?.onlyMissing ?? false,
            revealed: cur?.revealed ?? new Set(),
          });
          return next;
        });
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        setDetailMap((prev) => {
          const next = new Map(prev);
          const cur = next.get(appId);
          next.set(appId, {
            loading: false,
            error: body.error ?? '상세 정보를 불러오지 못했습니다.',
            data: null,
            sort: cur?.sort ?? 'default',
            onlyMissing: cur?.onlyMissing ?? false,
            revealed: cur?.revealed ?? new Set(),
          });
          return next;
        });
        return;
      }
      const body = await res.json() as {
        appId: number;
        achievements: AchievementItem[];
        personalUnavailable?: 'private' | 'unavailable' | 'error';
      };
      setDetailMap((prev) => {
        const next = new Map(prev);
        const cur = next.get(appId);
        next.set(appId, {
          loading: false,
          error: null,
          data: body.achievements,
          sort: cur?.sort ?? 'default',
          onlyMissing: cur?.onlyMissing ?? false,
          revealed: cur?.revealed ?? new Set(),
          personalUnavailable: body.personalUnavailable,
        });
        return next;
      });
    } catch {
      setDetailMap((prev) => {
        const next = new Map(prev);
        const cur = next.get(appId);
        next.set(appId, {
          loading: false,
          error: '네트워크 오류가 발생했습니다.',
          data: null,
          sort: cur?.sort ?? 'default',
          onlyMissing: cur?.onlyMissing ?? false,
          revealed: cur?.revealed ?? new Set(),
        });
        return next;
      });
    }
  }, [detailMap]);

  const handleToggleExpand = useCallback((appId: number) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(appId)) {
        next.delete(appId);
      } else {
        next.add(appId);
        // 펼칠 때 상세 데이터가 없으면 fetch
        const detail = detailMap.get(appId);
        if (!detail || (detail.data === null && !detail.loading && !detail.error)) {
          fetchDetail(appId);
        }
      }
      return next;
    });
  }, [detailMap, fetchDetail]);

  const handleDetailSort = useCallback((appId: number, sort: DetailSortKey) => {
    setDetailMap((prev) => {
      const next = new Map(prev);
      const cur = next.get(appId);
      if (!cur) return prev;
      next.set(appId, { ...cur, sort });
      return next;
    });
  }, []);

  const handleDetailOnlyMissing = useCallback((appId: number, value: boolean) => {
    setDetailMap((prev) => {
      const next = new Map(prev);
      const cur = next.get(appId);
      if (!cur) return prev;
      next.set(appId, { ...cur, onlyMissing: value });
      return next;
    });
  }, []);

  const handleDetailReveal = useCallback((appId: number, name: string) => {
    setDetailMap((prev) => {
      const next = new Map(prev);
      const cur = next.get(appId);
      if (!cur) return prev;
      const revealed = new Set(cur.revealed);
      revealed.add(name);
      next.set(appId, { ...cur, revealed });
      return next;
    });
  }, []);

  // ------------------------------------------------------------------
  // 로그아웃
  // ------------------------------------------------------------------
  async function handleLogout() {
    setLoggingOut(true);
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
      router.push('/');
    } catch {
      setLoggingOut(false);
    }
  }

  // ------------------------------------------------------------------
  // 정렬/필터/페이지네이션 (useMemo)
  // ------------------------------------------------------------------
  const filteredRows = useMemo(() => {
    let result = rows;
    if (hidePerfect) {
      result = result.filter((r) => !(r.unlocked === r.total && r.total > 0));
    }
    return sortRows(result, sort);
  }, [rows, hidePerfect, sort]);

  const displayedRows = useMemo(
    () => filteredRows.slice(0, page * PAGE_SIZE),
    [filteredRows, page]
  );

  const hasMore = displayedRows.length < filteredRows.length;

  // ------------------------------------------------------------------
  // 인증 확인 전 스피너
  // ------------------------------------------------------------------
  if (!authChecked) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-5 h-5 border-2 border-[#1b6fa8] dark:border-[#66c0f4] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // 요약은 현재 rows에서 실시간 파생한다 — 스캔 중 partial로 rows가 늘 때마다
  // 요약도 함께 갱신되도록(서버 summary는 cached/result에만 오므로 스캔 중 0에
  // 멈추는 문제를 피함). rows가 아직 없으면 서버 summary로 폴백.
  // 요약은 항상 현재 rows에서 파생한다(단일 소스, #4). rows가 비면 전부 0.
  const view = summarizeRows(rows);
  const totalUnlocked = view.totalUnlocked;
  const totalAchievements = view.totalAchievements;
  const perfectGames = view.perfectGames;
  const avgRate = Math.round(view.avgRate * 100);
  const recent30d = view.recent30d;

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="sticky top-0 z-40 bg-white/95 dark:bg-gray-900/95 backdrop-blur border-b border-gray-200 dark:border-gray-800 px-4 py-3">
        <div className="max-w-5xl mx-auto flex items-center justify-between gap-4 flex-wrap">
          <Link href="/" className="text-[#1b6fa8] dark:text-[#66c0f4] font-bold text-base shrink-0">
            Steam Review Feed
          </Link>
          <AppNav current="achievements" />
          <div className="flex items-center gap-3">
            {steamId && (
              <a
                href={`https://steamcommunity.com/profiles/${steamId}`}
                target="_blank"
                rel="noopener noreferrer"
                className="hidden sm:flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400 hover:text-[#1b6fa8] dark:hover:text-[#66c0f4] transition-colors"
                title={steamId}
              >
                {avatarUrl && (
                  <img src={avatarUrl} alt="" className="w-6 h-6 rounded-full" />
                )}
                <span className="truncate max-w-[120px]">{displayName || steamId}</span>
              </a>
            )}
            <ThemeToggle />
            <button
              type="button"
              onClick={handleLogout}
              disabled={loggingOut}
              className="px-3 py-1.5 text-sm text-gray-500 dark:text-gray-400 border border-gray-300 dark:border-gray-700 rounded-lg hover:text-gray-700 dark:hover:text-gray-200 hover:border-gray-400 dark:hover:border-gray-600 transition-colors disabled:opacity-50"
            >
              {loggingOut ? '...' : '로그아웃'}
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-5xl mx-auto w-full px-4 py-6 space-y-6">

        {/* 변경 알림 배너 (Phase 3) — 미확인 완벽달성 해제/구성 변경 */}
        {alerts.length > 0 && (
          <section className="rounded-lg border border-amber-300 dark:border-amber-700/60 bg-amber-50 dark:bg-amber-900/20 p-4 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold text-amber-800 dark:text-amber-300">
                도전과제 변경 알림 ({alerts.length})
              </h2>
              <button
                type="button"
                onClick={handleDismissAlerts}
                className="text-xs text-amber-700 dark:text-amber-400 hover:underline shrink-0"
              >
                모두 확인
              </button>
            </div>
            <ul className="space-y-1 text-sm text-amber-800 dark:text-amber-200">
              {alerts.slice(0, 10).map((a) => (
                <li key={a.alertId} className="flex gap-2">
                  <span className="text-amber-500 dark:text-amber-400 shrink-0">•</span>
                  <span>{formatAlert(a)}</span>
                </li>
              ))}
            </ul>
            {alerts.length > 10 && (
              <p className="text-xs text-amber-600 dark:text-amber-500">
                외 {alerts.length - 10}건
              </p>
            )}
          </section>
        )}

        {/* 요약 카드 */}
        <section className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4 space-y-4">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">도전과제 요약</h2>
            <div className="flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400">
              {lastFetchedAt && (
                <span>마지막 갱신: {formatRelativeTime(lastFetchedAt)}</span>
              )}
              <button
                type="button"
                onClick={handleRefresh}
                disabled={scanning}
                className="px-2.5 py-1 border border-gray-300 dark:border-gray-600 rounded text-xs text-gray-600 dark:text-gray-300 hover:border-[#1b6fa8] dark:hover:border-[#66c0f4] hover:text-[#1b6fa8] dark:hover:text-[#66c0f4] transition-colors disabled:opacity-50"
              >
                {scanning ? '스캔 중...' : '지금 새로고침'}
              </button>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <StatCard label="총 획득" value={`${totalUnlocked.toLocaleString('ko-KR')} / ${totalAchievements.toLocaleString('ko-KR')}`} />
            <StatCard label="완벽 달성" value={`${perfectGames.toLocaleString('ko-KR')}게임`} />
            <StatCard label="평균 달성률" value={`${avgRate}%`} />
            <StatCard label="최근 30일 획득" value={`${recent30d.toLocaleString('ko-KR')}개`} />
          </div>

          <AchievementProgress
            unlocked={totalUnlocked}
            total={totalAchievements}
            size="md"
            showLabel
          />
        </section>

        {/* 진행률 바 */}
        {scanning && progress && (
          <div className="space-y-2">
            <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400">
              <span>도전과제 스캔 중...</span>
              <span>{progress.loaded} / {progress.total}</span>
            </div>
            <ProgressBar loaded={progress.loaded} total={progress.total} />
          </div>
        )}

        {/* 첫 스캔 안내 */}
        {scanning && rows.length < 10 && (
          <div className="text-sm text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-800/50 rounded-lg p-4">
            <p>첫 스캔은 라이브러리가 크면 10분 이상 걸릴 수 있습니다.</p>
            <p className="text-xs mt-1">스캔이 완료되면 이후 방문부터는 캐시된 결과가 즉시 표시됩니다.</p>
          </div>
        )}

        {/* 에러 배너 */}
        {error && (
          <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded-lg p-4">
            {error}
          </div>
        )}

        {/* done 안내 배너들 */}
        {doneData?.profilePrivate && (
          <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg p-4 space-y-2">
            <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
              Steam 프로필의 &apos;게임 세부 정보&apos;를 공개로 바꿔야 진행률을 볼 수 있습니다.
            </p>
            <a
              href="https://steamcommunity.com/id/me/edit/settings"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block text-xs text-[#1b6fa8] dark:text-[#66c0f4] underline hover:opacity-80 transition-opacity"
            >
              Steam 개인정보 설정 바꾸기
            </a>
          </div>
        )}

        {doneData?.libraryFetchFailed && !doneData.profilePrivate && (
          <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded-lg p-4">
            라이브러리를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.
          </div>
        )}

        {doneData?.budgetExceeded && (
          <div className="text-sm text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg p-4">
            오늘의 조회 한도에 도달했습니다. 내일 다시 시도해주세요. (캐시 결과는 표시됩니다)
          </div>
        )}

        {doneData && doneData.remaining > 0 && !doneData.budgetExceeded && (
          <div className="text-sm text-gray-600 dark:text-gray-300 bg-gray-50 dark:bg-gray-800/50 rounded-lg p-4">
            전체 중 일부만 완료되었습니다. 다시 방문하면 이어서 진행합니다. (남은 {doneData.remaining}개)
          </div>
        )}

        {/* 게임 리스트 */}
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">
              게임 목록 {rows.length > 0 ? `(${filteredRows.length.toLocaleString('ko-KR')}개)` : ''}
            </h2>
            <div className="flex items-center gap-3 flex-wrap">
              {/* 펼친 상세 모두 접기 — 펼쳐진 게 있을 때만 노출 */}
              {expandedIds.size > 0 && (
                <button
                  type="button"
                  onClick={handleCollapseAll}
                  className="text-xs text-[#1b6fa8] dark:text-[#66c0f4] hover:underline"
                >
                  모두 접기 ({expandedIds.size})
                </button>
              )}
              {/* 필터 체크박스 */}
              <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={hidePerfect}
                  onChange={(e) => setHidePerfect(e.target.checked)}
                  className="w-3.5 h-3.5"
                />
                완벽 달성 숨김
              </label>
              <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={includeUnplayed}
                  onChange={(e) => handleIncludeUnplayedChange(e.target.checked)}
                  className="w-3.5 h-3.5"
                />
                미착수 게임 포함
              </label>
              {/* 정렬 드롭다운 */}
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as SortKey)}
                className="px-2 py-1 text-xs bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded text-gray-700 dark:text-gray-200"
              >
                {SORT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
          </div>

          {/* 빈 상태 */}
          {!scanning && rows.length === 0 && !error && (
            <div className="text-sm text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-800/50 rounded-lg p-8 text-center">
              표시할 도전과제 데이터가 없습니다.
            </div>
          )}

          {/* 리스트 */}
          {displayedRows.length > 0 && (
            <ul className="divide-y divide-gray-100 dark:divide-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
              {displayedRows.map((row) => (
                <GameRow
                  key={row.appId}
                  row={row}
                  expanded={expandedIds.has(row.appId)}
                  detail={detailMap.get(row.appId) ?? null}
                  isLoggedIn={steamId !== null}
                  onToggle={handleToggleExpand}
                  onSort={handleDetailSort}
                  onOnlyMissing={handleDetailOnlyMissing}
                  onReveal={handleDetailReveal}
                />
              ))}
            </ul>
          )}

          {/* 더 보기 */}
          {hasMore && (
            <div className="text-center pt-2">
              <button
                type="button"
                onClick={() => setPage((p) => p + 1)}
                className="px-5 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg text-gray-600 dark:text-gray-300 hover:border-[#1b6fa8] dark:hover:border-[#66c0f4] hover:text-[#1b6fa8] dark:hover:text-[#66c0f4] transition-colors"
              >
                더 보기 ({filteredRows.length - displayedRows.length}개 남음)
              </button>
            </div>
          )}
        </section>
      </main>
      <AppFooter />
    </div>
  );
}

// ============================================================================
// 요약 수치 카드
// ============================================================================

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <div className="text-xs text-gray-500 dark:text-gray-400">{label}</div>
      <div className="text-base font-semibold text-gray-800 dark:text-gray-100 tabular-nums">
        {value}
      </div>
    </div>
  );
}

/**
 * 현재 rows로부터 요약 지표를 파생한다(스캔 중 실시간 갱신용).
 * avgRate는 total>0 게임의 (unlocked/total) 평균, perfectGames는 unlocked>=total,
 * recent30d는 rows의 unlocked30d 합. 서버 getProgressSummary와 동일 정의.
 */
function summarizeRows(rows: Row[]): Summary {
  let totalUnlocked = 0;
  let totalAchievements = 0;
  let perfectGames = 0;
  let rateSum = 0;
  let rateCount = 0;
  let recent30d = 0;
  for (const r of rows) {
    totalUnlocked += r.unlocked;
    totalAchievements += r.total;
    recent30d += r.unlocked30d;
    if (r.total > 0) {
      rateSum += r.unlocked / r.total;
      rateCount += 1;
      if (r.unlocked >= r.total) perfectGames += 1;
    }
  }
  return {
    totalUnlocked,
    totalAchievements,
    perfectGames,
    avgRate: rateCount > 0 ? rateSum / rateCount : 0,
    recent30d,
  };
}

// ============================================================================
// 게임 행
// ============================================================================

interface GameRowProps {
  row: Row;
  expanded: boolean;
  detail: DetailState | null;
  isLoggedIn: boolean;
  onToggle: (appId: number) => void;
  onSort: (appId: number, sort: DetailSortKey) => void;
  onOnlyMissing: (appId: number, value: boolean) => void;
  onReveal: (appId: number, name: string) => void;
}

function GameRow({
  row,
  expanded,
  detail,
  isLoggedIn,
  onToggle,
  onSort,
  onOnlyMissing,
  onReveal,
}: GameRowProps) {
  const rate = row.total > 0 ? Math.round((row.unlocked / row.total) * 100) : 0;
  const remaining = row.total - row.unlocked;

  // 상세 목록 정렬/필터
  const detailData = detail?.data ?? null;
  const detailSort = detail?.sort ?? 'default';
  const detailOnlyMissing = detail?.onlyMissing ?? false;
  const processedItems: AchievementItem[] = useMemo(() => {
    if (!detailData) return [];
    let items = detailData;
    // 미획득 필터 (로그인 + onlyMissing)
    if (isLoggedIn && detailOnlyMissing) {
      items = items.filter((a) => a.achieved !== true);
    }
    // 정렬
    if (detailSort === 'rarity-asc') {
      items = [...items].sort((a, b) => {
        if (a.globalPercent === null && b.globalPercent === null) return 0;
        if (a.globalPercent === null) return 1;
        if (b.globalPercent === null) return -1;
        return a.globalPercent - b.globalPercent;
      });
    }
    return items;
  }, [detailData, detailSort, detailOnlyMissing, isLoggedIn]);

  return (
    <li className="bg-white dark:bg-gray-800">
      {/* 게임 행 헤더 */}
      <div className="flex items-center gap-3 px-3 py-2.5 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors">
        {/* 썸네일 */}
        {row.headerImage ? (
          <img
            src={row.headerImage}
            alt=""
            className="w-16 h-9 object-cover rounded shrink-0 bg-gray-100 dark:bg-gray-900"
          />
        ) : (
          <div className="w-16 h-9 rounded shrink-0 bg-gray-100 dark:bg-gray-700" />
        )}

        {/* 이름 + 진행률 */}
        <div className="flex-1 min-w-0 space-y-1.5">
          <Link
            href={`/game/${row.appId}`}
            className="block text-sm font-medium text-gray-800 dark:text-gray-100 hover:text-[#1b6fa8] dark:hover:text-[#66c0f4] truncate transition-colors"
            onClick={(e) => e.stopPropagation()}
          >
            {row.name}
          </Link>
          <AchievementProgress
            unlocked={row.unlocked}
            total={row.total}
            size="sm"
            showLabel
          />
        </div>

        {/* 우측 메타 + chevron */}
        <div className="shrink-0 flex items-center gap-2">
          <div className="text-right space-y-0.5">
            <div className="text-xs font-medium text-[#1b6fa8] dark:text-[#66c0f4] tabular-nums">
              {rate}%
            </div>
            {remaining > 0 && (
              <div className="text-xs text-gray-400 dark:text-gray-500 tabular-nums">
                {remaining}개 남음
              </div>
            )}
            {remaining === 0 && row.total > 0 && (
              <div className="text-xs text-green-600 dark:text-green-400 font-medium">
                완벽 달성
              </div>
            )}
          </div>
          {/* 펼침 토글 버튼 */}
          <button
            type="button"
            onClick={() => onToggle(row.appId)}
            aria-expanded={expanded}
            aria-label={expanded ? '접기' : '과제 목록 펼치기'}
            className="p-1.5 rounded text-gray-400 dark:text-gray-500 hover:text-[#1b6fa8] dark:hover:text-[#66c0f4] hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 16 16"
              fill="currentColor"
              className={`w-4 h-4 transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
            >
              <path
                fillRule="evenodd"
                d="M4.22 6.22a.75.75 0 0 1 1.06 0L8 8.94l2.72-2.72a.75.75 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 7.28a.75.75 0 0 1 0-1.06Z"
                clipRule="evenodd"
              />
            </svg>
          </button>
        </div>
      </div>

      {/* 펼침 패널 */}
      {expanded && (
        <div className="border-t border-gray-100 dark:border-gray-700/60 bg-gray-50 dark:bg-gray-800/50">
          {/* 패널 컨트롤 바 */}
          <div className="flex items-center gap-3 flex-wrap px-3 py-2 border-b border-gray-100 dark:border-gray-700/60">
            <span className="text-xs text-gray-500 dark:text-gray-400 font-medium">
              과제 상세
            </span>
            <div className="flex items-center gap-2 ml-auto flex-wrap">
              {/* 미획득 필터 (로그인 시만) */}
              {isLoggedIn && (
                <label className="flex items-center gap-1 text-xs text-gray-600 dark:text-gray-300 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={detail?.onlyMissing ?? false}
                    onChange={(e) => onOnlyMissing(row.appId, e.target.checked)}
                    className="w-3 h-3"
                  />
                  미획득만
                </label>
              )}
              {/* 정렬 토글 */}
              <div className="flex rounded border border-gray-200 dark:border-gray-600 overflow-hidden text-xs">
                <button
                  type="button"
                  onClick={() => onSort(row.appId, 'default')}
                  className={[
                    'px-2 py-0.5 transition-colors',
                    (detail?.sort ?? 'default') === 'default'
                      ? 'bg-[#1b6fa8] dark:bg-[#66c0f4] text-white dark:text-gray-900'
                      : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700',
                  ].join(' ')}
                >
                  기본
                </button>
                <button
                  type="button"
                  onClick={() => onSort(row.appId, 'rarity-asc')}
                  className={[
                    'px-2 py-0.5 transition-colors border-l border-gray-200 dark:border-gray-600',
                    (detail?.sort ?? 'default') === 'rarity-asc'
                      ? 'bg-[#1b6fa8] dark:bg-[#66c0f4] text-white dark:text-gray-900'
                      : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700',
                  ].join(' ')}
                >
                  희귀도순
                </button>
              </div>
            </div>
          </div>

          {/* personalUnavailable 안내 */}
          {detail?.personalUnavailable === 'private' && (
            <div className="px-3 py-2 text-xs text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/20 border-b border-amber-100 dark:border-amber-800">
              프로필의 &apos;게임 세부 정보&apos;를 공개하면 개인 획득 현황이 표시됩니다.
            </div>
          )}

          {/* 로딩 */}
          {detail?.loading && (
            <div className="flex items-center justify-center py-8 gap-2 text-xs text-gray-400 dark:text-gray-500">
              <div className="w-4 h-4 border-2 border-[#1b6fa8] dark:border-[#66c0f4] border-t-transparent rounded-full animate-spin" />
              불러오는 중...
            </div>
          )}

          {/* 에러 */}
          {!detail?.loading && detail?.error && (
            <div className="px-3 py-4 text-xs text-red-600 dark:text-red-400">
              {detail.error}
            </div>
          )}

          {/* 빈 상태 */}
          {!detail?.loading && !detail?.error && detail?.data !== null && processedItems.length === 0 && (
            <div className="px-3 py-4 text-xs text-gray-400 dark:text-gray-500 text-center">
              표시할 과제가 없습니다.
            </div>
          )}

          {/* 과제 목록 */}
          {!detail?.loading && !detail?.error && processedItems.length > 0 && (
            <ul>
              {processedItems.map((item) => (
                <AchievementRow
                  key={item.name}
                  item={item}
                  initialRevealed={detail?.revealed.has(item.name) ?? false}
                  onReveal={(name) => onReveal(row.appId, name)}
                  isLoggedIn={isLoggedIn}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}
