'use client';

/**
 * 성향 분석 + 추천 페이지.
 *
 * 작업 지시서 3.4절 구현. EventSource로 /api/recommend SSE 연결.
 *
 * UI 분기 (3.4.5 매핑 표):
 *   - analysisInsufficient=true        → 분석 신호 부족 안내 (상단 단독)
 *   - wishlistFetchFailed=true         → 트랙 B 자리에 위시리스트 조회 실패 안내
 *   - wishlistGames=0                  → 트랙 B 자리에 위시리스트 비어있음 안내
 *   - libraryUnplayed=[] (분석 정상)   → 트랙 A 자리에 임계값 조정 권유
 *   - wishlist=[] (분석 정상)          → 트랙 B 자리에 매칭 없음 안내
 *
 * 옵션 변경 시 500ms debounce 후 SSE 재시작.
 */

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import ThemeToggle from '@/components/ThemeToggle';
import ProgressBar from '@/components/ProgressBar';
import AppNav from '@/components/AppNav';
import AppFooter from '@/components/AppFooter';
import { DEFAULT_ANALYZE_OPTIONS, type AnalyzeOptions, type TasteProfile, type Recommendation, type ReviewBadge } from '@/lib/steam/profile';

// UI default = lib default + 사용자 친화적 override.
// lib의 DEFAULT_ANALYZE_OPTIONS를 그대로 import해 미래 옵션 필드 추가/기본값
// 변경이 자동 반영되도록 한다. UI에서 다르게 시작할 필드만 명시적으로 override.
const DEFAULT_OPTIONS: AnalyzeOptions = {
  ...DEFAULT_ANALYZE_OPTIONS,
  // 무료 게임은 대부분 free-to-play 형태로 대량 진입했다가 안 하는 경우가 많아
  // 추천 노이즈가 크다. 사용자 시그널: UI 진입 시 기본 체크.
  excludeFree: true,
};

interface ProgressData { phase: string; loaded: number; total: number; }
interface ResultData { profile: TasteProfile; libraryUnplayed: Recommendation[]; wishlist: Recommendation[]; }
interface PartialResultData extends ResultData { loaded: number; total: number; }
interface CachedData extends ResultData {
  ownedGames: number;
  wishlistGames: number;
  wishlistFetchFailed: boolean;
  /** 캐시가 마지막으로 저장된 시각 (Unix ms) */
  computedAt: number;
}
interface DoneData {
  ownedGames: number;
  wishlistGames: number;
  cacheHitRate: number;
  wishlistFetchFailed: boolean;
  analysisInsufficient: boolean;
  metaMissingDominant?: boolean;
  libraryFetchFailed?: boolean;
}

function buildUrl(opts: AnalyzeOptions): string {
  const params = new URLSearchParams({
    cardMin: String(opts.cardFarmingMaxMinutes),
    unplayedMax: String(opts.unplayedMaxMinutes),
    excludeFree: String(opts.excludeFree),
    topN: String(opts.topNTaste),
    max: String(opts.maxRecommendationsPerTrack),
    fast: String(opts.fastMode),
    tracks: 'lib,wish',
  });
  return `/api/recommend?${params.toString()}`;
}

export default function RecommendPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-5 h-5 border-2 border-[#1b6fa8] dark:border-[#66c0f4] border-t-transparent rounded-full animate-spin" />
      </div>
    }>
      <RecommendContent />
    </Suspense>
  );
}

function RecommendContent() {
  const router = useRouter();
  const [options, setOptions] = useState<AnalyzeOptions>(DEFAULT_OPTIONS);
  const [progress, setProgress] = useState<ProgressData | null>(null);
  const [result, setResult] = useState<ResultData | null>(null);
  // 분석이 아직 진행 중이고 result가 partial-result에서 온 잠정 결과일 때 true.
  // 최종 'result' 이벤트가 도착하면 false로 전환. 옵션 변경/재분석 시 다시 true.
  const [isProvisional, setIsProvisional] = useState(false);
  // 캐시 hit으로 표시되는 동안 캐시 timestamp. 새 분석의 partial-result 또는
  // result가 도착하면 null로 해제.
  const [cachedAt, setCachedAt] = useState<number | null>(null);
  const [doneData, setDoneData] = useState<DoneData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [steamId, setSteamId] = useState<string | null>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);

  const esRef = useRef<EventSource | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 인증 확인 — 비로그인 시 홈 리다이렉트
  useEffect(() => {
    fetch('/api/auth/me')
      .then((res) => res.json())
      .then((data) => {
        if (!data.steamId) {
          router.replace('/');
          return;
        }
        setSteamId(data.steamId);
        setDisplayName(data.displayName);
        setAvatarUrl(data.avatarUrl);
      })
      .catch(() => router.replace('/'));
  }, [router]);

  // SSE 시작 (debounce)
  const startAnalysis = useCallback((opts: AnalyzeOptions) => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
    setProgress(null);
    setResult(null);
    setIsProvisional(false);
    setCachedAt(null);
    setDoneData(null);
    setError(null);
    setLoading(true);

    const es = new EventSource(buildUrl(opts));
    esRef.current = es;

    es.addEventListener('progress', (e: MessageEvent) => {
      try { setProgress(JSON.parse(e.data)); } catch { /* ignore */ }
    });
    // 캐시 hit — 분석이 시작되기 전에 가장 먼저 들어온다. 이전에 같은 옵션으로
    // 저장한 결과를 즉시 표시하고, 백그라운드의 새 분석이 partial/final로
    // 갱신할 때 cachedAt을 해제하여 배지를 바꾼다.
    es.addEventListener('cached', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as CachedData;
        setResult({
          profile: data.profile,
          libraryUnplayed: data.libraryUnplayed,
          wishlist: data.wishlist,
        });
        // doneData를 함께 채워 ResultView가 doneData 분기를 통과하도록 한다.
        // 계약 (producer = lib/recommend route의 tryWriteCache 헬퍼):
        //   - cache는 profile.analyzedGames > 0 AND (genres ∪ categories ≠ ∅)
        //     일 때만 저장됨. 따라서 cached event 수신 시 analysisInsufficient
        //     도 metaMissingDominant도 false로 단정 가능.
        //   - wishlistFetchFailed=true인 분석은 cache에 저장되지 않음. cached
        //     수신 시 wishlistFetchFailed는 payload의 false 값을 그대로 사용.
        // 이 계약이 깨지면 cached event로 빈 taste card가 표시될 수 있으므로
        // route측 가드 변경 시 이 핸들러도 함께 검토 필요.
        setDoneData({
          ownedGames: data.ownedGames,
          wishlistGames: data.wishlistGames,
          cacheHitRate: 0,
          wishlistFetchFailed: data.wishlistFetchFailed,
          analysisInsufficient: false,
          metaMissingDominant: false,
          libraryFetchFailed: false,
        });
        setCachedAt(data.computedAt);
      } catch { /* ignore */ }
    });
    // 잠정 결과: fetch가 진행되는 동안 ~3초 간격으로 들어온다.
    // 같은 ResultData 모양에 loaded/total이 추가되어 있지만 UI는 동일하게 사용.
    es.addEventListener('partial-result', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as PartialResultData;
        setResult({
          profile: data.profile,
          libraryUnplayed: data.libraryUnplayed,
          wishlist: data.wishlist,
        });
        setIsProvisional(true);
        // 새 분석의 첫 partial이 도착하면 캐시 표시는 의미를 잃는다.
        setCachedAt(null);
      } catch { /* ignore */ }
    });
    es.addEventListener('result', (e: MessageEvent) => {
      try {
        setResult(JSON.parse(e.data));
        setIsProvisional(false);
        setCachedAt(null);
      } catch { /* ignore */ }
    });
    es.addEventListener('done', (e: MessageEvent) => {
      try { setDoneData(JSON.parse(e.data)); } catch { /* ignore */ }
      setLoading(false);
      es.close();
      esRef.current = null;
    });
    es.addEventListener('error', (e: MessageEvent) => {
      // EventSource는 연결 종료 시에도 error를 발생시키므로,
      // result/done을 받았으면 정상 종료로 본다.
      if (!esRef.current) return;
      // 서버가 named error 이벤트로 message payload를 emit한 경우 우선 사용.
      // 연결 종료에 의한 native error event는 e.data가 빈 문자열이라 try/catch가
      // throw 또는 빈 JSON으로 떨어지므로 hardcoded fallback으로 안전.
      let message = '분석 중 오류가 발생했습니다.';
      try {
        const data = JSON.parse(e.data) as { message?: string };
        if (data && typeof data.message === 'string') message = data.message;
      } catch { /* native error event without data — fallback OK */ }
      setError(message);
      setLoading(false);
      // 에러 직전에 cached 이벤트로 cachedAt이 set돼 있으면 "백그라운드 분석 중"
      // 배너와 에러 배너가 동시에 표시되어 모순 UX가 된다. 에러 발생 시 캐시
      // 배지를 함께 해제해 사용자 메시지가 일관되게.
      setCachedAt(null);
      // isProvisional도 동일 이유로 해제 — 잠정 → 에러로 명확히 전환.
      setIsProvisional(false);
      es.close();
      esRef.current = null;
    });
  }, []);

  // 첫 로드: 인증 확인 후 자동 시작
  useEffect(() => {
    if (steamId) startAnalysis(options);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [steamId]);

  // 옵션 변경 → debounce → 재시작
  const handleOptionsChange = useCallback((next: AnalyzeOptions) => {
    setOptions(next);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => startAnalysis(next), 500);
  }, [startAnalysis]);

  // 언마운트 시 정리
  useEffect(() => () => {
    if (esRef.current) esRef.current.close();
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, []);

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
      router.push('/');
    } catch {
      setLoggingOut(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header (3.6 — feed page 패턴 차용) */}
      <header className="sticky top-0 z-40 bg-white/95 dark:bg-gray-900/95 backdrop-blur border-b border-gray-200 dark:border-gray-800 px-4 py-3">
        <div className="max-w-5xl mx-auto flex items-center justify-between gap-4 flex-wrap">
          <Link href="/" className="text-[#1b6fa8] dark:text-[#66c0f4] font-bold text-base shrink-0">
            Steam Review Feed
          </Link>
          <AppNav current="recommend" />
          <div className="flex items-center gap-3">
            {steamId && (
              <a
                href={`https://steamcommunity.com/profiles/${steamId}`}
                target="_blank"
                rel="noopener noreferrer"
                className="hidden sm:flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400 hover:text-[#1b6fa8] dark:hover:text-[#66c0f4] transition-colors"
                title={steamId}
              >
                {avatarUrl && (
                  <img src={avatarUrl} alt="" className="w-6 h-6 rounded-full" />
                )}
                <span className="truncate max-w-[120px]">{displayName || steamId}</span>
              </a>
            )}
            <ThemeToggle />
            <button
              type="button"
              onClick={handleLogout}
              disabled={loggingOut}
              className="px-3 py-1.5 text-sm text-gray-500 dark:text-gray-400 border border-gray-300 dark:border-gray-700 rounded-lg hover:text-gray-700 dark:hover:text-gray-200 hover:border-gray-400 dark:hover:border-gray-600 transition-colors disabled:opacity-50"
            >
              {loggingOut ? '...' : '로그아웃'}
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-5xl mx-auto w-full px-4 py-6 space-y-6">
        <OptionsPanel options={options} onChange={handleOptionsChange} />

        {/* 진행률 */}
        {loading && progress && (
          <div className="space-y-2">
            <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400">
              <span>{phaseLabel(progress.phase)}</span>
              <span>{progress.loaded} / {progress.total}</span>
            </div>
            <ProgressBar loaded={progress.loaded} total={progress.total} />
          </div>
        )}

        {/* 첫 분석 안내 */}
        {loading && !result && (
          <div className="text-sm text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-800/50 rounded-lg p-4 space-y-1">
            <p>라이브러리 크기에 따라 처음 분석은 수 분이 걸릴 수 있습니다. 일주일 이내 재방문 시 즉시 결과가 나옵니다.</p>
            <p className="text-xs">
              라이브러리가 5,000개 이상이면 Steam의 비공식 API Rate Limit에 걸려 첫 분석이 실패하거나 매우 오래 걸릴 수 있습니다.
            </p>
          </div>
        )}

        {error && (
          <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded-lg p-4">
            {error}
          </div>
        )}

        {/* 라이브러리 조회 실패 안내.
            cached event로 이전 결과(result)가 이미 표시된 상태에서 새 분석의
            라이브러리 fetch가 실패해도 사용자에게 그 사실을 알려야 한다.
            과거 가드는 `!result && ...`로 cached 결과가 있으면 안내를 숨겼는데,
            결과로 사용자가 stale 카드를 새 분석 결과로 오해하는 UX 회귀가 있었다.
            이제 libraryFetchFailed가 set되면 result 유무와 무관하게 항상 표시. */}
        {doneData?.libraryFetchFailed && (
          <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded-lg p-4">
            라이브러리를 불러오지 못했습니다. {result ? '아래는 이전 분석 결과입니다.' : '다시 시도해 주세요.'}
          </div>
        )}

        {/* 결과 표시 — 3.4.5 분기.
            잠정 결과(partial-result)는 doneData가 아직 없으므로 기본 분기로 렌더.
            doneData가 있는 경우(최종)에만 analysisInsufficient/metaMissingDominant 분기.
            캐시 hit인 경우 cached 이벤트에서 placeholder doneData가 채워져 있다.
            libraryFetchFailed가 true여도 cached result는 그대로 보여준다 — 사용자가
            오프라인/일시적 오류 상황에서 이전 결과로 의사결정을 계속할 수 있도록. */}
        {result && (
          <ResultView
            result={result}
            doneData={doneData}
            options={options}
            isProvisional={isProvisional}
            cachedAt={cachedAt}
          />
        )}
      </main>
      <AppFooter />
    </div>
  );
}

function phaseLabel(phase: string): string {
  switch (phase) {
    case 'fetching-meta':    return '게임 메타 정보 수집 중';
    case 'fetching-reviews': return '리뷰 평가 수집 중';
    case 'analyzing':        return '성향 분석 중';
    default:                 return phase;
  }
}

// ============================================================================
// 옵션 패널
// ============================================================================

function OptionsPanel({ options, onChange }: { options: AnalyzeOptions; onChange: (o: AnalyzeOptions) => void; }) {
  // 슬라이더 변경 시 unplayedMax ≤ cardFarmingMax 자동 클램프
  function setCard(v: number) {
    const u = Math.min(options.unplayedMaxMinutes, v);
    onChange({ ...options, cardFarmingMaxMinutes: v, unplayedMaxMinutes: u });
  }
  function setUnplayed(v: number) {
    const clamped = Math.min(v, options.cardFarmingMaxMinutes);
    onChange({ ...options, unplayedMaxMinutes: clamped });
  }

  return (
    <section className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4 space-y-4">
      <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">분석 옵션</h2>
      <div className="grid sm:grid-cols-2 gap-4">
        <SliderRow
          label="카드 농사 임계값 (분)"
          hint="이 시간 미만 플레이한 게임은 카드 농사로 간주하여 분석에서 제외합니다."
          min={0} max={1440} step={10}
          value={options.cardFarmingMaxMinutes}
          onChange={setCard}
        />
        <SliderRow
          label="미플레이 임계값 (분)"
          hint="이 시간 이하 플레이한 게임을 추천 후보로 봅니다. 카드 농사 임계값을 넘지 않도록 자동 조정됩니다."
          min={0} max={600} step={5}
          value={options.unplayedMaxMinutes}
          onChange={setUnplayed}
        />
      </div>
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={options.excludeFree}
            onChange={(e) => onChange({ ...options, excludeFree: e.target.checked })}
            className="w-4 h-4"
          />
          <span className="text-gray-700 dark:text-gray-200">무료 게임 제외</span>
        </label>
        <label className="flex items-center gap-2 cursor-pointer" title="대형 라이브러리 첫 분석을 몇 분 내로 줄입니다. 상한 밖 게임은 추천에서 빠질 수 있습니다(캐시 후에는 무관).">
          <input
            type="checkbox"
            checked={options.fastMode}
            onChange={(e) => onChange({ ...options, fastMode: e.target.checked })}
            className="w-4 h-4"
          />
          <span className="text-gray-700 dark:text-gray-200">빠른 모드</span>
        </label>
        <label className="flex items-center gap-2">
          <span className="text-gray-600 dark:text-gray-300">트랙별 추천 개수</span>
          <select
            value={options.maxRecommendationsPerTrack}
            onChange={(e) => onChange({ ...options, maxRecommendationsPerTrack: parseInt(e.target.value, 10) })}
            className="px-2 py-1 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded text-sm"
          >
            {[6, 12, 18, 24, 30].map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      </div>
    </section>
  );
}

function SliderRow({
  label, hint, min, max, step, value, onChange,
}: {
  label: string; hint: string; min: number; max: number; step: number;
  value: number; onChange: (v: number) => void;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-sm text-gray-700 dark:text-gray-200">{label}</span>
        <span className="text-sm font-mono text-[#1b6fa8] dark:text-[#66c0f4]">{value}</span>
      </div>
      <input
        type="range"
        min={min} max={max} step={step}
        value={value}
        onChange={(e) => onChange(parseInt(e.target.value, 10))}
        className="w-full accent-[#1b6fa8] dark:accent-[#66c0f4]"
      />
      <p className="text-xs text-gray-500 dark:text-gray-400">{hint}</p>
    </div>
  );
}

// ============================================================================
// 결과 표시 — 3.4.5 분기
// ============================================================================

function ResultView({
  result, doneData, options, isProvisional, cachedAt,
}: {
  result: ResultData; doneData: DoneData | null; options: AnalyzeOptions;
  isProvisional: boolean; cachedAt: number | null;
}) {
  // analysisInsufficient/metaMissingDominant 분기는 최종(doneData 도착) 시에만.
  // 잠정 단계에서는 profile.analyzedGames가 일시적으로 0이거나 메타 누락이 많을
  // 수 있는데, fetch가 진행되면 채워지므로 단정적인 안내를 띄우지 않는다.
  if (doneData?.analysisInsufficient) {
    return (
      <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg p-6 text-center space-y-2">
        <h2 className="text-base font-semibold text-amber-900 dark:text-amber-200">분석 신호가 부족합니다</h2>
        <p className="text-sm text-amber-800 dark:text-amber-300">
          성향 분석에 사용할 충분한 플레이 이력이 없습니다.
          {' '}카드 농사 임계값을 낮추거나 더 플레이 후 재방문해 주세요.
        </p>
        <p className="text-xs text-amber-700 dark:text-amber-400">
          라이브러리 {doneData.ownedGames}개 중 분석 가능한 게임: {result.profile.analyzedGames}개
        </p>
      </div>
    );
  }

  if (doneData?.metaMissingDominant) {
    return (
      <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg p-6 text-center space-y-2">
        <h2 className="text-base font-semibold text-amber-900 dark:text-amber-200">게임 메타 정보가 부족합니다</h2>
        <p className="text-sm text-amber-800 dark:text-amber-300">
          분석에 사용할 게임은 있지만 장르·카테고리 정보를 가져오지 못했습니다.
          {' '}Steam API Rate Limit이 원인일 수 있으니 잠시 후 다시 시도해 주세요.
        </p>
        <p className="text-xs text-amber-700 dark:text-amber-400">
          분석 대상 {result.profile.analyzedGames}개 중 메타 누락 {result.profile.metaMissing}개
        </p>
      </div>
    );
  }

  // 배지 우선순위: 잠정(분석 중) > 캐시 hit (분석 시작 대기/시작 중) > 없음(최종 또는 미상).
  // 잠정/캐시는 동시에 안 켜진다 — partial-result 도착 시 cachedAt을 null로 해제하므로.
  return (
    <>
      {isProvisional ? (
        <ProvisionalBanner />
      ) : cachedAt !== null ? (
        <CachedBanner computedAt={cachedAt} />
      ) : null}
      <TasteCard profile={result.profile} />
      <TrackSection
        title="라이브러리에 있지만 안 해본 게임"
        recs={result.libraryUnplayed}
        isProvisional={isProvisional}
        emptyMessage={`안 한 게임을 찾지 못했습니다. 미플레이 임계값(현재 ${options.unplayedMaxMinutes}분)을 올려보세요.`}
      />
      <WishlistSection
        recs={result.wishlist}
        wishlistGames={doneData?.wishlistGames ?? 0}
        wishlistFetchFailed={doneData?.wishlistFetchFailed ?? false}
        isProvisional={isProvisional}
      />
    </>
  );
}

function ProvisionalBanner() {
  return (
    <div className="flex items-center gap-2 bg-[#1b6fa8]/5 dark:bg-[#66c0f4]/10 border border-[#1b6fa8]/20 dark:border-[#66c0f4]/30 rounded-lg px-3 py-2 text-xs text-[#1b6fa8] dark:text-[#66c0f4]">
      <span className="inline-block w-2 h-2 bg-[#1b6fa8] dark:bg-[#66c0f4] rounded-full animate-pulse" aria-hidden />
      <span>잠정 순위 — 분석 중입니다. 메타 정보가 추가로 도착하면 순위가 갱신됩니다.</span>
    </div>
  );
}

function CachedBanner({ computedAt }: { computedAt: number }) {
  return (
    <div className="flex items-center gap-2 bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-xs text-gray-600 dark:text-gray-300">
      <span className="inline-block w-2 h-2 bg-gray-400 dark:bg-gray-500 rounded-full" aria-hidden />
      <span>
        이전 분석 결과 ({formatRelativeTime(computedAt)}) — 백그라운드에서 새 분석이 진행 중입니다.
      </span>
    </div>
  );
}

/**
 * Unix ms 시각을 "방금", "5분 전", "2시간 전", "어제", "2026-05-25" 등으로 표시.
 * 영어가 아닌 한국어 단위로 표시한다.
 */
function formatRelativeTime(unixMs: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - unixMs) / 1000));
  if (diffSec < 60) return '방금 전';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}분 전`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}시간 전`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}일 전`;
  const d = new Date(unixMs);
  // 7일 이상 지나면 절대 날짜
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ============================================================================
// 성향 카드
// ============================================================================

function TasteCard({ profile }: { profile: TasteProfile }) {
  return (
    <section className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4 space-y-3">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">당신의 성향</h2>
        <span className="text-xs text-gray-500 dark:text-gray-400">
          분석 {profile.analyzedGames} / 카드 농사 {profile.cardFarmingExcluded} / 미플레이 {profile.unplayedCount}
          {profile.metaMissing > 0 ? ` / 메타 누락 ${profile.metaMissing}` : ''}
          {profile.excludedFree > 0 ? ` / 무료 제외 ${profile.excludedFree}` : ''}
        </span>
      </div>
      {profile.genres.length === 0 && profile.categories.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">분석된 성향 신호가 없습니다.</p>
      ) : (
        <>
          {profile.genres.length > 0 && (
            <TasteRow title="장르" entries={profile.genres} />
          )}
          {profile.categories.length > 0 && (
            <TasteRow title="카테고리" entries={profile.categories} />
          )}
        </>
      )}
    </section>
  );
}

function TasteRow({ title, entries }: { title: string; entries: TasteProfile['genres'] }) {
  return (
    <div>
      <div className="text-xs text-gray-500 dark:text-gray-400 mb-1.5">{title}</div>
      <div className="flex flex-wrap gap-2">
        {entries.map((e) => (
          <span
            key={String(e.key)}
            className="inline-flex items-center gap-1 px-2 py-1 bg-[#1b6fa8]/10 dark:bg-[#66c0f4]/15 text-[#1b6fa8] dark:text-[#66c0f4] rounded text-xs"
            title={`weight: ${e.weight.toFixed(2)}`}
          >
            <span className="font-medium">{e.label}</span>
            <span className="opacity-70">{(e.share * 100).toFixed(0)}%</span>
          </span>
        ))}
      </div>
    </div>
  );
}

// ============================================================================
// 트랙 섹션
// ============================================================================

function TrackSection({
  title, recs, emptyMessage, isProvisional,
}: {
  title: string; recs: Recommendation[]; emptyMessage: string; isProvisional: boolean;
}) {
  // 잠정 단계에서 빈 결과는 "최종 없음"이 아니라 "아직 안 채워짐"이므로 다른 메시지.
  const displayedEmpty = isProvisional
    ? '잠정 결과를 기다리는 중입니다. 메타 정보가 더 도착하면 후보가 나타납니다.'
    : emptyMessage;
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">
        {title} {recs.length > 0 ? `(${recs.length})` : ''}
      </h2>
      {recs.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-800/50 rounded-lg p-4">
          {displayedEmpty}
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {recs.map(r => <RecommendCard key={r.appid} rec={r} />)}
        </div>
      )}
    </section>
  );
}

function WishlistSection({
  recs, wishlistGames, wishlistFetchFailed, isProvisional,
}: {
  recs: Recommendation[]; wishlistGames: number; wishlistFetchFailed: boolean; isProvisional: boolean;
}) {
  // 잠정 단계에서는 wishlistGames/wishlistFetchFailed가 아직 확정 아님 → 잠정 메시지 우선.
  let emptyMessage: string;
  if (isProvisional) {
    emptyMessage = '잠정 결과를 기다리는 중입니다. 위시리스트는 라이브러리 메타가 끝난 뒤 채워집니다.';
  } else if (wishlistFetchFailed) {
    emptyMessage = '위시리스트를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.';
  } else if (wishlistGames === 0) {
    emptyMessage = '위시리스트가 비어있습니다.';
  } else {
    emptyMessage = '위시리스트에서 성향과 일치하는 게임을 찾지 못했습니다.';
  }
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">
        위시리스트 중 성향에 맞는 게임 {recs.length > 0 ? `(${recs.length})` : ''}
      </h2>
      {recs.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-800/50 rounded-lg p-4">
          {emptyMessage}
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {recs.map(r => <RecommendCard key={r.appid} rec={r} />)}
        </div>
      )}
    </section>
  );
}

function RecommendCard({ rec }: { rec: Recommendation }) {
  const storeUrl = `https://store.steampowered.com/app/${rec.appid}/`;
  return (
    <a
      href={storeUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="group block bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden hover:border-[#1b6fa8] dark:hover:border-[#66c0f4] hover:shadow-md transition-all"
    >
      {rec.headerImage && (
        <img src={rec.headerImage} alt="" className="w-full aspect-[460/215] object-cover bg-gray-100 dark:bg-gray-900" />
      )}
      <div className="p-3 space-y-2">
        <h3 className="text-sm font-medium text-gray-800 dark:text-gray-100 group-hover:text-[#1b6fa8] dark:group-hover:text-[#66c0f4] line-clamp-2">
          {rec.name}
        </h3>
        <div className="flex flex-wrap gap-1">
          {rec.matchedGenres.slice(0, 3).map(g => (
            <span key={g.id} className="text-xs px-1.5 py-0.5 bg-[#1b6fa8]/10 dark:bg-[#66c0f4]/15 text-[#1b6fa8] dark:text-[#66c0f4] rounded">
              {g.label}
            </span>
          ))}
          {rec.matchedCategories.slice(0, 2).map(c => (
            <span key={c.id} className="text-xs px-1.5 py-0.5 bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 rounded">
              {c.label}
            </span>
          ))}
        </div>
        <div className="flex items-center justify-between gap-2 text-xs text-gray-500 dark:text-gray-400">
          <span>
            {rec.source === 'library-unplayed' && (
              rec.playtimeMinutes === 0
                ? '아직 안 해본 게임'
                : `${rec.playtimeMinutes}분 플레이`
            )}
            {rec.source === 'wishlist' && '위시리스트'}
          </span>
          {rec.reviewBadge && <ReviewBadgeChip badge={rec.reviewBadge} />}
        </div>
      </div>
    </a>
  );
}

/** 저표본 기준: 이 미만이면 호평 %를 단정하지 않고 표본 수만 노출한다. */
const REVIEW_BADGE_MIN_SAMPLE = 10;

/**
 * 호평률 배지 칩.
 *
 * 정직성 원칙:
 *   - 표본이 REVIEW_BADGE_MIN_SAMPLE 미만이면 %가 신뢰할 수 없으므로 중립 회색으로
 *     "리뷰 N개"만 표시(감정 라벨 없음).
 *   - 충분하면 percent에서 한국어 감정 라벨/색상을 파생(Steam desc 언어에 의존하지 않음)
 *     하고 표본 수를 함께 노출해 사용자가 신뢰도를 판단하게 한다.
 */
function ReviewBadgeChip({ badge }: { badge: ReviewBadge }) {
  const count = badge.totalReviews.toLocaleString('ko-KR');
  if (badge.totalReviews < REVIEW_BADGE_MIN_SAMPLE) {
    return (
      <span
        className="shrink-0 px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400"
        title={`리뷰 ${count}개 — 표본이 적어 호평률을 표시하지 않습니다`}
      >
        리뷰 {count}
      </span>
    );
  }
  const { label, className } = reviewBadgeStyle(badge.positivePercent);
  return (
    <span
      className={`shrink-0 px-1.5 py-0.5 rounded font-medium ${className}`}
      title={`${label} · 호평 ${badge.positivePercent}% (리뷰 ${count}개)`}
    >
      {label} {badge.positivePercent}%
    </span>
  );
}

/** 호평 %를 한국어 감정 라벨 + Tailwind 색상 클래스로 매핑 (Steam 등급 구간 근사). */
function reviewBadgeStyle(percent: number): { label: string; className: string } {
  if (percent >= 80) return { label: '매우 긍정적', className: 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300' };
  if (percent >= 70) return { label: '대체로 긍정적', className: 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400' };
  if (percent >= 40) return { label: '복합적', className: 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300' };
  if (percent >= 20) return { label: '대체로 부정적', className: 'bg-orange-100 dark:bg-orange-900/40 text-orange-700 dark:text-orange-300' };
  return { label: '매우 부정적', className: 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300' };
}
