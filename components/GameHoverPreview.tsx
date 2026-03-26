'use client';

/**
 * GameHoverPreview — 게임 이름 hover 시 표시되는 미디어 팝업.
 *
 * Portal로 document.body에 렌더링하여 부모 overflow/button 제약을 회피한다.
 * 위치는 anchorEl 기준으로 계산하며, 하단 공간 부족 시 상단에 표시.
 * 스크롤 시 즉시 닫힌다 (위치 재계산 대신).
 *
 * 클라이언트 캐시: 모듈 스코프 Map으로 동일 게임 재hover 시 재요청 방지.
 */

import { useEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import MediaPlayer from './MediaPlayer';
import type { SteamMovie, SteamScreenshot } from '@/lib/steam/types';

/** 미디어 API 응답 데이터 */
interface MediaData {
  movies: SteamMovie[];
  screenshots: SteamScreenshot[];
  short_description: string;
  header_image: string;
}

interface GameHoverPreviewProps {
  appId: number;
  /** 위치 계산 기준 DOM 요소 */
  anchorEl: HTMLElement;
  /** 팝업에 마우스 진입 시 호출 — 부모의 닫기 타이머 취소 */
  onMouseEnter: () => void;
  /** 팝업에서 마우스 이탈 시 호출 — 부모의 닫기 타이머 예약 */
  onMouseLeave: () => void;
}

/** 모듈 스코프 캐시 — 같은 게임 재hover 시 API 재요청 방지 */
const mediaCache = new Map<number, MediaData>();

/**
 * anchorEl 위치를 기준으로 팝업 좌표를 계산한다.
 * 기본: anchor 아래. 하단 공간이 300px 미만이면 anchor 위에 표시.
 */
function calcPosition(anchorEl: HTMLElement): { top: number; left: number } {
  const rect = anchorEl.getBoundingClientRect();
  const spaceBelow = window.innerHeight - rect.bottom;
  const popupHeight = 300; // 예상 팝업 높이

  // 좌측 위치: anchor 왼쪽 정렬, 화면 밖으로 나가지 않도록 보정
  let left = rect.left;
  const popupWidth = 400;
  if (left + popupWidth > window.innerWidth) {
    left = window.innerWidth - popupWidth - 8;
  }
  if (left < 8) left = 8;

  if (spaceBelow >= popupHeight) {
    // 아래에 표시 (fixed positioning — viewport 기준, scrollY 불필요)
    return { top: rect.bottom + 4, left };
  }
  // 위에 표시
  return { top: rect.top - popupHeight - 4, left };
}

export default function GameHoverPreview({
  appId,
  anchorEl,
  onMouseEnter,
  onMouseLeave,
}: GameHoverPreviewProps) {
  const [data, setData] = useState<MediaData | null>(mediaCache.get(appId) ?? null);
  const [loading, setLoading] = useState(!mediaCache.has(appId));
  const [pos, setPos] = useState(() => calcPosition(anchorEl));

  // 미디어 데이터 fetch (캐시 miss 시)
  useEffect(() => {
    if (mediaCache.has(appId)) return;

    let cancelled = false;
    fetch(`/api/game/${appId}/media`)
      .then((res) => {
        if (!res.ok) throw new Error('fetch failed');
        return res.json();
      })
      .then((json: MediaData) => {
        if (cancelled) return;
        mediaCache.set(appId, json);
        setData(json);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [appId]);

  // 스크롤 시 팝업 닫기 — onMouseLeave 호출로 부모에게 닫기 위임
  const handleScroll = useCallback(() => {
    onMouseLeave();
  }, [onMouseLeave]);

  useEffect(() => {
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, [handleScroll]);

  // 위치 갱신 (resize 시)
  useEffect(() => {
    const handleResize = () => setPos(calcPosition(anchorEl));
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [anchorEl]);

  const popup = (
    <div
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className="fixed z-[60] w-[400px] bg-gray-900 border border-gray-700 rounded-lg shadow-2xl overflow-hidden"
      style={{ top: pos.top, left: pos.left }}
    >
      {/* 로딩 skeleton */}
      {loading && (
        <div className="aspect-video bg-gray-800 animate-pulse" />
      )}

      {/* 미디어 렌더링 */}
      {data && (
        <>
          <MediaPlayer
            movies={data.movies}
            screenshots={data.screenshots}
            headerImage={data.header_image}
            variant="compact"
          />
          {/* 짧은 설명 (2줄 제한) */}
          {data.short_description && (
            <div className="px-3 py-2">
              <p className="text-gray-300 text-xs line-clamp-2">
                {data.short_description}
              </p>
            </div>
          )}
        </>
      )}

      {/* 데이터 없음 (fetch 실패) */}
      {!loading && !data && (
        <div className="aspect-video bg-gray-800 flex items-center justify-center">
          <span className="text-gray-500 text-xs">미리보기를 불러올 수 없습니다</span>
        </div>
      )}
    </div>
  );

  // Portal로 body에 렌더링
  return createPortal(popup, document.body);
}
