'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import SteamLoginButton from '@/components/SteamLoginButton';
import GameSearch from '@/components/GameSearch';
import ThemeToggle from '@/components/ThemeToggle';
import AboutDialog from '@/components/AboutDialog';

export default function Home() {
  const [manualOpen, setManualOpen] = useState(false);
  const [steamInput, setSteamInput] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [inputError, setInputError] = useState<string | null>(null);
  const router = useRouter();

  async function handleManualSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!steamInput.trim()) return;

    setSubmitting(true);
    setInputError(null);
    try {
      const res = await fetch('/api/auth/manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ steamId: steamInput.trim() }),
      });
      const data = await res.json();
      if (res.ok) {
        router.push('/feed');
      } else {
        setInputError(data.error ?? '로그인에 실패했습니다.');
      }
    } catch {
      setInputError('요청 중 오류가 발생했습니다.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="border-b border-gray-200 dark:border-gray-800 px-4 py-4">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-[#1b6fa8] dark:text-[#66c0f4] font-bold text-lg">Steam Review Feed</span>
          </div>
          <div className="flex items-center gap-3">
            <ThemeToggle />
            <a href="/privacy" className="text-gray-500 text-sm hover:text-gray-700 dark:hover:text-gray-300 transition-colors">
              개인정보 처리방침
            </a>
          </div>
        </div>
      </header>

      {/* Hero */}
      <main className="flex-1 flex flex-col items-center justify-center px-4 py-16">
        <div className="w-full max-w-2xl space-y-10">
          {/* Title */}
          <div className="text-center space-y-3">
            <h1 className="text-4xl font-bold">
              Steam Review Feed
            </h1>
            <p className="text-gray-500 dark:text-gray-400 text-lg">
              위시리스트와 라이브러리 게임들의 최신 리뷰를 한 피드에서 모아보세요.
            </p>
            <ul className="flex flex-col sm:flex-row gap-2 justify-center text-sm text-gray-500 mt-4">
              <li className="flex items-center gap-1">
                <span className="text-[#1b6fa8] dark:text-[#66c0f4]">✓</span> 언어별 필터
              </li>
              <li className="flex items-center gap-1">
                <span className="text-[#1b6fa8] dark:text-[#66c0f4]">✓</span> 플레이타임 맥락
              </li>
              <li className="flex items-center gap-1">
                <span className="text-[#1b6fa8] dark:text-[#66c0f4]">✓</span> 실시간 스트리밍
              </li>
              <li className="flex items-center gap-1">
                <span className="text-[#1b6fa8] dark:text-[#66c0f4]">✓</span> 기간/추천 필터
              </li>
            </ul>
          </div>

          {/* Login section */}
          <div className="bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-6 space-y-4">
            <h2 className="font-semibold text-base">시작하기</h2>
            <p className="text-gray-500 dark:text-gray-400 text-sm">
              위시리스트 / 라이브러리 기반 피드를 사용하려면 로그인이 필요합니다.
            </p>

            <div className="flex flex-col sm:flex-row gap-3">
              <SteamLoginButton />
              <button
                type="button"
                onClick={() => setManualOpen((o) => !o)}
                className="px-4 py-3 rounded-lg border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 text-sm hover:border-gray-400 dark:hover:border-gray-500 hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
              >
                Steam ID 직접 입력
              </button>
            </div>

            {/* Manual login form */}
            {manualOpen && (
              <form onSubmit={handleManualSubmit} className="space-y-3 pt-2 border-t border-gray-200 dark:border-gray-700">
                <div>
                  <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">
                    Steam64 ID 또는 커스텀 URL (예: migurazi 또는 76561198XXXXXXXXX)
                  </label>
                  <input
                    type="text"
                    value={steamInput}
                    onChange={(e) => setSteamInput(e.target.value)}
                    placeholder="Steam ID 또는 커스텀 URL 입력"
                    className="w-full px-3 py-2 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-lg text-sm placeholder-gray-400 dark:placeholder-gray-600 focus:outline-none focus:border-[#1b6fa8] dark:focus:border-[#66c0f4] transition-colors"
                  />
                  {inputError && (
                    <p className="text-red-500 dark:text-red-400 text-xs mt-1">{inputError}</p>
                  )}
                </div>
                <button
                  type="submit"
                  disabled={submitting || !steamInput.trim()}
                  className="px-4 py-2 bg-[#1b6fa8] dark:bg-[#1b2838] border border-[#1b6fa8] dark:border-[#4c6b8a] text-white text-sm rounded-lg hover:bg-[#155a8a] dark:hover:bg-[#2a475e] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {submitting ? '확인 중...' : '로그인'}
                </button>
              </form>
            )}
          </div>

          {/* Game search (no login required) */}
          <div className="space-y-3">
            <h2 className="text-gray-600 dark:text-gray-300 font-medium text-sm">게임 검색 (비로그인 가능)</h2>
            <GameSearch />
            <p className="text-gray-400 dark:text-gray-600 text-xs">
              특정 게임의 리뷰를 바로 확인할 수 있습니다.
            </p>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-gray-200 dark:border-gray-800 px-4 py-4 text-center text-gray-500 dark:text-gray-600 text-xs">
        Steam Review Feed <AboutDialog /> — Steam과 무관한 비공식 서비스입니다.{' '}
        <a href="/privacy" className="hover:text-gray-700 dark:hover:text-gray-400 transition-colors underline">
          개인정보 처리방침
        </a>
      </footer>
    </div>
  );
}
