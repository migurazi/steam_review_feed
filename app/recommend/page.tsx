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
import type { AnalyzeOptions, TasteProfile, Recommendation } from '@/lib/steam/profile';

const DEFAULT_OPTIONS: AnalyzeOptions = {
  cardFarmingMaxMinutes: 180,
  unplayedMaxMinutes: 60,
  excludeFree: false,
  topNTaste: 6,
  maxRecommendationsPerTrack: 12,
};

interface ProgressData { phase: string; loaded: number; total: number; }
interface ResultData { profile: TasteProfile; libraryUnplayed: Recommendation[]; wishlist: Recommendation[]; }
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
    setDoneData(null);
    setError(null);
    setLoading(true);

    const es = new EventSource(buildUrl(opts));
    esRef.current = es;

    es.addEventListener('progress', (e: MessageEvent) => {
      try { setProgress(JSON.parse(e.data)); } catch { /* ignore */ }
    });
    es.addEventListener('result', (e: MessageEvent) => {
      try { setResult(JSON.parse(e.data)); } catch { /* ignore */ }
    });
    es.addEventListener('done', (e: MessageEvent) => {
      try { setDoneData(JSON.parse(e.data)); } catch { /* ignore */ }
      setLoading(false);
      es.close();
      esRef.current = null;
    });
    es.addEventListener('error', () => {
      // EventSource는 연결 종료 시에도 error를 발생시키므로,
      // result/done을 받았으면 정상 종료로 본다.
      if (!esRef.current) return;
      setError('분석 중 오류가 발생했습니다.');
      setLoading(false);
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
          <nav className="flex items-center gap-1 text-sm bg-gray-100 dark:bg-gray-800 rounded-lg p-1">
            <Link
              href="/feed"
              className="px-3 py-1.5 rounded text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
            >
              리뷰 피드
            </Link>
            <span
              aria-current="page"
              className="px-3 py-1.5 rounded bg-white dark:bg-[#1b2838] text-[#1b6fa8] dark:text-[#66c0f4] border border-gray-300 dark:border-[#4c6b8a] shadow-sm font-medium"
            >
              성향 분석
            </span>
          </nav>
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

        {/* 라이브러리 조회 실패 (result 없이 done만 도착) */}
        {!result && doneData?.libraryFetchFailed && (
          <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded-lg p-4">
            라이브러리를 불러오지 못했습니다. 다시 시도해 주세요.
          </div>
        )}

        {/* 결과 표시 — 3.4.5 분기 */}
        {result && doneData && !doneData.libraryFetchFailed && (
          <ResultView result={result} doneData={doneData} options={options} />
        )}
      </main>
    </div>
  );
}

function phaseLabel(phase: string): string {
  switch (phase) {
    case 'fetching-meta': return '게임 메타 정보 수집 중';
    case 'analyzing':     return '성향 분석 중';
    default:              return phase;
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

function ResultView({ result, doneData, options }: { result: ResultData; doneData: DoneData; options: AnalyzeOptions; }) {
  // 분석 풀=0 → 단독 안내 (두 트랙 숨김)
  if (doneData.analysisInsufficient) {
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

  // 분석 풀은 있지만 메타가 거의 다 누락된 경우 (R11 Rate Limit 시나리오 등)
  if (doneData.metaMissingDominant) {
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

  return (
    <>
      <TasteCard profile={result.profile} />
      <TrackSection
        title="라이브러리에 있지만 안 해본 게임"
        recs={result.libraryUnplayed}
        emptyMessage={`안 한 게임을 찾지 못했습니다. 미플레이 임계값(현재 ${options.unplayedMaxMinutes}분)을 올려보세요.`}
      />
      <WishlistSection
        recs={result.wishlist}
        wishlistGames={doneData.wishlistGames}
        wishlistFetchFailed={doneData.wishlistFetchFailed}
      />
    </>
  );
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
  title, recs, emptyMessage,
}: {
  title: string; recs: Recommendation[]; emptyMessage: string;
}) {
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">
        {title} {recs.length > 0 ? `(${recs.length})` : ''}
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

function WishlistSection({
  recs, wishlistGames, wishlistFetchFailed,
}: {
  recs: Recommendation[]; wishlistGames: number; wishlistFetchFailed: boolean;
}) {
  let emptyMessage = '';
  if (wishlistFetchFailed) {
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
        <div className="text-xs text-gray-500 dark:text-gray-400">
          {rec.source === 'library-unplayed' && (
            rec.playtimeMinutes === 0
              ? '아직 안 해본 게임'
              : `${rec.playtimeMinutes}분 플레이`
          )}
          {rec.source === 'wishlist' && '위시리스트'}
        </div>
      </div>
    </a>
  );
}
