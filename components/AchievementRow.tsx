'use client';

/**
 * AchievementRow — 과제 1건 표시.
 *
 * 아이콘 + displayName + description + 전역 희귀도 바 + 획득 여부 + 획득 일시.
 * hidden && !achieved 인 경우 기본 접힘(스포일러 보호).
 */

import { useState } from 'react';

// ============================================================================
// 타입
// ============================================================================

export interface AchievementItem {
  name: string;
  displayName: string;
  description: string;
  hidden: boolean;
  icon: string | null;
  globalPercent: number | null;
  achieved?: boolean;
  unlockTime?: number;
}

interface AchievementRowProps {
  item: AchievementItem;
  /** 외부에서 초기 공개 상태 주입(revealed Set 동기화용). 미지정 시 내부 관리. */
  initialRevealed?: boolean;
  onReveal?: (name: string) => void;
  isLoggedIn: boolean;
}

// ============================================================================
// 유틸
// ============================================================================

function formatUnlockDate(ms: number): string {
  if (ms === 0) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ============================================================================
// 컴포넌트
// ============================================================================

export default function AchievementRow({
  item,
  initialRevealed = false,
  onReveal,
  isLoggedIn,
}: AchievementRowProps) {
  const isSpoiler = item.hidden && item.achieved !== true;
  const [revealed, setRevealed] = useState(initialRevealed);

  const achieved = item.achieved === true;
  const unlockDateStr =
    achieved && item.unlockTime && item.unlockTime > 0
      ? formatUnlockDate(item.unlockTime)
      : '';

  // 희귀도 바 색상 — 5% 미만은 주황, 20% 미만은 파랑, 나머지는 기본
  function rarityColor(pct: number): string {
    if (pct < 5) return 'bg-orange-500 dark:bg-orange-400';
    if (pct < 20) return 'bg-[#1b6fa8] dark:bg-[#66c0f4]';
    return 'bg-[#1b6fa8] dark:bg-[#66c0f4]';
  }

  function handleReveal() {
    setRevealed(true);
    onReveal?.(item.name);
  }

  return (
    <li className={[
      'flex items-start gap-3 px-3 py-2.5',
      'border-b border-gray-100 dark:border-gray-700/60 last:border-b-0',
      achieved
        ? 'bg-white dark:bg-gray-800'
        : 'bg-gray-50/60 dark:bg-gray-800/40',
    ].join(' ')}>
      {/* 아이콘 */}
      <div className="shrink-0 w-10 h-10 mt-0.5">
        {item.icon && (!isSpoiler || revealed) ? (
          <img
            src={item.icon}
            alt=""
            className={[
              'w-10 h-10 rounded object-cover',
              achieved ? '' : 'grayscale opacity-40',
            ].join(' ')}
          />
        ) : (
          <div className={[
            'w-10 h-10 rounded',
            isSpoiler && !revealed
              ? 'bg-gray-300 dark:bg-gray-600'
              : achieved
                ? 'bg-gray-200 dark:bg-gray-600'
                : 'bg-gray-200 dark:bg-gray-700',
          ].join(' ')} />
        )}
      </div>

      {/* 본문 */}
      <div className="flex-1 min-w-0 space-y-1.5">
        {isSpoiler && !revealed ? (
          /* 스포일러 상태 */
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm text-gray-400 dark:text-gray-500 italic">
              숨겨진 도전과제
            </span>
            <button
              type="button"
              onClick={handleReveal}
              className="text-xs px-2 py-0.5 border border-gray-300 dark:border-gray-600 rounded text-gray-500 dark:text-gray-400 hover:border-[#1b6fa8] dark:hover:border-[#66c0f4] hover:text-[#1b6fa8] dark:hover:text-[#66c0f4] transition-colors"
            >
              공개
            </button>
          </div>
        ) : (
          /* 공개 상태 */
          <>
            <div className="flex items-center gap-2 flex-wrap">
              <span className={[
                'text-sm font-medium leading-tight',
                achieved
                  ? 'text-gray-800 dark:text-gray-100'
                  : 'text-gray-600 dark:text-gray-300',
              ].join(' ')}>
                {item.displayName || item.name}
              </span>
              {/* 로그인 시 획득 여부 */}
              {isLoggedIn && achieved && (
                <span className="text-xs text-green-600 dark:text-green-400 font-medium shrink-0">
                  [획득]
                </span>
              )}
              {isLoggedIn && !achieved && (
                <span className="text-xs text-gray-400 dark:text-gray-500 shrink-0">
                  [미획득]
                </span>
              )}
            </div>
            {item.description && (
              <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">
                {item.description}
              </p>
            )}
            {unlockDateStr && (
              <p className="text-xs text-green-600 dark:text-green-400">
                획득: {unlockDateStr}
              </p>
            )}
          </>
        )}

        {/* 전역 희귀도 바 */}
        <div className="flex items-center gap-2">
          <div className="flex-1 h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
            {item.globalPercent !== null ? (
              <div
                className={`h-full rounded-full transition-all duration-300 ${rarityColor(item.globalPercent)}`}
                style={{ width: `${item.globalPercent}%` }}
              />
            ) : (
              <div className="h-full w-0" />
            )}
          </div>
          <span className="text-xs text-gray-400 dark:text-gray-500 tabular-nums shrink-0 w-10 text-right">
            {item.globalPercent !== null ? `${item.globalPercent.toFixed(1)}%` : '-'}
          </span>
        </div>
      </div>
    </li>
  );
}
