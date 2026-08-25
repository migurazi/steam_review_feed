'use client';

/**
 * 통합 리뷰 피드 페이지.
 *
 * 필터 상태를 URL 쿼리 파라미터에 저장하여:
 * - 새로고침 시 필터 유지
 * - 뒤로가기/앞으로가기 시 필터 복원
 * - URL 공유 시 동일한 필터로 접근 가능
 *
 * useSearchParams()는 Suspense boundary가 필요하므로
 * 페이지를 Suspense로 감싼다.
 */

import { Suspense, useEffect, useState, useCallback, useMemo } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import FilterPanel, { FilterState } from '@/components/FilterPanel';
import ReviewFeed from '@/components/ReviewFeed';
import GameSearch from '@/components/GameSearch';
import ThemeToggle from '@/components/ThemeToggle';
import AppFooter from '@/components/AppFooter';
import { parseFiltersFromParams, filtersToParams, saveFiltersToStorage, loadFiltersFromStorage } from '@/lib/filter-params';

type DataSource = 'wishlist' | 'library' | 'both';

/** Suspense 래퍼. useSearchParams()가 CSR bailout을 발생시키므로 필요. */
export default function FeedPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-5 h-5 border-2 border-[#1b6fa8] dark:border-[#66c0f4] border-t-transparent rounded-full animate-spin" />
      </div>
    }>
      <FeedPageContent />
    </Suspense>
  );
}

function FeedPageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  // 필터 초기값 — URL 파라미터 또는 기본값. localStorage는 hydration 안전을
  // 위해 useEffect에서 복원한다.
  //
  // 회귀 방지: 이전엔 initialFilters가 loadFiltersFromStorage()를 호출했는데,
  // 서버 렌더 시점엔 localStorage 접근 불가라 항상 null 반환. 클라이언트는
  // 저장된 필터 반환. 결과적으로 server initial !== client initial → React
  // hydration mismatch (filter source 탭의 selected/unselected className이
  // server/client에서 다르게 렌더링됨). useEffect에서 mount 후 1회만 복원
  // 하면 hydration tree는 일치하고 그 직후 setFilters로 자연스럽게 갱신.
  const initialFilters = useMemo(() => parseFiltersFromParams(searchParams), [searchParams]);
  const [filters, setFilters] = useState<FilterState>(initialFilters);
  const [loggingOut, setLoggingOut] = useState(false);
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [steamId, setSteamId] = useState<string | null>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/auth/me')
      .then((res) => res.json())
      .then((data) => {
        setSteamId(data.steamId);
        setDisplayName(data.displayName);
        setAvatarUrl(data.avatarUrl);
      })
      .catch(() => {});
  }, []);

  // localStorage 필터 복원 — hydration 직후 1회. URL에 명시적 파라미터가 있으면
  // (사용자가 의도적으로 URL을 직접 조작했거나 공유 링크로 들어옴) localStorage
  // 보다 URL 우선. mount 시점에 한 번만 실행돼야 하므로 deps는 빈 배열.
  useEffect(() => {
    if (searchParams.toString()) return; // URL 우선
    const fromStorage = loadFiltersFromStorage();
    if (fromStorage) {
      setFilters(fromStorage);
      // URL도 함께 갱신해 두면 새로고침/공유 시 일관 — but URL replace는 또
      // 다른 라우터 사이클을 트리거하므로 의도적으로 생략. updateFilters가
      // 다음 사용자 액션 시점에 URL을 정상화한다.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 필터 변경 시 URL + localStorage 모두 업데이트 */
  const updateFilters = useCallback((newFilters: FilterState) => {
    setFilters(newFilters);
    saveFiltersToStorage(newFilters);
    const qs = filtersToParams(newFilters);
    const url = qs ? `/feed?${qs}` : '/feed';
    router.replace(url, { scroll: false });
  }, [router]);

  function handleSourceChange(newSource: DataSource) {
    updateFilters({ ...filters, source: newSource });
  }

  function handleFilterChange(newFilters: FilterState) {
    updateFilters({ ...newFilters, source: filters.source });
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

  const tabs: { value: DataSource; label: string }[] = [
    { value: 'wishlist', label: '위시리스트' },
    { value: 'library', label: '라이브러리' },
    { value: 'both', label: '둘 다' },
  ];

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="sticky top-0 z-40 bg-white/95 dark:bg-gray-900/95 backdrop-blur border-b border-gray-200 dark:border-gray-800 px-4 py-3">
        <div className="max-w-5xl mx-auto flex items-center justify-between gap-4">
          <Link href="/" className="text-[#1b6fa8] dark:text-[#66c0f4] font-bold text-base shrink-0">
            Steam Review Feed
          </Link>

          {/* Source tabs */}
          <div className="flex bg-gray-100 dark:bg-gray-800 rounded-lg p-1 gap-1">
            {tabs.map((tab) => (
              <button
                key={tab.value}
                type="button"
                onClick={() => handleSourceChange(tab.value)}
                className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                  filters.source === tab.value
                    ? 'bg-white dark:bg-[#1b2838] text-[#1b6fa8] dark:text-[#66c0f4] border border-gray-300 dark:border-[#4c6b8a] shadow-sm'
                    : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-3">
            <Link
              href="/recommend"
              className="hidden sm:inline text-sm text-gray-500 dark:text-gray-400 hover:text-[#1b6fa8] dark:hover:text-[#66c0f4] transition-colors"
              title="보유 게임 성향 분석 + 추천"
            >
              성향 분석
            </Link>
            <Link
              href="/achievements"
              className="hidden sm:inline text-sm text-gray-500 dark:text-gray-400 hover:text-[#1b6fa8] dark:hover:text-[#66c0f4] transition-colors"
              title="라이브러리 도전과제 달성 현황"
            >
              도전과제
            </Link>
            <div className="hidden sm:block w-48">
              <GameSearch />
            </div>
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

      <main className="flex-1 max-w-5xl mx-auto w-full px-4 py-6 space-y-5">
        {/* Filter panel */}
        <FilterPanel filters={filters} onChange={handleFilterChange} />

        {/* Review feed */}
        <ReviewFeed key={JSON.stringify(filters)} filters={filters} />

        {/* 하단 안내 */}
        <div className="text-center pb-6 text-gray-400 dark:text-gray-500 text-xs">
          <p>최근 50개 게임의 리뷰를 표시합니다.</p>
        </div>
      </main>
      <AppFooter />
    </div>
  );
}
