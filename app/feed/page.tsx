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
import AboutDialog from '@/components/AboutDialog';
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

  // 필터 초기값 복원 우선순위: URL 파라미터 > localStorage > 기본값
  const initialFilters = useMemo(() => {
    const fromUrl = parseFiltersFromParams(searchParams);
    // URL에 파라미터가 있으면 URL 우선
    if (searchParams.toString()) return fromUrl;
    // URL에 파라미터가 없으면 localStorage에서 복원 시도
    return loadFiltersFromStorage() ?? fromUrl;
  }, [searchParams]);
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
        <div className="text-center pb-6 text-gray-400 dark:text-gray-500 text-xs space-y-1">
          <p>최근 50개 게임의 리뷰를 표시합니다.</p>
          <p>Steam Review Feed <AboutDialog /></p>
        </div>
      </main>
    </div>
  );
}
