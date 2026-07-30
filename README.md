# Steam Review Feed

[English](README.en.md) | **한국어**

Steam 위시리스트/라이브러리 게임들의 최신 리뷰를 한 피드에서 모아보는 서비스.

## 스크린샷

| 홈 화면 | 리뷰 피드 |
|---------|-----------|
| ![홈 화면](docs/screenshots/home.png) | ![리뷰 피드](docs/screenshots/feed.png) |

## 주요 기능

- **통합 리뷰 피드** — 위시리스트·라이브러리 게임의 최신 리뷰를 한 화면에서 확인
- **성향 분석 + 보유 게임 추천** (`/recommend`) — 라이브러리 플레이타임에서 장르·카테고리 신호를 추출하여 두 트랙(라이브러리 미플레이 / 위시리스트)으로 추천. **코사인 유사도**로 취향을 매칭해 태그가 많은 게임의 편향을 제거하고, **리뷰 호평률을 랭킹에 블렌딩**(0.65·취향 + 0.35·호평)하여 "취향 + 평 좋은 게임" 순으로 정렬하고 각 추천 카드에 호평률 배지 표시. 카드 농사용 단기 플레이는 사용자 조정 가능한 임계값으로 제외
- **Steam 로그인** — Steam OpenID 로그인 또는 Steam ID 직접 입력
- **SSE 점진적 로딩** — 게임별 리뷰가 병렬로 수집되어 실시간 스트리밍
- **다양한 필터** — 언어, 기간, 플레이타임, 글자수, 추천/비추천, 무료 게임 제외
- **게임 검색** — 비로그인 상태에서도 게임 이름으로 검색 후 리뷰 조회
- **게임별 리뷰** — 개별 게임 페이지에서 리뷰 상세 보기
- **미디어 갤러리** — 게임 이름 hover 시 동영상/스크린샷 팝업 (이전/다음 탐색), 게임 상세 페이지 통합 미디어 갤러리
- **Light/Dark 테마** — 시스템 설정 자동 감지 + 수동 토글 (light/dark/system)

## 기술 스택

| 영역 | 기술 |
|------|------|
| 프레임워크 | Next.js 16 (App Router, TypeScript) |
| 스타일링 | Tailwind CSS 4 (class 기반 dark mode) |
| DB | SQLite (better-sqlite3) — 사용자/게임 목록 영속화 |
| 세션 | iron-session (서명된 쿠키) |
| 캐시 | lru-cache (인메모리) + SQLite 영속 캐시 (게임 메타·추천 결과) |
| 인증 | Steam OpenID |
| 동영상 | hls.js (HLS 스트리밍) |
| 테스트 | Vitest (128개 테스트) |
| 배포 | Docker + GitLab CI/CD |

## 프로젝트 구조

```
├── app/
│   ├── api/           # API 라우트 (auth, cache, reviews, search, wishlist, library, media, recommend)
│   ├── feed/          # 통합 리뷰 피드 페이지
│   ├── recommend/     # 성향 분석 + 추천 페이지
│   ├── game/[appId]/  # 게임별 리뷰 페이지
│   ├── privacy/       # 개인정보 처리방침
│   ├── layout.tsx     # 루트 레이아웃 (ThemeProvider, FOUC 방지)
│   └── page.tsx       # 홈 (로그인/검색)
├── components/        # React 컴포넌트 (ThemeProvider, MediaPlayer, ReviewCard 등)
├── lib/
│   ├── constants.ts   # 전역 상수 (PAGE_SIZE, RATE_LIMIT 등)
│   ├── env.ts         # 환경변수 검증
│   ├── init.ts        # 서버 초기화 (env 검증 + DB 스케줄러)
│   ├── cache.ts       # 인메모리 TTL + LRU 캐시
│   ├── db.ts          # SQLite DB 초기화 및 쿼리
│   ├── logger.ts      # JSONL 이벤트 로깅
│   ├── rate-limit.ts  # 사용자당 Rate Limit
│   ├── session.ts     # iron-session 세션 관리
│   └── steam/         # Steam API 클라이언트, 타입, 정렬, 필터, 성향 분석(profile)
├── __tests__/         # 단위 테스트 (13파일 128개)
├── middleware.ts       # 인증 미들웨어 (Edge Runtime)
├── Dockerfile
├── docker-compose.yml
├── .gitlab-ci.yml     # GitLab CI/CD 파이프라인
└── nginx.conf
```

## 시작하기

### 사전 요구사항

- **Node.js 20+** ([공식 다운로드](https://nodejs.org/ko/download))
  - Windows에서 `setup.bat`을 실행하면 Node.js가 없을 경우 winget으로 자동 설치 가능
  - winget 직접 사용: `winget install OpenJS.NodeJS.LTS`
- Steam Web API Key ([여기서 발급받기](https://steamcommunity.com/dev/apikey))

### 1. 환경 변수 설정

프로젝트 루트에 `.env.local` 파일을 생성합니다:

```env
STEAM_API_KEY=발급받은_API_키
SESSION_SECRET=32자_이상_랜덤_문자열
NEXT_PUBLIC_BASE_URL=http://localhost:3000
```

> `STEAM_API_KEY`와 `SESSION_SECRET`은 필수입니다. 설정하지 않으면 서버 시작 시 경고가 표시됩니다.

### 2. 설치 및 실행

#### 윈도우일 때 실행하는 법 (Batch 파일, 권장)

프로젝트 루트의 `.bat` 파일을 **더블클릭**만 하면 됩니다. 각 스크립트는 선행 조건(`node_modules`, `.env.local`, standalone 빌드)을 자동 검사합니다.

| 파일 | 동작 |
|------|------|
| `setup.bat` | `npm install` + `.env.local` 자동 생성 (SESSION_SECRET 32바이트 랜덤 발급) |
| `dev.bat` | 개발 서버 (`npm run dev`) |
| `build.bat` | 프로덕션 빌드 (`npm run build`) |
| `start.bat` | standalone 서버 실행 (`npm run start:standalone`) |

처음 받았다면 `setup.bat` 실행 후 생성된 `.env.local`의 `STEAM_API_KEY`만 직접 입력하면 바로 사용 가능합니다.

#### 수동 실행 (npm)

```bash
# 의존성 설치
npm install

# 개발 서버
npm run dev

# 테스트
npm test

# 프로덕션 빌드 (standalone + 정적 파일 자동 복사)
npm run build

# 프로덕션 실행
npm run start:standalone
```

> **참고:** `start:standalone`은 `.env.local`을 `--env-file`로 자동 로드합니다. standalone 모드에서는 Next.js가 `.env.local`을 직접 읽지 않기 때문입니다.

http://localhost:3000 에서 접속합니다.

### 3. Docker 배포

```bash
# .env 파일 생성 (docker-compose가 자동 로드)
cp .env.local .env

# 빌드 및 실행
docker-compose up --build
```

`data/` 볼륨에 SQLite DB가 저장됩니다.
Nginx 리버스 프록시가 필요하면 `docker-compose.yml`에서 nginx 서비스의 주석을 해제하세요.

### 4. GitLab CI/CD

`.gitlab-ci.yml`이 포함되어 있습니다. GitLab > Settings > CI/CD > Variables에 다음 변수를 등록하세요:

| 변수 | 설명 |
|------|------|
| `SSH_PRIVATE_KEY` | 배포 서버 SSH 키 |
| `SSH_KNOWN_HOSTS` | 배포 서버 known_hosts |
| `SSH_USER` / `SSH_HOST` | 배포 서버 접속 정보 |
| `STEAM_API_KEY` | Steam API 키 |
| `SESSION_SECRET` | 세션 암호화 키 |
| `NEXT_PUBLIC_BASE_URL` | 서비스 URL |

파이프라인: `develop`/`main` push -> Docker 이미지 빌드 -> GitLab Registry push -> 수동 배포

## npm 스크립트

| 명령 | 설명 |
|------|------|
| `npm run dev` | 개발 서버 (HMR, .env.local 자동 로드) |
| `npm run build` | 프로덕션 빌드 + standalone 정적 파일 복사 |
| `npm run start` | next start (개발용 프로덕션 서버) |
| `npm run start:standalone` | standalone 서버 (.env.local 자동 로드) |
| `npm run lint` | ESLint 검사 |
| `npm test` | Vitest 테스트 실행 |

## 성능 / 캐시

### 첫 분석이 느린 이유 (`/recommend`)

라이브러리가 클수록 **첫 분석**이 오래 걸립니다. Steam의 `appdetails` API가 비공식이라
Rate Limit이 엄격(~40 req/min)해서, 게임 메타(장르·카테고리)를 **게임당 약 1.5초씩
직렬로** 조회하기 때문입니다. 이보다 빠르게 요청하면 Steam이 429로 차단하고 모든
응답이 실패하는 악순환이 생겨, 의도적으로 보수적인 속도로 맞춰져 있습니다.

- 예: 5000개 라이브러리 첫 분석 ≈ 2시간. 300개면 ≈ 8분.
- **캐시 후에는 빠릅니다.** 조회한 메타는 인메모리 LRU + **SQLite 영속 캐시**
  (`app_details_cache`, 7일)에 저장되어, 재분석·서버 재시작 후에도 즉시 재사용됩니다.
  최종 추천 결과 자체도 `recommendation_cache`에 저장되어 다음 방문 시 즉시 표시됩니다.
- 분석 도중 탭을 닫아도 그때까지 모은 부분 결과가 저장되어, 다음 방문 시 이어서 봅니다.
- 팁: 첫 분석은 한 번만 견디면 됩니다. 옵션(임계값)을 바꾸면 해당 조합으로 다시
  분석하지만, 게임 메타는 이미 캐시되어 있어 훨씬 빠릅니다.

### 빠른 모드 (`/recommend` 옵션)

첫 분석을 기다리기 어렵다면 옵션 패널의 **빠른 모드**를 켜세요. 메타 조회 대상
(미플레이 후보·성향 분석용 게임)에 상한을 두어 대형 라이브러리도 몇 분 내로 끝납니다.

- 후보는 플레이타임 순으로, 성향은 최다 플레이 게임 위주로 표본을 뽑으므로 상한
  밖 게임은 추천에서 빠질 수 있습니다(완결성↔속도 트레이드오프).
- 빠른/전체 결과는 캐시 키가 분리되어 서로 덮어쓰지 않습니다. 빠른 모드로 훑어본 뒤
  체크를 해제하면 전체 분석이 백그라운드로 돌아가며, 완료되면 결과가 갱신됩니다.
- 참고로 카드팜용 단기 플레이 게임(임계값 구간)은 모드와 무관하게 메타 조회를
  생략합니다 — 어차피 분석·추천에서 제외되는 게임이라 결과에 영향이 없습니다.

## 트러블슈팅

### Windows PowerShell에서 `npm` 실행 시 보안 오류

```
npm : 이 시스템에서 스크립트를 실행할 수 없으므로 ...
+ CategoryInfo : 보안 오류: (:) [], PSSecurityException
```

**방법 1 — 실행 정책 변경 (관리자 PowerShell, 영구)**
```powershell
Set-ExecutionPolicy RemoteSigned
```

**방법 2 — 현재 세션에서만 허용**
```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy RemoteSigned
```

**방법 3 — cmd에서 실행**
```
cmd
npm install
```

### standalone 실행 시 CSS가 적용되지 않음

`npm run build`가 `postbuild` 스크립트로 정적 파일을 자동 복사합니다.
수동으로 빌드한 경우 정적 파일을 직접 복사하세요:

```bash
cp -r .next/static .next/standalone/.next/static
cp -r public .next/standalone/public
```

### standalone 실행 시 환경변수 오류

standalone 모드에서는 `.env.local`이 자동 로드되지 않습니다:

```bash
# 올바른 실행 방법
node --env-file .env.local .next/standalone/server.js

# 또는 npm script 사용
npm run start:standalone
```

## 라이선스

[MIT](LICENSE)
