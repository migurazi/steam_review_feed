# 작업 지시서: 보유 게임 성향 분석 및 미플레이/위시리스트 게임 추천

| 항목 | 값 |
|------|-----|
| 작성일 | 2026-05-27 |
| 작성자 | Claude (Sisyphus) |
| 상태 | v4 (Momus 3차 검토 반영, 최종) |
| 대상 브랜치 | `feature/profile-recommend` |
| 베이스 commit | `1a029c3c06430057652b947e07eeb7ca63f4957f` (작업 시작 시점) |

---

## 0. 변경 이력

| 버전 | 변경 |
|------|------|
| v1 | 초안 — 라이브러리 미플레이 추천만, Momus 검토 대기 |
| v2 | (1) **위시리스트 게임 추천 추가** (1차 범위로 승격) (2) Momus C1~C4·M1~M5·L1~L5 모두 반영 |
| v3 | Momus 2차 검토 반영: classify 규칙 재정의(unplayedMax 실효화), 라이브러리+위시리스트 합산 성능 행 추가, 단계 0 산출물 명세 강화, 트랙 B 단독 시나리오 안내, 라벨 정책 = 첫 등장 확정, 위시리스트 null/빈 배열 구분 |
| v4 | Momus 3차 검토 반영: SSE done 플래그별 UI 안내 매핑 표 통합(3.4.4), recommendLibraryUnplayed 주석 v2 잔재 정정, 단계 0 엔트로피 임계값 정당화 추가 |

---

## 1. 배경 및 목적

### 1.1 배경

`steam-review-feed`는 현재 위시리스트/라이브러리 게임의 **리뷰**를 통합 피드로 보여주는 데 집중되어 있다. 사용자는 종종 다음 두 결정에서 막힌다.

- **라이브러리 안에서**: "라이브러리에 100개 넘는 게임이 있는데, 그중 좋아할 만한 안 한 게임이 뭔지 떠오르지 않는다"
- **위시리스트 안에서**: "할인 메일을 받았는데, 위시리스트 50개 중 내 취향에 정말 맞는 게 뭔지 매번 다시 따져야 한다"

이 프로젝트의 보유 인프라(Steam OpenID/세션, `getOwnedGames`, `getWishlist`, `getAppDetails`, 캐시, Rate Limit, SSE 패턴)를 활용하면 외부 LLM 없이 **"라이브러리 플레이타임 → 성향 프로필 → 두 트랙 추천(미플레이 라이브러리 / 위시리스트)"** 기능을 추가할 수 있다.

### 1.2 목적

1. 사용자의 **라이브러리 플레이타임 분포**에서 결정론적 룰로 성향 신호(장르·카테고리)를 추출한다.
2. **트랙 A — 미플레이 추천**: 라이브러리 안에서 아직 (충분히) 플레이하지 않은 게임 중 성향에 맞는 추천.
3. **트랙 B — 위시리스트 추천**: 위시리스트 안에서 성향에 맞는 게임 추천 (구매 의사결정 보조).
4. "카드 농사" (트레이딩 카드 발급용 단기 플레이) 신호 오염을 사용자 조정 가능한 임계값으로 배제한다.
5. 외부 LLM 없이 **결정론적 룰 기반**, 무료/오프라인/예측 가능성을 모두 만족한다.

### 1.3 비목표 (Out of Scope)

- 라이브러리/위시리스트 외 Steam 전체 카탈로그 추천
- 협업 필터링 (다른 사용자 데이터 활용)
- LLM/머신러닝 기반 추천
- 분석 결과의 영속 저장 (DB 보관)
- 친구 라이브러리 비교

---

## 2. 현재 상태

### 2.1 활용 가능한 기존 자산

| 항목 | 위치 | 비고 |
|------|------|------|
| Steam 세션 (steamId) | `lib/session.ts` | OpenID 로그인 후 쿠키 보존 |
| 보유 게임 + 플레이타임 | `lib/steam/api.ts::getOwnedGames` | `playtime_forever`, `playtime_2weeks`, `rtime_last_played` |
| 위시리스트 | `lib/steam/api.ts::getWishlist` | `appid` + `priority` + `date_added` |
| 게임 상세 | `lib/steam/api.ts::getAppDetails` | `cc=KR&l=koreana` 호출 (영향: 4.3 참조) |
| 캐시 | `lib/cache.ts` | LRU 10,000 + TTL (appInfo=7일) |
| Rate Limit 딜레이 | `lib/constants.ts::STEAM_API_DELAY.appDetails=1000ms` | |
| 동시성 상수 | `lib/constants.ts::STREAM_CONCURRENCY=3` | |
| SSE 취소 패턴 (선례) | `app/api/reviews/stream/route.ts:116-138, 228-264` | `cancelled` 플래그 + `cancel()` 콜백. 배치 시작 전 `isCancelled()` 체크 |
| API 인증·Rate Limit 패턴 | `app/api/library/route.ts` | `rateLimitResponse` + `getSession` |
| 페이지 구조 | `app/feed/page.tsx` | 인증 가드 + 필터 URL 동기화 |
| Filter 패널 | `components/FilterPanel.tsx` | 슬라이더·체크박스 UI 패턴 재사용 가능 |

### 2.2 결손 사항 (이 작업에서 보강)

| 결손 | 영향 | 보강 |
|------|------|------|
| `SteamAppDetails` 타입에 `genres`, `categories` 부재 | 성향 신호의 핵심 | 타입 확장 (3.1) |
| 다언어(cc=KR) description 매칭 시 신호 누락 위험 | 영어 vs 한국어 라벨 불일치로 매칭=0 가능 | **id 기반 매칭**, description은 표시 전용 (4.3) |
| 일괄 메타 조회 헬퍼 부재 | 라우트마다 반복 | `lib/steam/api.ts::getAppDetailsBatch` 신규 (3.5) |
| 성향 분석 로직 부재 | — | `lib/steam/profile.ts` 신규 (3.2) |
| 추천 페이지/API 부재 | — | `/recommend` + `/api/recommend` (3.3, 3.4) |

---

## 3. 변경 계획

### 3.1 타입 확장 — `lib/steam/types.ts`

```typescript
export interface SteamGenre {
  /** 장르 ID (문자열, 매칭의 기준) */
  id: string;
  /** 표시명 (cc=KR이면 한국어, 예: "액션") */
  description: string;
}

export interface SteamCategory {
  /** 카테고리 ID (정수, 매칭의 기준, 예: 2=싱글플레이어) */
  id: number;
  description: string;
}

export interface SteamAppDetails {
  // ... 기존 필드 ...
  genres?: SteamGenre[];
  categories?: SteamCategory[];
}
```

신규 테스트: `__tests__/steam-types.test.ts`에 옵셔널 필드 케이스 추가 (genres 있음/없음/빈 배열, id 타입 보존).

### 3.2 분석 모듈 — `lib/steam/profile.ts` (신규)

#### 3.2.1 데이터 모델

```typescript
/** 라이브러리 게임 + 메타를 결합한 분석 단위 */
export interface OwnedAnalyzedGame {
  appid: number;
  name: string;
  playtimeMinutes: number;
  recent2wMinutes: number;
  /** 장르 ID 배열 (매칭용) */
  genreIds: string[];
  /** 카테고리 ID 배열 (매칭용) */
  categoryIds: number[];
  /** 표시명 매핑 (id → description). 같은 풀 안에서 누적 병합. */
  genreLabels: Record<string, string>;
  categoryLabels: Record<number, string>;
  isFree: boolean;
  headerImage?: string;
}

/** 위시리스트 게임 + 메타 (플레이타임 없음) */
export interface WishlistAnalyzedGame {
  appid: number;
  name: string;
  priority: number;
  dateAddedUnix: number;
  genreIds: string[];
  categoryIds: number[];
  genreLabels: Record<string, string>;
  categoryLabels: Record<number, string>;
  isFree: boolean;
  headerImage?: string;
}

export interface TasteEntry {
  /** 매칭 키 (id) */
  key: string | number;
  /** 표시명 (대표 description) */
  label: string;
  weight: number;
  /** 0~1 (차원 내 정규화, sum=1 within dimension) */
  share: number;
  topGames: { appid: number; name: string; playtimeMinutes: number }[];
}

export interface TasteProfile {
  totalWeight: number;
  /** 분석에 실제로 사용된 게임 수 */
  analyzedGames: number;
  /** 카드 농사로 제외된 수 */
  cardFarmingExcluded: number;
  /** 미플레이로 분석에서 제외된 수 (추천 후보 풀로는 이동) */
  unplayedCount: number;
  /** 장르 메타 누락으로 분석에 기여 못한 수 */
  metaMissing: number;
  genres: TasteEntry[];
  categories: TasteEntry[];
}

export interface Recommendation {
  appid: number;
  name: string;
  headerImage?: string;
  isFree: boolean;
  /** 매칭된 장르/카테고리 (description 노출용) */
  matchedGenres: { id: string; label: string }[];
  matchedCategories: { id: number; label: string }[];
  score: number;
  /** 후보 풀 출처 */
  source: 'library-unplayed' | 'wishlist';
  /** 라이브러리 미플레이 후보일 때만: 누적 플레이타임(분) */
  playtimeMinutes?: number;
  /** 위시리스트 후보일 때만: 우선순위 */
  wishlistPriority?: number;
}
```

#### 3.2.2 분석 옵션

```typescript
export interface AnalyzeOptions {
  /** 카드 농사 상한 (분). 0 < playtime < 이 값 → 분석/추천 양쪽 제외. */
  cardFarmingMaxMinutes: number;
  /** 미플레이 상한 (분). playtime ≤ 이 값 → 추천 후보. */
  unplayedMaxMinutes: number;
  excludeFree: boolean;
  topNTaste: number;
  /** 추천 개수 상한 (트랙별 각각 적용) */
  maxRecommendationsPerTrack: number;
}

export const DEFAULT_ANALYZE_OPTIONS: AnalyzeOptions = {
  cardFarmingMaxMinutes: 180,
  unplayedMaxMinutes: 60,
  excludeFree: false,
  topNTaste: 6,
  maxRecommendationsPerTrack: 12,
};

/** 옵션 검증 — 제약 위반 시 throw */
export function validateAnalyzeOptions(o: AnalyzeOptions): void;
//   - 0 ≤ cardFarmingMaxMinutes ≤ 1440
//   - 0 ≤ unplayedMaxMinutes ≤ 600
//   - unplayedMaxMinutes ≤ cardFarmingMaxMinutes  (Momus C2)
//   - 1 ≤ topNTaste ≤ 12
//   - 1 ≤ maxRecommendationsPerTrack ≤ 30
```

#### 3.2.3 풀 분류 규칙 (Momus C2·L4 해결, v3 재정의)

게임마다 정확히 하나의 풀로 분류한다. 세 구간으로 명확히 분리되며 **모든 옵션 파라미터가 실제 분류에 영향을 준다**.

```
function classify(game, opts):
  if opts.excludeFree and game.isFree:
    return 'excluded-free'
  pt = game.playtimeMinutes

  // 구간 1: 미플레이 (0 ≤ pt ≤ unplayedMaxMinutes)
  //   사용자가 사실상 "안 해본 것"으로 인식할 범위. 추천 후보 풀로 이동.
  //   기본 unplayedMax=60이면 0~60분.
  //   사용자가 슬라이더를 0으로 내리면 pt=0만 미플레이.
  if pt <= opts.unplayedMaxMinutes:
    return 'unplayed'

  // 구간 2: 카드 농사 의심 (unplayedMax < pt < cardFarmingMax)
  //   트레이딩 카드 발급 후 접은 구간으로 추정. 분석·추천 양쪽 제외.
  //   기본 unplayedMax=60, cardMax=180이면 60~180분.
  if pt < opts.cardFarmingMaxMinutes:
    return 'card-farming'

  // 구간 3: 정상 플레이 (pt ≥ cardFarmingMax)
  //   성향 신호로 분석에 기여. 추천 후보 아님.
  return 'analyzed'
```

핵심 결정:
- **세 구간 모두 옵션으로 의미 있게 조정 가능** — `unplayedMax`는 미플레이 상한, `cardFarmingMax`는 카드 농사 상한 (= 분석 진입 하한).
- 두 슬라이더가 같으면 (`unplayedMax == cardFarmingMax`) 카드 농사 구간은 빈 집합이 되고, 분류는 "미플레이 또는 분석" 둘 뿐.
- `unplayedMax = 0`이면 정확히 0분만 미플레이.
- 제약 (`validateAnalyzeOptions`에서 강제): `unplayedMax ≤ cardFarmingMax`. UI에서도 슬라이더 연동으로 자동 클램프.
- 기본값 의미: 1시간 이하는 사용자 입장에서 "안 해본 거나 다름없음" → 추천 후보. 1~3시간은 카드 농사 의심 → 분석에서도 빼고 추천에서도 뺌. 3시간+는 진심 플레이로 성향 신호.

#### 3.2.4 핵심 함수

```typescript
/** 라이브러리 게임만으로 성향을 분석한다. 위시리스트는 신호 없음. */
export function analyzeTaste(
  owned: OwnedAnalyzedGame[],
  opts: AnalyzeOptions
): TasteProfile;

/** 트랙 A: classify가 'unplayed'로 분류한 후보(0 ≤ pt ≤ unplayedMax) 중에서 추천. */
export function recommendLibraryUnplayed(
  owned: OwnedAnalyzedGame[],
  profile: TasteProfile,
  opts: AnalyzeOptions
): Recommendation[];

/** 트랙 B: 위시리스트 후보에서 추천. */
export function recommendFromWishlist(
  wishlist: WishlistAnalyzedGame[],
  profile: TasteProfile,
  opts: AnalyzeOptions
): Recommendation[];
```

가중치 산식:
- 분석: `weight(game) = log(1 + playtimeMinutes)` (장르·카테고리 각 id에 누적)
- 추천 점수: `score = sum(matchedGenre.share) + W_CAT * sum(matchedCategory.share)`
  - `W_CAT` 잠정 기본값 `0.5`. **단계 0의 사전 측정으로 ±0.2 범위 내 재조정 가능** (5절 단계 0 참조, Momus M1).
- 동률 시: `score → 최신성(라이브러리: rtime_last_played 내림차순으로 메타 누락 자체 점수가 같은 경우 안정 정렬용 / 위시리스트: priority 오름차순) → appid 오름차순`

엣지 케이스:
- 분석 풀이 비면 (analyzedGames=0) → 트랙 A/B 모두 빈 배열 반환 (점수 0). UI에 안내 (4.4).
- 후보의 `genreIds`가 비어 있으면 점수 계산 시 0 기여 → 추천에서 자연 탈락.

### 3.3 API 라우트 — `app/api/recommend/route.ts` (신규)

#### 3.3.1 요청

- `GET /api/recommend?cardMin=180&unplayedMax=60&excludeFree=false&topN=6&max=12&tracks=lib,wish`
- 인증 필수 (세션 없으면 401)
- `rateLimitResponse` 적용
- 파라미터 검증 — `validateAnalyzeOptions` 와 동일 범위. 위반 시 400.
- `tracks` 기본값: `lib,wish`. 어느 하나만 요청 가능.

#### 3.3.2 SSE 응답

```
event: progress
data: { "phase": "fetching-owned-meta",    "loaded": 12, "total": 200 }

event: progress
data: { "phase": "fetching-wishlist-meta", "loaded": 8,  "total": 30 }

event: progress
data: { "phase": "analyzing",              "loaded": 230, "total": 230 }

event: result
data: { "profile": TasteProfile, "libraryUnplayed": Recommendation[], "wishlist": Recommendation[] }

event: done
data: { "ownedGames": 200, "wishlistGames": 30, "cacheHitRate": 0.92,
        "wishlistFetchFailed": false, "analysisInsufficient": false }
```

부분 결과는 보내지 않는다 (UI 진동 방지). 진행률만 표시.

#### 3.3.3 동시성 및 취소 (Momus C1)

**선례 `app/api/reviews/stream/route.ts`의 패턴을 그대로 차용**:

```typescript
let cancelled = false;
const stream = new ReadableStream({
  async start(controller) {
    try {
      await runAnalysis(controller, session.steamId, opts, () => cancelled);
    } catch (err) {
      if (cancelled) return;
      // 에러 SSE 전송
    } finally {
      if (!cancelled) try { controller.close(); } catch {}
    }
  },
  cancel() { cancelled = true; },
});
```

`runAnalysis` 내부에서는:
- 라이브러리/위시리스트 fetch 후 appid 합집합 생성
- `STREAM_CONCURRENCY=3` 단위로 배치 처리
- **매 배치 시작 전 `isCancelled()` 체크**, true면 즉시 return (선례 228-264와 동일)
- 캐시 미스 항목만 `getAppDetails` 호출 → 캐시 히트는 즉시
- `delay()` 자체는 abortable로 만들지 않음 (1초 단위로 짧고, 배치 경계에서 취소 검사로 충분)

**예상 소요시간 (Momus M2 보정, v3 합산 행 추가)**:

총 메타 호출 = `owned ∪ wishlist`의 유니크 appid 수. 콜드 시간 = `ceil(N / STREAM_CONCURRENCY) × STEAM_API_DELAY.appDetails`.

| 시나리오 | 유니크 appid | 캐시 콜드 | 캐시 핫 |
|----------|-------------|-----------|---------|
| 라이브러리 50, 위시리스트 0    | 50    | ~17초          | <1초  |
| 라이브러리 200, 위시리스트 30  | ~225  | ~75초          | ~2초  |
| 라이브러리 500, 위시리스트 50  | ~545  | ~182초 (≈3분)  | ~6초  |
| 라이브러리 1000, 위시리스트 100 | ~1090 | ~363초 (≈6.1분) | ~12초 |
| 라이브러리 1000, 위시리스트 200 | ~1180 | ~393초 (≈6.6분) | ~12초 |

(위시리스트는 보통 라이브러리와 부분 중첩 — 보유 게임이 위시리스트에서 자동 제거되므로 거의 disjoint. 위 추정은 disjoint 가정.)

UI 안내 문구는 **라이브러리+위시리스트 합산 기준**으로 표기: "라이브러리 500개 기준 첫 분석 약 3분, 일주일 이내 재방문 시 즉시."

#### 3.3.4 LRU 캐시 eviction 시나리오 (Momus M2)

- 전역 LRU 10,000 엔트리. 여러 사용자가 동시 분석 시 가장 오래된 엔트리부터 evict.
- 일반 사용자(라이브러리 200~500개)면 단일 사용자도 5% 이내 점유. 동시 사용자 10명까지는 일반적으로 무리 없음.
- 1000+ 라이브러리 사용자는 다른 사용자의 캐시를 압박할 가능성. 운영 시 모니터링 항목으로만 두고, 1차에서 별도 조치 없음.

#### 3.3.5 부분 실패 (v3 위시리스트 null/빈 배열 구분)

- **라이브러리 조회 실패 (null)** → 502 + `error` SSE. 분석 불가, 종료.
- **위시리스트 조회 실패 (null)** → 분석 계속, 트랙 A만 결과 + `done` 이벤트에 `wishlistFetchFailed: true` 플래그. UI는 "위시리스트를 불러오지 못했습니다" 안내.
- **위시리스트 정상이지만 빈 배열 (0개)** → 분석 계속, 트랙 A만 결과 + `done`에 `wishlistGames: 0`. UI는 "위시리스트가 비어있습니다" 안내.
- **일부 메타 조회 실패** (`getAppDetails`가 success=false 반환) → 해당 게임은 `genreIds=[], categoryIds=[]`로 분석 통과 (0 기여), 추천 후보 자격 잃음. `profile.metaMissing` 카운트.
- **분석 풀=0 (R5b)** → `profile.analyzedGames=0`, 트랙 A/B 모두 빈 배열. `done`에 `analysisInsufficient: true` 플래그. UI 안내는 R5b 참조.

#### 3.3.6 Rate Limit 상호작용 (Momus M4)

- `rateLimitResponse`는 요청 시작 시 1회 카운트. 장기 SSE도 1요청으로 처리됨 → 분석 중 본인 다른 API 호출이 영향받지 않음 (윈도우 60초/30요청).
- 슬라이더 변경으로 재시작 시: 클라이언트가 이전 SSE 취소 → 서버 `cancelled=true` → 새 요청은 새 카운트 1회. **debounce 500ms 적용** (3.4.2).

### 3.4 페이지 — `app/recommend/page.tsx` (신규)

#### 3.4.1 레이아웃

```
[헤더: 로고 + 사용자 + 테마 토글 + /feed 링크]
─────────────────────────────────────
[당신의 성향]
  장르: [액션 35%][롤플레잉 28%][전략 18%][인디 11%] ...
  카테고리: [싱글 플레이어][컨트롤러 지원][Steam 도전 과제] ...
  분석 대상: 134게임 / 카드 농사 12 / 미플레이 54 / 메타 누락 0
─────────────────────────────────────
[옵션]
  카드 농사 임계값 ●────── 180분  (0 ≤ ▾ ≤ 1440)
  미플레이 임계값  ●──── 60분   (자동으로 카드 농사 이하로 클램프)
  □ 무료 게임 제외
  추천 개수 [12]   트랙: [☑ 미플레이] [☑ 위시리스트]
─────────────────────────────────────
[트랙 A — 라이브러리에 있지만 안 해본 게임 (12)]
  [헤더이미지] 게임명
              매칭: 액션 · 롤플레잉
              [Steam에서 보기]
  ...
─────────────────────────────────────
[트랙 B — 위시리스트 중 성향에 맞는 게임 (8)]
  [헤더이미지] 게임명
              매칭: 전략 · 인디
              위시리스트 추가일: 2026-04-12
              [Steam에서 보기]
  ...
[진행률 바: 분석 중일 때만, 'fetching-owned-meta 12/200' 식 라벨]
```

#### 3.4.2 상호작용

- 첫 진입 시 자동 SSE 시작
- 옵션 변경 시 **500ms debounce 후** 기존 SSE abort → 새 SSE 시작
- 미플레이/카드 농사 슬라이더 연동: 사용자가 unplayed > cardFarming 입력 시 unplayed 가 card 값으로 자동 클램프 (UI에서 처리)
- 추천 카드 클릭 → `https://store.steampowered.com/app/{appid}/` 새 탭

#### 3.4.3 비로그인 처리

- `/api/auth/me` 확인 → 비로그인 시 홈으로 리다이렉트 (`/feed` 동일 패턴)

#### 3.4.4 i18n / 추천 사유 (Momus M5)

서버는 `reasonText`를 **생성하지 않는다**. `matchedGenres`/`matchedCategories`만 전달. 사람이 읽을 문구는 **클라이언트에서 조립** (예: ``${matchedGenres.map(g=>g.label).join('·')} 장르가 성향과 일치``). 한국어 고정 (1차). 후속에서 locale 분기.

#### 3.4.5 SSE done 이벤트 플래그 → UI 안내 매핑 (Momus 3차 Medium-A)

`result` 이벤트의 추천 배열과 `done` 이벤트 플래그를 조합하여 다음과 같이 분기:

| 상태 | 판정 신호 | 표시 위치 | 안내 문구 |
|------|----------|-----------|-----------|
| 정상 | 두 트랙 모두 비어있지 않음 | — | 추천 카드 그리드만 표시, 안내 없음 |
| 트랙 A 빈 (R5) | `libraryUnplayed=[]` & 위시리스트 정상 & `analysisInsufficient=false` | 트랙 A 섹션 자리 | "안 한 게임을 찾지 못했습니다. 미플레이 임계값을 올려보세요." |
| 트랙 B 빈 — 위시리스트 비어있음 | `wishlistGames=0` & `wishlistFetchFailed=false` | 트랙 B 섹션 자리 | "위시리스트가 비어있습니다." |
| 트랙 B 빈 — 위시리스트 조회 실패 | `wishlistFetchFailed=true` | 트랙 B 섹션 자리 | "위시리스트를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요." |
| 트랙 B 빈 — 매칭 없음 | `wishlist=[]` & `wishlistGames>0` & `wishlistFetchFailed=false` & `analysisInsufficient=false` | 트랙 B 섹션 자리 | "위시리스트에서 성향과 일치하는 게임을 찾지 못했습니다." |
| 분석 풀=0 (R5b) | `analysisInsufficient=true` | 상단 성향 카드 자리에 단독 표시 (두 트랙 섹션 숨김) | "성향 분석에 사용할 충분한 플레이 이력이 없습니다. cardFarmingMax를 낮추거나 더 플레이 후 재방문하세요." |
| 라이브러리 조회 실패 | HTTP 502 또는 `error` SSE | 페이지 전체 자리 | "라이브러리를 불러오지 못했습니다. 다시 시도해 주세요." |

분기 판정은 `result` 도착 시점에 일괄 평가. 분기 후에는 진행 중 SSE 종료 (이미 `done` 도착 시점이라 별도 처리 불필요).

### 3.5 일괄 메타 조회 헬퍼 — `lib/steam/api.ts`에 추가 (Momus M3)

```typescript
/**
 * 여러 appId의 메타를 캐시 우선으로 일괄 조회한다.
 * STREAM_CONCURRENCY 단위로 병렬, isCancelled 즉시 반영.
 *
 * @param appIds 조회할 appid 배열 (중복은 호출 측에서 제거)
 * @param onProgress 한 게임 완료 시마다 호출. (loaded, total) 전달.
 * @param isCancelled 취소 검사 함수. true 반환 시 즉시 중단.
 */
export async function getAppDetailsBatch(
  appIds: number[],
  onProgress?: (loaded: number, total: number) => void,
  isCancelled: () => boolean = () => false
): Promise<Map<number, SteamAppDetails | null>>;
```

라우트 외에 후속 위시리스트 분석/검색 등에서 재사용. `lib/steam/profile.ts`는 이 헬퍼를 **호출하지 않는다** (분석 함수는 순수 — 메타가 이미 결합된 입력만 받음).

### 3.6 진입점 링크 (Momus L2)

- `app/feed/page.tsx`의 헤더 우측에 "성향 분석" 텍스트 링크 1개 추가 (`<Link href="/recommend">`)
- 별도 헤더 컴포넌트는 없음 (확인 완료) — feed page 내부 헤더 영역에 직접 추가
- 모바일에서는 동일 헤더 영역 안에서 줄바꿈 허용 (별도 햄버거 메뉴 도입 안 함)
- 홈 화면(`app/page.tsx`)의 진입점은 1차 범위 제외 — `/feed`에서만 진입

### 3.7 테스트 — `__tests__/profile.test.ts` (신규)

`analyzeTaste`, `recommendLibraryUnplayed`, `recommendFromWishlist`, `validateAnalyzeOptions`, `classify` 동작 검증.

| # | 케이스 | 검증 |
|---|--------|------|
| 1 | 빈 라이브러리 | `analyzedGames=0`, 트랙 A/B 빈 배열 |
| 2 | 모두 pt=30분 (기본: unplayedMax=60, cardMax=180) | 30 ≤ 60 → 'unplayed'. `unplayedCount=5`, `cardFarmingExcluded=0`, `analyzedGames=0`. 트랙 A 후보 풀=5게임. 분석 풀이 0이므로 추천 점수 0 → 트랙 A 빈 배열 |
| 3 | 모두 pt=30분, unplayedMax=0, cardMax=0 | 모두 'analyzed'. `analyzedGames=5` |
| 4 | pt=0 게임 다수 | 'unplayed'로 분류, 트랙 A 후보 풀에 들어감 |
| 5 | 1게임 1000h + 5게임 10h | 1000h 단일 게임이 share 70% 초과 안 함 (로그 가중치 검증) |
| 6 | genres/categories 메타 누락 게임 | `metaMissing` 카운트, 분석 통과(0 기여), 추천 후보 자격 박탈 |
| 7 | `excludeFree=true` | 무료 게임이 분석·트랙 A·트랙 B 모두에서 제외 |
| 8 | share 정규화 | 차원별 share 합=1.0 (ε=1e-9) |
| 9 | 추천 동률 정렬 | score 동일 시 appid 오름차순 |
| 10 | `topNTaste=3` | 정확히 3개 반환 |
| 11 | 위시리스트 추천 | 라이브러리 분석 결과 기반, 위시리스트 게임 중 매칭 게임만 추천. priority 동률 시 appid 오름차순. |
| 12 | 위시리스트 추천 - 라이브러리 분석 풀=0 | 트랙 B 빈 배열 (점수 0) |
| 13 | `validateAnalyzeOptions` | `unplayedMax > cardFarmingMax`에서 throw, 그 외 범위 위반에서 throw |
| 14 | classify 경계값 | pt=60, unplayedMax=60, cardMax=180 → 'unplayed' (경계 포함). pt=61 → 'card-farming'. pt=180 → 'analyzed' (cardMax 포함). pt=179 → 'card-farming' |
| 15 | id 기반 매칭 (Momus C3) | 같은 genre id의 description이 한국어/영어로 섞여 와도 매칭은 id로 합산됨. **표시 label = 해당 id가 처음 등장한 게임의 description** (결정: 첫 등장 우선) |

API 라우트 통합 테스트는 1차 범위 제외 — 선례인 `app/api/reviews/stream/route.ts`도 단위 테스트만 존재 (테스트 파일 명단 확인 완료). 후속에서 추가 검토.

---

## 4. 제약 조건

### 4.1 외부 API

- Steam appDetails는 비공식 API — 응답 구조가 바뀔 위험. 옵셔널 타입 + 누락 시 빈 배열 fallback으로 방어. 운영 로그로 감지.
- 부분 실패 허용: success=false 게임은 점수 0 기여 + 추천 후보 자격 박탈.

### 4.2 보안·프라이버시

- 분석 결과 영속 저장 없음 — 매 요청마다 캐시된 원본에서 재계산.
- 세션 기반 자기 데이터만 (`session.steamId`) — 다른 사용자 데이터 노출 불가.
- 응답에 다른 사용자 식별자 포함 없음 (steamId 에코백 없음).

### 4.3 호환성

- Next.js 16 App Router, Node 런타임 (Edge 사용 안 함, middleware 외).
- TypeScript strict 모드 유지. ESLint 통과.
- 캐시 키 기존과 동일 (`library:{steamId}`, `wishlist:{steamId}`, `app:{appId}:info:KR`). **신규 키 도입 없음.**
- **언어 매칭 정책 (Momus C3)**: 모든 매칭은 `id` 기반. cc=KR 호출로 description은 한국어로 반환되므로 UI 표시는 description 그대로. id 기반이므로 cc 변경 시에도 분석 안정.

### 4.4 성능 목표

총 메타 호출 N = `|owned ∪ wishlist|`.

| 시나리오 (N) | 목표 |
|--------------|------|
| N=100 캐시 콜드 | ≤ 40초 |
| N=225 캐시 콜드 | ≤ 80초 |
| N=545 캐시 콜드 | ≤ 200초 |
| N=1090 캐시 콜드 | 안내 메시지 노출 (≈6.1분 명시) |
| N 임의, 캐시 핫 | ≤ 12초 |
| 분석 함수 자체 (메타 결합 후) | N=200 기준 ≤ 50ms |
| 추가 상시 상주 메모리 | 0 (기존 LRU 재사용) |
| 캐시 TTL 만료 후 재방문 (Momus L1) | UI에 "최근 일주일 이내 재방문은 즉시, 그 외는 다시 수분 소요" 안내 |

### 4.5 UI/UX

- 다크/라이트 테마 지원, 신규 색상 정의 금지 — 기존 Tailwind 토큰 재사용
- 모바일 360px 폭에서 1열 정상
- 진행률 바는 `components/ProgressBar.tsx` 재사용
- 카드 농사·미플레이 슬라이더는 `unplayedMax ≤ cardFarmingMax` 자동 클램프

---

## 5. 단계별 작업 순서

### 단계 0 — 사전 측정 (Momus M1, v3 산출물 명세 강화)

**주체**: 본 작업 수행자(Claude)가 본인 Steam 계정의 라이브러리로 단계 2~3 완료 직후 측정.

**측정 스크립트**: `scripts/measure-profile.ts` (신규, **레포에 커밋하지 않는 임시 파일** — `.gitignore`에 `scripts/measure-*` 추가). Node로 직접 실행 가능하도록 `tsx scripts/measure-profile.ts` 형태. 환경변수 `.env.local`의 `STEAM_API_KEY`와 본인 `STEAM_ID`를 사용.

**측정 항목** (모두 부록 A 표에 기록):

1. 라이브러리 크기 (총 게임 수), 위시리스트 크기
2. classify 분류 분포 — `unplayed`, `card-farming`, `analyzed` 각 카운트 (기본 옵션 기준)
3. 장르 분포 엔트로피 (Shannon, 분석 풀 기준): `H = -Σ p_i log2(p_i)` (p_i = 장르 i의 share)
4. 카테고리 분포 엔트로피 (Shannon, 분석 풀 기준)
5. cardFarmingMax 후보 60/120/180/240/300분 각각에 대해 카드 농사 분류 수 (unplayedMax는 60 고정)
6. unplayedMax 후보 0/30/60/120분 각각에 대해 unplayed 분류 수 (cardMax는 180 고정)

**조정 룰 (객관적)**:

엔트로피 임계값 근거: `log2(3) ≈ 1.58`, `log2(6) ≈ 2.58`. 즉 "실효 장르 수가 3 미만"이면 장르 신호가 빈약하다고 보고 카테고리 가중치를 키우며, "6 이상"이면 장르 신호가 충분히 풍부하다고 보고 카테고리 가중치를 줄인다.

| 조건 | 조정 |
|------|------|
| 장르 엔트로피 < 1.5 | 장르 신호 빈약 → `W_CAT` 0.5 → 0.7 상향 |
| 장르 엔트로피 ≥ 2.5 | 장르 신호 풍부 → `W_CAT` 0.5 → 0.3 하향 |
| 1.5 ≤ 장르 엔트로피 < 2.5 | 기본값 0.5 유지 |
| cardFarmingMax=180에서 카드 농사 비율 > 라이브러리의 40% | 임계값이 너무 공격적 → 기본을 120으로 하향 검토 |
| cardFarmingMax=180에서 카드 농사 비율 < 라이브러리의 5% | 의미 없음 → 임계값 240 상향 검토 (안 해도 됨, 기록만) |

조정 결정은 부록 A에 기록하고 코드의 `DEFAULT_ANALYZE_OPTIONS`에 반영. 측정이 합리적 범위면 기본값 유지(조정 없음)도 정당한 결과로 기록.

### 단계 1~9 (구현)

1. 타입 확장 (`lib/steam/types.ts`) + `__tests__/steam-types.test.ts` 케이스 추가
2. 분석 모듈 (`lib/steam/profile.ts`) — 순수 함수, 외부 의존 없음
3. 분석 모듈 단위 테스트 (`__tests__/profile.test.ts`) — 15개 케이스
4. 일괄 메타 헬퍼 (`lib/steam/api.ts::getAppDetailsBatch`)
5. **단계 0 사전 측정 수행** (위) — 결과를 부록에 기록
6. API 라우트 (`app/api/recommend/route.ts`) — SSE
7. 페이지 (`app/recommend/page.tsx`) — UI
8. 진입점 링크 (`app/feed/page.tsx`)
9. 회귀 + 빌드 + 동작 검증 (6절 참조)

각 단계 후 체크포인트 커밋. 전체 완료 시 develop으로 squash merge 제안 (push는 명시 동의 후).

---

## 6. 완료 기준

각 기준은 **객관적 측정** 또는 **재현 가능한 절차**가 정의되어야 한다 (Momus C4·완료기준 검증 가능성).

| # | 영역 | 기준 | 검증 방법 |
|---|------|------|-----------|
| 1 | 기능 | `/recommend` 진입 시 자동 분석 + 두 트랙 추천 표시 | `npm run dev` 띄워 본인 계정으로 진입, 두 섹션이 채워지는 스크린샷 |
| 2 | 기능 | 카드 농사 슬라이더를 0으로 → 카드 농사 제외 카운트 0 | UI에서 슬라이더 조정 후 분석 결과 카운트 확인 |
| 3 | 기능 | unplayed 슬라이더를 card 이상으로 설정 시 자동 클램프 | UI 조작으로 확인 |
| 4 | 기능 | 추천 카드 클릭 → `https://store.steampowered.com/app/{appid}/` 새 탭 | DOM 확인 또는 클릭 테스트 |
| 5 | 기능 | 위시리스트 비어있을 때 트랙 B "위시리스트가 비어있습니다" 안내 | 위시리스트 없는 계정 또는 mock으로 확인 |
| 6 | 코드 | 타입 확장 + 신규 모듈 + 신규 라우트 + 신규 페이지 모두 생성 | git status |
| 7 | 코드 | 매칭이 id 기반 (description 변경에 비의존적) | 코드 리뷰 (Momus C3) |
| 8 | 코드 | SSE cancel 패턴이 선례와 동일 | 코드 리뷰 (Momus C1) |
| 9 | 코드 | `unplayedMax ≤ cardFarmingMax` 검증 강제 | `validateAnalyzeOptions` 테스트 (#13) |
| 10 | 테스트 | `__tests__/profile.test.ts` 15개 케이스 통과 | `npm test -- profile` |
| 11 | 테스트 | 베이스 commit `1a029c3` 기준 기존 테스트 통과 수가 유지 (이번 작업으로 신규 추가 외에 기존 테스트가 줄거나 실패하지 않음) | 베이스에서 `npm test` 수치 기록 → 현재 결과 비교 |
| 12 | 빌드 | `npm run lint` 통과 | 명령 실행 |
| 13 | 빌드 | `npm run build` 통과 (standalone 산출물 정상) | 명령 실행 |
| 14 | 동작 | 본인 계정으로 캐시 콜드 1회 + 캐시 핫 1회 완주 | 두 차례 분석 후 진행시간 기록 |
| 15 | 동작 | SSE 중 페이지 떠나면 서버 로그에 cancel 진입 흔적 | 로그 확인 또는 cancel 콜백 호출 로그 추가 |
| 16 | 산출물 | 부록 A의 모든 TBD 행이 측정값 또는 "조정 없음"으로 채워짐 | 본 문서 부록 A 검토 |
| 17 | 산출물 | 측정 결과에 따라 `DEFAULT_ANALYZE_OPTIONS`의 `W_CAT`/`cardFarmingMaxMinutes` 값이 룰표대로 결정 | 코드 vs 부록 A 일치 확인 |

---

## 7. 리스크와 대응

| # | 리스크 | 가능성 | 영향 | 대응 |
|---|--------|--------|------|------|
| R1 | Steam appDetails 응답 키 변경 (genres/categories 누락) | 낮음 | 분석 불가 | 옵셔널 타입 + 빈 배열 fallback, 로그 |
| R2 | 1000+ 게임 사용자 첫 분석 지연 (≈5.5분) | 중간 | 이탈 | UI 사전 안내 + 진행률, 캐시 핫에서 즉시 |
| R3 | 카드 농사 기본 180분이 짧은 인디 진심 플레이를 잘못 배제 | 중간 | 정확도 | 사용자 슬라이더 조정 가능 + 안내 |
| R4 | Steam 장르(Action 등) 거칠어 변별력 부족 | 중간 | 추천 다양성 | 단계 0 사전 측정 후 가중치 조정, categories 결합 |
| R5 | 미플레이 후보 0건 (모든 게임이 unplayedMax 초과 + 카드 농사 초과) | 낮음 | 트랙 A 빈 결과 | "unplayedMax 슬라이더를 올려보세요" 문구 |
| R5b | **분석 풀=0** (라이브러리 모두 unplayed 또는 card-farming, analyzed=0) → 성향 추출 불가 → 트랙 A·B 모두 점수 0 | 중간 | 두 트랙 모두 빈 결과인데 위시리스트만 있는 사용자가 혼란 | 위시리스트가 존재하는데 트랙 B가 비면 UI에 별도 안내: "성향 분석에 사용할 충분한 플레이 이력이 없습니다. cardFarmingMax를 낮추거나 더 플레이 후 재방문하세요." |
| R6 | SSE 도중 사용자 페이지 떠남 | 중간 | 리소스 낭비 | 선례 cancel 패턴 차용 (Momus C1 해소) |
| R7 | 동시 다중 사용자로 LRU eviction → 캐시 콜드 빈발 | 낮음 | 응답 지연 | 운영 모니터링 항목 (1차 별도 조치 없음) |
| R8 | 위시리스트 메타 다수 캐시 미스로 트랙 B 지연 | 중간 | 분석 지연 | 라이브러리·위시리스트 메타를 합쳐 한 번에 배치 처리 (중복 appid 자동 제거) |
| R9 | 추천 사유 한국어 고정 → 향후 i18n 비용 | 낮음 | 후속 작업 부담 | 서버는 라벨만 반환, 사유 문구는 클라이언트에서 조립 (Momus M5 해소) |
| R10 | 분석 결과가 사용자 직관과 어긋남 | 높음 | UX 불만 | 매칭 장르/카테고리 칩 노출로 투명성 |
| R11 | **초대형 라이브러리(5,000+) Rate Limit 폭증** — 단계 0 측정에서 실측 확인 | 중간 (해당 사용자에 한해 높음) | 첫 분석 사실상 불가, metaMissing 다수, analysisInsufficient | 1차 범위: UI 안내 "라이브러리가 매우 크면 첫 분석이 실패하거나 매우 오래 걸릴 수 있습니다." 후속: 적응형 동시성/딜레이, 또는 캐시 히트분만 즉시 분석하는 모드 (부록 A 후속 조치 참조) |

---

## 8. 후속 확장 여지

- 위시리스트 우선순위(priority)나 추가일(date_added)을 추천 점수에 가산
- 친구 라이브러리 비교 ("친구가 좋아하는데 나는 안 한 게임")
- 분석 결과 캐싱 (`profile:{steamId}:{optsHash}` 키, 단기 TTL)
- 추천 결과 공유 카드(PNG) 생성
- Steam Spy 등 외부 태그 결합으로 변별력 강화
- 미플레이 가산점: `rtime_last_played`가 매우 오래된 게임에 가산 ("잊고 있던 게임 환기")

---

## 9. 변경 파일 요약

| 파일 | 종류 | 변경 |
|------|------|------|
| `lib/steam/types.ts` | 수정 | `SteamGenre`, `SteamCategory`, `SteamAppDetails` 옵셔널 필드 |
| `lib/steam/profile.ts` | 신규 | 분석·추천 함수 + 옵션 검증 |
| `lib/steam/api.ts` | 수정 | `getAppDetailsBatch` 헬퍼 추가 |
| `app/api/recommend/route.ts` | 신규 | SSE 추천 API |
| `app/recommend/page.tsx` | 신규 | 추천 페이지 |
| `app/feed/page.tsx` | 수정 | "성향 분석" 진입점 링크 |
| `__tests__/profile.test.ts` | 신규 | 15개 케이스 |
| `__tests__/steam-types.test.ts` | 수정 | 신규 옵셔널 필드 케이스 |
| `docs/20260527_01_profile_analysis_recommendation.md` | 신규 (본 문서) | — |

---

## 부록 A — 단계 0 사전 측정 결과 (완료)

| 항목 | 측정값 | 비고 |
|------|--------|------|
| 측정 일자 | 2026-05-27 | |
| Steam ID | 76561198056932899 (vanity: migurazi) | |
| 라이브러리 크기 | **5,347** | 작업 지시서 4.4 표의 1000+ 시나리오 초과 |
| 위시리스트 크기 | **3,597** | |
| 유니크 appid (라이브러리 ∪ 위시리스트) | **8,944** | |
| 측정 소요시간 (캐시 콜드, 백그라운드) | **약 58분 (3,525초)** | 다수 429 발생에도 결국 완주 |
| classify 분포 (기본 옵션) | unplayed **2,098** / card-farming **206** / analyzed **3,043** / excluded-free 0 | 합계 5,347 |
| metaMissing (analyzed 중 메타 누락) | **2,315** | success=false + 일부 Rate Limit 잔여. 분석 풀 3043 중 실효 신호 기여는 728개 |
| 장르 종류 (분석 풀 기준) | **26**개 | |
| 장르 엔트로피 (Shannon) | **2.962** | ≥ 2.5 → 조정 룰 트리거 |
| 카테고리 종류 (분석 풀 기준) | **54**개 | |
| 카테고리 엔트로피 (Shannon) | **4.296** | (참고용, 룰 사용 안 함) |
| `W_CAT` 최종 결정값 | **0.3 (0.5 → 0.3 하향)** | 룰표 적용. 코드 갱신됨 (`lib/steam/profile.ts`) |
| `cardFarmingMaxMinutes` 최종 결정값 | **180 (기본 유지)** | cardMax=180에서 카드 농사 3.9% < 5% — 240 상향은 룰표상 "안 해도 됨"으로 분류, 유지 |
| `unplayedMaxMinutes` 최종 결정값 | **60 (기본 유지)** | |

### Top 10 장르 (분석 풀 기준, weight 내림차순)

| id | label | weight | share |
|----|-------|-------:|------:|
| 23 | 인디 | 2800.06 | 25.4% |
| 1 | 액션 | 2044.76 | 18.6% |
| 25 | 어드벤처 | 1971.36 | 17.9% |
| 4 | 캐주얼 | 1285.52 | 11.7% |
| 2 | 전략 | 876.26 | 8.0% |
| 3 | RPG | 862.00 | 7.8% |
| 28 | 시뮬레이션 | 604.77 | 5.5% |
| 9 | 레이싱 | 147.83 | 1.3% |
| 18 | 스포츠 | 97.60 | 0.9% |
| 37 | 무료 플레이 | 76.15 | 0.7% |

### Top 10 카테고리 (분석 풀 기준)

| id | label | weight | share |
|----|-------|-------:|------:|
| 2 | 싱글 플레이어 | 4071.88 | 13.6% |
| 62 | 가족 공유 | 4023.22 | 13.4% |
| 29 | Steam 트레이딩 카드 | 3828.13 | 12.8% |
| 22 | Steam 도전 과제 | 3322.92 | 11.1% |
| 23 | Steam Cloud | 2310.60 | 7.7% |
| 28 | 컨트롤러 완벽 지원 | 1692.20 | 5.7% |
| 1 | 멀티플레이어 | 1169.80 | 3.9% |
| 25 | Steam 순위표 | 722.06 | 2.4% |
| 43 | Remote Play TV | 694.79 | 2.3% |
| 9 | 협동 | 628.50 | 2.1% |

### cardFarmingMax 후보별 카드 농사 분류 수 (unplayedMax=60 고정)

| cardMax (분) | 카드 농사 수 | 라이브러리 대비 |
|-------------:|------------:|----------------:|
| 60 | 0 | 0.0% |
| 120 | 91 | 1.7% |
| **180** (기본) | **206** | **3.9%** |
| 240 | 749 | 14.0% |
| 300 | 2017 | 37.7% |

### unplayedMax 후보별 미플레이 분류 수 (cardMax=180 고정)

| unplayedMax (분) | 미플레이 수 | 라이브러리 대비 |
|-----------------:|------------:|----------------:|
| 0 | 1865 | 34.9% |
| 30 | 2024 | 37.9% |
| **60** (기본) | **2098** | **39.2%** |
| 120 | 2189 | 40.9% |

### 측정 발견 사항

1. **Rate Limit 폭증과 결국 완주** — `STEAM_API_DELAY.appDetails=1000ms` ×
   `STREAM_CONCURRENCY=3` = 초당 ~3회는 store.steampowered.com 비공식 API
   한계 부근. 50개 호출 직후 429 시작, 그러나 1000ms 딜레이 + 캐시 미스만
   재시도 안 함 (cacheSet=null 안 함)이 누적되어 58분에 걸쳐 결국 8944개
   모두 캐시에 자리잡음. 다만 metaMissing 2315로 실효 신호는 절반에도
   못 미침.

2. **장르 신호가 풍부** — 26개 장르가 등장했고 엔트로피 2.962. Top 3
   (인디·액션·어드벤처)가 61.9% 점유라 일정한 편향이 있지만 다양성 유지.
   조정 룰에 따라 **W_CAT을 0.3으로 하향**한 것은 합리적 — 카테고리는
   "싱글 플레이어 13.6%"처럼 거의 보편적 신호라 변별력이 낮다.

3. **R11 검증** — 5,000+ 라이브러리 사용자가 분석을 받으려면 실제로 약 1시간이
   소요. 운영 환경에서는 SSE가 1시간 동안 열려 있어야 하고, 사용자는 그동안
   브라우저를 켜 두어야 한다. 후속에서 적응형 동시성 또는 분산 백그라운드
   분석 방식 검토 필요.

### 후속 조치 (1차 범위 외, R11)

- 초대형 라이브러리(5,000+) 적응형 동시성: 429 응답 빈도에 따라
  `STREAM_CONCURRENCY` 동적 하향 + 딜레이 증가
- 또는 메타 조회를 비동기 백그라운드로 분리 후 캐시 히트분만 즉시 분석
- 또는 위시리스트만 우선 분석 (라이브러리 메타 누적은 별도 워커)
