import Link from 'next/link';

interface AppNavProps {
  current: 'feed' | 'recommend' | 'achievements' | 'bundle';
}

const NAV_ITEMS = [
  { key: 'feed' as const, label: '리뷰 피드', href: '/feed' },
  { key: 'recommend' as const, label: '성향 분석', href: '/recommend' },
  { key: 'achievements' as const, label: '도전과제', href: '/achievements' },
  { key: 'bundle' as const, label: '번들 차트', href: '/bundle' },
] as const;

export default function AppNav({ current }: AppNavProps) {
  return (
    <nav
      className="flex items-center gap-1 text-sm bg-gray-100 dark:bg-gray-800 rounded-lg p-1 overflow-x-auto"
      aria-label="주요 메뉴"
    >
      {NAV_ITEMS.map((item) =>
        item.key === current ? (
          <span
            key={item.key}
            aria-current="page"
            className="shrink-0 px-3 py-1.5 rounded bg-white dark:bg-[#1b2838] text-[#1b6fa8] dark:text-[#66c0f4] border border-gray-300 dark:border-[#4c6b8a] shadow-sm font-medium whitespace-nowrap"
          >
            {item.label}
          </span>
        ) : (
          <Link
            key={item.key}
            href={item.href}
            className="shrink-0 px-3 py-1.5 rounded text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors whitespace-nowrap"
          >
            {item.label}
          </Link>
        )
      )}
    </nav>
  );
}
