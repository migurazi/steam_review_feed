'use client';

/**
 * About 다이얼로그.
 * 앱 이름, 버전, 기술 스택, 라이선스 등을 표시한다.
 * footer의 버전 텍스트를 클릭하면 열린다.
 */

import { useState, useEffect, useCallback } from 'react';
import { APP_VERSION } from '@/lib/version';

export default function AboutDialog() {
  const [open, setOpen] = useState(false);

  // ESC 키로 닫기
  const close = useCallback(() => setOpen(false), []);
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, close]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="hover:text-gray-700 dark:hover:text-gray-400 transition-colors"
      >
        v{APP_VERSION}
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={() => setOpen(false)}
        >
          <div
            className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl shadow-2xl w-full max-w-md mx-4 p-6 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold">Steam Review Feed</h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
                aria-label="닫기"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Version */}
            <div className="flex items-center gap-2">
              <span className="px-2 py-0.5 bg-[#1b6fa8]/10 dark:bg-[#66c0f4]/10 text-[#1b6fa8] dark:text-[#66c0f4] text-xs font-medium rounded">
                v{APP_VERSION}
              </span>
            </div>

            {/* Description */}
            <p className="text-sm text-gray-600 dark:text-gray-300">
              Steam 위시리스트와 라이브러리 게임들의 최신 리뷰를 한 피드에서 모아보는 서비스.
            </p>

            {/* Tech Stack */}
            <div className="space-y-2">
              <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">기술 스택</h3>
              <div className="flex flex-wrap gap-1.5">
                {['Next.js 16', 'TypeScript', 'Tailwind CSS 4', 'SQLite', 'iron-session', 'hls.js', 'Vitest'].map((tech) => (
                  <span key={tech} className="px-2 py-0.5 bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 text-xs rounded">
                    {tech}
                  </span>
                ))}
              </div>
            </div>

            {/* Links */}
            <div className="flex items-center gap-4 pt-2 border-t border-gray-200 dark:border-gray-700 text-xs">
              <a href="/privacy" className="text-[#1b6fa8] dark:text-[#66c0f4] hover:underline">
                개인정보 처리방침
              </a>
              <span className="text-gray-300 dark:text-gray-600">|</span>
              <span className="text-gray-400 dark:text-gray-500">
                MIT License
              </span>
            </div>

            {/* Disclaimer */}
            <p className="text-[10px] text-gray-400 dark:text-gray-600 leading-relaxed">
              Steam과 무관한 비공식 서비스입니다. Steam은 Valve Corporation의 상표입니다.
            </p>
          </div>
        </div>
      )}
    </>
  );
}
