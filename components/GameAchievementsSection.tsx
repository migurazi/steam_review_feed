'use client';

/**
 * 게임 상세 페이지(/game/[appId])의 도전과제 요약 섹션 (Phase 2, §5.6.4).
 *
 * 비로그인도 접근 가능한 페이지이므로 /api/achievements/{appId}(비보호)를 그대로
 * 쓴다:
 *   - 로그인: 진행률 바(획득/전체) + 희귀 "미획득" 과제 몇 개
 *   - 비로그인: 전역 희귀 과제 몇 개(개인 필드 없음)
 *
 * 과제 없음(404)/조회 실패면 섹션 자체를 렌더하지 않는다(게임 페이지 흐름을 방해하지
 * 않도록). 숨김 과제는 스포일러 방지를 위해 희귀 목록에서 제외한다.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import AchievementProgress from '@/components/AchievementProgress';

interface DetailAchievement {
  name: string;
  displayName: string;
  description: string;
  hidden: boolean;
  icon: string | null;
  globalPercent: number | null;
  achieved?: boolean;
  unlockTime?: number;
}
interface DetailResponse {
  appId: number;
  achievements: DetailAchievement[];
  personalUnavailable?: 'private' | 'unavailable' | 'error';
}

/** 요약 섹션에 표시할 희귀 과제 최대 개수. */
const RAREST_COUNT = 3;

export default function GameAchievementsSection({ appId }: { appId: string }) {
  const [data, setData] = useState<DetailResponse | null>(null);
  const [status, setStatus] = useState<'loading' | 'hidden' | 'ready'>('loading');

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/achievements/${appId}?lang=ko`)
      .then(async (res) => {
        if (cancelled) return;
        // 404(과제 없음)·기타 실패 → 섹션 숨김.
        if (!res.ok) {
          setStatus('hidden');
          return;
        }
        const d = (await res.json()) as DetailResponse;
        if (cancelled) return;
        setData(d);
        setStatus('ready');
      })
      .catch(() => {
        if (!cancelled) setStatus('hidden');
      });
    return () => {
      cancelled = true;
    };
  }, [appId]);

  if (status === 'hidden') return null;

  if (status === 'loading') {
    return (
      <section className="rounded-lg border border-gray-200 dark:border-gray-700/50 p-4">
        <div className="flex items-center gap-3 text-gray-500 dark:text-gray-400 text-sm">
          <div className="w-4 h-4 border-2 border-[#1b6fa8] dark:border-[#66c0f4] border-t-transparent rounded-full animate-spin" />
          도전과제 불러오는 중...
        </div>
      </section>
    );
  }

  if (!data) return null;

  const achs = data.achievements;
  // 개인 필드(achieved)는 세션이 있을 때만 응답에 포함된다 → 존재 여부로 로그인 판별.
  const loggedIn = achs.length > 0 && achs[0].achieved !== undefined;
  // 로그인했어도 프로필 비공개(personalUnavailable)면 개인 현황이 실제 데이터가 아니라
  // 전부 achieved:false다 → 진행바를 그리면 잘못된 0%가 뜬다(#3). 이 경우 개인 데이터를
  // 신뢰하지 않고(전역 희귀 뷰로 폴백) 진행바를 숨긴다.
  const personalOk = loggedIn && !data.personalUnavailable;
  const total = achs.length;
  const unlocked = personalOk ? achs.filter((a) => a.achieved).length : 0;

  // 희귀 과제: 개인 데이터가 유효하면 '미획득' 중에서, 아니면 전체 중에서. 숨김 과제는
  // 스포일러 방지로 제외하고, 전역 달성률 낮은 순(희귀)으로 상위 몇 개.
  const pool = personalOk ? achs.filter((a) => !a.achieved) : achs;
  const rarest = pool
    .filter((a) => !a.hidden && a.globalPercent !== null)
    .sort((a, b) => (a.globalPercent as number) - (b.globalPercent as number))
    .slice(0, RAREST_COUNT);

  return (
    <section className="rounded-lg border border-gray-200 dark:border-gray-700/50 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-sm">도전과제</h2>
        {loggedIn && (
          <Link
            href="/achievements"
            className="text-[#1b6fa8] dark:text-[#66c0f4] text-xs hover:underline"
          >
            전체 보기
          </Link>
        )}
      </div>

      {personalOk ? (
        <AchievementProgress unlocked={unlocked} total={total} size="md" showLabel />
      ) : !loggedIn ? (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          로그인하면 내 달성 현황이 표시됩니다. 아래는 전역 희귀 과제입니다.
        </p>
      ) : null}

      {data.personalUnavailable === 'private' && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          프로필의 &lsquo;게임 세부 정보&rsquo;를 공개하면 내 획득 현황이 표시됩니다.
        </p>
      )}

      {rarest.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {personalOk ? '희귀 미획득 과제' : '희귀 과제'}
          </p>
          {rarest.map((a) => (
            <div key={a.name} className="flex items-center gap-3">
              {a.icon ? (
                <img
                  src={a.icon}
                  alt=""
                  className="w-8 h-8 rounded flex-shrink-0"
                  loading="lazy"
                />
              ) : (
                <div className="w-8 h-8 rounded bg-gray-200 dark:bg-gray-700 flex-shrink-0" />
              )}
              <p className="text-sm truncate min-w-0 flex-1">{a.displayName}</p>
              <span className="text-xs text-gray-500 dark:text-gray-400 tabular-nums flex-shrink-0">
                {a.globalPercent !== null
                  ? `${a.globalPercent.toFixed(1)}%`
                  : '-'}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
