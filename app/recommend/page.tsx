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
 * 옵션 변경:
 *   - 가성비·할인만·추천 개수: 서버 재요청 없이 재정렬 풀(lib/recommend-rerank.ts)로 즉시 다시 계산.
 *     새로 블렌딩 대상이 된 후보의 리뷰 요약만 /api/recommend/reviews로 받아 한 번 더 계산한다.
 *   - 할인 발굴 끄기: 섹션만 숨긴다. 켜기는 이번 분석에 발굴이 없었으면 재분석.
 *   - 그 외(임계값·무료 제외·빠른 모드): 성향 자체가 바뀌므로 500ms debounce 후 SSE 재시작.
 */

import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import ThemeToggle from '@/components/ThemeToggle';
import ProgressBar from '@/components/ProgressBar';
import AppNav from '@/components/AppNav';
import AppFooter from '@/components/AppFooter';
import GamePrice from '@/components/GamePrice';
import {
  DEFAULT_ANALYZE_OPTIONS,
  REVIEW_BADGE_MIN_SAMPLE,
  type AnalyzeOptions,
  type TasteProfile,
  type Recommendation,
  type ReviewBadge,
} from '@/lib/steam/profile';
import { isPriceStale, formatRelativeTime, formatPriceAge } from '@/lib/price-display';
import {
  rerankFromPool,
  RERANK_OPTION_KEYS,
  shouldKeepPreviousWishlist,
  withPreviousWishlist,
  type RerankPool,
} from '@/lib/recommend-rerank';
import type { ReviewSummary } from '@/lib/steam/types';

/**
 * 페이지 옵션 = 분석 옵션 + 트랙 선택.
 * discoverDeals는 AnalyzeOptions가 아니라 요청 tracks(deal)로 보낸다 — 서버 캐시 키에서
 * tracks는 별도 차원이고, 순수 분석 함수는 이 값을 쓰지 않기 때문 (작업 지시서 20261010_01 §2-5).
 */
interface PageOptions extends AnalyzeOptions {
  /** 미보유 할인 게임 발굴 트랙 (opt-in). 첫 실행 1–2분 추가. */
  discoverDeals: boolean;
}

// UI default = lib default + 사용자 친화적 override.
// lib의 DEFAULT_ANALYZE_OPTIONS를 그대로 import해 미래 옵션 필드 추가/기본값
// 변경이 자동 반영되도록 한다. UI에서 다르게 시작할 필드만 명시적으로 override.
const DEFAULT_OPTIONS: PageOptions = {
  ...DEFAULT_ANALYZE_OPTIONS,
  // 무료 게임은 대부분 free-to-play 형태로 대량 진입했다가 안 하는 경우가 많아
  // 추천 노이즈가 크다. 사용자 시그널: UI 진입 시 기본 체크.
  excludeFree: true,
  discoverDeals: false,
};

interface ProgressData { phase: string; loaded: number; total: number; }
/**
 * wishlist=null: saleOnly 분석의 가격 확인 전 단계. 확정할 수 없으므로 "가격 확인 중"
 * 플레이스홀더를 그린다 (작업 지시서 20261010_01 §1-4 partial-result).
 * storeDeals: 발굴 트랙 결과. undefined = 아직 없음(발굴 미요청·진행 중·이전 결과 없음).
 */
interface ResultData {
  profile: TasteProfile;
  libraryUnplayed: Recommendation[];
  wishlist: Recommendation[] | null;
  storeDeals?: Recommendation[];
}
interface PartialResultData extends ResultData { loaded: number; total: number; pool?: RerankPool; }
interface FinalResultData extends ResultData { pool?: RerankPool; priceFetchFailed?: boolean; }
interface CachedData extends Omit<ResultData, 'wishlist'> {
  wishlist: Recommendation[];
  ownedGames: number;
  wishlistGames: number;
  wishlistFetchFailed: boolean;
  /** 재정렬 풀. 구 캐시 row에는 없다. */
  pool?: RerankPool;
  priceFetchFailed?: boolean;
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
  /** 위시 가격 커버리지 부족 — "할인 게임 없음" 대신 가격 실패 안내를 띄운다. */
  priceFetchFailed?: boolean;
  /** 발굴 트랙 후보 수집 실패 — "할인 게임 없음" 대신 실패 안내. */
  storeDealsFailed?: boolean;
  /** 발굴 트랙 시간 예산 초과 — 일부 후보만 확인했음을 알린다. */
  storeDealsTruncated?: boolean;
}

/**
 * partial-result는 가격 조회 전(match-only)이라 price가 없다. 이전 state(캐시 결과 등)에
 * 같은 appid의 가격이 있으면 이어 붙여, 메타 수집 단계 동안 가격이 사라지지 않게 한다.
 * 묵은 가격은 priceFetchedAt 기준으로 카드에서 회색 처리된다.
 */
function carryPrices(next: Recommendation[], prev: Recommendation[] | null): Recommendation[] {
  if (!prev || prev.length === 0) return next;
  const byId = new Map(prev.map(r => [r.appid, r]));
  return next.map(r => {
    if (r.price !== undefined) return r;
    const old = byId.get(r.appid);
    return old && old.price !== undefined
      ? { ...r, price: old.price, priceFetchedAt: old.priceFetchedAt }
      : r;
  });
}

/** 서버 재분석이 필요한 옵션 변경인지. 재정렬 옵션·발굴 끄기는 클라이언트에서 처리한다. */
function needsServerRun(next: PageOptions, analyzed: PageOptions): boolean {
  const rerankKeys = new Set<string>(RERANK_OPTION_KEYS);
  for (const k of Object.keys(next) as (keyof PageOptions)[]) {
    if (rerankKeys.has(k) || k === 'discoverDeals') continue;
    if (next[k] !== analyzed[k]) return true;
  }
  // 발굴은 켤 때만 서버가 필요하다(이번 분석에 발굴 결과가 없으므로). 끄기는 섹션만 숨긴다.
  return next.discoverDeals && !analyzed.discoverDeals;
}

/**
 * partial-result의 풀을 이전 풀과 합친다.
 *   - 리뷰는 누적 (이전 분석·캐시에서 받은 것도 재사용).
 *   - 새 풀이 위시 가격 전(wishPricesReady=false)인데 이전 풀은 가격이 있으면, 이전 위시 풀을 유지한다
 *     — 할인만 켬 상태에서 "가격 확인 중"으로 깜빡이지 않게 (기존 partial wishlist=null 처리와 같은 의도).
 *   - 그 밖에는 새 풀의 위시에 이전 가격을 이어 붙이되, 1시간(PRICE_STALE_MS) 이내 가격만 붙인다.
 *     풀의 가격은 표시뿐 아니라 할인만 필터·가성비 점수에도 쓰이므로, 며칠 묵은 캐시 가격을 붙이면
 *     끝난 할인이 잠정 순위에 섞인다 (/code-review L1).
 */
function mergePartialPool(prev: RerankPool | null, next: RerankPool): RerankPool {
  if (!prev) return next;
  const reviews = { ...prev.reviews, ...next.reviews };
  // 서버 poolForCache와 같은 규칙 (lib/recommend-rerank.ts).
  if (shouldKeepPreviousWishlist(next, prev)) return withPreviousWishlist({ ...next, reviews }, prev);
  const freshPrev = prev.wishlist.filter(r => r.priceFetchedAt !== undefined && !isPriceStale(r.priceFetchedAt));
  return { ...next, wishlist: carryPrices(next.wishlist, freshPrev), reviews };
}

function buildUrl(opts: PageOptions): string {
  // 트랙은 옵션에서 조립한다. deal은 opt-in일 때만 붙여, 끈 상태의 요청·캐시 해시가
  // 단계 1과 동일하게 유지되도록 한다.
  const tracks = opts.discoverDeals ? 'lib,wish,deal' : 'lib,wish';
  const params = new URLSearchParams({
    cardMin: String(opts.cardFarmingMaxMinutes),
    unplayedMax: String(opts.unplayedMaxMinutes),
    excludeFree: String(opts.excludeFree),
    topN: String(opts.topNTaste),
    max: String(opts.maxRecommendationsPerTrack),
    fast: String(opts.fastMode),
    value: String(opts.valueWeighting),
    saleOnly: String(opts.saleOnly),
    tracks,
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
  const [options, setOptions] = useState<PageOptions>(DEFAULT_OPTIONS);
  // 현재 표시 중인 결과를 만든 분석의 옵션. 옵션 변경 후 debounce(500ms) 동안에는
  // 이전 결과가 그대로 보이므로, 결과 표시 문구는 options가 아니라 이 값을 따른다.
  const [analyzedOptions, setAnalyzedOptions] = useState<PageOptions>(DEFAULT_OPTIONS);
  // 이번 분석의 store-deals 이벤트를 받았는지. 받기 전 result.storeDeals는 캐시(이전 분석)
  // 값이라, 발굴 섹션에 "찾는 중" 표시를 함께 띄우는 근거로 쓴다.
  const [storeDealsFresh, setStoreDealsFresh] = useState(false);
  // 이번 분석 store-deals 이벤트의 상태 플래그. done을 기다리지 않고 이벤트에서 바로 받아,
  // 두 이벤트 사이에 "할인 게임 없음"이 잠깐 보이는 것을 막는다.
  const [storeDealsStatus, setStoreDealsStatus] = useState({ failed: false, truncated: false });
  const [progress, setProgress] = useState<ProgressData | null>(null);
  const [result, setResult] = useState<ResultData | null>(null);
  // 재정렬 풀. 있으면 화면 목록은 풀 + 현재 옵션으로 계산한다(result의 목록은 fallback).
  const [pool, setPool] = useState<RerankPool | null>(null);
  // 위시 가격 커버리지 부족 (result·cached에서). done보다 먼저 알아야 할인만 안내가 맞게 나온다.
  const [priceFetchFailed, setPriceFetchFailed] = useState(false);
  // 분석이 아직 진행 중이고 result가 partial-result에서 온 잠정 결과일 때 true.
  // 최종 'result' 이벤트가 도착하면 false로 전환. 옵션 변경/재분석 시 다시 true.
  const [isProvisional, setIsProvisional] = useState(false);
  // 캐시 hit으로 표시되는 동안 캐시 timestamp. 새 분석의 partial-result 또는
  // result가 도착하면 null로 해제.
  const [cachedAt, setCachedAt] = useState<number | null>(null);
  const [doneData, setDoneData] = useState<DoneData | null>(null);
  const [loading, setLoading] = useState(true);
  // 서버가 라이브러리·위시 리뷰 조회를 끝냈는지 (최종 'result' 수신). 발굴 단계(result 이후, 최대 120초)
  // 동안 loading은 계속 true지만 그 단계는 라이브러리·위시 리뷰를 받지 않으므로, 재정렬용 리뷰 보충은
  // 이 값으로 시작한다 (/code-review 5차 #6).
  const [mainResultReceived, setMainResultReceived] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [steamId, setSteamId] = useState<string | null>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);

  const esRef = useRef<EventSource | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 콜백에서 최신 값을 읽기 위한 ref (handleOptionsChange는 재생성하지 않는다).
  const analyzedOptionsRef = useRef<PageOptions>(DEFAULT_OPTIONS);
  // 재정렬용 리뷰 요약을 이미 요청한 appid (아래 effect). 새 서버 분석 시작 시 비운다.
  const requestedReviewIdsRef = useRef<Set<number>>(new Set());
  const poolRef = useRef<RerankPool | null>(null);
  useEffect(() => { poolRef.current = pool; }, [pool]);

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
  const startAnalysis = useCallback((opts: PageOptions) => {
    setAnalyzedOptions(opts);
    analyzedOptionsRef.current = opts;
    requestedReviewIdsRef.current.clear();
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
    setProgress(null);
    setResult(null);
    setPool(null);
    setPriceFetchFailed(false);
    setStoreDealsFresh(false);
    setStoreDealsStatus({ failed: false, truncated: false });
    setIsProvisional(false);
    setCachedAt(null);
    setDoneData(null);
    setError(null);
    setLoading(true);
    setMainResultReceived(false);

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
          storeDeals: data.storeDeals,
        });
        setPool(data.pool ?? null);
        setPriceFetchFailed(!!data.priceFetchFailed);
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
          priceFetchFailed: !!data.priceFetchFailed,
        });
        setCachedAt(data.computedAt);
      } catch { /* ignore */ }
    });
    // cached의 발굴 목록 교체본: 서버가 현재 라이브러리·위시리스트로 다시 거른 목록.
    // 이번 분석의 결과가 아니므로 storeDealsFresh는 건드리지 않는다.
    es.addEventListener('cached-store-deals', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as { storeDeals: Recommendation[]; poolStoreDeals?: Recommendation[] };
        setResult(prev => (prev ? { ...prev, storeDeals: data.storeDeals } : prev));
        setPool(prev => (prev ? { ...prev, storeDeals: data.poolStoreDeals } : prev));
      } catch { /* ignore */ }
    });
    // 잠정 결과: fetch가 진행되는 동안 ~3초 간격으로 들어온다.
    // 같은 ResultData 모양에 loaded/total이 추가되어 있지만 UI는 동일하게 사용.
    es.addEventListener('partial-result', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as PartialResultData;
        // wishlist=null(saleOnly 가격 확인 전)이면 이전 위시 state(캐시 결과 등)를 유지한다.
        // 이전 state도 없으면 null 그대로 → "가격 확인 중" 플레이스홀더.
        setResult(prev => ({
          profile: data.profile,
          libraryUnplayed: data.libraryUnplayed,
          wishlist: data.wishlist
            ? carryPrices(data.wishlist, prev?.wishlist ?? null)
            : prev?.wishlist ?? null,
          // partial에는 발굴 결과가 없다 — 캐시에서 온 이전 발굴 결과를 유지한다.
          storeDeals: prev?.storeDeals,
        }));
        // 풀: 발굴 풀은 partial에 없으므로 이전 것(캐시)을 유지한다.
        if (data.pool) {
          const nextPool = data.pool;
          setPool(prev => ({ ...mergePartialPool(prev, nextPool), storeDeals: prev?.storeDeals }));
        }
        setIsProvisional(true);
        // 새 분석의 첫 partial이 도착하면 캐시 표시는 의미를 잃는다.
        setCachedAt(null);
      } catch { /* ignore */ }
    });
    es.addEventListener('result', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as FinalResultData;
        // result는 라이브러리·위시 트랙만 담는다. 발굴 결과는 뒤이은 store-deals 이벤트가
        // 채우므로 그 전까지 이전(캐시) 발굴 결과를 유지한다.
        setResult(prev => ({
          profile: data.profile,
          libraryUnplayed: data.libraryUnplayed,
          wishlist: data.wishlist,
          storeDeals: prev?.storeDeals,
        }));
        if (data.pool) {
          const finalPool = data.pool;
          // 리뷰는 누적(이전 풀의 것도 재사용), 발굴 풀은 store-deals 전까지 이전 것 유지.
          setPool(prev => ({
            ...finalPool,
            reviews: { ...(prev?.reviews ?? {}), ...finalPool.reviews },
            storeDeals: prev?.storeDeals,
          }));
        }
        setPriceFetchFailed(!!data.priceFetchFailed);
        setIsProvisional(false);
        setCachedAt(null);
        setMainResultReceived(true);
      } catch { /* ignore */ }
    });
    // 발굴 트랙 확정 (tracks.deal일 때만, result 이후 · done 이전).
    es.addEventListener('store-deals', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as {
          storeDeals: Recommendation[];
          failed?: boolean;
          truncated?: boolean;
          /** failed일 때만: 현재 라이브러리·위시리스트로 다시 거른 이전 발굴 결과. */
          previous?: Recommendation[];
          /** 재정렬용 발굴 shortlist와 그 리뷰 (성공 시). */
          pool?: Recommendation[];
          reviews?: Record<number, ReviewSummary | null>;
          /** failed일 때만: 이전 발굴 풀. */
          previousPool?: Recommendation[];
          previousReviews?: Record<number, ReviewSummary | null>;
        };
        const failed = !!data.failed;
        // 실패면 서버가 다시 거른 이전 결과를 "이전 결과 표시" 안내와 함께 보여준다.
        // (cached로 받은 목록을 그대로 두면 그 사이 구매·위시 추가한 게임이 남는다)
        const next = failed ? data.previous : data.storeDeals;
        setResult(prev => (prev ? { ...prev, storeDeals: next } : prev));
        const nextPoolDeals = failed ? data.previousPool : data.pool;
        const nextReviews = (failed ? data.previousReviews : data.reviews) ?? {};
        setPool(prev => (prev
          ? { ...prev, storeDeals: nextPoolDeals, reviews: { ...prev.reviews, ...nextReviews } }
          : prev));
        setStoreDealsStatus({ failed, truncated: !!data.truncated });
        setStoreDealsFresh(true);
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
  const handleOptionsChange = useCallback((next: PageOptions) => {
    setOptions(next);
    // 재정렬만으로 되는 변경이면 서버를 부르지 않는다 — 화면은 useMemo(displayed)가 즉시 다시 계산.
    // 판단은 항상 "최신 옵션 vs 분석한 옵션"이다. 서버가 필요하면 최신 옵션으로 (다시) 예약한다.
    // 풀이 없으면(구 캐시 결과·오류 등) 재정렬할 근거가 없으므로 서버로 간다. 단 분석이 진행 중이면
    // 곧 풀이 도착하므로 기다린다 — 첫 이벤트 전 토글마다 분석을 처음부터 다시 하지 않도록 (/code-review L2).
    const serverRun = needsServerRun(next, analyzedOptionsRef.current)
      || (poolRef.current === null && esRef.current === null);
    if (!serverRun) {
      // 예약된 재분석이 있으면 취소한다 — 서버 옵션을 바꿨다가 500ms 안에 되돌린 경우 등. 최신 옵션은
      // 분석한 옵션과 서버 관점에서 같으므로 재정렬만으로 충분하다 (/code-review 5차 #4).
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      startAnalysis(next);
    }, 500);
  }, [startAnalysis]);

  // 화면 목록: 풀이 있으면 현재 옵션으로 재정렬, 없으면 서버 목록 그대로.
  const displayed = useMemo<{ result: ResultData; missingReviewIds: number[] } | null>(() => {
    if (!result) return null;
    if (!pool) return { result, missingReviewIds: [] };
    const r = rerankFromPool(pool, options);
    return {
      result: {
        profile: result.profile,
        libraryUnplayed: r.libraryUnplayed,
        wishlist: r.wishlist,
        // 발굴 풀이 없으면(구 캐시·발굴 전) 서버 목록을 쓴다.
        storeDeals: r.storeDeals ?? result.storeDeals,
      },
      missingReviewIds: r.missingReviewIds,
    };
  }, [result, pool, options]);

  // 재정렬로 새로 블렌딩 대상이 된 후보의 리뷰 요약 받기. 분석 중에는 서버가 받는 중일 수 있어
  // 기다리고, 최종 result(서버 리뷰 조회 완료) 또는 분석 종료 뒤 한 번에 요청한다. 이미 요청한 appid는 다시 묻지 않는다(실패 포함 — 응답이
  // null로 채워져 중립 0.5로 계산됨).
  //
  // 요청 표시(requestedReviewIdsRef)는 응답을 받아 풀에 반영했을 때만 남긴다. abort·실패·non-ok면
  // 즉시(cleanup·then 안에서) 지워, 다음 effect 실행이 그 appid를 다시 요청할 수 있게 한다
  // (/code-review M5 — 예전에는 catch가 늦게 지워 다음 실행이 건너뛴 뒤 다시 실행되지 않았다).
  // 새 서버 분석이 시작되면 startAnalysis가 비운다.
  const missingKey = displayed?.missingReviewIds.join(',') ?? '';
  // 하나의 값으로 묶어 의존성에 둔다 — loading과 mainResultReceived를 따로 두면 result 직후 done으로
  // loading만 바뀔 때 진행 중인 요청을 취소하고 같은 요청을 다시 보낸다 (/code-review 5차 재검토 L4).
  const reviewsReady = !loading || mainResultReceived;
  useEffect(() => {
    if (!reviewsReady || !missingKey) return;
    const ids = missingKey.split(',').map(Number).filter(id => !requestedReviewIdsRef.current.has(id)).slice(0, 60);
    if (ids.length === 0) return;
    for (const id of ids) requestedReviewIdsRef.current.add(id);
    const ctrl = new AbortController();
    let settled = false;
    const release = () => { for (const id of ids) requestedReviewIdsRef.current.delete(id); };
    fetch(`/api/recommend/reviews?ids=${ids.join(',')}`, { signal: ctrl.signal })
      .then(res => (res.ok ? res.json() : null))
      .then((data: { summaries?: Record<number, ReviewSummary | null> } | null) => {
        settled = true;
        const summaries = data?.summaries;
        if (!summaries) { release(); return; }
        // 응답에 빠진 appid는 null(조회 실패)로 채워 중립 0.5로 확정한다 — 같은 실패를 반복 요청하지 않도록.
        const filled: Record<number, ReviewSummary | null> = {};
        for (const id of ids) filled[id] = summaries[id] ?? null;
        setPool(prev => (prev ? { ...prev, reviews: { ...prev.reviews, ...filled } } : prev));
      })
      .catch(() => { settled = true; release(); });
    return () => {
      if (!settled) release();
      ctrl.abort();
    };
  }, [reviewsReady, missingKey]);

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
        {displayed && (
          <ResultView
            result={displayed.result}
            // 가격 실패 여부는 화면 목록을 만든 풀에서 계산한다 — 캐시에서 온 doneData가 done 전까지 남아
            // 새 결과와 어긋난 안내를 띄우지 않도록 (/code-review M2). 풀이 없을 때만 이벤트 값을 쓴다.
            doneData={doneData ? {
              ...doneData,
              priceFetchFailed: pool ? pool.wishPricesReady && !pool.wishPriceOk : (doneData.priceFetchFailed || priceFetchFailed),
            } : null}
            // 재정렬 옵션·발굴 끄기는 현재 옵션을 따르고(즉시 반영), 나머지 문구는 분석 옵션을 따른다.
            options={{
              ...analyzedOptions,
              valueWeighting: options.valueWeighting,
              saleOnly: options.saleOnly,
              maxRecommendationsPerTrack: options.maxRecommendationsPerTrack,
              discoverDeals: analyzedOptions.discoverDeals && options.discoverDeals,
            }}
            isProvisional={isProvisional}
            cachedAt={cachedAt}
            discovering={loading && !storeDealsFresh}
            storeDealsFresh={storeDealsFresh}
            storeDealsStatus={storeDealsStatus}
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
    case 'fetching-prices':  return '가격 확인 중';
    case 'analyzing':        return '성향 분석 중';
    case 'discovering':        return '할인 게임 찾는 중';
    case 'fetching-deal-meta': return '할인 게임 정보 확인 중';
    default:                 return phase;
  }
}

// ============================================================================
// 옵션 패널
// ============================================================================

function OptionsPanel({ options, onChange }: { options: PageOptions; onChange: (o: PageOptions) => void; }) {
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
        <label className="flex items-center gap-2 cursor-pointer" title="위시리스트 순위에 현재 할인율과 할인가를 반영합니다. 취향이 여전히 가장 큰 비중입니다.">
          <input
            type="checkbox"
            checked={options.valueWeighting}
            onChange={(e) => onChange({ ...options, valueWeighting: e.target.checked })}
            className="w-4 h-4"
          />
          <span className="text-gray-700 dark:text-gray-200">가성비 반영 (할인율 가산)</span>
        </label>
        <label className="flex items-center gap-2 cursor-pointer" title="위시리스트에서 지금 할인 중인 게임만 보여줍니다.">
          <input
            type="checkbox"
            checked={options.saleOnly}
            onChange={(e) => onChange({ ...options, saleOnly: e.target.checked })}
            className="w-4 h-4"
          />
          <span className="text-gray-700 dark:text-gray-200">할인 중인 게임만</span>
        </label>
        <label className="flex items-center gap-2 cursor-pointer" title="라이브러리·위시리스트에 없는 게임 중 지금 할인 중이고 취향에 맞으며 평이 좋은 게임을 찾습니다.">
          <input
            type="checkbox"
            checked={options.discoverDeals}
            onChange={(e) => onChange({ ...options, discoverDeals: e.target.checked })}
            className="w-4 h-4"
          />
          <span className="text-gray-700 dark:text-gray-200">미보유 할인 게임 찾기 (첫 실행 1–2분 추가)</span>
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
  result, doneData, options, isProvisional, cachedAt, discovering, storeDealsFresh, storeDealsStatus,
}: {
  result: ResultData; doneData: DoneData | null; options: PageOptions;
  isProvisional: boolean; cachedAt: number | null;
  /** 이번 분석의 발굴 결과가 아직 도착하지 않았고 분석이 진행 중. */
  discovering: boolean;
  /** 이번 분석의 store-deals 이벤트를 받았다(result.storeDeals가 새 결과). */
  storeDealsFresh: boolean;
  /** 이번 분석 store-deals 이벤트의 실패/일부 확인 플래그. */
  storeDealsStatus: { failed: boolean; truncated: boolean };
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
        priceFetchFailed={doneData?.priceFetchFailed ?? false}
        saleOnly={options.saleOnly}
        valueWeighting={options.valueWeighting}
        isProvisional={isProvisional}
      />
      {options.discoverDeals && (
        <StoreDealSection
          recs={result.storeDeals}
          discovering={discovering}
          fresh={storeDealsFresh}
          failed={storeDealsStatus.failed}
          truncated={storeDealsStatus.truncated}
        />
      )}
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

/** 제목 버튼으로 내용을 접고 펼치는 추천 트랙 섹션. 기본은 펼침. */
function CollapsibleSection({
  title, count, children,
}: {
  title: string; count: number; children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(true);
  return (
    <section className="space-y-3">
      <h2>
        <button
          type="button"
          onClick={() => setExpanded(v => !v)}
          aria-expanded={expanded}
          className="group flex w-full items-center gap-1.5 text-left text-sm font-semibold text-gray-700 dark:text-gray-200 hover:text-[#1b6fa8] dark:hover:text-[#66c0f4] transition-colors"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 16 16"
            fill="currentColor"
            aria-hidden
            className={`w-4 h-4 shrink-0 text-gray-400 dark:text-gray-500 group-hover:text-current transition-transform duration-200 ${expanded ? '' : '-rotate-90'}`}
          >
            <path
              fillRule="evenodd"
              d="M4.22 6.22a.75.75 0 0 1 1.06 0L8 8.94l2.72-2.72a.75.75 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 7.28a.75.75 0 0 1 0-1.06Z"
              clipRule="evenodd"
            />
          </svg>
          <span>{title} {count > 0 ? `(${count})` : ''}</span>
        </button>
      </h2>
      {expanded && children}
    </section>
  );
}

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
    <CollapsibleSection title={title} count={recs.length}>
      {recs.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-800/50 rounded-lg p-4">
          {displayedEmpty}
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {recs.map(r => <RecommendCard key={r.appid} rec={r} />)}
        </div>
      )}
    </CollapsibleSection>
  );
}

function WishlistSection({
  recs: recsOrNull, wishlistGames, wishlistFetchFailed, priceFetchFailed, saleOnly, valueWeighting, isProvisional,
}: {
  recs: Recommendation[] | null; wishlistGames: number; wishlistFetchFailed: boolean;
  priceFetchFailed: boolean; saleOnly: boolean; valueWeighting: boolean; isProvisional: boolean;
}) {
  const recs = recsOrNull ?? [];
  // 잠정 단계에서는 wishlistGames/wishlistFetchFailed가 아직 확정 아님 → 잠정 메시지 우선.
  // 가격 실패를 "할인 게임 없음"으로 표시하지 않는다 (작업 지시서 20261010_01 정직성 제약).
  let emptyMessage: string;
  if (recsOrNull === null) {
    emptyMessage = '가격 확인 중… 분석이 끝나면 할인 중인 위시리스트 게임이 표시됩니다.';
  } else if (isProvisional) {
    emptyMessage = '잠정 결과를 기다리는 중입니다. 위시리스트 게임 정보를 확인하는 중입니다.';
  } else if (wishlistFetchFailed) {
    emptyMessage = '위시리스트를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.';
  } else if (wishlistGames === 0) {
    emptyMessage = '위시리스트가 비어있습니다.';
  } else if (saleOnly && priceFetchFailed) {
    emptyMessage = '가격 정보를 가져오지 못했습니다. 잠시 후 다시 분석해 주세요.';
  } else if (saleOnly) {
    emptyMessage = '지금 할인 중인 위시리스트 게임이 없습니다.';
  } else {
    emptyMessage = '위시리스트에서 성향과 일치하는 게임을 찾지 못했습니다.';
  }
  return (
    <CollapsibleSection
      title={saleOnly ? '위시리스트 중 할인 중이고 성향에 맞는 게임' : '위시리스트 중 성향에 맞는 게임'}
      count={recs.length}
    >
      {/* 결과가 있는데 가격 조회가 실패한 경우: 가성비 반영 없이 기존 순위임을 알린다. */}
      {!isProvisional && valueWeighting && priceFetchFailed && recs.length > 0 && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          가격 정보를 가져오지 못해 할인 반영 없이 정렬했습니다.
        </p>
      )}
      {recs.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-800/50 rounded-lg p-4">
          {emptyMessage}
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {recs.map(r => <RecommendCard key={r.appid} rec={r} />)}
        </div>
      )}
    </CollapsibleSection>
  );
}

/**
 * 트랙 C: 미보유 할인 게임 (작업 지시서 20261010_01 단계 2-6).
 *
 * 상태 문구 (정직성 제약 — 실패·예산 초과를 "할인 게임 없음"으로 표시하지 않음):
 *   - 발굴 진행 중: 결과가 없으면 "할인 게임 찾는 중", 있으면(이전 캐시) 위에 갱신 중 안내.
 *   - 실패: "할인 목록을 가져오지 못했습니다".
 *   - 예산 초과: "일부 후보만 확인했습니다" (결과와 함께 또는 단독).
 *   - 정상 0건: "취향에 맞는 할인 게임이 없습니다".
 */
function StoreDealSection({
  recs, discovering, fresh, failed, truncated,
}: {
  recs: Recommendation[] | undefined; discovering: boolean; fresh: boolean;
  failed: boolean; truncated: boolean;
}) {
  const list = recs ?? [];
  let emptyMessage: string;
  if (discovering) {
    emptyMessage = '할인 게임 찾는 중… 라이브러리·위시리스트 분석이 끝난 뒤 진행됩니다.';
  } else if (!fresh) {
    // 분석이 store-deals 전에 끝남(오류·라이브러리 조회 실패 등). "없음"이라고 단정하지 않는다.
    emptyMessage = '이번 분석에서는 할인 게임을 확인하지 못했습니다.';
  } else if (failed) {
    emptyMessage = '할인 목록을 가져오지 못했습니다. 잠시 후 다시 분석해 주세요.';
  } else if (truncated) {
    emptyMessage = '일부 후보만 확인했습니다. 확인한 후보 중에는 취향에 맞는 할인 게임이 없습니다.';
  } else {
    emptyMessage = '취향에 맞는 할인 게임이 없습니다.';
  }
  return (
    <CollapsibleSection title="취향 맞는 할인 게임" count={list.length}>
      {list.length > 0 && discovering && (
        <p className="text-xs text-gray-500 dark:text-gray-400">이전 결과입니다. 새로 찾는 중…</p>
      )}
      {list.length > 0 && !discovering && failed && (
        <p className="text-xs text-amber-700 dark:text-amber-400">할인 목록을 가져오지 못해 이전 결과를 표시합니다.</p>
      )}
      {list.length > 0 && !discovering && !failed && truncated && (
        <p className="text-xs text-amber-700 dark:text-amber-400">시간 제한으로 일부 후보만 확인했습니다.</p>
      )}
      {list.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-800/50 rounded-lg p-4">
          {emptyMessage}
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {list.map(r => <RecommendCard key={r.appid} rec={r} />)}
        </div>
      )}
    </CollapsibleSection>
  );
}

/** 할인 종료까지 남은 시간 표시. 지났거나 7일 넘게 남았으면 표시하지 않는다(정보 가치 낮음). */
function formatDiscountEnds(endsAtSec: number | undefined): string | null {
  if (endsAtSec === undefined) return null;
  const diffMs = endsAtSec * 1000 - Date.now();
  if (diffMs <= 0) return null;
  const hours = Math.floor(diffMs / (60 * 60 * 1000));
  if (hours < 24) return hours <= 0 ? '곧 할인 종료' : `${hours}시간 후 할인 종료`;
  const days = Math.floor(hours / 24);
  return days > 7 ? null : `${days}일 후 할인 종료`;
}

function RecommendCard({ rec }: { rec: Recommendation }) {
  const discountEnds = rec.source === 'store-deal' ? formatDiscountEnds(rec.discountEndsAt) : null;
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
        {/* 가격: 위시리스트 트랙에서 가격을 조회한 경우만(undefined=미상 → 미표시).
            1시간(PRICE_STALE_MS) 넘은 캐시 가격은 회색으로 구분한다. */}
        {rec.price !== undefined && (rec.price !== null || rec.isFree || rec.comingSoon) && (
          <div className="min-h-[1.5rem] flex items-center">
            <GamePrice
              price={rec.price ?? undefined}
              isFree={rec.isFree}
              // 가격이 있으면(예약 구매 할인 등) 가격을 우선 표시 — GamePrice는 comingSoon을
              // 가격보다 먼저 그리므로, 가격이 없을 때만 "출시 예정"으로 대체한다.
              comingSoon={rec.price === null && rec.comingSoon}
              stale={isPriceStale(rec.priceFetchedAt)}
              staleLabel={formatPriceAge(rec.priceFetchedAt)}
            />
          </div>
        )}
        <div className="flex items-center justify-between gap-2 text-xs text-gray-500 dark:text-gray-400">
          <span>
            {rec.source === 'library-unplayed' && (
              rec.playtimeMinutes === 0
                ? '아직 안 해본 게임'
                : `${rec.playtimeMinutes}분 플레이`
            )}
            {rec.source === 'wishlist' && '위시리스트'}
            {rec.source === 'store-deal' && (discountEnds ? `스토어 할인 · ${discountEnds}` : '스토어 할인')}
          </span>
          {rec.reviewBadge && <ReviewBadgeChip badge={rec.reviewBadge} />}
        </div>
      </div>
    </a>
  );
}

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
