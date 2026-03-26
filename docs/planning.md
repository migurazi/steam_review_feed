# Steam Review Feed Reader - 기획서

## 변경 이력

| 버전 | 날짜 | 비고 |
|------|------|------|
| v1.0 | 2026-03-26 | 초안 |
| v1.1 | 2026-03-26 | Momus 비판적 검토 반영: 위시리스트 API 미검증 대응, 응답 시간 설계, MVP 스택 간소화, 니즈 검증 KPI, 수익화 전략 추가 |
| v1.2 | 2026-03-26 | Phase 0.5 검증 결과 반영: IWishlistService(공식 API) 발견, 인증 방식 변경 (OpenID → API Key + Steam ID), 비공식 API 의존 대폭 감소, 데이터 소스 테이블 전면 수정 |
| v1.3 | 2026-03-26 | 인증 방식 재설계: Steam OpenID(ID 획득용) + 서버 API Key(데이터 조회용) 하이브리드 방식으로 전환. Steam ID 직접 입력은 fallback으로 유지. 기술 스택을 Next.js 풀스택 단일 구조로 전환 (FastAPI 제거, TypeScript 단일 언어). |

---

## 1. 서비스 개요

### 1.1 핵심 가치

Steam 라이브러리/위시리스트에 있는 게임들의 **최신 리뷰를 한 피드에서 모아보는** 서비스. 리뷰에 플레이타임 맥락을 함께 제공하여 리뷰의 신뢰도를 즉시 판단할 수 있게 한다.

### 1.2 문제 정의

| 문제 | 설명 |
|------|------|
| 리뷰 분산 | Steam에서 여러 게임의 리뷰를 보려면 게임별로 스토어 페이지에 직접 들어가야 함 |
| 언어 필터 번거로움 | 한국어 리뷰만 보려면 매번 언어 필터를 수동 변경해야 함 |
| 신규 리뷰 추적 불가 | 위시리스트 게임에 새 리뷰가 올라와도 알 방법이 없음 (세일 알림만 제공) |
| 라이브러리 게임 근황 파악 어려움 | 소유 게임의 패치 후 반응, 최근 평판 변화를 놓치기 쉬움 |

### 1.3 기존 서비스와의 차별점

| 서비스 | 리뷰 기능 | 이 서비스의 차별점 |
|--------|-----------|-------------------|
| Steam | 게임별 리뷰 페이지, 언어 필터 있으나 매번 수동 | 여러 게임 리뷰를 한 피드로 통합 |
| SteamDB | 리뷰 점수 히스토리 차트, 리뷰 본문 미제공 | 실제 리뷰 본문 + 플레이타임 맥락 |
| Augmented Steam | 스토어 페이지 보강 (브라우저 확장) | 독립 서비스, 피드 형식, 교차 게임 집계 |

핵심 차별화: **"내 게임들의 최신 리뷰"를 한곳에서, 원하는 언어로, 플레이타임 맥락과 함께** 볼 수 있는 서비스는 현재 없다.

### 1.4 핵심 가정 및 검증 필요 사항

> 이 서비스의 근본 가정은 **"사용자가 여러 게임의 리뷰를 한 피드에서 모아보고 싶어한다"**는 것이다. 이 니즈 자체가 아직 검증되지 않았으며, Phase 1 출시 후 사용 데이터로 검증해야 한다.

실제 사용 시나리오는 두 가지일 수 있다:
1. **통합 피드** — 여러 게임 리뷰를 시간순으로 훑어보기 (뉴스 피드처럼)
2. **게임별 조회** — 특정 게임의 한국어 리뷰를 빠르게 보기

MVP에서 두 방식 모두 지원하고, 사용 비율을 추적하여 어느 쪽이 실제 니즈인지 검증한다.

---

## 2. 대상 사용자 (Persona)

### Persona A: 신중한 구매자 (Primary)
- **특성**: 위시리스트에 10~50개 게임, 세일 때 구매 결정을 내리기 전 리뷰를 꼼꼼히 읽음
- **니즈**: 위시리스트 게임의 최근 한국어 리뷰를 빠르게 확인
- **사용 빈도**: 주 1~2회, 세일 기간 집중

### Persona B: 라이브러리 관리자 (Secondary)
- **특성**: 수백 개 게임 보유, 업데이트/패치 후 커뮤니티 반응이 궁금함
- **니즈**: 소유 게임의 최근 리뷰 트렌드 파악 (패치 후 반응, 평판 변화)
- **사용 빈도**: 주 1회

### Persona C: 한국어 리뷰 선호 유저 (Tertiary)
- **특성**: 영어 리뷰보다 한국어 리뷰를 선호, 한국 유저 관점의 평가를 원함
- **니즈**: 한국어 리뷰가 있는 게임과 없는 게임을 빠르게 구분
- **사용 빈도**: 비정기, 게임 구매 고려 시

---

## 3. 성공 지표 (KPI)

### Phase 1 (MVP)
| 지표 | 목표 | 측정 방법 |
|------|------|-----------|
| Weekly Active Users | 100 | Analytics |
| 평균 세션 시간 | 2분 이상 | Analytics |
| Steam 로그인 전환율 | 15% 이상 | 방문자 대비 Steam 로그인(또는 ID 입력) 비율 |
| **통합 피드 vs 게임별 조회 비율** | 측정 (목표치 없음) | 이벤트 추적 — 니즈 검증용 |
| **리뷰 필터 사용 비율** | 측정 (목표치 없음) | 어떤 필터가 실제로 쓰이는지 추적 |

> KPI를 보수적으로 조정: WAU 500 → 100. 니치 서비스의 초기 현실에 맞춤. 니즈 검증 지표를 추가.

### Phase 2+
| 지표 | 목표 |
|------|------|
| WAU | 500+ |
| 7일 리텐션 | 15% 이상 |
| 세일 기간 DAU spike | 평상시 대비 3배 |

---

## 4. 용어 정의

| 용어 | 정의 |
|------|------|
| **Review Feed** | 여러 게임의 최신 리뷰를 시간순으로 통합한 목록 |
| **Game View** | 특정 게임의 리뷰만 모아보는 뷰 |
| **Playtime Context** | 리뷰 작성 시점의 플레이타임(`playtime_at_review`)과 현재 총 플레이타임(`playtime_forever`) |
| **Source** | 리뷰를 수집할 게임 목록의 출처 (Library 또는 Wishlist) |

---

## 5. 핵심 기능 명세

### 5.1 사용자 플로우

#### 플로우 A: Steam 로그인 → 위시리스트 리뷰 피드

```
"Steam으로 로그인" 버튼 클릭
  → Steam OpenID 로그인 페이지로 리다이렉트
  → 로그인 완료 → Steam64 ID 자동 획득 (콜백)
  → IWishlistService로 위시리스트 게임 목록 가져오기
  → (필터 적용: 언어, 기간, 플레이타임 등)
  → 리뷰 피드 표시 (점진적 로딩 — 아래 5.4 참조)
    ├─ 통합 피드 탭: 전체 게임 리뷰 시간순
    └─ 게임별 탭: 특정 게임 선택 → 해당 게임 리뷰만
  → 리뷰 클릭 → Steam 스토어 페이지로 이동
```

#### 플로우 B: Steam 로그인 → 라이브러리 리뷰 피드

```
Steam 로그인 완료 상태 (동일 세션이면 재로그인 불필요)
  → IPlayerService/GetOwnedGames로 소유 게임 목록 가져오기
  → 최근 플레이 게임 우선 정렬 (playtime_2weeks > 0인 게임 우선)
  → (필터 적용)
  → 리뷰 피드 표시 (점진적 로딩)
```

#### 플로우 C: 게임 검색 (로그인 불필요)

```
서비스 접속
  → 게임 검색 (이름 또는 AppID)
    - 이름 검색: store.steampowered.com/api/storesearch 활용 (비공식)
    - AppID 직접 입력: appdetails로 유효성 확인
  → 해당 게임의 최신 리뷰 표시 (언어 필터 적용)
  → Steam 로그인 유도 ("위시리스트/라이브러리 전체의 리뷰를 보세요")
```

#### 플로우 D: Steam ID 직접 입력 (fallback)

```
Steam 로그인 대신 Steam ID 또는 커스텀 URL 직접 입력 (예: "migurazi")
  → ResolveVanityURL로 Steam64 ID 획득
  → 이후 플로우 A/B와 동일
```

> **v1.3 변경**: 기본 진입은 "Steam으로 로그인" 버튼 (업계 표준). 로그인 없이도 게임 검색(플로우 C) 가능하고, Steam ID 직접 입력(플로우 D)도 fallback으로 지원.

### 5.2 필터 옵션

| 필터 | 값 | 기본값 |
|------|----|--------|
| 데이터 소스 | Wishlist / Library / 둘 다 | Wishlist |
| 언어 | 한국어 / 영어 / 일본어 / 중국어(간체) / 전체 | 한국어 |
| 최소 플레이타임 | off / 1h / 5h / 10h | off |
| 최소 글자수 | off / 50자 / 100자 | off |
| 추천/비추 | 전체 / 추천만 / 비추만 | 전체 |
| 기간 | 7일 / 30일 / 90일 / 전체 | 30일 |
| 무료 게임 제외 | on / off | on |

### 5.3 리뷰 카드 표시 정보

각 리뷰는 다음 정보를 포함한 카드 형태로 표시:

| 항목 | 데이터 소스 |
|------|-------------|
| 게임 이름 + 아이콘 | 라이브러리: GetOwnedGames 응답 / 위시리스트: appdetails API (캐시) |
| 추천/비추천 | `voted_up` |
| 리뷰 본문 (접기/펼치기) | `review` |
| 리뷰 작성 시점 플레이타임 | `author.playtime_at_review` |
| 현재 총 플레이타임 | `author.playtime_forever` |
| 리뷰어 소유 게임 수 | `author.num_games_owned` |
| 작성일 | `timestamp_created` |
| 도움이 됐어요 수 | `votes_up` |
| Steam 원문 링크 | 생성 |

### 5.4 점진적 로딩 설계

> 50개 게임 리뷰를 한 번에 가져오면 캐시 미스 시 50초+ 대기 — 서비스 킬러.
> (게임당 Reviews API 0.5초 + appdetails 1초 = 1.5초, 50개 순차 호출 시 75초)

```
[점진적 로딩 전략]

1단계 (즉시, 0~2초):
  - 게임 목록 가져오기 (위시리스트 or 라이브러리)
  - 캐시 히트인 게임의 리뷰 즉시 표시
  - "N개 게임 리뷰 로딩 중..." 프로그레스 표시

2단계 (스트리밍):
  - 캐시 미스인 게임을 순차 처리:
    - appdetails 호출 (캐시 미스 시, 1초 딜레이) → 게임 정보 + is_free 확인
    - is_free=true이면 건너뜀
    - Reviews API 호출 (0.5초 딜레이) → 리뷰 획득
    - 위시리스트: 게임당 약 1~1.5초 (appdetails + Reviews API)
    - 라이브러리 (무료 필터 off): 게임당 약 0.5초 (Reviews API만)
    - 라이브러리 (무료 필터 on): 게임당 약 1~1.5초 (appdetails + Reviews API)
    - appdetails 캐시 히트 시: 게임당 0.5초
  - 한 게임의 리뷰가 도착할 때마다 SSE로 클라이언트에 전송
  - 프로그레스: "12/30 게임 로딩 완료"
  - 예상 소요 (30게임 기준):
    - 위시리스트 캐시 콜드: 약 30~45초
    - 라이브러리 (무료 필터 off) 캐시 콜드: 약 15초
    - 캐시 웜: 약 15~20초

3단계 (완료):
  - 모든 게임 로딩 완료 → 프로그레스 제거
  - 클라이언트에서 timestamp_created 기준 최종 정렬
```

이 방식은 Server-Sent Events(SSE)로 구현. 사용자는 첫 2초 내에 캐시된 리뷰를 보기 시작하고, 새로운 리뷰가 점진적으로 추가되므로 전체 완료를 기다릴 필요가 없다.

> **최적화 여지**: Reviews API와 appdetails API의 Rate Limit이 엔드포인트별로 독립적이라면 병렬 호출로 게임당 소요 시간을 1초로 단축 가능. Phase 1 구현 시 Rate Limit 특성을 추가 검증 필요.

### 5.5 필터와 리뷰 수집량의 관계

> 게임당 5개만 가져온 후 필터를 적용하면 결과가 0~1개로 줄어들 수 있는 문제.

**해결 전략: 서버 사이드 필터 우선, 부족 시 추가 수집**

```
[리뷰 수집 로직]

1. Steam Reviews API 호출 시 서버에서 적용 가능한 필터를 먼저 적용:
   - language: API 파라미터로 전달 (서버 사이드)
   - 기간: day_range 파라미터 활용 가능

2. 서버에서 후처리 필터 적용:
   - 최소 플레이타임
   - 최소 글자수
   - 추천/비추

3. 필터 후 결과가 게임당 2개 미만이면:
   - num_per_page를 20으로 늘려 재요청 (1회만)
   - 그래도 부족하면 해당 게임은 "조건에 맞는 리뷰 없음" 표시

4. 게임당 최대 수집량: 20개 (API 부하 상한)
```

### 5.6 Phase별 기능 매트릭스

| 기능 | Phase 1 (MVP) | Phase 2 | Phase 3 |
|------|:---:|:---:|:---:|
| **위시리스트 리뷰 피드** | O | O | O |
| **라이브러리 리뷰 피드** | O | O | O |
| **게임 검색 (비로그인)** | O | O | O |
| **언어 필터** | O | O | O |
| **플레이타임/글자수/기간 필터** | O | O | O |
| **무료 게임 제외 필터** | O | O | O |
| **Steam OpenID 로그인 + Steam ID 직접 입력 fallback** | O | O | O |
| **점진적 로딩 (SSE)** | O | O | O |
| **게임별 리뷰 뷰** | O | O | O |
| **게임별 리뷰 요약 통계** | - | O | O |
| **플레이타임 구간별 긍/부정 비율** | - | O | O |
| **리뷰 점수 변동 알림** | - | O | O |
| **필터 프리셋 저장** | - | O | O |
| **이메일/Push 알림** | - | - | O |
| **리뷰 번역/요약 (LLM)** | - | - | O |

---

## 6. 시스템 아키텍처

### 6.1 아키텍처 다이어그램 (MVP)

```
  ┌──────────────────────────────────────────┐
  │         Next.js (단일 프로젝트)             │
  │                                          │
  │  [React UI]                              │
  │   리뷰 피드 / 필터 패널 / Steam 로그인      │
  │   게임 검색 / 게임별 뷰                     │
  │          │ SSE (점진적 로딩)               │
  │  [API Routes]                            │
  │   Steam API Fetcher / Auth / Aggregator  │
  │          │                               │
  │  ┌───────┴──────────────┐                │
  │  │ In-Memory Cache (TTL)│                │
  │  │ + SQLite (users)     │                │
  │  └─────────────────────-┘                │
  └──────────┬───────────────────────────────┘
             │ HTTPS
       ┌─────▼─────┐
       │ Steam API  │
       └───────────┘
```

> MVP에서는 Redis, PostgreSQL, Prometheus 없이 시작. Next.js 단일 프로세스 + 인메모리 캐시 + SQLite. $5 VPS에서 실행 가능한 최소 구성.

### 6.2 요청 흐름

```
[위시리스트 리뷰 피드 요청]
사용자 Steam 로그인 완료 상태 (또는 Steam ID 직접 입력)
  → Next.js API Route: 사용자 위시리스트 조회 (캐시 우선)
    → Cache HIT: 캐시된 위시리스트 사용
    → Cache MISS: Steam Wishlist API 호출 → 캐시 저장
  → 사전 필터링: 앱 정보 캐시에 is_free=true인 게임만 제외
  → SSE 스트림 시작:
    → 캐시 히트 게임의 리뷰 즉시 전송
    → 캐시 미스 게임: appdetails 조회 → is_free 확인 → 리뷰 조회 → 전송
  → 클라이언트: 도착순 표시, 전체 완료 후 시간순 정렬

[수동 캐시 갱신]
사용자가 "새로고침" 버튼 클릭
  → 해당 게임/위시리스트의 캐시 무효화
  → Steam API 재호출 → 캐시 재저장
```

---

## 7. 주요 컴포넌트 상세 설계

### 7.1 Steam API Fetcher

#### 데이터 소스 분석

| 데이터 | API 엔드포인트 | 안정성 | 인증 필요 | 검증 결과 |
|--------|---------------|--------|-----------|-----------|
| 위시리스트 | `IWishlistService/GetWishlist/v1` | **높음 (공식)** | API Key + Steam ID | **검증 완료** — 3,490개 항목 정상 반환 |
| 소유 게임 목록 | `IPlayerService/GetOwnedGames/v1` | **높음 (공식)** | API Key + Steam ID | **검증 완료** — 5,330개 게임, playtime 포함 |
| 최근 플레이 | `IPlayerService/GetRecentlyPlayedGames/v1` | **높음 (공식)** | API Key + Steam ID | **검증 완료** |
| 게임 리뷰 | `store.steampowered.com/appreviews/{appid}` | 높음 (공식 문서화) | 불필요 | **검증 완료** |
| 앱 상세 정보 | `store.steampowered.com/api/appdetails` | 중간 (비공식) | 불필요 | **검증 완료** (is_free, 가격 등) |
| 게임 검색 | `store.steampowered.com/api/storesearch` | 중간 (비공식) | 불필요 | 미검증 (Phase 1에서 검증) |
| Steam ID 조회 | `ISteamUser/ResolveVanityURL/v1` | **높음 (공식)** | API Key | **검증 완료** |

> **v1.2 변경**: 기존에 비공식 API(`wishlistdata`)에 의존하던 위시리스트 조회를 공식 API(`IWishlistService`)로 전환. 이에 따라 **비공식 API 의존이 2개(wishlistdata, appdetails)에서 appdetails 1개로 감소**. (게임 검색용 `storesearch`는 Phase 1에서 추가 예정)

#### 위시리스트 API 응답 구조

`IWishlistService/GetWishlist`는 `appid`, `priority`, `date_added`만 반환한다. 게임 이름, 가격 등 상세 정보는 `appdetails` API로 추가 조회가 필요하다. (참고: `GetOwnedGames`는 `name`, `img_icon_url`을 포함하므로, 라이브러리 게임은 appdetails 없이 게임 이름/아이콘 사용 가능)

```json
{
  "response": {
    "items": [
      {"appid": 1300, "priority": 0, "date_added": 1694842107},
      {"appid": 2270, "priority": 0, "date_added": 1430991108}
    ]
  }
}
```

위시리스트가 수천 개인 경우 전체 appdetails를 일괄 조회하는 것은 비현실적이므로, 게임별로 순차 처리한다. 각 게임에 대해 appdetails를 조회(캐시 미스 시)하여 게임 정보와 is_free 여부를 확인한 후, 무료 게임이 아니면 Reviews API를 호출한다. appdetails 결과는 TTL 7일로 캐시하므로 재방문 시에는 대부분 캐시 히트된다.

#### 인증 방식

> **v1.3 변경**: Steam OpenID(ID 획득) + 서버 API Key(데이터 조회) 하이브리드 방식.
> OpenID는 사용자의 Steam ID를 얻기 위한 수단이며, API 호출 인증과는 별개.

**인증 흐름 (기본)**:
1. 사용자가 **"Steam으로 로그인"** 버튼 클릭
2. Steam OpenID 페이지로 리다이렉트 → 사용자가 Steam에서 로그인
3. 콜백으로 **Steam64 ID** 자동 획득 (서버에서 수신)
4. **서버의 API Key**로 `IWishlistService`, `IPlayerService` 호출

**인증 흐름 (fallback)**:
1. 사용자가 **Steam ID** 또는 커스텀 URL을 직접 입력
2. 서버가 `ISteamUser/ResolveVanityURL`로 Steam64 ID 획득
3. 이후 기본 흐름과 동일

**API Key 관리**:
- API Key는 **서버 측에서 관리** (사용자에게 발급 요구하지 않음)
- 서비스 운영자가 https://steamcommunity.com/dev/apikey 에서 1회 발급
- 환경변수(`STEAM_API_KEY`)로 서버에 설정

**이 설계의 핵심 구분**:
| 용도 | 방식 | 역할 |
|------|------|------|
| 사용자 Steam ID 획득 | Steam OpenID 로그인 | 사용자 편의 (Steam ID를 몰라도 됨) |
| Steam 데이터 조회 | 서버 API Key | 위시리스트/라이브러리/리뷰 API 호출 |

**장점**:
- 업계 표준 UX — "Steam으로 로그인" 버튼 하나로 진입 (SteamDB, IsThereAnyDeal 등과 동일)
- 사용자가 Steam ID를 몰라도 됨
- OpenID는 ID 획득용이므로, 폐기 시 Steam ID 직접 입력 fallback으로 전환 가능
- 프로필 공개/비공개 무관하게 공식 API로 데이터 접근 가능

**제약**:
- Steam OpenID 2.0 폐기 가능성 → fallback(Steam ID 직접 입력) 준비 완료
- 타인의 Steam ID를 직접 입력(fallback)할 수 있음 → 공식 API가 프로필 비공개 설정을 존중하는지 추가 검증 필요 (Phase 0.5에서는 본인 계정만 테스트)

#### 장애 대응

- Steam API 일시 장애 시: 캐시된 데이터에 `stale` 플래그 + "N분 전 데이터" UI 표시
- 전면 장애 시: 캐시된 데이터만으로 제한된 서비스 제공

#### Rate Limit 전략

| 대상 | 제한 | 전략 |
|------|------|------|
| IWishlistService | 공식, 관대 | 사용자당 1회 호출 후 캐시 |
| IPlayerService (GetOwnedGames) | 공식, 관대 | 사용자당 1회 호출 후 캐시 |
| Steam Reviews API | 공식 문서화, 초당 1~2회 안전 | 0.5초 딜레이 + 캐시 |
| appdetails API | 비공식, 초당 1회 안전 | 1초 딜레이 + 캐시 (TTL 7일) |
| storesearch API | 비공식, 제한 미확인 | 캐시 + Phase 1에서 Rate Limit 검증 |
| 사용자당 서비스 요청 | 자체 설정 | 분당 30회 |

### 7.2 Review Aggregator

#### 리뷰 수집 로직

```
[게임 목록 수신 (위시리스트 or 라이브러리 or 수동 등록)]

1. 사전 필터링 (캐시 히트 데이터만 활용):
   - 무료 게임 제외: 앱 정보 캐시에 is_free=true가 있는 게임만 제외
   - 캐시 미스 게임은 이 단계에서 제외하지 않음 (리뷰 조회 시 판별)
   - 위시리스트: date_added 최신순 정렬, 조회 대상 상한 50개
   - 라이브러리: 최근 플레이 게임 우선 (playtime_2weeks > 0)
   - 라이브러리: 조회 대상 상한 50개
   - (두 소스 모두 "더 보기"로 추가 로딩 가능)

2. 게임별 리뷰 조회 (SSE로 점진 전송):
   - 게임 정보 확인:
     - 라이브러리: GetOwnedGames에서 이름/아이콘 이미 확보.
       무료 게임 필터 on → appdetails로 is_free 확인 (캐시 미스 시만)
       무료 게임 필터 off → appdetails 호출 불필요 (게임당 0.5초로 단축)
     - 위시리스트: appdetails 조회 필수 (이름 + is_free, 캐시 미스 시)
     - is_free=true이면 해당 게임 건너뜀 (무료 게임 사후 필터)
   - Steam Reviews API 호출:
     - language={선택 언어} (서버 사이드 필터)
     - filter=recent
     - num_per_page=10 (기본)
   - 서버 후처리 필터: 최소 플레이타임, 최소 글자수, 추천/비추
   - 필터 후 결과 2개 미만 → num_per_page=20으로 1회 재요청
   - 결과를 SSE로 클라이언트에 전송

3. 클라이언트:
   - 도착하는 리뷰를 피드 하단에 추가 (도착순)
   - 전체 로딩 완료 후 timestamp_created 기준 최종 정렬
   - 로딩 프로그레스 표시
```

#### 대량 게임 대응

위시리스트/라이브러리에 수백~수천 개 게임이 있는 사용자 대응:

```
[위시리스트 게임 정렬 우선순위]
1. date_added 최신순 (최근 추가한 게임 우선)
→ 상위 50개만 자동 조회, "더 보기"로 추가 로딩

[라이브러리 게임 정렬 우선순위]
1. 최근 2주 플레이 게임 (playtime_2weeks > 0) — 최우선
2. 총 플레이타임 높은 순 — 차선
3. 나머지 — 무시 (사용자가 명시적으로 요청 시에만)
→ 상위 50개만 자동 조회, "더 보기"로 추가 로딩
```

### 7.3 캐시 전략

| 캐시 대상 | TTL | 캐시 키 | 수동 갱신 |
|-----------|-----|---------|-----------|
| 위시리스트 목록 | 6시간 | `wishlist:{steamId}` | O (새로고침 버튼) |
| 소유 게임 목록 | 24시간 | `library:{steamId}` | O |
| 앱 상세 정보 (is_free 등) | 7일 | `app:{appId}:info` | X |
| 리뷰 (언어별) | 15분 | `reviews:{appId}:{language}:{count}` | O |

> 위시리스트 캐시 TTL을 12시간 → 6시간으로 조정. 사용자가 위시리스트에 게임을 추가한 직후 반영되지 않는 문제를 완화. 수동 새로고침 버튼도 제공.

MVP에서는 **인메모리 TTL Map**으로 구현 (`node-cache` 패키지 또는 `Map` + TTL 직접 구현). 서버 재시작 시 캐시가 날아가지만, Steam API 재호출로 복구되므로 데이터 손실 없음.

### 7.4 데이터 저장

> MVP에서 DB 역할은 사용자 설정 저장 + 수동 관심 게임 목록뿐. SQLite로 충분.

```
┌─────────────────────┐     ┌─────────────────────┐
│      users           │     │  user_game_list      │
├─────────────────────┤     ├─────────────────────┤
│ user_id (PK)        │──┐  │ user_id (FK)        │
│ steam_id            │  │  │ app_id              │
│ display_name        │  └─→│ source (wishlist/   │
│ preferences (JSON)  │     │   library/manual)   │
│ created_at          │     │ added_at            │
│ last_login_at       │     └─────────────────────┘
└─────────────────────┘
```

---

## 8. 법적/보안 고려사항

### 8.1 Steam ToS 준수

| 항목 | 리스크 | 대응 |
|------|--------|------|
| Reviews API 호출 | 낮음 (공식 문서화된 API) | Rate Limit 준수 |
| 위시리스트 API (IWishlistService) | 낮음 (공식 API) | Rate Limit 준수 |
| appdetails API | 중간 (비공식) | 캐시 TTL 7일, 호출 최소화 |
| 리뷰 본문 표시 | 낮음 (Steam 리뷰는 공개 데이터) | 출처(Steam) 명시, 원문 링크 제공 |

### 8.2 사용자 데이터 보호

- **수집 데이터**: Steam64 ID (OpenID 로그인 콜백 또는 직접 입력으로 획득), 필터 설정
- **미수집**: 비밀번호, Steam 인증 토큰 (OpenID는 ID만 반환하며 비밀번호/토큰은 서버에 전달되지 않음)
- **보관 기간**: 마지막 로그인으로부터 6개월, 이후 자동 삭제
- **개인정보 처리방침**: 서비스 출시 전 작성 필수

---

## 9. 운영 전략

### 9.1 모니터링 (MVP)

> MVP는 Prometheus/Grafana 없이 **로그 파일 기반 모니터링**.

| 메트릭 | 측정 방법 | 알림 |
|--------|-----------|------|
| Steam API 호출 성공/실패 | 로그 집계 | 로그 파일 확인 |
| 응답 시간 | 로그 | - |
| 사용자 수/세션 | SQLite 쿼리 | - |
| 피드 vs 게임별 뷰 사용 비율 | 이벤트 로그 | - |

Phase 2에서 사용자 증가 시 Prometheus + Grafana 도입 검토.

### 9.2 배포

- **MVP**: Docker (Next.js standalone 빌드) + Nginx 리버스 프록시, 단일 서버
- **확장 시**: Redis 추가, VPS 수평 확장 (서버리스 플랫폼은 SSE 타임아웃 제약으로 비적합)

---

## 10. 기술 스택 (MVP)

> **v1.3 변경**: Next.js 풀스택 단일 구조로 전환. FastAPI(Python) 제거, TypeScript 단일 언어.

| 레이어 | 기술 | 근거 |
|--------|------|------|
| 풀스택 프레임워크 | **Next.js (App Router)** | React UI + API Routes를 단일 프로젝트로. TypeScript 단일 언어 |
| UI | React (Next.js 내장) | 필터 패널, 탭, SSE 실시간 피드 등 동적 UI에 적합 |
| API | Next.js API Routes (Route Handlers) | Steam API 호출, OpenID 콜백, SSE 스트리밍 |
| Cache | 인메모리 TTL Map | MVP에 Redis 불필요, 서버 단일 인스턴스. (`node-cache` 또는 직접 구현) |
| Database | SQLite (`better-sqlite3`) | 사용자 설정 저장만, 스키마 단순 |
| 배포 | Docker (단일 컨테이너) | Next.js standalone 빌드, Nginx 리버스 프록시 |

**단일 구조의 장점**:
- 서버 1대, 프로세스 1개, 언어 1개 (TypeScript)
- 프론트/백엔드 간 타입 공유 가능
- 배포 단순화 (Docker 컨테이너 1개)

확장 시 전환 경로: 인메모리 캐시 → Redis, SQLite → PostgreSQL, 단일 서버 → VPS 수평 확장

> **주의**: Vercel 등 서버리스 플랫폼은 함수 실행 시간 제한(10~60초)이 있어, SSE 장시간 스트리밍(30~45초)과 충돌할 수 있다. 확장 시에는 VPS 기반 수평 확장이 적합.

---

## 11. 단계별 로드맵

### Phase 0: PoC (완료)

| 검증 항목 | 결과 |
|-----------|------|
| Steam Reviews API 동작 확인 | 성공 - language=koreana 필터 동작 |
| 리뷰 데이터 품질 확인 | 성공 - playtime_at_review, playtime_forever, num_games_owned 포함 |
| API Rate Limit 확인 | 성공 - 0.5~1초 딜레이로 안정적 |
| 미출시 게임 자연 제외 확인 | 성공 - 리뷰 0건 반환 |

### Phase 0.5: 미검증 API 검증 (완료)

| 검증 항목 | 결과 | 비고 |
|-----------|------|------|
| `IWishlistService/GetWishlist` | **PASS** | 3,490개 항목 정상 반환. API Key 필요. 프로필 공개 무관. |
| `IPlayerService/GetOwnedGames` | **PASS** | 5,330개 게임, playtime_forever/playtime_2weeks 포함 |
| `IPlayerService/GetRecentlyPlayedGames` | **PASS** | 최근 2주 플레이 게임 정상 반환 |
| `ISteamUser/ResolveVanityURL` | **PASS** | 커스텀 URL → Steam64 ID 변환 정상 |
| 무료 게임 판별 (is_free) | **PASS** (7/8) | Path of Exile만 실패 (PoE2로 이관되어 앱 삭제) |
| 기존 `wishlistdata` 엔드포인트 | **폐기 확인** | 302 리다이렉트 → 사용 불가. IWishlistService로 대체. |

> **핵심 발견**: 위시리스트와 라이브러리 모두 **공식 API**(IWishlistService, IPlayerService)로 접근 가능. 비공식 API 의존이 `appdetails` 1개로 대폭 감소. 데이터 조회는 **서버 API Key**로 수행하며, 사용자 Steam ID 획득은 **Steam OpenID 로그인**(기본) 또는 Steam ID 직접 입력(fallback)으로 처리.

### Phase 1: MVP (3~4주)

| 작업 | 비고 |
|------|------|
| Steam OpenID 로그인 | Steam64 ID 자동 획득 (기본 진입) |
| Steam ID 직접 입력 (fallback) + ResolveVanityURL | 커스텀 URL/Steam64 ID 양쪽 지원 |
| 위시리스트 조회 (IWishlistService) | 공식 API, 서버 API Key로 호출 |
| 라이브러리 조회 (IPlayerService) | 공식 API, API Key로 호출 |
| 게임 검색 (비로그인) | 이름/AppID 검색 → 리뷰 표시 |
| 리뷰 피드 (통합 + 게임별) | SSE 점진적 로딩 |
| 필터 패널 | 모든 필터 옵션 |
| 리뷰 카드 UI | 플레이타임 맥락 표시 |
| 인메모리 캐시 | TTL Map |
| 이벤트 로깅 | 니즈 검증용 사용 패턴 추적 |

### Phase 2: 고도화 (Phase 1 데이터 검증 후)

| 작업 | 선행 조건 |
|------|-----------|
| 게임별 리뷰 요약 통계 | Phase 1 사용 데이터 분석 |
| 플레이타임 구간별 긍/부정 비율 | |
| 리뷰 점수 변동 추적 | Redis + DB 도입 |
| 필터 프리셋 저장 | |
| Redis 캐시 전환 | 사용자 증가 시 |

### Phase 3: 확장 (이후)

| 작업 | 선행 조건 |
|------|-----------|
| 이메일/Push 알림 | Phase 2 리텐션 검증 |
| 리뷰 번역/요약 (LLM) | 비용 모델 검토 (Phase 2+ 비용 추정 별도 필요) |

---

## 12. 비용 추정

### Phase 1 (MVP)
| 항목 | 월 예상 비용 | 비고 |
|------|-------------|------|
| VPS | $5~10 | 단일 서버, 1 vCPU (Redis 없으므로 메모리 여유) |
| SQLite | $0 | 파일 기반 |
| 도메인 | $1~2 | |
| **합계** | **$6~12/월** | |

### Phase 2+ (확장 시)
| 항목 | 월 예상 비용 | 비고 |
|------|-------------|------|
| VPS (2 vCPU) | $15~25 | Redis + PostgreSQL 추가 |
| LLM API (Phase 3) | $10~50 | 리뷰 건당 추정 필요, 사용량에 따라 변동 큼 |

---

## 13. 리스크 매트릭스

| 리스크 | 영향도 | 발생 확률 | 대응 |
|--------|--------|-----------|------|
| ~~위시리스트 API 차단/변경~~ | ~~높음~~ | ~~중~~ | **해소** — IWishlistService(공식 API)로 전환 완료 |
| ~~위시리스트 프로필 비공개 이탈~~ | ~~높음~~ | ~~높음~~ | **해소** — API Key 방식은 프로필 공개 여부 무관 |
| OpenID 2.0 폐기 | 낮음 | 낮음 | OpenID는 ID 획득 편의용으로만 사용. 폐기 시 Steam ID 직접 입력 fallback으로 전환 (v1.3) |
| Reviews API 변경 | 치명 | 낮음 | 공식 문서화된 API, 변경 시 빠른 대응 |
| **비공식 API 변경/차단 (appdetails, storesearch)** | 중 | 중 | 비공식 API 2개 의존. appdetails: 게임 이름/is_free 정보 소스 (대안: ISteamApps/GetAppList). storesearch: 게임 검색 (대안: GetAppList 로컬 캐시 검색) |
| 한국어 리뷰 부족 (마이너 게임) | 중 | 중 | 영어 리뷰 fallback, "한국어 리뷰 없음" 명시 |
| 라이브러리 게임 수 과다 | 중 | 중 | 최근 플레이 우선 + 상한 50개 + "더 보기" |
| 쓰레기 리뷰 비율 높음 | 중 | 높음 | 필터로 완화. 단, 한국어 리뷰 필터 강하게 걸면 결과 부족 — 트레이드오프 UI에 안내 |
| 타인의 비공개 위시리스트/라이브러리 접근 | 중 | 중 | 공식 API가 프로필 비공개 설정을 존중하는지 Phase 1에서 추가 검증. 접근 가능 시 프라이버시 고지 필요 |
| **"통합 피드" 니즈 미검증** | 높음 | 중 | 통합/게임별 뷰 동시 제공, 사용 비율 추적으로 검증 |

---

## 14. 사용자 획득 전략

> MVP 단계에서는 유료 마케팅 없이 오가닉 채널만 활용.

| 채널 | 방법 |
|------|------|
| Reddit | r/Steam, r/GameDeals에 서비스 소개 (자기 홍보 규정 준수) |
| Steam 커뮤니티 | Steam 토론 게시판에 공유 |
| 한국 게임 커뮤니티 | 루리웹, 디시인사이드 스팀 갤러리, 에펨코리아 |
| SEO | "스팀 한국어 리뷰", "steam korean reviews" 키워드 |
| 입소문 | 게임 리뷰를 공유할 수 있는 링크 생성 기능 |

---

## 15. 수익화 전략

> 현 단계에서는 **취미/사이드 프로젝트**로 운영. 월 $6~12 비용은 자비로 감당 가능한 수준.

수익화가 필요해지는 시점: MAU 1,000+ 또는 서버 비용 $30/월 초과 시.

| 방안 | 시점 | 비고 |
|------|------|------|
| 후원 (Buy Me a Coffee 등) | Phase 1 | 니치 서비스에 적합 |
| 광고 (비침투적) | Phase 2 | 사용자 수 충분 시 검토, UX 해치지 않는 범위 |
| 프리미엄 필터/알림 | Phase 3 | 기본 기능은 무료, 고급 필터나 알림은 유료 |

---

## 16. 서비스 이름 후보

| 이름 | 의미 |
|------|------|
| SteamPulse | 게임 커뮤니티의 "맥박"을 읽는다 |
| ReviewRadar | 리뷰를 레이더처럼 탐지 |
| Steam Review Feed | 직관적, 기능 설명 |
