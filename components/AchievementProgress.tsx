interface AchievementProgressProps {
  unlocked: number;
  total: number;
  size?: 'sm' | 'md';
  showLabel?: boolean;
}

export default function AchievementProgress({
  unlocked,
  total,
  size = 'md',
  showLabel = false,
}: AchievementProgressProps) {
  const pct = total > 0 ? Math.min(unlocked, total) / total * 100 : 0;
  const height = size === 'sm' ? 'h-1.5' : 'h-2.5';

  return (
    <div className="w-full space-y-1">
      {showLabel && (
        <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
          <span>{unlocked}/{total}</span>
          <span>{Math.round(pct)}%</span>
        </div>
      )}
      <div className={`w-full bg-gray-200 dark:bg-gray-700 rounded-full ${height}`}>
        <div
          className={`bg-[#1b6fa8] dark:bg-[#66c0f4] ${height} rounded-full transition-all duration-300 ease-out`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
