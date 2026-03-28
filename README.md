# Steam Review Feed

[English](README.en.md) | **한국어**

Steam 위시리스트/라이브러리 게임들의 최신 리뷰를 한 피드에서 모아보는 서비스.

## 스크린샷

| 홈 화면 | 리뷰 피드 |
|---------|-----------|
| ![홈 화면](docs/screenshots/home.png) | ![리뷰 피드](docs/screenshots/feed.png) |

## 주요 기능

- **통합 리뷰 피드** — 위시리스트·라이브러리 게임의 최신 리뷰를 한 화면에서 확인
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
| 캐시 | lru-cache (인메모리) |
| 인증 | Steam OpenID |
| 동영상 | hls.js (HLS 스트리밍) |
| 테스트 | Vitest (77개 테스트) |
| 배포 | Docker + GitLab CI/CD |

## 프로젝트 구조

```
├── app/
│   ├── api/           # API 라우트 (auth, cache, reviews, search, wishlist, library, media)
│   ├── feed/          # 통합 리뷰 피드 페이지
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
│   └── steam/         # Steam API 클라이언트, 타입, 정렬, 필터
├── __tests__/         # 단위 테스트 (11파일 77개)
├── middleware.ts       # 인증 미들웨어 (Edge Runtime)
├── Dockerfile
├── docker-compose.yml
├── .gitlab-ci.yml     # GitLab CI/CD 파이프라인
└── nginx.conf
```

## 시작하기

### 사전 요구사항

- Node.js 20+
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
