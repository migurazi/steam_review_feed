'use client';

import { use, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import FilterPanel, { FilterState, DEFAULT_FILTERS } from '@/components/FilterPanel';
import ReviewCard from '@/components/ReviewCard';
import ProgressBar from '@/components/ProgressBar';
import MediaPlayer from '@/components/MediaPlayer';
import type { GameReviewsEvent, ProgressEvent as ProgressEventData, SteamReview, SteamMovie, SteamScreenshot } from '@/lib/steam/types';

export default function GamePage({
  params,
}: {
  params: Promise<{ appId: string }>;
}) {
  const { appId: rawAppId } = use(params);
  const appId = /^\d+$/.test(rawAppId) ? rawAppId : "";

  const [filters, setFilters] = useState<FilterState>({
    ...DEFAULT_FILTERS,
    source: 'both',
  });
  const [gameName, setGameName] = useState<string | null>(null);

  /** 미디어 데이터 (동영상, 스크린샷, 헤더 이미지) */
  const [media, setMedia] = useState<{
    movies: SteamMovie[];
    screenshots: SteamScreenshot[];
    header_image: string;
  } | null>(null);

  useEffect(() => {
    if (!appId) return;
    // 게임 이름과 미디어 데이터를 병렬 fetch
    fetch(`/api/search?appId=${appId}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.results?.[0]?.name) {
          setGameName(data.results[0].name);
        }
      })
      .catch(() => {});

    fetch(`/api/game/${appId}/media`)
      .then((res) => res.ok ? res.json() : null)
      .then((data) => {
        if (data) setMedia(data);
      })
      .catch(() => {});
  }, [appId]);

  function handleFilterChange(newFilters: FilterState) {
    setFilters({ ...newFilters, source: 'both' });
  }

  if (!appId) {
    return (
      <div className="min-h-screen bg-gray-900 text-gray-100 flex items-center justify-center">
        <div className="text-center space-y-4">
          <p className="text-gray-400">올바르지 않은 App ID입니다.</p>
          <Link href="/" className="text-[#66c0f4] hover:underline">홈으로 돌아가기</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100 flex flex-col">
      {/* Header */}
      <header className="sticky top-0 z-40 bg-gray-900/95 backdrop-blur border-b border-gray-800 px-4 py-3">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <Link href="/" className="text-[#66c0f4] font-bold text-base">
            Steam Review Feed
          </Link>
          <div className="flex items-center gap-4">
            <Link href="/feed" className="text-gray-400 text-sm hover:text-gray-200 transition-colors">
              피드
            </Link>
            <Link href="/" className="text-gray-400 text-sm hover:text-gray-200 transition-colors">
              홈
            </Link>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-4xl mx-auto w-full px-4 py-6 space-y-5">
        {/* Game info */}
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <h1 className="text-xl font-bold text-white">
              {gameName || `AppID ${appId}`}
            </h1>
            {gameName && (
              <p className="text-gray-500 text-xs">App ID: {appId}</p>
            )}
          </div>
          <a
            href={`https://store.steampowered.com/app/${appId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-gray-400 hover:text-[#66c0f4] text-sm flex items-center gap-1 transition-colors"
          >
            Steam 스토어
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </a>
        </div>

        {/* 미디어 섹션 — 동영상 또는 스크린샷 */}
        {media && (
          <div className="rounded-lg overflow-hidden border border-gray-700/50">
            <MediaPlayer
              movies={media.movies}
              screenshots={media.screenshots}
              headerImage={media.header_image}
              variant="full"
            />
          </div>
        )}

        {/* Filter panel (source hidden for single game view) */}
        <FilterPanel filters={filters} onChange={handleFilterChange} />

        {/* Review feed for specific appId */}
        <GameSpecificReviewFeed
          key={`${appId}-${JSON.stringify(filters)}`}
          appId={appId}
          filters={filters}
        />
      </main>
    </div>
  );
}

function GameSpecificReviewFeed({
  appId,
  filters,
}: {
  appId: string;
  filters: FilterState;
}) {
  const [items, setItems] = useState<
    Array<{ review: SteamReview; gameName: string; gameIcon: string }>
  >([]);
  const [progress, setProgress] = useState<ProgressEventData | null>(null);
  const [loading, setLoading] = useState(true);
  const [done, setDone] = useState(false);
  const doneRef = useRef(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (esRef.current) {
      esRef.current.close();
    }

    const searchParams = new URLSearchParams({
      appId,
      language: filters.language,
      minPlaytime: String(filters.minPlaytime),
      minLength: String(filters.minLength),
      reviewType: filters.reviewType,
      dayRange: String(filters.dayRange),
      excludeFree: String(filters.excludeFree),
    });

    const es = new EventSource(`/api/reviews/stream?${searchParams.toString()}`);
    esRef.current = es;

    es.addEventListener('game-reviews', (e: MessageEvent) => {
      try {
        const data: GameReviewsEvent = JSON.parse(e.data);
        setItems((prev) => [
          ...prev,
          ...data.reviews.map((r) => ({
            review: r,
            gameName: data.gameName,
            gameIcon: data.gameIcon,
          })),
        ]);
      } catch {
        // ignore
      }
    });

    es.addEventListener('progress', (e: MessageEvent) => {
      try {
        setProgress(JSON.parse(e.data));
      } catch {
        // ignore
      }
    });

    es.addEventListener('done', () => {
      setItems((prev) =>
        [...prev].sort((a, b) => b.review.timestamp_created - a.review.timestamp_created)
      );
      setLoading(false);
      setDone(true);
      doneRef.current = true;
      es.close();
      esRef.current = null;
    });

    es.addEventListener('error', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        if (data.message) setStreamError(data.message);
      } catch {
        setLoading(false);
        setDone(true);
        doneRef.current = true;
        es.close();
        esRef.current = null;
      }
    });

    es.onerror = () => {
      setLoading(false);
      if (!doneRef.current) {
        setStreamError('스트림 연결에 실패했습니다. 새로고침 해주세요.');
      }
      es.close();
      esRef.current = null;
    };

    return () => {
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
    };
  }, [appId, filters.language, filters.minPlaytime, filters.minLength, filters.reviewType, filters.dayRange, filters.excludeFree]);

  return (
    <div className="space-y-4">
      {loading && progress && (
        <ProgressBar loaded={progress.loaded} total={progress.total} />
      )}
      {loading && !progress && (
        <div className="flex items-center gap-3 text-gray-400 text-sm py-4">
          <div className="w-4 h-4 border-2 border-[#66c0f4] border-t-transparent rounded-full animate-spin" />
          리뷰를 불러오는 중...
        </div>
      )}
      {streamError && (
        <div className="bg-red-900/40 border border-red-700 rounded-lg px-4 py-3 text-red-300 text-sm">
          {streamError}
        </div>
      )}
      {items.length > 0 && (
        <div className="space-y-3">
          {items.map(({ review, gameName, gameIcon }) => (
            <ReviewCard
              key={review.recommendationid}
              review={review}
              gameName={gameName}
              gameIcon={gameIcon}
            />
          ))}
        </div>
      )}
      {done && items.length === 0 && !streamError && (
        <div className="text-center py-12 text-gray-500">
          조건에 맞는 리뷰가 없습니다.
        </div>
      )}
    </div>
  );
}
