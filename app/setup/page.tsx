'use client';

/**
 * 최초 설정 페이지 — 비개발자가 브라우저에서 Steam API 키(필수)·ITAD API 키(선택)를 붙여넣으면 끝나도록.
 *
 * 흐름: 상태 확인(GET /api/setup) → 각 키별 섹션(미설정이면 폼, 설정됨이면 배지) → 저장(POST) → 반영.
 *   - Steam 키와 ITAD 키는 독립이다. 한쪽만 입력해 저장할 수 있고, 이미 설정된 키는 재설정이 막힌다(409).
 *   - Steam 키가 설정되면 앱을 쓸 수 있으므로 "시작하기" 버튼을 노출한다. ITAD 키는 번들 차트 메이커의
 *     최신 번들 목록 전용(선택 사항).
 * SESSION_SECRET은 start.bat이 자동 생성하므로 사용자는 신경 쓸 필요가 없다.
 */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

interface SetupStatus {
  configured: boolean;
  itadConfigured: boolean;
}

export default function SetupPage() {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [steamKey, setSteamKey] = useState('');
  const [itadKey, setItadKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const router = useRouter();

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/setup');
      const data = (await res.json()) as SetupStatus;
      setStatus({ configured: !!data.configured, itadConfigured: !!data.itadConfigured });
    } catch {
      // 상태 확인 실패는 치명적이지 않다 — 둘 다 미설정으로 보고 폼을 띄운다.
      setStatus({ configured: false, itadConfigured: false });
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const steam = steamKey.trim();
    const itad = itadKey.trim();
    if (!steam && !itad) return;

    setSaving(true);
    setError(null);
    setSavedMessage(null);
    try {
      const body: { key?: string; itadKey?: string } = {};
      if (steam) body.key = steam;
      if (itad) body.itadKey = itad;
      const res = await fetch('/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        setSteamKey('');
        setItadKey('');
        setSavedMessage('저장되었습니다.');
        await refresh();
        // Steam 키를 방금 처음 등록했으면 잠시 후 홈으로.
        if (steam) setTimeout(() => router.replace('/'), 1200);
      } else {
        setError(data.error ?? '저장에 실패했습니다.');
      }
    } catch {
      setError('요청 중 오류가 발생했습니다.');
    } finally {
      setSaving(false);
    }
  }

  const steamConfigured = status?.configured ?? false;
  const itadAlreadyConfigured = status?.itadConfigured ?? false;
  const canSubmit =
    (!steamConfigured && steamKey.trim().length > 0) ||
    (!itadAlreadyConfigured && itadKey.trim().length > 0);

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-16">
      <div className="w-full max-w-lg space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-bold">Steam Review Feed 설정</h1>
          <p className="text-gray-500 dark:text-gray-400 text-sm">
            Steam API 키를 한 번만 등록하면 됩니다. ITAD 키는 번들 차트의 최신 번들 목록용(선택).
          </p>
        </div>

        {status === null ? (
          <div className="flex justify-center py-8">
            <div className="w-5 h-5 border-2 border-[#1b6fa8] dark:border-[#66c0f4] border-t-transparent rounded-full animate-spin" />
          </div>
        ) : (
          <form
            onSubmit={handleSubmit}
            className="bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-6 space-y-6"
          >
            {/* Steam 키 (필수) */}
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">
                  Steam Web API 키 <span className="text-red-500">(필수)</span>
                </h2>
                {steamConfigured && (
                  <span className="text-xs px-2 py-0.5 rounded bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300 font-medium">
                    설정됨
                  </span>
                )}
              </div>

              {steamConfigured ? (
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  이미 등록되어 있습니다. 키를 바꾸려면 프로젝트 폴더의 <code>.env.local</code> 파일을 직접
                  편집하세요.
                </p>
              ) : (
                <>
                  <div className="space-y-2 text-sm text-gray-600 dark:text-gray-300">
                    <p className="font-medium">발급 방법</p>
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
                      <li>
                        도메인 이름에 아무 값(예: <code>localhost</code>) 입력 후 동의·등록
                      </li>
                      <li>표시된 32자리 키를 복사해 아래에 붙여넣기</li>
                    </ol>
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1" htmlFor="steam-key">
                      Steam Web API Key (32자리 16진수)
                    </label>
                    <input
                      id="steam-key"
                      type="text"
                      value={steamKey}
                      onChange={(e) => setSteamKey(e.target.value)}
                      placeholder="예: 1A2B3C4D5E6F7890ABCDEF1234567890"
                      autoComplete="off"
                      spellCheck={false}
                      className="w-full px-3 py-2 font-mono bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-lg text-sm placeholder-gray-400 dark:placeholder-gray-600 focus:outline-none focus:border-[#1b6fa8] dark:focus:border-[#66c0f4] transition-colors"
                    />
                  </div>
                </>
              )}
            </div>

            <div className="border-t border-gray-200 dark:border-gray-700" />

            {/* ITAD 키 (선택) */}
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">
                  ITAD API 키 <span className="text-gray-400 dark:text-gray-500">(선택)</span>
                </h2>
                {itadAlreadyConfigured && (
                  <span className="text-xs px-2 py-0.5 rounded bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300 font-medium">
                    설정됨
                  </span>
                )}
              </div>

              {itadAlreadyConfigured ? (
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  이미 등록되어 있습니다. 키를 바꾸려면 <code>.env.local</code> 파일을 직접 편집하세요.
                </p>
              ) : (
                <>
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    번들 차트 메이커에서 최신 번들 목록을 불러오려면 필요합니다. 없어도 게임을 직접 붙여넣거나
                    검색해 차트를 만들 수 있습니다.
                  </p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    <a
                      href="https://isthereanydeal.com/apps/my/"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[#1b6fa8] dark:text-[#66c0f4] underline"
                    >
                      isthereanydeal.com/apps/my/
                    </a>{' '}
                    에서 앱을 등록하고 키를 발급받으세요 (무료).
                  </p>
                  <div>
                    <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1" htmlFor="itad-key">
                      ITAD API Key
                    </label>
                    <input
                      id="itad-key"
                      type="text"
                      value={itadKey}
                      onChange={(e) => setItadKey(e.target.value)}
                      placeholder="IsThereAnyDeal API 키"
                      autoComplete="off"
                      spellCheck={false}
                      className="w-full px-3 py-2 font-mono bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-lg text-sm placeholder-gray-400 dark:placeholder-gray-600 focus:outline-none focus:border-[#1b6fa8] dark:focus:border-[#66c0f4] transition-colors"
                    />
                  </div>
                </>
              )}
            </div>

            {error && <p className="text-red-500 dark:text-red-400 text-xs whitespace-pre-line">{error}</p>}
            {savedMessage && <p className="text-green-600 dark:text-green-400 text-xs">{savedMessage}</p>}

            <div className="flex flex-col sm:flex-row gap-3">
              {!(steamConfigured && itadAlreadyConfigured) && (
                <button
                  type="submit"
                  disabled={saving || !canSubmit}
                  className="flex-1 px-4 py-2 bg-[#1b6fa8] dark:bg-[#1b2838] border border-[#1b6fa8] dark:border-[#4c6b8a] text-white text-sm rounded-lg hover:bg-[#155a8a] dark:hover:bg-[#2a475e] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {saving ? '검증 중…' : '저장'}
                </button>
              )}
              {steamConfigured && (
                <button
                  type="button"
                  onClick={() => router.replace('/')}
                  className="flex-1 px-4 py-2 bg-[#1b6fa8] dark:bg-[#1b2838] border border-[#1b6fa8] dark:border-[#4c6b8a] text-white text-sm rounded-lg hover:bg-[#155a8a] dark:hover:bg-[#2a475e] transition-colors"
                >
                  시작하기
                </button>
              )}
            </div>

            <p className="text-xs text-gray-400 dark:text-gray-600">
              입력한 키는 이 컴퓨터의 <code>.env.local</code> 파일에만 저장되며, 외부로 전송되지 않습니다(검증을
              위한 공식 API 호출 제외).
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
