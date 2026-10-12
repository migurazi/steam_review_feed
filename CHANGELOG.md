# Changelog

이 프로젝트의 모든 주요 변경 사항을 기록합니다.
형식은 [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/)를 따릅니다.

## [Unreleased]

### Added

- **번들 차트 메이커** (`/bundle`) — Steam 게임 번들을 게시판에 소개할 표 생성 도구
  - 3가지 입력: IsThereAnyDeal 최신 번들 목록 조회·필터·선택 / ITAD 번들 URL 붙여넣기 / 수동 입력(스토어 URL·appID·이름 검색 + Steam 패키지/번들 전개)
  - 4포맷 출력: SteamGifts 마크다운 · BBCode · 일반 마크다운 · HTML (각각 클립보드 복사·파일 다운로드·원문/미리보기 토글)
  - 게임 행: 썸네일 · 게임명(스토어 링크) · 현재가/정가/할인율(KRW) · 호평률 배지 · DLC 표시 · 불확실 매칭 "?" 표시
  - 티어 구조 편집(Humble "Beat the Average" 등): 추가/삭제/이름/가격 규칙(정가 합·고정가·N개 선택·N% 할인) · 게임 이동
  - 환율 변환(신규): 무료 API(open.er-api.com, base USD, 12시간 캐시)로 번들 가격 USD→KRW 환산하여 "지불 $27.00 (≈₩36,200)" 병기 · 절약 % 계산 · 환산 불가 시 degrade
  - 자유 가격 메모(신규): ITAD가 주지 않는 가격(예: Fanatical 품목당 단가 스케줄) 직접 입력 → 출력 상단 표기
  - HTML 출력: 링크는 새 탭(`target=_blank`), `<table border="1">` 저장 시에도 테두리 표시 · 마크다운/SG/BBCode는 제목·게임명 메타문자 이스케이프
  - 미보유 미매칭 수습: ITAD UUID→Steam appid 매핑 실패분을 이름 검색으로 보강해 원래 티어에 삽입
  - ITAD API 키 선택(무료, https://isthereanydeal.com/apps/my/): 없으면 ITAD 목록 기능 비활성, 수동·Steam 전개·복사·다운로드는 정상
  - 공개 페이지: 비로그인 사용 가능 · 로그인 시 헤더 프로필·로그아웃 표시
  - 보안/견고성: 공개 라우트 입력 상한(배열 ≤100, 전개 대상 ≤10) · ITAD rate limit + outbound 예산 가드 · 미스 음성 캐시 · `.env.local` 쓰기 시 개행 주입 차단 · ITAD 키 형식 검증
- **성향 분석 + 보유 게임 추천** (`/recommend`) — 라이브러리 플레이타임 분포에서
  장르·카테고리 신호를 추출하여 두 트랙으로 추천
  - 트랙 A: 라이브러리에 있지만 안 해본 게임 (`classify`가 'unplayed'로 분류한 후보)
  - 트랙 B: 위시리스트 중 성향과 일치하는 게임
  - 결정론적 룰 기반 (LLM 미사용): 로그 가중치 `log(1 + playtime)`,
    `score = Σ matchedGenre.share + W_CAT × Σ matchedCategory.share`
  - 매칭은 id 기반 (cc=KR 한국어 description에 비의존적)
- **카드 농사 제외 옵션** — 트레이딩 카드 발급용 단기 플레이를 분석에서 제외
  - 세 구간 분류: `pt ≤ unplayedMax`(미플레이) / `unplayedMax < pt < cardFarmingMax`(카드 농사) /
    `pt ≥ cardFarmingMax`(분석 기여)
  - 사용자 슬라이더로 임계값 조정 (기본 60분 / 180분, 두 슬라이더 자동 클램프)
- **SSE 추천 API** — `GET /api/recommend?cardMin=...&unplayedMax=...&tracks=lib,wish`
  - `progress` / `result` / `done` 이벤트 (선례 reviews/stream의 cancel 패턴 차용)
  - `done` 플래그: `libraryFetchFailed`, `wishlistFetchFailed`,
    `analysisInsufficient`, `metaMissingDominant` — 클라이언트가 7가지 빈 상태 분기
- **메타 일괄 조회 헬퍼** — 라이브러리/위시리스트 합산 유니크 appid, `isCancelled` 즉시 반영
  (처음 `getAppDetailsBatch`로 도입, 이후 GetItems 기반 `getStoreMetaBatch`로 대체)
- **타입 확장** — `SteamGenre`, `SteamCategory` + `SteamAppDetails.genres/categories` 옵셔널 필드
- **도전과제 대시보드** (`/achievements`) — 라이브러리 전체의 도전과제 달성 현황을
  SSE로 스캔하여 완주율순으로 표시 (Phase 0–3)
  - 게임을 펼치면 과제별 목록(아이콘 / 전역 희귀도 / 획득 시각) 표시, 상단
    "모두 접기" 버튼으로 펼친 항목 일괄 접기
  - 스캔 중단/재방문 시 지금까지 스캔한 결과를 유지(영속 진행률 upsert), 완료
    후 게임 상세를 다녀와도 재스캔하지 않음
  - **스키마 변경 알림** — 게임의 도전과제 스키마가 갱신되면(추가 / 삭제 /
    완주 깨짐 / 숨김 해제) 알림 배너 노출, day 단위 dedup + 미확인(unseen) dedup
  - Steam Web API: GetSchemaForGame / GetPlayerAchievements(`apiname` 키) /
    GetGlobalAchievementPercentagesForApp
  - 아웃바운드 전역 세마포어 + 일일 콜 예산(`lib/outbound-limit.ts`)으로 Rate Limit 회피
  - LRU + SQLite 이중 캐시 (스키마/전역 달성률/개인 진행률/변경 이력/알림 테이블)
- **게임 상세 도전과제 섹션** (`/game/[appId]`) — 진행률 바 + 희귀 과제 미리보기.
  비로그인은 전역 희귀 과제, 프로필 '게임 세부 정보' 비공개 시 안내 문구
- **셀프호스팅 셋업 마법사** — Steam API 키가 없는 최초 실행 시 브라우저 `/setup`
  화면에서 키만 등록(수동 파일 편집 불필요), `.env.local`에 기록 후 즉시 반영
  - `lib/app-root.ts` — standalone 서버가 `.next/standalone`으로 chdir 하는 문제를
    피해 `INIT_CWD` 기반으로 프로젝트 루트를 찾아 DB/로그/`.env.local` 경로 고정
- **단위 테스트** — 도전과제 diff/store/scan + app-root 등 커버리지 추가.
  128 → 257 → **408 테스트** (30개 파일, 가성비·재정렬·GetItems 메타·캐시 분리 테스트 포함)

- **가성비·할인 추천** (`/recommend`) — 위시리스트 카드에 현재 가격 표시, 할인 매력도
  블렌딩(취향·호평·할인), "할인 중인 게임만" 필터. 가격 조회 실패 시 24시간 이내 마지막 가격을
  회색 + "N시간 전 가격"으로 표시
- **미보유 할인 게임 발굴** 트랙 (옵션) — 스토어 할인 게임 중 라이브러리·위시리스트에 없고 취향에
  맞으며 리뷰 10개 이상인 게임 추천 (시간 예산 120초)
- **즉시 재정렬** — 가성비·할인만·추천 개수 변경은 서버 재분석 없이 클라이언트가 재정렬
  (`lib/recommend-rerank.ts`). 서버가 후보 풀(라이브러리·위시·발굴 + 리뷰 요약)을 내려주고 결과
  캐시에도 저장. 세 옵션은 캐시 키에서 제외. 풀 밖 리뷰는 `GET /api/recommend/reviews`로 보충
- `/recommend` 결과 섹션(라이브러리·위시리스트·할인 발굴) 접기/펼치기

### Changed

- **상단 네비게이션 통일**: 모든 페이지(`/feed` · `/recommend` · `/achievements` · `/bundle`)가 공용 `AppNav` 사용
- **성향 분석 메타 조회를 GetItems 배치로 전환** — 게임마다 `appdetails`(store 호스트, 1.5초
  직렬)를 부르던 것을 `IStoreBrowseService/GetItems` 100개/호출로 교체 (`getStoreMetaBatch`).
  미캐시 5,000개 라이브러리 첫 분석 약 2시간 → 1분 안팎, 게임당 응답 20KB+ → 2–3KB
  - 장르는 상위 사용자 태그 중 Steam 장르 태그로 산출 (`lib/steam/store-meta.ts`), 카테고리 이름은
    `GetStoreCategories`. 영속 캐시는 새 테이블 `store_meta_cache` (기존 캐시는 1회 재조회)
  - 같은 응답으로 리뷰 요약·스토어 요약·가격·`app_meta`(이름·헤더 이미지) 캐시를 함께 채움.
    리뷰 호평률은 appreviews 개별 호출 대신 GetItems 요약 사용 (호평률 ±1%p 차이 가능)
  - 위시리스트 가격도 GetItems로 조회 (`getStoreItemPricesBatch`). 결과 계약은 기존 가격 배치와 동일
- 할인 발굴 후보 메타도 GetItems 배치 사용
- partial 결과 캐시 쓰기를 30초 간격으로 제한 (이전 3초). partial-result 중복 판단은 목록 모양만 비교하고
  재정렬 풀은 30초 간격으로 별도 전송
- 인메모리 캐시 분리 — 게임 단위 키(`storemeta:`·`reviewsummary:`·`storeitem:`·`app:{id}:price:`)는
  전용 LRU(60,000)로, 일반 LRU(10,000)는 그 밖의 키만. 대형 라이브러리 첫 분석이 같은 분석의 리뷰·가격과
  다른 사용자 캐시를 밀어내던 문제 해소
- 조기 위시 단계에서 라이브러리 분석(성향 계산)을 한 번만 하고 재사용 (이전 3회)
- `/feed` 헤더에 "성향 분석" 진입점 링크 추가
- `EventType`에 `recommend_analyze` 추가 (`lib/logger.ts`)
- 상단 네비게이션(`AppNav`)에 도전과제 탭 추가
- DB/로그/`.env.local` 경로를 `lib/app-root.ts`의 `APP_ROOT` 기준으로 통일
  (standalone 실행 시 데이터가 `.next/standalone` 하위로 흩어지던 문제 해소)

### Fixed

- GetItems `is_free`가 100% 할인 배포(한정 무료)에도 true라 무료 게임으로 분류되던 문제 —
  F2P와 구분 (`storeItemIsFreeToPlay`)
- 묶음 패키지 가격이 게임 가격으로 캐시·표시되던 문제, 구매 옵션 없는 유료 게임 응답이 마지막
  가격(last-known)을 지우던 문제 (`storeItemPriceIsAppPrice`)
- 카테고리 이름 조회 실패 시 "카테고리 {id}" 라벨이 7일간 영속 저장되던 문제
- 리뷰 없는 게임(출시 예정 등)을 분석마다 다시 조회하던 문제 — "리뷰 없음"을 1시간 캐시
- 번들 행만 있는 할인 검색 페이지에서 후보 순회가 멈추던 문제
- 가격 조회 `success:false`(판매 불가)가 마지막 가격을 덮어쓰던 문제, 24시간 넘은 묵은 가격이
  fallback으로 쓰이던 문제, 429 backoff가 장시간 유휴 후에도 남던 문제
- 최저 구매 옵션이 묶음뿐인 게임이 "판매 불가"로 기록되던 문제 — 위시 가격은 appdetails로 단품 가격 보충
- GetItems 장애 시 메타가 전부 없어 "분석 불가"가 되던 문제 — 만료된 이전 메타로 fallback
- 카테고리 이름 재조회가 한 번 실패하면 이후 계속 이름 없이 동작하던 문제 (이전 값 재캐시, 동시 조회 공유)
- 분석 도중 탭을 닫으면 마지막 partial이 저장되지 않을 수 있던 문제
- 옵션을 바꿨다가 500ms 안에 되돌려도 전체 재분석이 시작되던 문제
- 할인 발굴 진행 중(최대 120초) 재정렬 리뷰 보충이 멈춰 있던 문제
- 할인 후보 메타 진행률이 "0/40"에 머물던 문제

### Notes

- `/bundle` 환율 API는 외부 서비스(open.er-api.com) 의존 — 조회 실패 시 graceful degrade
- ITAD API 키는 선택(무료, 발급 신청 필요) — 없으면 번들 목록 기능만 비활성, 수동 입력·다운로드는 정상
- `W_CAT` 기본값은 단계 0 사전 측정 결과(장르 엔트로피 2.962 ≥ 2.5)에 따라
  조정 룰 적용으로 0.5 → **0.3** 하향. 자세한 측정 데이터는 작업 지시서
  부록 A (`docs/20260527_01_profile_analysis_recommendation.md`) 참조.
- (해소) 라이브러리 5,000+ 사용자의 첫 분석이 appdetails Rate Limit으로 오래 걸리던 문제(R11)는
  GetItems 배치 전환으로 해소.
- 장르 id 체계가 appdetails 장르 id에서 태그 id로 바뀜 — 성향 프로필은 매 분석 새로 계산하므로
  영향 없음. 태그는 사용자 투표 기반이라 appdetails 장르와 일부 다를 수 있음.
- 게임 상세 화면 가격(appdetails 기본 패키지)과 추천 가격(GetItems 최저 단일 게임 옵션)이 같은 가격
  캐시를 써서, 두 가격이 다른 드문 경우 마지막으로 조회한 쪽이 표시됨.

## [0.3.0] - 2026-03-28

### Added

- **Light/Dark 테마** — 시스템 설정 자동 감지 + 수동 토글 (light/dark/system)
  - ThemeProvider (`useSyncExternalStore` 기반, localStorage 저장)
  - ThemeToggle 컴포넌트 (태양/달/모니터 아이콘 순환)
  - FOUC 방지 인라인 스크립트 (`layout.tsx <head>`)
  - 전체 11개 UI 파일에 Tailwind `dark:` variant 적용
- **hover 미디어 갤러리 탐색** — compact 모드에서도 이전/다음 버튼으로 동영상+스크린샷 탐색
- **GitLab CI/CD** — `.gitlab-ci.yml` (Docker 빌드 -> Registry push -> SSH 배포)
- **환경변수 검증** — 서버 시작 시 필수 환경변수 누락 조기 감지 (`lib/env.ts`)
- **서버 초기화 모듈** — `lib/init.ts` (env 검증 + DB 정리 스케줄러 통합)
- **전역 상수 모듈** — `lib/constants.ts` (PAGE_SIZE, RATE_LIMIT, SESSION_COOKIE_NAME 등)
- **정렬/필터 유틸리티 분리** — `lib/steam/sort.ts`, `lib/steam/filters.ts`
- **단위 테스트 대폭 추가** — 20개 -> 77개
  - env (환경변수 검증), constants (상수 값), db (CRUD, 싱글톤)
  - logger (JSONL 기록), sort (엣지 케이스), filters (경계값, 유니코드)
- **npm 스크립트** — `start:standalone`, `postbuild` (정적 파일 자동 복사)

### Changed

- **SSE 스트리밍 병렬화** — 순차 -> 3개씩 배치 병렬 (`Promise.allSettled` + `STREAM_CONCURRENCY`)
- **중복 API 호출 제거** — `checkIsFree` + `getAppDetails` -> `getAppInfo` 통합
- **DB 사이드이펙트 제거** — 모듈 import만으로 스케줄러 시작되던 문제 해결
- **로거 완전 비동기화** — `fs.existsSync` (동기) -> `fs.promises.mkdir` (비동기)
- **Steam API 에러 상세화** — 429/403/5xx 상태별 경고 메시지 구분
- **OpenID 콜백 URL 교정** — standalone 모드 origin 불일치 시 baseUrl 기준 교정
- **SESSION_COOKIE_NAME 일원화** — middleware/session 중복 정의 -> `lib/constants.ts`
- **TextEncoder 재사용** — SSE 이벤트 인코딩 시 모듈 레벨 싱글톤
- **MediaPlayer 간소화** — full/compact 분기 제거, 단일 `MediaGallery` 호출
- **ESLint no-img-element** — 개별 disable 주석 10개 -> eslint.config에서 전역 off

### Fixed

- **캐시 무효화 와일드카드 버그** — `replace("*","")` -> `slice(0,-1)`
- **HTML 스펙 위반** — `<button>` 안의 `<a>` 중첩 -> `<div role="button">`
- **standalone CSS 미적용** — postbuild 스크립트로 정적 파일 자동 복사
- **standalone 환경변수 미로드** — `--env-file` 가이드 및 npm script 추가
- **ESLint 경고 전수 해결** — `void e`, `set-state-in-effect`, `refs-during-render`

## [0.2.0] - 2026-03-27

### Added

- 게임 이름 hover 시 동영상/스크린샷 미리보기 팝업 (GameHoverPreview)
- 게임 상세 페이지 동영상+스크린샷 통합 미디어 갤러리 (이전/다음 탐색)
- HLS 스트리밍 동영상 재생 (hls.js, Safari 네이티브 HLS 지원)
- 미디어 데이터 API 엔드포인트 (`/api/game/[appId]/media`)
- 모바일 hover 비활성화 (`matchMedia` 체크)
- 클라이언트 미디어 캐시 (재hover 시 API 재요청 방지)
- 미디어 API 및 타입 검증 유닛 테스트 10건
- README 한국어/영어 이중 언어 지원
- Windows PowerShell 트러블슈팅 가이드 (README)

## [0.1.0] - 2026-03-26

### Added

- Steam OpenID 로그인 및 Steam ID 직접 입력 지원
- 위시리스트/라이브러리 게임 통합 리뷰 피드
- SSE 기반 점진적 리뷰 로딩
- 리뷰 필터링 (언어, 기간, 플레이타임, 글자수, 추천/비추천, 무료 게임 제외)
- 게임 검색 기능 (비로그인)
- 게임별 리뷰 상세 페이지
- 개인정보 처리방침 페이지
- SQLite 기반 사용자/게임 목록 영속화
- Docker 배포 구성 (Nginx 설정 포함)
- Rate limiting (IP 기반, 분당 30회)
- 이벤트 로깅 시스템
