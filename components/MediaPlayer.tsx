'use client';

/**
 * MediaPlayer — 공유 미디어 렌더링 컴포넌트.
 *
 * hover 팝업(compact)과 게임 상세 페이지(full)에서 공통으로 사용한다.
 * 미디어 우선순위: 동영상(HLS) → 스크린샷 슬라이드 → 헤더 이미지 fallback.
 *
 * - compact: 작은 사이즈, 컨트롤 숨김, 자동재생 (hover 팝업)
 * - full: 동영상+스크린샷 통합 갤러리, 이전/다음 컨트롤, 재생/음소거 (게임 상세 페이지)
 */

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import type { SteamMovie, SteamScreenshot } from '@/lib/steam/types';

interface MediaPlayerProps {
  /** Steam 동영상 목록 (HLS 스트리밍) */
  movies?: SteamMovie[];
  /** Steam 스크린샷 목록 */
  screenshots?: SteamScreenshot[];
  /** 최종 fallback 이미지 */
  headerImage: string;
  /** compact: hover 팝업용. full: 상세 페이지용 */
  variant: 'compact' | 'full';
}

/**
 * HLS 동영상 플레이어.
 * hls.js를 dynamic import하여 브라우저 호환성을 확보한다.
 * Safari는 네이티브 HLS를 지원하므로 hls.js 없이 직접 재생.
 */
function HlsVideo({
  src,
  variant,
  onError: onErrorProp,
}: {
  src: string;
  variant: 'compact' | 'full';
  /** HLS 로딩 실패 시 호출 — 부모가 fallback(스크린샷 등)으로 전환 */
  onError?: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [muted, setMuted] = useState(true);
  const [playing, setPlaying] = useState(true);
  /** HLS 로딩 실패 시 true — fallback으로 전환 */
  const [error, setError] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    // Safari는 네이티브 HLS 지원
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src;
      video.play().catch(() => {});
      return;
    }

    // 다른 브라우저: hls.js 사용 (dynamic import로 번들 분리)
    let hls: import('hls.js').default | null = null;

    import('hls.js').then((HlsModule) => {
      const Hls = HlsModule.default;
      if (!Hls.isSupported()) {
        setError(true);
        return;
      }
      hls = new Hls({
        // hover preview는 빠른 시작이 중요하므로 낮은 품질로 시작
        startLevel: variant === 'compact' ? 0 : -1,
        maxBufferLength: variant === 'compact' ? 10 : 30,
      });
      hls.loadSource(src);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch(() => {});
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) setError(true);
      });
    }).catch(() => {
      setError(true);
    });

    return () => {
      hls?.destroy();
    };
  }, [src, variant]);

  // error 발생 시 부모에게 알려 fallback 전환
  useEffect(() => {
    if (error && onErrorProp) onErrorProp();
  }, [error, onErrorProp]);

  if (error) return null;

  return (
    <div className="relative">
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video
        ref={videoRef}
        muted={muted}
        autoPlay
        loop
        playsInline
        preload={variant === 'full' ? 'metadata' : undefined}
        className="w-full aspect-video object-cover"
      />
      {/* full variant: 재생 컨트롤 표시 */}
      {variant === 'full' && (
        <div className="absolute bottom-2 right-2 flex gap-1.5">
          {/* 재생/일시정지 버튼 */}
          <button
            type="button"
            onClick={() => {
              const v = videoRef.current;
              if (!v) return;
              if (v.paused) { v.play(); setPlaying(true); }
              else { v.pause(); setPlaying(false); }
            }}
            className="bg-black/60 hover:bg-black/80 text-white rounded p-1.5 transition-colors"
            aria-label={playing ? '일시정지' : '재생'}
          >
            {playing ? (
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" /></svg>
            ) : (
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
            )}
          </button>
          {/* 음소거/해제 버튼 */}
          <button
            type="button"
            onClick={() => {
              const v = videoRef.current;
              if (!v) return;
              v.muted = !v.muted;
              setMuted(v.muted);
            }}
            className="bg-black/60 hover:bg-black/80 text-white rounded p-1.5 transition-colors"
            aria-label={muted ? '음소거 해제' : '음소거'}
          >
            {muted ? (
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.96 8.96 0 0021 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 003.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" /></svg>
            ) : (
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" /></svg>
            )}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * 스크린샷 슬라이드쇼 (compact variant 전용).
 * 3초 간격 자동 전환. path_thumbnail 사용.
 * full variant의 스크린샷 탐색은 MediaGallery가 담당한다.
 */
function ScreenshotSlideshow({
  screenshots,
}: {
  screenshots: SteamScreenshot[];
}) {
  const [index, setIndex] = useState(0);

  // 3초 간격 자동 전환
  useEffect(() => {
    if (screenshots.length <= 1) return;
    const timer = setInterval(() => {
      setIndex((prev) => (prev + 1) % screenshots.length);
    }, 3000);
    return () => clearInterval(timer);
  }, [screenshots.length]);

  return (
    <div className="relative aspect-video overflow-hidden">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        key={screenshots[index].id}
        src={screenshots[index].path_thumbnail}
        alt={`Screenshot ${index + 1}`}
        className="w-full h-full object-cover"
      />
    </div>
  );
}

/**
 * 통합 미디어 갤러리 (full variant 전용).
 *
 * 동영상과 스크린샷을 하나의 리스트로 합쳐
 * 이전/다음 버튼으로 탐색할 수 있다.
 * 동영상이 먼저, 스크린샷이 뒤에 배치된다.
 */
type GalleryItem =
  | { type: 'movie'; movie: SteamMovie }
  | { type: 'screenshot'; screenshot: SteamScreenshot };

function MediaGallery({
  movies,
  screenshots,
  headerImage,
}: {
  movies: SteamMovie[];
  screenshots: SteamScreenshot[];
  headerImage: string;
}) {
  const [index, setIndex] = useState(0);
  /** 동영상 에러 발생한 movie id 집합 */
  const [failedMovies, setFailedMovies] = useState<Set<number>>(new Set());

  // 동영상 → 스크린샷 순서로 통합, 실패한 동영상은 제외
  const validItems = useMemo(() => {
    const items: GalleryItem[] = [
      ...movies.map((m): GalleryItem => ({ type: 'movie', movie: m })),
      ...screenshots.map((s): GalleryItem => ({ type: 'screenshot', screenshot: s })),
    ];
    return items.filter(
      (item) => !(item.type === 'movie' && failedMovies.has(item.movie.id))
    );
  }, [movies, screenshots, failedMovies]);
  const totalCount = validItems.length;

  // index가 범위를 초과하면 보정
  const safeIndex = totalCount > 0 ? index % totalCount : 0;
  const current = validItems[safeIndex];

  const goPrev = useCallback(() => {
    setIndex((i) => (i - 1 + totalCount) % totalCount);
  }, [totalCount]);

  const goNext = useCallback(() => {
    setIndex((i) => (i + 1) % totalCount);
  }, [totalCount]);

  const handleMovieError = useCallback((movieId: number) => {
    setFailedMovies((prev) => new Set(prev).add(movieId));
  }, []);

  // 미디어가 하나도 없으면 헤더 이미지 fallback
  if (totalCount === 0) {
    return (
      <div className="aspect-video">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={headerImage} alt="Game header" className="w-full h-full object-cover" />
      </div>
    );
  }

  return (
    <div className="relative aspect-video overflow-hidden bg-black">
      {/* 현재 미디어 렌더링 — z-0으로 컨트롤(z-10) 아래 배치 */}
      <div className="absolute inset-0 z-0">
        {current.type === 'movie' ? (
          <HlsVideo
            key={current.movie.id}
            src={current.movie.hls_h264}
            variant="full"
            onError={() => handleMovieError(current.movie.id)}
          />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={`ss-${current.screenshot.id}`}
            src={current.screenshot.path_full}
            alt={`Screenshot ${safeIndex + 1}`}
            className="w-full h-full object-cover"
          />
        )}
      </div>

      {/* 이전/다음 버튼 — z-10으로 동영상/이미지 위에 표시 */}
      {totalCount > 1 && (
        <>
          <button
            type="button"
            onClick={goPrev}
            className="absolute z-10 left-2 top-1/2 -translate-y-1/2 bg-black/60 hover:bg-black/80 text-white rounded-full p-2 transition-colors"
            aria-label="이전"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <button
            type="button"
            onClick={goNext}
            className="absolute z-10 right-2 top-1/2 -translate-y-1/2 bg-black/60 hover:bg-black/80 text-white rounded-full p-2 transition-colors"
            aria-label="다음"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </>
      )}

      {/* 하단 인디케이터 — 동영상은 ▶ 아이콘, 스크린샷은 ● 점 */}
      {totalCount > 1 && (
        <div className="absolute z-10 bottom-2 left-1/2 -translate-x-1/2 flex items-center gap-1.5 bg-black/50 rounded-full px-2 py-1 max-w-[80%] overflow-x-auto">
          {validItems.map((item, i) => (
            <button
              key={item.type === 'movie' ? `m-${item.movie.id}` : `s-${item.screenshot.id}`}
              type="button"
              onClick={() => setIndex(i)}
              className={`flex-shrink-0 transition-colors ${i === safeIndex ? 'text-white' : 'text-white/40 hover:text-white/70'}`}
              aria-label={`${item.type === 'movie' ? '동영상' : '스크린샷'} ${i + 1}`}
            >
              {item.type === 'movie' ? (
                <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
              ) : (
                <span className={`block w-1.5 h-1.5 rounded-full ${i === safeIndex ? 'bg-white' : 'bg-current'}`} />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * MediaPlayer 메인 컴포넌트.
 *
 * - compact (hover 팝업): 동영상 → 스크린샷 슬라이드 → 헤더 이미지 fallback
 * - full (게임 상세 페이지): 동영상 + 스크린샷 통합 갤러리, 이전/다음 컨트롤
 */
export default function MediaPlayer({
  movies,
  screenshots,
  headerImage,
  variant,
}: MediaPlayerProps) {
  // full variant: 통합 갤러리
  if (variant === 'full') {
    return (
      <MediaGallery
        movies={movies ?? []}
        screenshots={screenshots ?? []}
        headerImage={headerImage}
      />
    );
  }

  // compact variant: 기존 우선순위 로직 (동영상 → 스크린샷 → 헤더)
  return <CompactMediaPlayer movies={movies} screenshots={screenshots} headerImage={headerImage} />;
}

/**
 * Compact variant용 미디어 플레이어.
 * 동영상 → 스크린샷 슬라이드 → 헤더 이미지 순서로 fallback.
 */
function CompactMediaPlayer({
  movies,
  screenshots,
  headerImage,
}: {
  movies?: SteamMovie[];
  screenshots?: SteamScreenshot[];
  headerImage: string;
}) {
  const [videoFailed, setVideoFailed] = useState(false);
  const handleVideoError = useCallback(() => setVideoFailed(true), []);

  const firstMovie = movies?.[0];
  if (firstMovie && !videoFailed) {
    return <HlsVideo src={firstMovie.hls_h264} variant="compact" onError={handleVideoError} />;
  }

  if (screenshots && screenshots.length > 0) {
    return <ScreenshotSlideshow screenshots={screenshots} />;
  }

  return (
    <div className="aspect-video">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={headerImage} alt="Game header" className="w-full h-full object-cover" />
    </div>
  );
}
