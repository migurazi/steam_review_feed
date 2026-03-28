interface ProgressBarProps {
  loaded: number;
  total: number;
}

export default function ProgressBar({ loaded, total }: ProgressBarProps) {
  const pct = total > 0 ? Math.round((loaded / total) * 100) : 0;

  return (
    <div className="w-full">
      <div className="flex justify-between items-center mb-1">
        <span className="text-sm text-gray-500 dark:text-gray-400">
          {loaded}/{total} 게임 로딩 완료
        </span>
        <span className="text-sm text-gray-500 dark:text-gray-400">{pct}%</span>
      </div>
      <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
        <div
          className="bg-[#1b6fa8] dark:bg-[#66c0f4] h-2 rounded-full transition-all duration-300 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
