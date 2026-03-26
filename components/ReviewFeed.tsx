'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { GameReviewsEvent, ProgressEvent as ProgressEventData, SteamReview } from '@/lib/steam/types';
import { FilterState } from './FilterPanel';
import ReviewCard from './ReviewCard';
import ProgressBar from './ProgressBar';
import GameHoverPreview from './GameHoverPreview';

interface ReviewFeedProps {
  filters: FilterState;
  offset?: number;
}

interface FeedItem {
  appId: number;
  gameName: string;
  gameIcon: string;
  reviews: SteamReview[];
  noReviewsInLanguage?: boolean;
}

function buildStreamUrl(filters: FilterState, offset: number): string {
  const params = new URLSearchParams({
    source: filters.source,
    language: filters.language,
    minPlaytime: String(filters.minPlaytime),
    minLength: String(filters.minLength),
    reviewType: filters.reviewType,
    dayRange: String(filters.dayRange),
    excludeFree: String(filters.excludeFree),
    offset: String(offset),
  });
  return `/api/reviews/stream?${params.toString()}`;
}

export default function ReviewFeed({ filters, offset = 0 }: ReviewFeedProps) {
  const [items, setItems] = useState<FeedItem[]>([]);
  const [progress, setProgress] = useState<ProgressEventData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const doneRef = useRef(false);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    // Close existing connection
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    setItems([]);
    setProgress(null);
    setLoading(true);
    setError(null);
    setDone(false);
    doneRef.current = false;

    const url = buildStreamUrl(filters, offset);
    const es = new EventSource(url);
    esRef.current = es;

    es.addEventListener('game-reviews', (e: MessageEvent) => {
      try {
        const data: GameReviewsEvent = JSON.parse(e.data);
        setItems((prev) => [
          ...prev,
          {
            appId: data.appId,
            gameName: data.gameName,
            gameIcon: data.gameIcon,
            reviews: data.reviews,
            noReviewsInLanguage: data.noReviewsInLanguage,
          },
        ]);
      } catch {
        // ignore parse errors
      }
    });

    es.addEventListener('progress', (e: MessageEvent) => {
      try {
        const data: ProgressEventData = JSON.parse(e.data);
        setProgress(data);
      } catch {
        // ignore
      }
    });

    es.addEventListener('done', (e: MessageEvent) => {
      try {
        // Sort all reviews by timestamp_created descending after done
        setItems((prev) => {
          const sorted = [...prev].map((item) => ({
            ...item,
            reviews: [...item.reviews].sort((a, b) => b.timestamp_created - a.timestamp_created),
          }));
          // Also sort items by most recent review
          sorted.sort((a, b) => {
            const aMax = a.reviews.length > 0 ? a.reviews[0].timestamp_created : 0;
            const bMax = b.reviews.length > 0 ? b.reviews[0].timestamp_created : 0;
            return bMax - aMax;
          });
          return sorted;
        });
      } catch {
        // ignore
      }
      setLoading(false);
      setDone(true);
      doneRef.current = true;
      es.close();
      esRef.current = null;
      void e; // suppress unused warning
    });

    es.addEventListener('error', (e: MessageEvent) => {
      try {
        const data: { appId?: number; message?: string } = JSON.parse(e.data);
        if (data.message) {
          setError(data.message);
        }
      } catch {
        // Connection error (not a data error event)
        if (es.readyState === EventSource.CLOSED) {
          setLoading(false);
          setDone(true);
          doneRef.current = true;
        }
      }
    });

    es.onerror = () => {
      setLoading(false);
      if (!doneRef.current) {
        setError('스트림 연결에 실패했습니다. 새로고침 해주세요.');
      }
      es.close();
      esRef.current = null;
    };

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [filters, offset]);

  // 리뷰가 있는 게임만 필터 (게임별 그룹)
  const gamesWithReviews = items.filter(
    (item) => !item.noReviewsInLanguage && item.reviews.length > 0
  );
  const totalReviewCount = gamesWithReviews.reduce(
    (sum, item) => sum + item.reviews.length, 0
  );
  const noKoreanGames = items.filter((i) => i.noReviewsInLanguage);

  return (
    <div className="space-y-4">
      {/* Progress */}
      {loading && progress && (
        <ProgressBar loaded={progress.loaded} total={progress.total} />
      )}

      {loading && !progress && (
        <div className="flex items-center gap-3 text-gray-400 text-sm py-4">
          <div className="w-4 h-4 border-2 border-[#66c0f4] border-t-transparent rounded-full animate-spin flex-shrink-0" />
          리뷰를 불러오는 중...
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="bg-red-900/40 border border-red-700 rounded-lg px-4 py-3 text-red-300 text-sm">
          {error}
        </div>
      )}

      {/* No Korean review games */}
      {noKoreanGames.length > 0 && (
        <div className="bg-gray-800/60 border border-gray-700 rounded-lg px-4 py-3">
          <p className="text-gray-400 text-xs mb-2">한국어 리뷰 없음:</p>
          <div className="flex flex-wrap gap-2">
            {noKoreanGames.map((item) => (
              <span
                key={item.appId}
                className="inline-flex items-center gap-1 px-2 py-1 bg-gray-700 rounded text-xs text-gray-300"
              >
                {item.gameIcon && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={item.gameIcon} alt="" className="w-4 h-4 rounded" />
                )}
                {item.gameName}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Reviews: 게임별 그룹 */}
      {gamesWithReviews.length > 0 && (
        <div className="space-y-4">
          {gamesWithReviews.map((item) => (
            <GameGroup key={item.appId} item={item} />
          ))}
        </div>
      )}

      {/* Done, no reviews */}
      {done && totalReviewCount === 0 && noKoreanGames.length === 0 && (
        <div className="text-center py-12 text-gray-500">
          조건에 맞는 리뷰가 없습니다.
        </div>
      )}
    </div>
  );
}

/**
 * 게임별 그룹 컴포넌트. 기본 축소 상태에서 첫 번째 리뷰만 표시.
 * 게임 이름 hover 시 GameHoverPreview 팝업을 표시한다.
 * 모바일(hover 미지원)에서는 hover preview 비활성화.
 */
function GameGroup({ item }: { item: FeedItem }) {
  const [expanded, setExpanded] = useState(false);
  const hasMore = item.reviews.length > 1;
  const visibleReviews = expanded ? item.reviews : item.reviews.slice(0, 1);

  const toggle = useCallback(() => setExpanded((e) => !e), []);

  // --- hover preview 상태 ---
  const [showPreview, setShowPreview] = useState(false);
  const nameRef = useRef<HTMLAnchorElement>(null);
  const hoverTimeout = useRef<ReturnType<typeof setTimeout>>(undefined);
  const closeTimeout = useRef<ReturnType<typeof setTimeout>>(undefined);
  /** hover 장치 여부 (모바일 비활성화) */
  const [canHover, setCanHover] = useState(false);

  // matchMedia로 hover 지원 여부 감지 (CSR only)
  useEffect(() => {
    setCanHover(window.matchMedia('(hover: hover)').matches);
  }, []);

  // 500ms 후 팝업 열기 예약
  const scheduleOpen = useCallback(() => {
    if (!canHover) return;
    clearTimeout(closeTimeout.current);
    hoverTimeout.current = setTimeout(() => setShowPreview(true), 500);
  }, [canHover]);

  // 50ms delay로 팝업 닫기 예약 (anchor↔팝업 이동 시 깜빡임 방지)
  const scheduleClose = useCallback(() => {
    clearTimeout(hoverTimeout.current);
    closeTimeout.current = setTimeout(() => setShowPreview(false), 50);
  }, []);

  // 팝업 hover 진입 시 닫기 취소
  const cancelClose = useCallback(() => {
    clearTimeout(closeTimeout.current);
  }, []);

  // cleanup: unmount 시 타이머 해제
  useEffect(() => {
    return () => {
      clearTimeout(hoverTimeout.current);
      clearTimeout(closeTimeout.current);
    };
  }, []);

  return (
    <div className="rounded-lg border border-gray-700/50 overflow-hidden">
      {/* 게임 헤더 — 클릭으로 expand/shrink */}
      <button
        type="button"
        onClick={hasMore ? toggle : undefined}
        className={`w-full flex items-center gap-3 bg-gray-800/80 px-4 py-2.5 text-left ${
          hasMore ? 'cursor-pointer hover:bg-gray-800' : 'cursor-default'
        } transition-colors`}
      >
        {item.gameIcon && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={item.gameIcon} alt="" className="w-8 h-8 rounded flex-shrink-0" />
        )}
        <a
          ref={nameRef}
          href={`/game/${item.appId}`}
          onClick={(e) => e.stopPropagation()}
          onMouseEnter={scheduleOpen}
          onMouseLeave={scheduleClose}
          className="text-[#66c0f4] font-semibold hover:underline truncate"
        >
          {item.gameName}
        </a>
        <span className="text-gray-500 text-xs flex-shrink-0">
          {item.reviews.length}개 리뷰
        </span>

        {/* expand/shrink 아이콘 */}
        {hasMore && (
          <svg
            className={`w-4 h-4 text-gray-500 flex-shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        )}

        <a
          href={`https://store.steampowered.com/app/${item.appId}`}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="ml-auto text-gray-500 hover:text-[#66c0f4] transition-colors text-xs flex items-center gap-1 flex-shrink-0"
        >
          Steam
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
          </svg>
        </a>
      </button>

      {/* 리뷰 목록 */}
      <div className="divide-y divide-gray-700/30">
        {visibleReviews.map((review) => (
          <div key={review.recommendationid} className="px-2">
            <ReviewCard
              review={review}
              gameName={item.gameName}
              gameIcon={item.gameIcon}
              hideGameHeader
            />
          </div>
        ))}
      </div>

      {/* 더 보기 / 접기 푸터 */}
      {hasMore && (
        <button
          type="button"
          onClick={toggle}
          className="w-full px-4 py-2 text-xs text-gray-400 hover:text-[#66c0f4] bg-gray-800/40 hover:bg-gray-800/60 transition-colors text-center"
        >
          {expanded
            ? '접기'
            : `나머지 ${item.reviews.length - 1}개 리뷰 더 보기`}
        </button>
      )}

      {/* Hover preview — Portal로 body에 렌더링 */}
      {showPreview && nameRef.current && (
        <GameHoverPreview
          appId={item.appId}
          anchorEl={nameRef.current}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
        />
      )}
    </div>
  );
}
