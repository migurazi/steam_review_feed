# Changelog

이 프로젝트의 모든 주요 변경 사항을 기록합니다.
형식은 [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/)를 따릅니다.

## [Unreleased]

### Added

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
- **`getAppDetailsBatch` 헬퍼** — `STREAM_CONCURRENCY` 단위 병렬 메타 일괄 조회 +
  `isCancelled` 즉시 반영 (라이브러리/위시리스트 합산 유니크 appid 처리)
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
  128 → **257 테스트** (22개 파일)

### Changed

- `/feed` 헤더에 "성향 분석" 진입점 링크 추가
- `EventType`에 `recommend_analyze` 추가 (`lib/logger.ts`)
- 상단 네비게이션(`AppNav`)에 도전과제 탭 추가
- DB/로그/`.env.local` 경로를 `lib/app-root.ts`의 `APP_ROOT` 기준으로 통일
  (standalone 실행 시 데이터가 `.next/standalone` 하위로 흩어지던 문제 해소)

### Notes

- `W_CAT` 기본값은 단계 0 사전 측정 결과(장르 엔트로피 2.962 ≥ 2.5)에 따라
  조정 룰 적용으로 0.5 → **0.3** 하향. 자세한 측정 데이터는 작업 지시서
  부록 A (`docs/20260527_01_profile_analysis_recommendation.md`) 참조.
- 라이브러리 5,000+ 사용자는 Steam appdetails 비공식 API Rate Limit으로
  첫 분석 완주가 어려울 수 있음 (R11). UI에 안내 노출. 후속에서 적응형
  동시성 검토 예정.

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
