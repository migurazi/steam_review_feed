'use client';

/**
 * 최초 설정 페이지 — 비개발자가 브라우저에서 Steam API 키만 붙여넣으면 끝나도록.
 *
 * 흐름: 상태 확인(GET /api/setup) → 미설정이면 폼 → 검증·저장(POST) → 성공 시 홈으로.
 * SESSION_SECRET은 start.bat이 자동 생성하므로 사용자는 신경 쓸 필요가 없다.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

type Phase = 'checking' | 'form' | 'saving' | 'done' | 'already';

export default function SetupPage() {
  const [phase, setPhase] = useState<Phase>('checking');
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    fetch('/api/setup')
      .then((res) => res.json())
      .then((data: { configured: boolean }) => {
        if (cancelled) return;
        setPhase(data.configured ? 'already' : 'form');
      })
      .catch(() => {
        if (!cancelled) setPhase('form');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = key.trim();
    if (!trimmed) return;
    setPhase('saving');
    setError(null);
    try {
      const res = await fetch('/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: trimmed }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        setPhase('done');
        // 잠시 성공 화면을 보여준 뒤 홈으로.
        setTimeout(() => router.replace('/'), 1200);
      } else {
        setError(data.error ?? '저장에 실패했습니다.');
        setPhase('form');
      }
    } catch {
      setError('요청 중 오류가 발생했습니다.');
      setPhase('form');
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-16">
      <div className="w-full max-w-lg space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-bold">Steam Review Feed 설정</h1>
          <p className="text-gray-500 dark:text-gray-400 text-sm">
            처음 한 번만 Steam API 키를 등록하면 됩니다.
          </p>
        </div>

        {phase === 'checking' && (
          <div className="flex justify-center py-8">
            <div className="w-5 h-5 border-2 border-[#1b6fa8] dark:border-[#66c0f4] border-t-transparent rounded-full animate-spin" />
          </div>
        )}

        {phase === 'already' && (
          <div className="bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-6 space-y-4 text-center">
            <p className="text-sm text-gray-600 dark:text-gray-300">
              이미 설정이 완료되어 있습니다.
            </p>
            <button
              type="button"
              onClick={() => router.replace('/')}
              className="px-4 py-2 bg-[#1b6fa8] dark:bg-[#1b2838] border border-[#1b6fa8] dark:border-[#4c6b8a] text-white text-sm rounded-lg hover:bg-[#155a8a] dark:hover:bg-[#2a475e] transition-colors"
            >
              시작하기
            </button>
            <p className="text-xs text-gray-400 dark:text-gray-600">
              키를 바꾸려면 프로젝트 폴더의 <code>.env.local</code> 파일을 직접 편집하세요.
            </p>
          </div>
        )}

        {phase === 'done' && (
          <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-xl p-6 text-center space-y-2">
            <p className="text-sm text-green-700 dark:text-green-400 font-medium">
              설정 완료! 잠시 후 홈으로 이동합니다…
            </p>
          </div>
        )}

        {(phase === 'form' || phase === 'saving') && (
          <form
            onSubmit={handleSubmit}
            className="bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-6 space-y-4"
          >
            <div className="space-y-2 text-sm text-gray-600 dark:text-gray-300">
              <p className="font-medium">Steam API 키 발급 방법</p>
              <ol className="list-decimal list-inside space-y-1 text-gray-500 dark:text-gray-400">
                <li>
                  <a
                    href="https://steamcommunity.com/dev/apikey"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[#1b6fa8] dark:text-[#66c0f4] underline"
                  >
                    steamcommunity.com/dev/apikey
                  </a>{' '}
                  접속 (Steam 로그인 필요)
                </li>
                <li>도메인 이름에 아무 값(예: <code>localhost</code>) 입력 후 동의·등록</li>
                <li>표시된 32자리 키를 복사해 아래에 붙여넣기</li>
              </ol>
            </div>

            <div>
              <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">
                Steam Web API Key (32자리 16진수)
              </label>
              <input
                type="text"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="예: 1A2B3C4D5E6F7890ABCDEF1234567890"
                autoComplete="off"
                spellCheck={false}
                className="w-full px-3 py-2 font-mono bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-lg text-sm placeholder-gray-400 dark:placeholder-gray-600 focus:outline-none focus:border-[#1b6fa8] dark:focus:border-[#66c0f4] transition-colors"
              />
              {error && (
                <p className="text-red-500 dark:text-red-400 text-xs mt-1">{error}</p>
              )}
            </div>

            <button
              type="submit"
              disabled={phase === 'saving' || !key.trim()}
              className="w-full px-4 py-2 bg-[#1b6fa8] dark:bg-[#1b2838] border border-[#1b6fa8] dark:border-[#4c6b8a] text-white text-sm rounded-lg hover:bg-[#155a8a] dark:hover:bg-[#2a475e] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {phase === 'saving' ? '검증 중…' : '저장하고 시작하기'}
            </button>
            <p className="text-xs text-gray-400 dark:text-gray-600">
              입력한 키는 이 컴퓨터의 <code>.env.local</code> 파일에만 저장되며, 외부로
              전송되지 않습니다(검증을 위한 Steam 공식 API 호출 제외).
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
