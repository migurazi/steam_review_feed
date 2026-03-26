'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import FilterPanel, { FilterState, DEFAULT_FILTERS } from '@/components/FilterPanel';
import ReviewFeed from '@/components/ReviewFeed';
import GameSearch from '@/components/GameSearch';

type DataSource = 'wishlist' | 'library' | 'both';

export default function FeedPage() {
  const [source, setSource] = useState<DataSource>('wishlist');
  const [filters, setFilters] = useState<FilterState>({
    ...DEFAULT_FILTERS,
    source: 'wishlist',
  });
  const [loggingOut, setLoggingOut] = useState(false);
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [steamId, setSteamId] = useState<string | null>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const router = useRouter();

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

  function handleSourceChange(newSource: DataSource) {
    setSource(newSource);
    setFilters((f) => ({ ...f, source: newSource }));
  }

  function handleFilterChange(newFilters: FilterState) {
    setFilters({ ...newFilters, source });
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
    <div className="min-h-screen bg-gray-900 text-gray-100 flex flex-col">
      {/* Header */}
      <header className="sticky top-0 z-40 bg-gray-900/95 backdrop-blur border-b border-gray-800 px-4 py-3">
        <div className="max-w-5xl mx-auto flex items-center justify-between gap-4">
          <Link href="/" className="text-[#66c0f4] font-bold text-base shrink-0">
            Steam Review Feed
          </Link>

          {/* Source tabs */}
          <div className="flex bg-gray-800 rounded-lg p-1 gap-1">
            {tabs.map((tab) => (
              <button
                key={tab.value}
                type="button"
                onClick={() => handleSourceChange(tab.value)}
                className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                  source === tab.value
                    ? 'bg-[#1b2838] text-[#66c0f4] border border-[#4c6b8a]'
                    : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-3">
            <div className="hidden sm:block w-48">
              <GameSearch />
            </div>
            {steamId && (
              <a
                href={`https://steamcommunity.com/profiles/${steamId}`}
                target="_blank"
                rel="noopener noreferrer"
                className="hidden sm:flex items-center gap-2 text-sm text-gray-400 hover:text-[#66c0f4] transition-colors"
                title={steamId}
              >
                {avatarUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={avatarUrl} alt="" className="w-6 h-6 rounded-full" />
                )}
                <span className="truncate max-w-[120px]">{displayName || steamId}</span>
              </a>
            )}
            <button
              type="button"
              onClick={handleLogout}
              disabled={loggingOut}
              className="px-3 py-1.5 text-sm text-gray-400 border border-gray-700 rounded-lg hover:text-gray-200 hover:border-gray-600 transition-colors disabled:opacity-50"
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

        {/* 게임 50개 상한 안내 */}
        <div className="text-center pb-6 text-gray-500 text-xs">
          최근 50개 게임의 리뷰를 표시합니다.
        </div>
      </main>
    </div>
  );
}
