# Changelog

이 프로젝트의 모든 주요 변경 사항을 기록합니다.
형식은 [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/)를 따릅니다.

## [Unreleased]

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
