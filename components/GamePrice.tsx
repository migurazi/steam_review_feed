import type { SteamPriceOverview } from '@/lib/steam/types';

interface GamePriceProps {
  price?: SteamPriceOverview;
  isFree?: boolean;
  /** 미출시 게임 여부. true면 "출시 예정" 라벨 */
  comingSoon?: boolean;
  /** 출시일 표시 문자열 (미출시 게임 툴팁용) */
  releaseDate?: string;
  /** "compact"=피드 헤더용 작은 크기, "full"=상세 페이지용 큰 크기 */
  variant?: 'compact' | 'full';
  className?: string;
}

/**
 * 게임 가격 표시 컴포넌트.
 * - is_free=true: "무료" 배지
 * - comingSoon=true: "출시 예정" 라벨 (releaseDate를 title로)
 * - 할인 없음: 정가만 표시
 * - 할인 중: 정가(취소선) + 할인가 + 할인율 배지 (Steam 그린)
 * - 가격 정보 없음 + 미출시 아님: null 반환
 */
export default function GamePrice({
  price,
  isFree,
  comingSoon,
  releaseDate,
  variant = 'compact',
  className = '',
}: GamePriceProps) {
  const isCompact = variant === 'compact';
  const baseSize = isCompact ? 'text-xs' : 'text-base';
  const finalSize = isCompact ? 'text-sm' : 'text-xl';
  const badgePad = isCompact ? 'px-1.5 py-0.5' : 'px-2 py-1';
  const badgeText = isCompact ? 'text-xs' : 'text-sm';

  if (isFree) {
    return (
      <span
        className={`inline-flex items-center ${badgePad} rounded font-semibold bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 ${badgeText} ${className}`}
      >
        무료
      </span>
    );
  }

  if (comingSoon) {
    return (
      <span
        title={releaseDate || undefined}
        className={`inline-flex items-center ${badgePad} rounded font-semibold bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 ${badgeText} ${className}`}
      >
        출시 예정
      </span>
    );
  }

  if (!price) return null;

  const onSale = price.discount_percent > 0;

  if (!onSale) {
    return (
      <span
        className={`text-gray-700 dark:text-gray-300 font-medium ${finalSize} ${className}`}
      >
        {price.final_formatted || price.initial_formatted}
      </span>
    );
  }

  // 할인 중: Steam 스타일 배지(라임 그린/다크 그린) + 정가 취소선 + 할인가 강조
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <span
        className={`inline-flex items-center ${badgePad} rounded font-bold bg-[#4c6b22] text-[#beee11] ${badgeText} tabular-nums shadow-sm`}
      >
        -{price.discount_percent}%
      </span>
      <span
        className={`text-gray-400 dark:text-gray-500 line-through ${baseSize}`}
      >
        {price.initial_formatted}
      </span>
      <span
        className={`text-[#5a8a1a] dark:text-[#beee11] font-bold ${finalSize}`}
      >
        {price.final_formatted}
      </span>
    </span>
  );
}
