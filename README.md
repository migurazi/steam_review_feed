# Steam Review Feed

Steam 위시리스트/라이브러리 게임들의 최신 리뷰를 한 피드에서 모아보는 서비스.

## 스크린샷

| 홈 화면 | 리뷰 피드 |
|---------|-----------|
| ![홈 화면](docs/screenshots/home.png) | ![리뷰 피드](docs/screenshots/feed.png) |

## 주요 기능

- **통합 리뷰 피드** — 위시리스트·라이브러리 게임의 최신 리뷰를 한 화면에서 확인
- **Steam 로그인** — Steam OpenID 로그인 또는 Steam ID 직접 입력
- **SSE 점진적 로딩** — 게임별 리뷰가 순차적으로 도착하는 실시간 스트리밍
- **다양한 필터** — 언어, 기간, 플레이타임, 글자수, 추천/비추천, 무료 게임 제외
- **게임 검색** — 비로그인 상태에서도 게임 이름으로 검색 후 리뷰 조회
- **게임별 리뷰** — 개별 게임 페이지에서 리뷰 상세 보기

## 기술 스택

| 영역 | 기술 |
|------|------|
| 프레임워크 | Next.js 16 (App Router, TypeScript) |
| 스타일링 | Tailwind CSS 4 |
| DB | SQLite (better-sqlite3) — 사용자/게임 목록 영속화 |
| 세션 | iron-session (서명된 쿠키) |
| 캐시 | lru-cache (인메모리) |
| 인증 | Steam OpenID |
| 배포 | Docker (Nginx 리버스 프록시 설정 포함) |

## 프로젝트 구조

```
├── app/
│   ├── api/           # API 라우트 (auth, cache, reviews, search, wishlist, library)
│   ├── feed/          # 통합 리뷰 피드 페이지
│   ├── game/[appId]/  # 게임별 리뷰 페이지
│   ├── privacy/       # 개인정보 처리방침
│   ├── layout.tsx     # 루트 레이아웃
│   └── page.tsx       # 홈 (로그인/검색)
├── components/        # React 컴포넌트
├── lib/               # 유틸리티 (캐시, DB, 세션, Rate Limit, Steam API)
├── middleware.ts       # 인증 미들웨어
├── docs/              # 기획 문서, 스크린샷
├── __tests__/         # 테스트
├── data/              # SQLite DB (gitignore)
├── logs/              # 이벤트 로그 (gitignore)
├── Dockerfile
├── docker-compose.yml
└── nginx.conf
```

## 시작하기

### 사전 요구사항

- Node.js 20+
- Steam Web API Key ([발급](https://steamcommunity.com/dev/apikey))

### 1. 환경 변수 설정

프로젝트 루트에 `.env.local` 파일을 생성합니다:

```env
STEAM_API_KEY=발급받은_API_키
SESSION_SECRET=32자_이상_랜덤_문자열
NEXT_PUBLIC_BASE_URL=http://localhost:3000
```

> `STEAM_API_KEY`와 `SESSION_SECRET`은 필수입니다. 설정하지 않으면 서버가 시작되지 않습니다.

### 2. 설치 및 실행

```bash
# 의존성 설치
npm install

# 개발 서버
npm run dev

# 테스트
npm test

# 프로덕션 빌드 + 실행
npm run build
node .next/standalone/server.js
```

http://localhost:3000 에서 접속합니다.

### 3. Docker 배포

Docker 실행 전 환경변수를 설정합니다:

```bash
# .env 파일 생성 (docker-compose가 자동 로드)
cp .env.local .env

# 빌드 및 실행
docker-compose up --build
```

`data/` 볼륨에 SQLite DB가 저장됩니다.
Nginx 리버스 프록시가 필요하면 `docker-compose.yml`에서 nginx 서비스의 주석을 해제하세요.

## 트러블슈팅

### Windows PowerShell에서 `npm` 실행 시 보안 오류

```
npm : 이 시스템에서 스크립트를 실행할 수 없으므로 ...
+ CategoryInfo : 보안 오류: (:) [], PSSecurityException
```

PowerShell 실행 정책이 스크립트 실행을 차단하는 경우입니다. 아래 방법 중 하나를 선택하세요:

**방법 1 — 실행 정책 변경 (관리자 PowerShell에서 실행, 영구 적용)**
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

## 라이선스

[MIT](LICENSE)
