'use client';

/**
 * 번들 차트의 게임 한 줄(GameRow) 표시·편집 행 (작업 지시서 20261012_01 단계 3·5).
 *
 * 구성: 헤더 이미지 썸네일 · 이름(스토어 링크) · 가격(GamePrice 재사용) · 호평률 배지 · DLC 배지 ·
 *       이동(위/아래·티어 선택)·삭제 컨트롤.
 *
 * 드래그 라이브러리 없이 **티어 선택 드롭다운 + 위/아래 버튼**으로만 이동한다.
 */

import GamePrice from '@/components/GamePrice';
import type { GameRow } from '@/lib/bundle/types';
import type { SteamPriceOverview } from '@/lib/steam/types';

/** GameRowPrice를 GamePrice가 받는 SteamPriceOverview 모양으로 변환한다(cents·필드명 1:1). */
function toSteamPrice(p: NonNullable<GameRow['price']>): SteamPriceOverview {
  return {
    currency: p.currency,
    initial: p.initial,
    final: p.final,
    discount_percent: p.discountPercent,
    // 무할인 시 initialFormatted가 비어 있을 수 있어 GamePrice가 final로 폴백한다.
    initial_formatted: p.initialFormatted,
    final_formatted: p.finalFormatted,
  };
}

/** 호평률 %를 한국어 감정 라벨 + Tailwind 색상으로 매핑(Steam 등급 구간 근사). */
function reviewStyle(percent: number): { label: string; className: string } {
  if (percent >= 80) return { label: '매우 긍정적', className: 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300' };
  if (percent >= 70) return { label: '대체로 긍정적', className: 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400' };
  if (percent >= 40) return { label: '복합적', className: 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300' };
  if (percent >= 20) return { label: '대체로 부정적', className: 'bg-orange-100 dark:bg-orange-900/40 text-orange-700 dark:text-orange-300' };
  return { label: '매우 부정적', className: 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300' };
}

export interface GameRowItemProps {
  game: GameRow;
  /** 현재 티어의 1-based 순번·전체 티어 수 (이동 대상 드롭다운 렌더용). */
  tierCount: number;
  /** 이 게임이 속한 티어 인덱스(0-based). */
  tierIndex: number;
  /** 티어 라벨 목록(드롭다운 표시용). */
  tierLabels: string[];
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  /** 다른 티어로 이동. 같은 티어를 고르면 no-op. */
  onMoveToTier: (targetTierIndex: number) => void;
  onRemove: () => void;
}

export default function GameRowItem({
  game,
  tierCount,
  tierIndex,
  tierLabels,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
  onMoveToTier,
  onRemove,
}: GameRowItemProps) {
  const review = game.review;
  const reviewInfo = review ? reviewStyle(review.positivePercent) : null;

  return (
    <li className="flex items-center gap-3 p-2 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg">
      {/* 썸네일 */}
      {game.headerImage ? (
        <img
          src={game.headerImage}
          alt=""
          className="w-24 aspect-[460/215] object-cover rounded bg-gray-100 dark:bg-gray-900 shrink-0"
          loading="lazy"
        />
      ) : (
        <div
          aria-hidden
          className="w-24 aspect-[460/215] rounded bg-gray-100 dark:bg-gray-900 shrink-0 flex items-center justify-center text-[10px] text-gray-400 dark:text-gray-600"
        >
          이미지 없음
        </div>
      )}

      {/* 본문 */}
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2 flex-wrap">
          <a
            href={game.storeUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-medium text-gray-800 dark:text-gray-100 hover:text-[#1b6fa8] dark:hover:text-[#66c0f4] truncate"
          >
            {game.name}
          </a>
          {game.type === 'dlc' && (
            <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300">
              DLC
            </span>
          )}
          {game.uncertain && (
            <span
              className="shrink-0 inline-flex items-center justify-center w-4 h-4 rounded-full text-[10px] font-bold bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 cursor-help"
              title="이름 검색으로 매칭된 게임입니다. 동명·다른 에디션일 수 있으니 링크를 확인하세요."
              aria-label="매칭 정확도 낮음 — 링크 확인 권장"
            >
              ?
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 flex-wrap text-xs">
          {/* 가격 */}
          {game.priceUnknown ? (
            <span className="text-gray-400 dark:text-gray-500">가격 미상</span>
          ) : game.price === null ? (
            <GamePrice isFree />
          ) : (
            <GamePrice
              price={toSteamPrice(game.price)}
              stale={game.price.fallback}
              staleLabel="마지막 확인 가격"
            />
          )}

          {/* 호평률 */}
          {review && reviewInfo && (
            <span
              className={`shrink-0 px-1.5 py-0.5 rounded font-medium ${reviewInfo.className}`}
              title={`${reviewInfo.label} · 호평 ${review.positivePercent}% (리뷰 ${review.total.toLocaleString('ko-KR')}개)`}
            >
              {review.positivePercent}% ({review.total.toLocaleString('ko-KR')})
            </span>
          )}
        </div>
      </div>

      {/* 컨트롤 */}
      <div className="flex items-center gap-1 shrink-0">
        <div className="flex flex-col">
          <button
            type="button"
            onClick={onMoveUp}
            disabled={!canMoveUp}
            aria-label={`${game.name} 위로 이동`}
            className="px-1.5 py-0.5 text-gray-500 dark:text-gray-400 hover:text-[#1b6fa8] dark:hover:text-[#66c0f4] disabled:opacity-30 disabled:cursor-not-allowed rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1b6fa8] dark:focus-visible:ring-[#66c0f4]"
          >
            <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden className="w-3.5 h-3.5">
              <path fillRule="evenodd" d="M7.47 4.22a.75.75 0 0 1 1.06 0l3.25 3.25a.75.75 0 0 1-1.06 1.06L8 5.81 5.28 8.53a.75.75 0 0 1-1.06-1.06l3.25-3.25Z" clipRule="evenodd" />
            </svg>
          </button>
          <button
            type="button"
            onClick={onMoveDown}
            disabled={!canMoveDown}
            aria-label={`${game.name} 아래로 이동`}
            className="px-1.5 py-0.5 text-gray-500 dark:text-gray-400 hover:text-[#1b6fa8] dark:hover:text-[#66c0f4] disabled:opacity-30 disabled:cursor-not-allowed rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1b6fa8] dark:focus-visible:ring-[#66c0f4]"
          >
            <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden className="w-3.5 h-3.5">
              <path fillRule="evenodd" d="M4.22 6.47a.75.75 0 0 1 1.06 0L8 9.19l2.72-2.72a.75.75 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 7.53a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" />
            </svg>
          </button>
        </div>

        {tierCount > 1 && (
          <label className="sr-only" htmlFor={`move-${game.appId}-${tierIndex}`}>
            {game.name} 다른 티어로 이동
          </label>
        )}
        {tierCount > 1 && (
          <select
            id={`move-${game.appId}-${tierIndex}`}
            value={tierIndex}
            onChange={(e) => onMoveToTier(parseInt(e.target.value, 10))}
            aria-label={`${game.name} 티어 이동`}
            className="px-1.5 py-1 text-xs bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded max-w-[120px] focus:outline-none focus:border-[#1b6fa8] dark:focus:border-[#66c0f4]"
          >
            {tierLabels.map((label, i) => (
              <option key={i} value={i}>
                {label || `티어 ${i + 1}`}
              </option>
            ))}
          </select>
        )}

        <button
          type="button"
          onClick={onRemove}
          aria-label={`${game.name} 삭제`}
          className="px-1.5 py-1 text-gray-400 dark:text-gray-500 hover:text-red-600 dark:hover:text-red-400 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
        >
          <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden className="w-4 h-4">
            <path fillRule="evenodd" d="M6.5 1.75a.25.25 0 0 1 .25-.25h2.5a.25.25 0 0 1 .25.25V3h-3V1.75Zm4.5 0V3h2.25a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1 0-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75ZM4.496 6.675l.66 6.6a.25.25 0 0 0 .249.225h5.19a.25.25 0 0 0 .249-.225l.66-6.6a.75.75 0 0 1 1.492.149l-.66 6.6A1.748 1.748 0 0 1 10.595 15h-5.19a1.75 1.75 0 0 1-1.741-1.575l-.66-6.6a.75.75 0 1 1 1.492-.15Z" clipRule="evenodd" />
          </svg>
        </button>
      </div>
    </li>
  );
}
