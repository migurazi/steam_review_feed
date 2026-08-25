# 작업 지시서: 도전과제 탭 (달성률 + 스키마 변경 알림)

| 항목 | 값 |
|------|-----|
| 작성일 | 2026-08-25 |
| 작성자 | Claude (Sisyphus) |
| 상태 | v3 (코드리뷰 재검증 반영) |
| 대상 브랜치 | `feature/achievements` |
| 베이스 commit | `81553c31b032865e4e9cd91493a8dc794fd1abb4` |

---

## 0. 변경 이력

| 버전 | 변경 |
|------|------|
| v1 | 초안 — Phase 0 실측 항목 포함 |
| v2 | Momus 1차 검토(REJECT) 반영. 주요 변경: (1) **스냅샷 write 가드를 Phase 1로 이동**(C1) (2) negative cache 오염 방지 3분기 규칙(C2) (3) 미들웨어 보호 범위 분리(C3) (4) "이전 진행률" 판정 방식을 scan-time 비교로 확정(C4) (5) **부록 A 실측치(라이브러리 5,347 / pt>0 3,482) 기반으로 규모·예산·소요시간 전면 재계산**(C5) (6) Phase 0 절차를 항목별 합격 기준 표로 재작성(C6) (7) 완료 기준에 검증 방법 컬럼 도입(C7) (8) 미해결 질문 3건 확정(C8) (9) M1~M17, L1~L8 반영 (10) §12 변경 파일 요약 신설 |
| v3 | 코드리뷰 재검증 반영. (1) **`logEvent` 선례 라인 오인용 정정** — `route.ts:137-141`(실제 tracks 검증 루프) → `:167`(§2.1, §5.5.1) (2) **"최근 30일 획득 수" 지표를 저장 모델과 정합화** — `user_achievement_progress`에 스캔 시점 산출 컬럼 `unlocked_30d` 추가. `last_unlock_at`(게임당 최신 1건)으로는 개수 산출 불가였음(§4.1, §5.3.2 6단계, §5.6.1, R10) (3) **§1.4에 라이브러리 횡단 희귀도 랭킹 비목표 명시** — 도전과제 헌터 관점 검토 결과, 전역 순위는 전 과제 상세 영속 저장이 필요해 별도 작업으로 분리 |
| v4 | **Phase 0 실측 완료(2026-08-25) 반영**. (1) V4 확정 — 원소 키 `apiname`(§3.5, §5.1.4), Hades 403은 미소유 오해 에러 (2) **V7 뒤집힘** — `has_community_visible_stats` 필드 부재 → 대체안(pt>0 전체 + negative cache)이 기본 경로(§5.3.1) (3) R7 해소 — private(403)/no-stats(400) 구별 가능 (4) V1 icon 도메인 `steamcdn-a.akamaihd.net`로 정정(§5.1.2) (5) V8 기본 english 확인 (6) **V9 실효 6.5 req/s**(429 0%) → §7.1 소요 ~1.8배 재계산 |
| v5 | §5.6.1 리스트 정렬에 **"남은 개수 많은 순"** 추가(기존 "적은 순"과 양방향). "완벽 달성 숨김" 필터가 "도전과제 남은 게임만" 뷰임을 명시. |

---

## 1. 배경 및 목적

### 1.1 배경

`steam-review-feed`는 "내 게임들의 근황"을 한곳에서 보여주는 서비스다. 현재 그 근황은 **리뷰**(`/feed`)와 **성향 추천**(`/recommend`) 두 축뿐이다. Steam 사용자에게 게임 근황의 큰 축 하나가 빠져 있다 — **도전과제**.

두 가지 구체적 결핍이 있다.

1. **달성 현황이 게임별로 흩어져 있다.** "내가 90% 이상 깬 게임이 뭐지", "3개만 더 하면 100%인 게임이 뭐지"를 알려면 Steam에서 게임 하나씩 프로필 페이지를 열어야 한다.
2. **도전과제 구성은 변한다.** DLC/업데이트로 과제가 추가되면 100% 달성이 조용히 해제되고, 삭제되면 반대로 채워진다. 이름·설명이 바뀌면 기존 공략 정보가 어긋난다. Steam은 이 변화를 사용자에게 알려주지 않는다.

`docs/planning.md` 1.2절이 정의한 "라이브러리 게임 근황 파악 어려움"과 같은 축이며, 기존 인프라(Steam OpenID 세션, `getOwnedGames`, LRU+SQLite 이중 캐시, SSE 점진 로딩, Rate Limit)를 그대로 재사용할 수 있다.

### 1.2 이 기능이 appdetails Rate Limit 병목과 무관한 이유

`lib/constants.ts:26-40`의 주석이 기록하듯, 이 프로젝트의 성능 고통은 전부 **비공식** `store.steampowered.com/api/appdetails`(관측 한도 ~40 req/min)에서 나온다.

도전과제에 필요한 세 엔드포인트는 모두 **공식 `api.steampowered.com`**이며 키당 100,000 calls/day 한도를 따른다. 즉 appdetails 레인과 **경쟁하지 않으며** 더 높은 동시성을 쓸 수 있다.

다만 "병목이 없다"는 뜻은 아니다. §7.1에서 재계산하듯 이 프로젝트의 알려진 기준 사용자(라이브러리 5,347)에서 첫 스캔은 **약 7,000콜 / 10분**이다. 규모 문제는 여전히 존재하며, 그 대응(전역 세마포어, 재개 가능한 스캔)이 Phase 1 필수 산출물이다.

### 1.3 목적

1. `/achievements` 탭에서 라이브러리 전체의 도전과제 달성 현황을 한 화면에 집계한다.
2. 과제별 **전역 달성률(희귀도)** 을 함께 표시하여 "내가 안 딴 것 중 희귀한 것" / "조금만 더 하면 완주" 같은 판단을 지원한다.
3. 게임의 도전과제 **스키마 스냅샷**을 보관하고, 변경(추가/삭제/개명/설명변경/숨김해제)을 감지해 알린다.
4. 개인 진행률과 스키마 변경을 결합해 **"100% 달성이 해제됨"** 같은 개인화된 알림을 만든다.

### 1.4 비목표 (Out of Scope)

- 이메일/웹푸시/브라우저 알림 발송 (앱 내 피드 표시까지만)
- 친구와의 달성률 비교, 리더보드
- Steam 외부 데이터(공략 사이트 등) 연동, 과제 획득 가이드 생성
- 도전과제 통계 항목(`availableGameStats.stats`) 추적
- 위시리스트 게임의 도전과제 (미소유 게임은 개인 진행률이 없음)
- **변경 알림 문구의 한국어화** — diff 기준선은 `l=english` 고정이므로 알림에 실리는 과제명은 영어다. 과제 목록 UI의 한국어 표시는 §5.1.6의 온디맨드 방식으로 별도 처리한다 (M14 결정)
- **라이브러리 횡단(cross-game) 희귀도 랭킹** — "내 라이브러리 전체에서 가장 희귀한/놓친 과제 Top-N" 같은 전역 순위는 이번 범위가 아니다. 희귀도(전역 달성률)는 **게임 단위로, 행을 펼쳤을 때만** 표시한다(§5.5.2, §5.6.1). AStats/Steam Hunters류 완장(完章) 헌터의 핵심 동선이지만, 전역 랭킹은 전 과제 상세를 영속 저장해야 성립하므로(§4.1이 배제한 17만 행) 별도 작업으로 분리한다. 본 기능이 헌터에게 주는 가치는 "완주 임박 정리(남은 개수순)"와 "완벽달성 해제 알림"에 한정된다

---

## 2. 현재 상태

### 2.1 활용 가능한 기존 자산

| 항목 | 위치 | 비고 |
|------|------|------|
| Steam 세션 (steamId) | `lib/session.ts:14-18` | `SessionData`는 `steamId`/`displayName`/`avatarUrl`만 보유. **`user_id`는 없다** (M1) |
| steamId → user_id 변환 규약 | `lib/recommend-cache.ts:85`, `:120`, `:142` | 모듈 경계에서 `getUserBySteamId`로 변환, 사용자 행 부재 시 null/no-op |
| 보유 게임 + 플레이타임 | `lib/steam/api.ts:276` `getOwnedGames` | `include_appinfo=true` 이미 사용 중 |
| 인메모리 캐시 | `lib/cache.ts:22-28` | LRU 10,000 + TTL. **`allowStale: true`** — §5.1.5 주의 |
| 영속 캐시 패턴 | `lib/app-details-store.ts` | raw row 반환, TTL 판정은 caller — 그대로 차용 |
| 앱 공용 메타 | `lib/db.ts::app_meta` (name, header_image) | `cached` 이벤트의 게임 이름 출처 (M3) |
| 사용자별 캐시 선례 | `lib/db.ts::recommendation_cache` | |
| SSE 공통 유틸 | `lib/sse.ts` | |
| SSE 취소 패턴 | `app/api/recommend/route.ts` | `cancelled` 플래그 + `cancel()` 콜백 |
| 모듈 모킹 테스트 선례 | `__tests__/media-api.test.ts:17-22` | `vi.mock("@/lib/steam/api", ...)` (M12) |
| Rate Limit | `lib/rate-limit.ts:34-37` | **IP당** 30 req/min (모듈 주석의 "사용자당"은 부정확 — L1) |
| 만료 사용자 정리 | `lib/db.ts:165-184` | 자식 테이블 → `users` 순서. **신규 테이블 추가 필요** (§4.2) |
| 초기화 진입점 | `lib/init.ts:42` `startCleanupScheduler()` | |
| 이벤트 로깅 | `lib/logger.ts::logEvent` | 선례: `app/api/recommend/route.ts:167` (`logEvent("recommend_analyze", …)`) |
| **실측 기준 사용자** | `docs/20260527_01_...md` 부록 A (`:670`, `:728`) | 라이브러리 **5,347**, playtime=0 게임 **1,865**(34.9%) → **pt>0 = 3,482** |

### 2.2 부재하여 새로 만들어야 하는 것

| 항목 | 사유 |
|------|------|
| 도전과제 Steam API 클라이언트 3종 | `lib/steam/api.ts` 신규 함수 |
| 원형 응답 타입 4종 | `lib/steam/types.ts` (M17) |
| 스키마/전역률/진행률 영속 저장 | 신규 테이블 |
| 아웃바운드 동시성 세마포어 | `lib/rate-limit.ts`는 **인바운드** IP 제한이라 대체 불가 (M11) |
| 스키마 diff 엔진 + 스냅샷 write 가드 | 순수 함수 모듈 |
| `/achievements` 페이지 + SSE 라우트 | |
| `components/AppNav.tsx` | 네비 3종 통합 (§5.6.3) |

### 2.3 확인된 기존 결함 (본 작업에서 함께 처리)

| ID | 내용 | 근거 | 처리 |
|----|------|------|------|
| E1 | `PROTECTED_PAGES`에 `/recommend` 없음 | `middleware.ts:12` | `/achievements`와 함께 추가 |
| E2 | `PROTECTED_API`·matcher에 `/api/recommend` 없음 | `middleware.ts:13`, `:50` | 함께 추가 (M10) |
| E3 | `cleanupExpiredUsers`가 신규 사용자 테이블을 모름 | `lib/db.ts:165-184` | §4.2 필수 항목 |
| E4 | README의 "13파일 128개"가 실제와 불일치 (실제 17파일) | `README.md:61` | 본 작업에서 함께 정정 |

---

## 3. Phase 0: 사전 실측 (구현 착수 전 필수)

`docs/planning.md`가 Phase 0.5 검증으로 API 가정을 뒤집은 선례(IWishlistService 발견)가 있다. 아래 항목을 실제 키로 검증하고 결과를 §3.5에 기록하기 전에는 Phase 1에 착수하지 않는다.

### 3.1 실측 완료 항목

`GetGlobalAchievementPercentagesForApp` — 2026-08-25 실측 완료.

```
GET https://api.steampowered.com/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v0002/?gameid=1145360
{"achievementpercentages":{"achievements":[
  {"name":"AchClearTartarus","percent":"81.9"}, ...
]}}
```

확정 사실:

- **API Key 불필요.**
- `name`은 API명(스키마의 `name`과 동일한 안정 키).
- **`percent`는 number가 아니라 string이다.** `parseFloat` 필수. 타입에 `string`으로 선언하고 경계에서만 변환한다 (M17).
- 응답은 percent 내림차순 정렬.

### 3.2 측정 스크립트

직전 지시서의 `scripts/measure-profile.ts` 선례(`20260527_01_...md:551`)를 따른다.

- 경로: `scripts/probe-achievements.ts`
- 실행: `npx tsx scripts/probe-achievements.ts`
- **`tsx`를 devDependencies에 추가한다** — 현재 `package.json:24-36`에 `tsx`도 `ts-node`도 없다.
- `.gitignore`에 `scripts/probe-*` 추가 (측정 산출물이 커밋되지 않도록).
- 스크립트는 원문 JSON을 `logs/probe-achievements.jsonl`에 append하고, 요약만 stdout에 출력한다.

### 3.3 검증 항목별 절차 및 합격 기준

| # | 호출 | 대상 | 합격 기준 | 기록할 것 |
|---|------|------|-----------|-----------|
| V1 | `GetSchemaForGame/v2?key&appid&l=english` | `1145360`(Hades), `220`(HL2) | 200 + `game.availableGameStats.achievements[]` 존재 | 원소의 전체 필드명 목록, `hidden`/`defaultvalue`의 타입, `icon` URL 전문 |
| V2 | 동 | 과제 없는 앱 `250820`(SteamVR) | 200 응답 | `availableGameStats` 키 유무, `achievements` 유무·빈배열 여부 — **셋 중 어느 형태인지 확정** |
| V3 | 동 | 존재하지 않는 appid `99999999` | — | HTTP 코드, body 형태 (`{"game":{}}`인지) |
| V4 | `GetPlayerAchievements/v1?key&steamid&appid` | 본인 steamId + `1145360` | 200 + `playerstats.success=true` | **원소의 키가 `apiname`인지 `name`인지** — §5.1.3의 핵심 가정. `unlocktime` 미획득 시 값 |
| V5 | 동 | 본인 프로필의 '게임 상세 정보'를 **비공개로 전환 후** 재호출. 측정 직후 원복 | — | HTTP 코드, `playerstats.success` 값, `error` 문자열 **원문 전체** |
| V6 | 동 | 본인 steamId + `250820`(과제 없음) | — | `error` 문자열 **원문 전체**. V5의 문자열과 **구별 가능한지**가 핵심 (M13) |
| V7 | `GetOwnedGames?include_appinfo=true` | 본인 steamId | — | `has_community_visible_stats` 필드 존재 여부. 존재 시 **true인 게임 수**와, 그중 무작위 20개를 V1으로 교차 검증한 일치율 |
| V8 | `GetSchemaForGame` `l` 파라미터 | `1145360`을 `l=english` / `l=koreana` / `l` 생략 3회 | — | 세 응답의 `displayName` 비교. 생략 시 기본값이 english인지 |
| V9 | `GetSchemaForGame` 부하 | 임의 appid **300개**를 동시성 3 + 250ms로 연속 호출 | **429 발생률 1% 미만** | 429 건수, 총 소요시간, 실효 req/s. 미달 시 딜레이 500ms로 재측정하고 그 값을 채택 |

**차단 조건**: V4가 뒤집히면 §5.1.4 정규화가 바뀐다. V6가 V5와 구별 불가능하면 §5.3.2의 "private 시 전체 중단"을 **폐기**하고 앱별 skip으로 되돌린다(R7). V7이 부재/부정확하면 §5.3.1 대체안으로 전환하고 §7.1 예산을 재계산한다.

### 3.4 V5 측정 시 주의

본인 Steam 프로필 → 개인정보 설정 → '게임 상세 정보'를 **비공개**로 전환 → V5 호출 → **즉시 원복**. 원복을 잊으면 이후 모든 개발/테스트에서 진행률이 조회되지 않는다. 스크립트 stdout에 원복 안내를 출력한다.

### 3.5 실측 결과 기록

2026-08-25 실측(`scripts/probe-achievements.ts`, 본인 계정). 판정 요약:

| # | 판정 | 실측 발췌 / 결론 |
|---|------|------------------|
| **V1** | ✅ 확인 | 원소 필드 `name, defaultvalue, displayName, hidden, description, icon, icongray`. `hidden`/`defaultvalue`는 **number**. **`description`은 실제로 누락 가능** — HL2(220) 첫 과제엔 description 필드 없음(Hades엔 있음) → 타입 `description?` 유지 정당. icon URL 도메인은 **`steamcdn-a.akamaihd.net`**(§5.1.2 가정 `media.steampowered.com`과 다름 → 복원 규칙 수정). 경로는 `/steamcommunity/public/images/apps/{appId}/{filename}`이라 파일명 추출은 유효 |
| **V2** | ✅ 확인 | 과제 없는 앱(SteamVR 250820): 200 + **`availableGameStats` 키 자체 부재**(achievements 빈배열 아님). §5.1.1 3분기 중 "game은 있고 availableGameStats 부재 → `none`" 경로가 실제 형태 |
| **V3** | ✅ 확인 | 존재하지 않는 appid: **HTTP 400 + body `{}`**. fetchJson이 400을 null로 흡수 → `status:'error'` 처리. `{"game":{}}`가 아니라 `{}` |
| **V4** | ✅ 확인 | 원소 키 = **`apiname`, `achieved`, `unlocktime`** (스키마의 `name` 아님) → 정규화에서 **`apiname → name` 통일**. 미획득 시 `achieved:0`, `unlocktime:0`. 실측 예: `{"apiname":"b2cbaee0-...","achieved":0,"unlocktime":0}`. ⚠️ 하드코딩 Hades(1145360)는 **미소유**라 오해 소지 있는 403 "Profile is not public"을 냈음 — 실제 보유 게임(Diablo IV 등)은 정상 200. **미소유 게임과 비공개 프로필이 같은 문자열**을 내므로, 스캔은 **보유 게임만 조회**해 이 모호성을 원천 차단한다 |
| **V5** | ✅ 확인 | 비공개 프로필: **HTTP 403, success=false, error=`"Profile is not public"`** |
| **V6** | ✅ 확인 | 과제 없는 게임 개인 조회: **HTTP 400, success=false, error=`"Requested app has no stats"`** |
| **R7** | ✅ **해소** | V5(403/"Profile is not public") vs V6(400/"Requested app has no stats") — **HTTP 코드·문자열 모두 구별 가능**. `classifyPlayerStatsError`로 private/unavailable 분리 가능 → §5.3.2 "연속 2건 private 중단" 로직 채택. R7 최악(구별 불가→중단 폐기)은 발생 안 함 |
| **V7** | ❌ **뒤집힘** | `GetOwnedGames` 응답에 **`has_community_visible_stats` 필드 부재**(라이브러리 5,364개). → §5.3.1 필터 사용 불가. **§5.3.1 대체안(pt>0 전체 시도 + `none` negative cache)이 기본 경로가 됨**. 첫 스캔 콜 수·소요 증가(§7.1 재계산) |
| **V8** | ✅ 확인 | `l` 생략 시 기본값 **english**(생략=english displayName 일치, koreana는 "타르타로스 탈출"로 정상 지역화). `l=english` 고정 정당, ko 온디맨드(§5.1.6) 유효 |
| **V9** | ✅ 확인(주의) | concurrency 3 + 250ms: **429율 0.00%**(딜레이 250ms 채택 가능). 단 **실효 throughput은 ~6.5 req/s**(300콜/45.9s) — 이론치 12 req/s의 절반(딜레이와 fetch RTT가 겹치지 않음). **§7.1 소요시간을 6.5 req/s로 재계산** |

**Phase 0 완료** (2026-08-25): V1~V9 전부 판정, 착수 차단 조건 없음. 확정 사항: V4 `apiname`, R7 구별 가능(중단 로직 채택), V7 필드 부재 → §5.3.1 대체안 채택, V8 기본 english, V9 250ms/0% 429(단 실효 6.5 req/s). 반영 대상: §5.1.2(icon 도메인), §5.1.4(apiname 확정), §5.3.1(V7 대체안 기본화), §7.1(throughput 재계산).

---

## 4. 데이터 모델

### 4.1 신규 테이블

`lib/db.ts::getDb()`의 `db.exec` 스키마 블록에 추가한다. 기존 테이블 변경이 없으므로 마이그레이션 불필요(`CREATE TABLE IF NOT EXISTS`).

```sql
-- [Phase 1] 앱 도전과제 스키마 스냅샷 (앱 공용, 사용자 비의존).
-- app_meta / app_details_cache 와 같은 계층. 전 사용자가 공유하므로
-- 사용자가 늘어도 앱당 1회만 fetch 한다.
--
-- schema: 정규화된 AchievementDef[] JSON (5.1.2).
--   has_achievements = 0 인 negative row는 '[]' 를 저장한다.
-- schema_hash: diff 대상 필드만으로 계산 (5.4.2). negative row는 빈 문자열.
-- has_achievements: 0이면 "과제 없음"이 확인된 앱. 재조회를 막는 negative
--   cache — 없으면 과제 없는 수천 개 앱을 매주 다시 조회한다.
--   주의: HTTP 실패를 여기에 기록하면 안 된다 (5.1.1 3분기 규칙).
-- miss_streak: negative 판정 연속 관측 횟수. 2 이상에서만 has_achievements=0
--   을 확정한다. 1회성 이상 응답이 30일 캐시로 고착되는 것을 막는다.
CREATE TABLE IF NOT EXISTS app_achievement_schema (
  app_id INTEGER PRIMARY KEY,
  schema TEXT NOT NULL,
  schema_hash TEXT NOT NULL,
  has_achievements INTEGER NOT NULL DEFAULT 1,
  miss_streak INTEGER NOT NULL DEFAULT 0,
  fetched_at INTEGER NOT NULL
);

-- [Phase 2] 전역 달성률 (앱 공용, API Key 불필요).
-- percentages: { [apiName: string]: number } 로 정규화 저장.
--   원본 percent는 string이므로 저장 전 parseFloat (3.1).
CREATE TABLE IF NOT EXISTS app_achievement_global (
  app_id INTEGER PRIMARY KEY,
  percentages TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);

-- [Phase 1] 사용자별 게임 진행률 요약.
-- 과제별 상세는 저장하지 않는다 — 3,482 게임 x 과제 50개 = 17만 행이 되고,
-- 상세는 사용자가 게임을 펼칠 때만 필요하다 (온디맨드, 5.5.2).
--
-- 이 테이블의 "현재 행"이 다음 스캔 시점에는 "직전 상태"가 된다. 5.4.4의
-- 완벽달성 해제 판정은 upsert 이전에 이 행을 읽어 수행한다 — 별도의 이력
-- 컬럼이 필요 없다. 순서를 지키지 않으면(먼저 덮어쓰면) 판정 불가.
--
-- unlocked_30d: 스캔 시점 기준 최근 30일 내 획득한 과제 수. §5.6.1 요약 카드
--   "최근 30일 획득 수"의 유일한 근거다. 과제별 unlockTime 은 온디맨드라 영속
--   저장하지 않으므로(위 주석), 스캔 시 getPlayerAchievements 응답의 unlockTime
--   을 그 자리에서 집계해 이 컬럼에 넣는다 (R10). last_unlock_at(게임당 최신 1건)
--   으로는 "획득 개수"를 산출할 수 없다 — 반드시 별도 컬럼이어야 한다.
--   한계: 30일 창은 조회 시점이 아니라 마지막 스캔 시점 기준이다. 스캔 신선도
--   창이 24시간(Q1)이므로 드리프트는 최대 24시간 — 허용 오차로 본다.
CREATE TABLE IF NOT EXISTS user_achievement_progress (
  user_id INTEGER NOT NULL,
  app_id INTEGER NOT NULL,
  unlocked INTEGER NOT NULL,
  total INTEGER NOT NULL,
  last_unlock_at INTEGER,
  unlocked_30d INTEGER NOT NULL DEFAULT 0,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, app_id),
  FOREIGN KEY (user_id) REFERENCES users(user_id)
);

-- [Phase 3] 스키마 변경 이력 (앱 공용, append-only).
CREATE TABLE IF NOT EXISTS app_achievement_change (
  change_id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id INTEGER NOT NULL,
  detected_at INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('added','removed','renamed','desc','unhidden')),
  api_name TEXT NOT NULL,
  before_value TEXT,
  after_value TEXT
);

CREATE INDEX IF NOT EXISTS idx_ach_change_app_time
  ON app_achievement_change (app_id, detected_at DESC);

-- [Phase 3] 사용자별 알림. 스캔 시점에 판정된 결과를 영속화한다.
-- 판정을 매 조회마다 다시 하지 않는 이유: 판정 재료(직전 진행률)가 upsert로
-- 이미 사라졌기 때문. 스캔 시점이 판정 가능한 유일한 시점이다 (5.4.4).
-- seen_at: 사용자가 배너를 확인한 시각. NULL이면 미확인.
CREATE TABLE IF NOT EXISTS user_achievement_alert (
  alert_id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  app_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('perfect_broken','changed')),
  detected_at INTEGER NOT NULL,
  payload TEXT NOT NULL,
  seen_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE INDEX IF NOT EXISTS idx_ach_alert_user
  ON user_achievement_alert (user_id, detected_at DESC);
```

`before`/`after`는 SQL 예약어 혼동을 피해 `before_value`/`after_value`로 명명한다.

### 4.2 삭제 정책 (필수)

`lib/db.ts::cleanupExpiredUsers()`의 트랜잭션에 다음을 추가한다.

- `user_achievement_progress` 삭제
- `user_achievement_alert` 삭제 (Phase 3)

**두 DELETE는 반드시 `users` DELETE보다 앞에 삽입한다** (M2). `getDb()`는 `PRAGMA foreign_keys`를 켜지 않으므로 FK가 강제되지 않고, 순서를 어기면 고아 행이 조용히 남는다.

도전과제 획득 시각은 개인 활동 이력이므로 개인정보처리방침의 "마지막 로그인으로부터 6개월 후 자동 삭제"가 적용된다. `app/privacy/page.tsx`에 수집 항목 "도전과제 달성 현황 및 획득 시각"을 추가한다.

**앱 공용 테이블**(`app_achievement_schema`, `app_achievement_global`)은 개인정보가 아니므로 사용자 만료와 무관하다. 단 `app_achievement_change`는 무한 증가하므로 **1년 경과 행을 정리**한다 — `cleanupExpiredUsers`와 별개의 함수 `cleanupOldAchievementChanges()`를 만들어 같은 `startCleanupScheduler` 타이머에서 호출한다 (Q3 확정, L6).

### 4.3 저장 용량 추정

`AchievementDef`(§5.1.2)는 `icongray`를 버리고 `icon`을 파일명만 남긴다. 정규화 **후** 기준으로 산정한다 (L2).

| 테이블 | 행 수 | 행당 | 합계 |
|--------|-------|------|------|
| `app_achievement_schema` | 앱 5,000 | 과제 50개 x ~80B ≈ 4KB | ~20MB |
| `app_achievement_global` | 앱 5,000 | ~1.5KB | ~8MB |
| `user_achievement_progress` | 사용자 100 x 앱 1,000 | ~60B | ~6MB |
| `app_achievement_change` | 연 수천 | ~200B | ~1MB |
| `user_achievement_alert` | 연 수천 | ~300B | ~1MB |

합계 ~36MB. SQLite에서 문제없는 규모다.

---

## 5. 변경 계획

### 5.1 `lib/steam/api.ts` / `lib/steam/types.ts` — API 클라이언트

#### 5.1.1 `getAchievementSchema(appId)`

```
GET {STEAM_API_BASE}/ISteamUserStats/GetSchemaForGame/v2/?key={KEY}&appid={appId}&l=english
```

**`l=english` 고정.** 로케일이 흔들리면 전 과제가 "이름 변경"으로 오탐된다 (§5.4.2). 표시용 한국어는 §5.1.6에서 별도 처리한다.

반환 타입 (3분기 — **C2 핵심**):

```ts
type SchemaResult =
  | { status: 'ok'; defs: AchievementDef[]; hash: string }
  | { status: 'none' }      // 과제 없음이 확인됨 (negative)
  | { status: 'error' };    // 조회 실패 — 아무것도 저장하지 않는다
```

분기 규칙:

| 조건 | 결과 | 저장 |
|------|------|------|
| `fetchJson`이 `null` 반환 | `error` | **아무것도 저장하지 않는다** |
| 200 + `availableGameStats.achievements` 배열 비어있지 않음 | `ok` | 가드 통과 시 스냅샷 저장 (§5.4.3) |
| 200 + `game` 객체는 있으나 `availableGameStats` 부재 | `none` | `miss_streak` 증가. **2 이상일 때만** `has_achievements=0` 확정 |
| 200 + `achievements: []` | V2 실측 결과에 따라 `none` 또는 `error` | §3.5 확정 후 결정 |

`fetchJson`은 429·403·5xx·content-type 불일치·네트워크 실패를 **전부 `null`로 반환한다**(`lib/steam/api.ts:214`, `:223`, `:238`). "응답에 achievements가 없으면 negative" 식으로 구현하면 429 버스트 한 번이 수천 앱을 30일간 "과제 없음"으로 못 박고, `app_achievement_schema`는 앱 공용이라 오염이 전 사용자에게 전파된다. **`error`와 `none`을 반드시 구분할 것.**

캐시 조회 순서: LRU `ach:schema:{appId}` → `app_achievement_schema` hydrate → API.

#### 5.1.2 정규화 타입

```ts
/** 스키마에서 diff/표시에 실제로 쓰는 필드만 남긴 정규화 형태. */
export interface AchievementDef {
  /** API명 — 유일한 안정 키. displayName 이 아니다. */
  name: string;
  displayName: string;
  description: string;
  /** 원본은 0|1 이므로 boolean 변환 */
  hidden: boolean;
  /** 아이콘 파일명 (URL 전체가 아님). 예: "a1b2c3....jpg" */
  icon: string;
}
```

`icon`은 URL에서 파일명만 추출해 저장한다. CDN 도메인 변경으로 diff가 오탐되지 않고 용량도 준다. **V1 실측(2026-08-25)**: 원본 URL은 `https://steamcdn-a.akamaihd.net/steamcommunity/public/images/apps/{appId}/{filename}` 형태(도메인이 `media.steampowered.com`이 아님). 경로 규칙 `/apps/{appId}/{filename}`이 확인됐으므로 파일명 추출은 유효하며, 표시 시 **`https://steamcdn-a.akamaihd.net/steamcommunity/public/images/apps/{appId}/{icon}`** 로 복원한다. (파일명은 Hades처럼 해시(`062a2b...jpg`)일 수도, HL2처럼 평문(`hl2_hit_cancop_withcan.jpg`)일 수도 있으나 추출 규칙은 동일.)

#### 5.1.3 원형 응답 타입 (M17)

`lib/steam/types.ts`에 기존 규약(`SteamOwnedGamesResponse` 등)과 나란히 정의한다.

```ts
export interface SteamRawAchievementDef {
  name: string;
  displayName: string;
  description?: string;   // 숨김 과제는 누락될 수 있음 — V1에서 확인
  hidden: 0 | 1;
  icon: string;
  icongray: string;
  defaultvalue: number;
}
export interface SteamAchievementSchemaResponse { /* game.availableGameStats.achievements */ }
export interface SteamPlayerAchievementsResponse { /* playerstats.{success,error,achievements} */ }
export interface SteamGlobalPercentagesResponse {
  achievementpercentages: { achievements: { name: string; percent: string }[] };
}
```

`percent: string`(§3.1 실측), `hidden: 0|1`, `achieved: 0|1`을 **타입 수준에 원형 그대로** 반영하고, 변환은 정규화 함수에서만 한다.

#### 5.1.4 `getPlayerAchievements(steamId, appId)`

```
GET {STEAM_API_BASE}/ISteamUserStats/GetPlayerAchievements/v1/?key={KEY}&steamid={steamId}&appid={appId}
```

- **`l` 파라미터를 붙이지 않는다.** 붙이면 name/description이 중복 포함되어 페이로드만 커진다. 문구는 스키마에서 가져온다.
- **확정 (V4 실측 2026-08-25):** 응답 원소의 키는 스키마의 `name`이 아니라 **`apiname`**이다(실측 원소 `{apiname, achieved, unlocktime}`). 정규화 계층에서 `apiname → name`으로 통일한다.
- `unlocktime`은 미획득 시 `0`, `achieved`는 `0|1`.
- 반환은 4상태:

```ts
type PlayerResult =
  | { status: 'ok'; achievements: { name: string; achieved: boolean; unlockTime: number }[] }
  | { status: 'private' }       // 프로필 비공개
  | { status: 'unavailable' }   // 이 게임에 통계 없음
  | { status: 'error' };        // 일시 실패 — 재시도 대상
```

`private`과 `unavailable`의 판별은 **순수 함수 `classifyPlayerStatsError(res)`로 격리**하고 단위 테스트를 붙인다 (M13). 두 응답은 형태가 유사하며, 오분류하면 §5.3.2가 전체 스캔을 오중단시킨다.

#### 5.1.5 캐시 사용 시 `isStale` 처리 (M4)

`lib/cache.ts:22-28`은 `allowStale: true`로 생성되며 `cacheGet`은 TTL 만료 후에도 `{ data, fetchedAt, isStale: true }`를 반환한다. 기존 호출부(`api.ts:256`, `:281`, `:325`, `:434`)는 전부 `if (cached) return cached;`로 **`isStale`을 검사하지 않는다.**

도전과제 진행률은 이 패턴을 복사하면 안 된다. 사용자가 과제를 딴 직후 새로고침했을 때 옛 값이 보인다. 신규 함수는 다음 형태를 쓴다:

```ts
const c = cacheGet<T>(key);
if (c && !c.isStale) return c.data;
```

negative cache는 값이 `null`일 수 있으므로 반환 타입을 `AchievementDef[] | null`로 명시하고 위 형태로 조회한다 — `if (cached) return cached;`(`api.ts:325` 형태)를 쓰면 miss와 negative를 구분할 수 없다 (M5). `getAppPrice`(`api.ts:404-405`)가 참고할 선례다.

#### 5.1.6 표시용 한국어 스키마 (Phase 2, M14)

이 앱은 전면 한국어이고 `getAppDetails`도 `cc=KR&l=koreana`를 쓴다(`api.ts:356`). 과제 목록만 영어면 §1.3 목적 2의 사용성이 훼손된다.

**결정**: diff·알림 기준선은 `l=english` 고정을 유지하되, **사용자가 게임 행을 펼칠 때만** `l=koreana` 스키마를 온디맨드로 1회 조회해 표시에 사용한다.

- 캐시 키 `ach:schema:ko:{appId}`, TTL 7일, **LRU 전용** (영속 저장하지 않음 — diff와 무관하고 용량만 늘린다)
- 조회 실패 시 영어 스키마로 폴백
- 리스트 뷰는 과제명을 표시하지 않으므로 추가 콜이 없다. 예산 영향은 펼침 횟수에 비례하며 §7.1 표에 반영

#### 5.1.7 `getGlobalAchievementPercentages(appId)` (Phase 2)

```
GET {STEAM_API_BASE}/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v0002/?gameid={appId}
```

- **`getSteamApiKey()`를 호출하지 않는다.** 키 불필요가 실측 확인됨(§3.1). 불필요한 키 노출 경로를 만들지 않는다.
- `percent`는 `parseFloat`. `Number.isFinite` 실패 시 해당 항목 제외.
- `{ [apiName]: number }`로 정규화 후 `app_achievement_global`에 저장. TTL 1일.

#### 5.1.8 로깅

신규 함수는 **반드시 `fetchJson`을 경유한다** — `fetch`를 직접 부르면 `maskUrl`(`api.ts:41-43`)을 우회해 API 키가 로그에 남는다. 로그 카테고리는 기존 `logThrottled` 버킷에 흡수되므로 새 키를 만들지 않는다.

### 5.2 `lib/achievement-store.ts` — 영속 계층 (신규, Phase 1)

`lib/app-details-store.ts`와 동일한 규약: **raw row만 반환, TTL 판정은 caller**. 모듈 경계는 `lib/recommend-cache.ts`와 동일하게 **`steamId`를 받아 내부에서 `getUserBySteamId`로 변환**하고, 사용자 행이 없으면 `null`/`false`를 반환한다 (M1).

| 함수 | 시그니처 | 비고 |
|------|----------|------|
| `getSchemaFromStore` | `(appId) => { defs, hash, hasAchievements, missStreak, fetchedAt } \| null` | JSON 파싱 실패 시 `null` + `console.warn` |
| `setSchemaInStore` | `(appId, defs, hash) => void` | INSERT OR REPLACE, `miss_streak = 0` 리셋 |
| `bumpSchemaMiss` | `(appId) => number` | `miss_streak` 증가 후 값 반환. 2 이상이면 caller가 `has_achievements=0` 확정 |
| `getGlobalFromStore` / `setGlobalInStore` | `(appId)` | Phase 2 |
| `getProgress` | `(steamId, appIds) => Map<appId, row>` | `row`는 `unlocked_30d` 포함. §5.6.1 요약이 합산 |
| `getProgressSummary` | `(steamId) => { totalUnlocked, totalAchievements, perfectGames, avgRate, recent30d } \| null` | 요약 카드용 집계 쿼리(§5.6.1 4개 지표 전부의 유일 출처). `recent30d = SUM(unlocked_30d)`, `avgRate = AVG(unlocked*1.0/total) WHERE total>0`(게임별 달성률의 평균), `perfectGames = COUNT(*) WHERE total>0 AND unlocked=total` |
| `upsertProgressBatch` | `(steamId, rows) => boolean` | **단일 트랜잭션**. `rows` 원소에 `unlocked30d` 포함. 사용자 행 부재 시 no-op + false |
| `insertChanges` | `(appId, changes) => void` | Phase 3, 단일 트랜잭션 |
| `insertAlerts` | `(steamId, alerts) => void` | Phase 3 |
| `getUnseenAlerts` | `(steamId, limit) => Alert[]` | Phase 3 |

### 5.3 `lib/achievement-scan.ts` — 스캔 오케스트레이션 (신규, Phase 1)

#### 5.3.1 대상 게임 선정

```
후보 = getOwnedGames(steamId)
  |> filter(playtime_forever > 0)                          // 기본값 (Q2 확정)
  // has_community_visible_stats 필터는 사용 불가 — V7 실측(2026-08-25)에서 필드
  // 부재 확정. 아래 대체안이 기본 경로다.
  |> filter(app_achievement_schema.has_achievements !== 0)  // negative cache
  |> filter(progress.fetched_at 가 신선도 창 밖)             // 재개 지원 (§5.3.4)
  |> sort(playtime_forever desc)
```

**대체안이 기본 경로 (V7 부재 확정)**: `GetOwnedGames`에 `has_community_visible_stats`가 없으므로, pt>0 전체를 시도하되 `SchemaResult.status === 'none'`인 앱을 negative cache해 다음 스캔부터 제외한다. 첫 스캔 콜 수는 pt>0 전체(≈ §7.1 상단 행)이며, UI에 **"첫 스캔은 10분 이상 걸릴 수 있습니다" 안내가 필수**다. 스키마는 앱 공용이라 두 번째 대형 사용자부터, 그리고 같은 사용자의 재스캔부터는 warm이라 콜이 급감한다.

#### 5.3.2 스캔 절차 (앱 1건)

1. **스키마 확보** — LRU → SQLite → API(§5.1.1). `error`면 skip + `done.skipped++`. `none`이면 negative 처리 후 skip.
2. **스냅샷 write 가드** — API에서 새로 받은 경우에만. `applySnapshotGuards(before, after)`가 `shouldWrite: false`를 주면 저장하지 않는다 (§5.4.3). **Phase 1부터 적용** (C1).
3. **diff 기록** — Phase 3에서만. Phase 1/2는 가드만 돌리고 `insertChanges`를 호출하지 않는다.
4. **개인 진행률 fetch**(§5.1.4).
   - `private`: **연속 2건**일 때만 전체 스캔 중단 + `done.profilePrivate = true`. 1건은 `unavailable` 오분류 가능성이 있으므로 skip 처리 (M13). 중단 시 이미 진행 중인 동시 작업 2건은 완료를 기다린 뒤 결과를 저장하고 종료한다.
   - `unavailable`: skip + `done.skipped++`. 중단하지 않는다.
   - `error`: skip + `done.skipped++`. 다음 스캔에서 재시도.
5. **완벽달성 해제 판정** (Phase 3) — **upsert 이전에** 기존 progress 행을 읽어 §5.4.4를 수행한다. 순서를 어기면 판정 재료가 사라진다.
6. **`unlocked_30d` 집계** (Phase 1) — 4단계 응답의 과제별 `unlockTime`을 이 자리에서 순회해 `fetched_at - 30일 <= unlockTime <= fetched_at`인 건수를 센다. 과제별 상세는 여기서 버리고 이 스칼라만 upsert에 넘긴다(§4.1). `private`/`unavailable`/`error`로 진행률이 없으면 `0`.
7. **progress upsert** — 20개 단위 트랜잭션. `{ unlocked, total, lastUnlockAt, unlocked30d, fetchedAt }`.

전역 달성률은 스캔에서 가져오지 않는다. 리스트 화면에 불필요하고 스캔 콜 수를 2배로 만든다. 펼침 시 온디맨드(§5.5.2).

#### 5.3.3 동시성과 딜레이

`lib/constants.ts`에 추가한다. 기존 `STEAM_API_DELAY` JSDoc(`constants.ts:26-40`)은 전체가 appdetails 전용 서술이므로, **"아래 근거 서술은 `appDetails` 키에만 적용된다"는 단서를 기존 주석에 추가**한 뒤 새 키를 넣는다 (L3).

```ts
/** 공식 api.steampowered.com 용. appdetails(비공식, 1500ms)와 별개 레인. */
achievements: 250,          // V9 결과에 따라 500으로 상향될 수 있음

/** 도전과제 스캔의 앱 단위 동시성. */
export const ACHIEVEMENT_CONCURRENCY = 3;

/** 프로세스 전역 아웃바운드 동시성 상한 (전 사용자 합산). */
export const ACHIEVEMENT_GLOBAL_CONCURRENCY = 8;
```

#### 5.3.4 재개 가능한 스캔 (Phase 1 필수, C5)

기준 사용자의 첫 스캔은 ~10분이다(§7.1). 10분짜리 SSE를 사용자가 켜 두고 기다린다는 가정은 부록 A "측정 발견 사항 3"에서 이미 문제로 지적된 패턴이다.

- progress는 앱 단위로 즉시 영속화되므로, 중단 후 재방문 시 `fetched_at`이 신선도 창(24시간) 안에 있는 앱을 **후보에서 제외**하면 자연스럽게 이어서 진행된다.
- 스키마도 앱 공용 캐시에 남으므로 재시도 시 콜이 절반으로 준다.
- 이 동작을 §5.5.1 `done`의 `remaining` 필드로 사용자에게 알린다: "3,482개 중 1,204개 완료. 다시 방문하면 이어서 진행합니다."

### 5.4 `lib/achievement-diff.ts` — diff 엔진 + 스냅샷 가드 (신규)

외부 의존이 없는 순수 함수 모듈. 이 기능의 실패 모드는 "동작 안 함"이 아니라 **"틀린 알림을 보냄"**이며 그 대부분이 여기서 나온다.

#### 5.4.1 시그니처

```ts
export interface AchievementChange {
  kind: 'added' | 'removed' | 'renamed' | 'desc' | 'unhidden';
  apiName: string;
  before?: string;
  after?: string;
}

/** [Phase 1] 스냅샷을 저장해도 되는지 판정. diff 기록과 무관하게 항상 호출. */
export function applySnapshotGuards(
  before: AchievementDef[] | null,
  after: AchievementDef[]
): { shouldWrite: boolean; reason?: 'empty-response' | 'mass-removal' };

/** [Phase 3] 변경 목록 산출. */
export function diffSchemas(
  before: AchievementDef[],
  after: AchievementDef[]
): AchievementChange[];

export function computeSchemaHash(defs: AchievementDef[]): string;
```

#### 5.4.2 diff 규칙

| 비교 대상 | 판정 | 근거 |
|-----------|------|------|
| `name` (API명) | 매칭 키. before에만 있으면 `removed`, after에만 있으면 `added` | 유일하게 안정적인 식별자 |
| `displayName` | 변경 시 `renamed` | 사용자에게 의미 있음 |
| `description` | 변경 시 `desc` | 공략 정보 영향 |
| `hidden` true→false | `unhidden` | 숨김 과제 공개 |
| `hidden` false→true | **무시** | 실질적으로 발생하지 않음 |
| `icon` | **무시** | CDN 경로/리마스터로 자주 바뀌는 노이즈 |
| 배열 순서 | **무시** | 의미 없음 |

`computeSchemaHash`는 **무시하지 않는 필드만으로** 계산한다. `icon`을 넣으면 아이콘만 바뀌어도 매번 diff 경로를 탄다.

#### 5.4.3 가드 (C1 — G1/G2는 Phase 1)

| 가드 | Phase | 규칙 | 사유 |
|------|-------|------|------|
| **G1 전멸 방지** | **1** | after가 빈 배열이고 before가 비어있지 않으면 `shouldWrite: false` — **스냅샷을 갱신하지 않는다** | API 일시 장애의 빈 응답을 저장하면 스냅샷이 파괴되어 복구 불가 |
| **G2 대량 삭제 보류** | **1** | `removed`가 전체의 50% 초과면 `shouldWrite: false`. **다음 스캔에서도 동일하면** 그때 저장 | 부분 장애 대응 |
| G3 기준선 무알림 | 3 | before 스냅샷이 없으면 변경 이력을 만들지 않는다 | 첫 관측에서 전 과제가 `added`로 뜨는 것 방지 |
| G4 폭주 제한 | 3 | 한 앱의 한 스캔에서 기록하는 변경 최대 50건 | UI/DB 보호 |

**G1·G2가 Phase 1에 있어야 하는 이유**: 이 둘은 diff를 보호하는 가드가 아니라 **스냅샷 저장을 보호하는 가드**다. Phase 3에 두면 Phase 1~3 사이에 축적된 기준선이 이미 훼손된 상태로 diff가 켜지고, 출시 직후 대량 오탐이 발생한다.

G2의 보류는 컬럼 없이 **스키마 갱신을 미루는 것**으로 구현한다. 저장하지 않으면 다음 스캔에서 같은 비교가 반복되고, 두 번째에 동일 결과면 저장한다.

#### 5.4.4 완벽달성 해제 판정 (Phase 3, C4)

**별도의 이력 컬럼이 필요 없다.** `user_achievement_progress`의 현재 행이 곧 직전 스캔 시점의 상태이므로, **upsert 이전에** 읽으면 그것이 "이전 상태"다 (§5.3.2 5단계).

```
prev = getProgress(steamId, [appId])         // upsert 이전
fresh = { unlocked, total }                   // 방금 fetch
if (prev && prev.total > 0 && prev.unlocked === prev.total && fresh.total > prev.total)
    → kind: 'perfect_broken'
```

| 조건 | 등급 | 문구 |
|------|------|------|
| `perfect_broken` | 높음 | "100% 달성했던 *Hades*에 과제 3개가 추가되어 완벽 달성이 해제되었습니다" |
| `changed` + `prev.unlocked > 0` | 보통 | "*Hades*의 도전과제 구성이 변경되었습니다 (추가 3)" |
| `prev.unlocked === 0` | 낮음 (기록하지 않음) | 착수하지 않은 게임의 변경은 노이즈 |

**한계 (문서화 필요)**: 스키마 변경 이후·알림 도입 이전에 진행률이 갱신되면 `prev`가 이미 비완벽 상태여서 감지되지 않는다. Phase 3 출시 후 발생하는 변경에 대해서만 보장한다.

### 5.5 API 라우트

#### 5.5.1 `app/api/achievements/stream/route.ts` (SSE, Phase 1)

`app/api/recommend/route.ts` 구조를 따른다 — `cancelled` 플래그 + `cancel()` 콜백, 배치 시작 전 `isCancelled()`, `sseEvent`/`sseResponse`, `rateLimitResponse` + `getSession`, `export const dynamic = "force-dynamic"`.

쿼리 파라미터:

| 파라미터 | 기본 | 설명 |
|----------|------|------|
| `force` | `false` | `true`면 progress 신선도 창을 무시하고 전체 재스캔 (§5.6.1 수동 버튼) |
| `includeUnplayed` | `false` | `playtime_forever > 0` 필터 해제 (Q2 확정) |

이벤트 시퀀스:

```
cached    { games[], summary, computedAt }   0|1회, 가장 먼저
progress  { loaded, total }                  반복
partial   { games[] }                        반복, 3초 throttle
result    { games[], summary }               1회, 확정
alerts    { items[] }                        1회 (Phase 3)
done      { scanned, skipped, remaining,
            profilePrivate, libraryFetchFailed } 1회
```

**`games[]` 원소 스키마** (M3):

```ts
interface AchievementGameRow {
  appId: number;
  name: string;          // app_meta.name — 없으면 `AppID ${appId}` 폴백
  headerImage: string | null;  // app_meta.header_image
  unlocked: number;
  total: number;
  lastUnlockAt: number | null;
  fetchedAt: number;
}
```

`unlocked_30d`는 **행 원소에 넣지 않는다.** 게임별 표시에 쓰지 않고 요약 카드에서만 합산하므로, 아래 `summary`에만 집계로 반영한다.

**`summary` 스키마**: 위 `getProgressSummary`(§5.2) 반환을 그대로 싣는다. §5.6.1 요약 카드 4개 지표의 유일한 출처다.

```ts
interface AchievementSummary {
  totalUnlocked: number;
  totalAchievements: number;
  perfectGames: number;
  avgRate: number;        // 게임별 달성률 평균 (0~1)
  recent30d: number;      // SUM(unlocked_30d)
}
```

`cached`/`result` 이벤트의 `games[]`는 `user_achievement_progress`를 **`lib/db.ts::app_meta`와 조인**해 구성하고, `summary`는 **`getProgressSummary(steamId)`로 별도 집계**한다(같은 트랜잭션/조회 아님). progress 테이블에는 이름·이미지가 없으므로 조인 없이는 화면을 채울 수 없다. `app_meta`에 행이 없는 앱은 위 폴백 문구를 쓴다. (`/recommend`는 완성 payload를 통째로 JSON 저장하는 방식(`lib/recommend-cache.ts:25-32`)을 썼으나, 여기서는 `app_meta`가 이미 앱 공용으로 존재하므로 중복 저장하지 않는다.)

`logEvent("achievement_scan", { steamId, targetCount, force })`를 스캔 시작 시 남긴다 (L5, 선례 `app/api/recommend/route.ts:167`).

#### 5.5.2 `app/api/achievements/[appId]/route.ts` (온디맨드 상세, Phase 2)

**비보호 라우트** (§5.7, C3). 비로그인 사용자도 `/game/[appId]`에서 전역 달성률을 볼 수 있어야 한다.

| 항목 | 규정 |
|------|------|
| URL | `GET /api/achievements/{appId}?lang=ko\|en` (기본 `ko`) |
| 인증 | `getSession()` 유무로 분기. **세션이 없으면 개인 필드를 아예 붙이지 않는다** |
| Rate Limit | `rateLimitResponse` 적용 (IP당 30/min) |
| `appId` 검증 | `Number.parseInt` + `Number.isInteger` + `> 0`. 실패 시 **400** |
| 스키마 negative | **404** `{ error: "이 게임에는 도전과제가 없습니다." }` |
| 스키마 error | **502** `{ error: "Steam API 조회에 실패했습니다." }` |
| 프로필 비공개 | 200 + `personal: null` + `personalUnavailable: 'private'` |
| 전역 달성률 miss | 200 + 각 항목 `globalPercent: null` (§8 #8) |
| `dynamic` | `force-dynamic` |

응답 타입:

```ts
interface AchievementDetailResponse {
  appId: number;
  achievements: {
    name: string;
    displayName: string;
    description: string;
    hidden: boolean;
    icon: string | null;
    globalPercent: number | null;
    achieved?: boolean;      // 세션 있을 때만
    unlockTime?: number;     // 세션 있을 때만
  }[];
  personalUnavailable?: 'private' | 'unavailable' | 'error';
}
```

#### 5.5.3 캐시 전략

| 데이터 | LRU 키 | TTL | 영속 |
|--------|--------|-----|------|
| 스키마 (en) | `ach:schema:{appId}` | 7일 | `app_achievement_schema` |
| 스키마 없음(negative) | 동일 키에 `null` 저장 | 30일 | `has_achievements=0` |
| 스키마 (ko, 표시용) | `ach:schema:ko:{appId}` | 7일 | 없음 (LRU 전용) |
| 전역 달성률 | `ach:global:{appId}` | 1일 | `app_achievement_global` |
| 개인 획득 | `ach:player:{steamId}:{appId}` | 1시간 | 없음 |
| 스캔 요약 | — | — | `user_achievement_progress.fetched_at` |

`lib/cache.ts::CACHE_TTL`에 `achievementSchema`, `achievementSchemaMissing`, `achievementGlobal`, `achievementPlayer` 추가. 모든 조회는 §5.1.5의 `isStale` 규칙을 따른다.

**변경 감지 지연**: 스키마 TTL이 7일이므로 §5.3.2 1단계가 캐시 hit이면 API를 부르지 않고, 따라서 **변경 감지 지연의 상한은 7일**이다 (M15). TTL 단축은 곧 §7.1 예산 증가이므로 현 시점에서는 7일을 유지하고, Phase 3 운영 후 재평가한다.

### 5.6 UI

#### 5.6.1 `app/achievements/page.tsx` (신규, Phase 1)

`app/recommend/page.tsx`의 레이아웃을 차용한다.

- **상단 요약 카드**: 총 획득 `x/y`, 완벽 달성 게임 수, 평균 달성률, 최근 30일 획득 수
  - "최근 30일 획득 수"는 `SUM(user_achievement_progress.unlocked_30d)`로 산출한다. 이 값은 마지막 스캔 시점 기준이므로(§4.1 한계) "마지막 갱신: N시간 전"과 함께 표기해 오해를 줄인다. **`last_unlock_at`으로 대체 계산하지 말 것** — 게임당 최신 1건이라 개수가 나오지 않는다
- **재스캔 정책** (Q1 확정): progress `fetched_at`이 **24시간 이상 경과한 앱이 있을 때만** 자동 스캔. 그 외에는 `cached` 결과만 표시하고 "마지막 갱신: N시간 전" + **"지금 새로고침" 버튼**(`?force=true`)을 제공한다. 방문마다 전체 재스캔하면 §7.1 예산이 몇 배가 된다.
- **변경 알림 배너** (Phase 3): 미확인 `perfect_broken` 알림을 상단에 강조. 별도 페이지를 만들지 않는다
- **게임 리스트**: 진행률 바 + `12/45` + %
  - 정렬: 달성률순 / **남은 개수 적은 순**(거의 완주) / **남은 개수 많은 순**(갈 길 먼 순) / 최근 획득순 / 이름순
    - "남은 개수" = `total - unlocked`. 두 방향 모두 완벽달성(남은 0)·미착수 게임은 필터 설정을 따른다. 정렬은 `useMemo`라 방향 추가 비용은 없다
  - 필터: 완벽 달성 숨김, 미착수 게임 포함(기본 꺼짐)
    - "완벽 달성 숨김"을 켜면 남은 과제가 있는 게임만 남는다(= "도전과제 남은 게임만" 뷰)
  - 렌더는 `PAGE_SIZE`(50) 단위 "더 보기". 정렬/필터는 `useMemo`
- **행 펼침** (Phase 2): `/api/achievements/{appId}` 호출. 획득 여부 + 획득 일시 + 전역 달성률 바
  - 정렬: 희귀도순(전역 % 오름차순) / 기본
  - 필터: 미획득만
  - **미획득 숨김 과제는 기본 접힘**(스포일러 보호), 클릭 시 공개. 획득한 숨김 과제는 접지 않는다

#### 5.6.2 `components/AchievementProgress.tsx` (신규)

**`components/ProgressBar.tsx`는 재사용하지 않는다** (M7 — 확정). 레이블 `"{loaded}/{total} 게임 로딩 완료"`가 하드코딩되어 있고(`ProgressBar.tsx:13`) props가 `{loaded, total}` 2개뿐이라 달성률 표시에 쓸 수 없다.

```ts
interface AchievementProgressProps {
  unlocked: number;
  total: number;
  size?: 'sm' | 'md';     // 리스트 행 / 요약 카드
  showLabel?: boolean;
}
```

SSE 로딩 진행률에는 기존 `ProgressBar`를 그대로 쓴다.

#### 5.6.3 `components/AppNav.tsx` (신규) — 네비 통합 (M6)

**두 페이지의 헤더는 구조가 같지 않다.**

- `app/recommend/page.tsx:259-272`: 중앙 pill `<nav>`(리뷰 피드 / 성향 분석)
- `app/feed/page.tsx:129-144`: **같은 슬롯을 소스 탭**(위시리스트/라이브러리/둘 다)이 차지하고, `/recommend` 링크는 우측에 `hidden sm:inline` 텍스트 링크로 별도 존재(`feed/page.tsx:147-153`)

따라서 단순 추출로는 통합되지 않는다. 확정 방침:

1. `AppNav`는 `props: { current: 'feed' | 'recommend' | 'achievements' }`를 받는 pill `<nav>` 컴포넌트로 만든다.
2. `/recommend`, `/achievements`는 중앙 슬롯에 `AppNav`를 놓는다.
3. `/feed`는 **소스 탭을 필터 영역(헤더 아래)으로 내리고** 중앙 슬롯에 `AppNav`를 놓는다. 우측의 `hidden sm:inline` "성향 분석" 링크는 제거한다(AppNav로 대체).
4. **모바일 노출**: 항목이 3개가 되므로 `hidden sm:` 계열 클래스를 쓰지 않는다. 좁은 화면에서는 pill을 가로 스크롤(`overflow-x-auto`)로 처리한다. 현재 `/recommend` 진입점은 모바일에서 보이지 않는데, 이를 함께 해소한다.

3번은 `/feed`의 기존 레이아웃 변경이므로 §10에 회귀 검증 항목을 둔다.

#### 5.6.4 `app/game/[appId]/page.tsx` (수정, Phase 2)

미디어 갤러리 아래에 도전과제 요약 섹션: 진행률 바 + 희귀 미획득 과제 3개. 이 페이지는 비로그인 접근이 허용되므로(`middleware.ts` 미보호), 비로그인 시 전역 달성률만 표시한다. `/api/achievements/{appId}`가 비보호여야 하는 이유가 이것이다(C3).

### 5.7 `middleware.ts` (수정, Phase 1)

```ts
const PROTECTED_PAGES = ["/feed", "/recommend", "/achievements"];          // E1
const PROTECTED_API = [
  "/api/wishlist", "/api/library", "/api/reviews",
  "/api/recommend",                    // E2 (M10)
  "/api/achievements/stream",          // stream만 보호 — C3
];
```

**`/api/achievements`를 통째로 넣으면 안 된다.** `[appId]` 상세 라우트는 비로그인 접근이 필요하다(§5.6.4). prefix를 `/api/achievements/stream`으로 좁히면 `middleware.ts:33-35`의 reviews 예외 같은 조건 분기 없이 해결된다.

`config.matcher`에도 다음을 추가한다 — **matcher에 없으면 미들웨어가 실행조차 되지 않는다**:

```ts
matcher: [
  "/feed/:path*", "/recommend/:path*", "/achievements/:path*",
  "/api/wishlist/:path*", "/api/library/:path*", "/api/reviews/:path*",
  "/api/recommend/:path*", "/api/achievements/:path*",
]
```

matcher는 `/api/achievements/:path*` 전체를 포함하되 `PROTECTED_API` 판정에서 `stream`만 걸리므로, 상세 라우트는 미들웨어를 통과만 하고 401을 받지 않는다.

### 5.8 `lib/outbound-limit.ts` — 전역 세마포어 (신규, Phase 1 필수, M11)

`lib/rate-limit.ts`는 인바운드 IP 제한이라 아웃바운드 동시성을 제어하지 못한다. 사용자 10명이 동시에 첫 스캔을 돌리면 `10 × ACHIEVEMENT_CONCURRENCY = 30` 동시 요청이 나간다.

```ts
/** 슬롯을 획득해 fn을 실행하고, 성공·실패·취소와 무관하게 반드시 반납한다. */
export function withOutboundSlot<T>(fn: () => Promise<T>): Promise<T>;
```

- 상한 `ACHIEVEMENT_GLOBAL_CONCURRENCY = 8` (프로세스 전역, 모듈 스코프 카운터 + 대기 큐)
- 반납은 `finally`로 보장한다. SSE `cancel()`로 스캔이 중단돼도 대기 중이던 작업이 슬롯을 물고 있으면 안 된다
- 대기 상한 60초. 초과 시 해당 앱은 skip + `done.skipped++` (전체 스캔을 실패시키지 않는다)
- **일일 예산 가드**: 프로세스 내 콜 카운터를 두고 80,000콜/일 초과 시 새 스캔을 거부하고 `done.budgetExceeded = true`를 반환한다. 한도 100,000에 대한 안전 마진(§7.1)

---

## 6. 단계 분할

| Phase | 범위 | 산출물 | 단독 가치 |
|-------|------|--------|-----------|
| **0** | API 실측 (§3) | `scripts/probe-achievements.ts`, §3.5 기록, V1~V9 판정 | 설계 가정 확정 |
| **1** | 수집 + 리스트 뷰 + **가드/세마포어** | API 2함수(schema/player), types 4종, `achievement-store.ts`, `achievement-scan.ts`, `achievement-diff.ts`(**G1/G2 + hash만**), `outbound-limit.ts`, SSE 라우트, `/achievements` 리스트, `AppNav`, `AchievementProgress`, 미들웨어, DB 2테이블 + cleanup | "내 라이브러리 달성 현황 한눈에" — 단독 출시 가능 |
| **2** | 상세 + 전역 달성률 + 한국어 표시 | `getGlobalAchievementPercentages`, ko 스키마 온디맨드, `[appId]` 라우트, 행 펼침 UI, `/game/[appId]` 섹션, DB 1테이블 | "희귀 과제 발굴" |
| **3** | 변경 감지 + 알림 | `diffSchemas` + G3/G4, `insertChanges`, 완벽달성 해제 판정, 알림 배너, DB 2테이블 + 이력 정리 | "완벽 달성 해제 알림" |

Phase 1이 **가드를 포함**하므로 Phase 1 배포 시점부터 오염되지 않은 기준선이 쌓인다. Phase 3은 그 위에 diff 기록만 얹는다.

Phase 3의 완벽달성 해제 판정은 §5.4.4대로 **직전 progress 행**을 재료로 쓰므로 Phase 1에 추가 컬럼이 필요 없다. 다만 §5.3.2의 **읽기→판정→upsert 순서**는 Phase 1 구현 시점부터 지켜 두어야 Phase 3에서 코드 구조를 뒤집지 않는다.

---

## 7. 제약 조건

### 7.1 Rate Limit 예산 (실측 기반 재계산 — C5)

Steam Web API Key 한도: **100,000 calls/day**, 키 단위 = **전 사용자 공유**.

기준: `ACHIEVEMENT_CONCURRENCY = 3`, `achievements: 250ms`. **V9 실측(2026-08-25): 429율 0%지만 실효 ~6.5 req/s**(딜레이와 fetch RTT가 겹치지 않아 이론치 12의 절반). **아래 표의 소요시간은 6.5 req/s 기준 약 1.8배로 늘려 읽어야 한다** (예: pt>0 3,482 cold ≈ ~18분). 스캔 구현 시 딜레이를 fetch와 겹치게(예: 슬롯 획득 후 즉시 fetch, 반납 시 지연) 만들면 실효율을 12에 근접시킬 수 있다 — Phase 1 튜닝 대상. 또한 V7 필드 부재로 **대상 = pt>0 전체**(도전과제 보유 필터 불가, §5.3.1)이므로 첫 스캔은 항상 상단 시나리오다.

| 라이브러리 규모 | 대상(pt>0) | 첫 스캔(cold) | 소요 | 재스캔(스키마 warm) | 소요 |
|---|---|---|---|---|---|
| 소형 | 300 | 600콜 | ~50초 | 300콜 | ~25초 |
| 중형 | 1,000 | 2,000콜 | ~2.8분 | 1,000콜 | ~1.4분 |
| **실측 기준 사용자** | **3,482** | **6,964콜** | **~9.7분** | **3,482콜** | **~4.8분** |

실측 기준 사용자 출처: `docs/20260527_01_...md:670`(라이브러리 5,347), `:728`(playtime=0이 1,865 = 34.9%) → pt>0 = 3,482. V7이 성공해 도전과제 보유 게임만 남기면 이보다 줄지만, **감소율이 측정되기 전까지는 3,482를 상한으로 본다**.

**일일 예산 점유**:

- 실측 기준 사용자 1명 cold = 6,964콜 = 한도의 **7.0%**
- 같은 규모 사용자 10명이 같은 날 cold = **70%** — 위험
- 정상 운영(WAU 100, 평균 500게임, 주 1회 warm 재스캔) = 50,000콜/주 = **일 7,100콜(7%)**

스키마는 앱 공용이라 두 번째 대형 사용자부터는 겹치는 앱만큼 warm이 된다. 그럼에도 §5.8의 **전역 세마포어와 일일 예산 가드는 Phase 1 필수**다.

§5.1.6의 ko 스키마는 펼침당 최대 1콜이며, 캐시 적중 후에는 0이다. 일 수백 콜 수준으로 예산에 유의미하지 않다.

### 7.2 하위 호환

- 신규 테이블만 추가, 기존 테이블 변경 없음 → 기존 `data/*.db`가 그대로 열린다
- 기존 API 응답 형식 변경 없음
- `SteamOwnedGame`에 `has_community_visible_stats?: boolean`을 **옵셔널** 추가
- `STEAM_API_DELAY` 키 추가는 `as const` 확장이라 기존 참조에 영향 없음
- **예외**: §5.6.3의 `/feed` 소스 탭 이동은 기존 UI 변경이다. §10에 회귀 항목을 둔다

### 7.3 보안 / 프라이버시

- 신규 함수는 반드시 `fetchJson` 경유 — 직접 `fetch` 시 `maskUrl`(`api.ts:41-43`)을 우회해 API 키가 로그에 남는다
- `appId`는 `Number.parseInt` + `Number.isInteger` + 양수 검증. SQL은 전부 prepared statement
- **다른 사용자의 도전과제를 조회할 수 있는 경로를 만들지 않는다.** 개인 진행률은 세션의 `steamId`만 사용하며, `steamId`를 쿼리 파라미터로 받지 않는다
- 비공개 프로필 사용자의 데이터는 조회되지 않으므로 저장할 것이 없다
- `/api/achievements/[appId]`는 비보호지만 **개인 필드는 세션이 있을 때만** 응답에 포함한다(§5.5.2)

### 7.4 성능

- progress upsert는 20개 단위 트랜잭션. better-sqlite3는 동기 API라 3,482건 개별 커밋 시 이벤트 루프를 유의미하게 막는다
- 리스트 뷰는 수천 행이 될 수 있다 — 정렬/필터는 `useMemo`, 렌더는 `PAGE_SIZE`(50) 단위
- 스키마 JSON 파싱은 펼침 시에만. 리스트 뷰는 `unlocked/total` 숫자만 쓴다

---

## 8. 엣지 케이스

| # | 상황 | 처리 |
|---|------|------|
| 1 | 프로필 비공개 | **연속 2건** `private`에서 스캔 중단, `done.profilePrivate = true`. UI: "Steam 프로필의 '게임 상세 정보'를 공개로 바꿔야 진행률을 볼 수 있습니다" + 설정 링크. 전역 달성률 기능은 계속 동작 |
| 2 | 라이브러리 조회 실패 | `done.libraryFetchFailed = true` (`/recommend`와 동일) |
| 3 | 도전과제 없는 게임 | `miss_streak` 2회 확정 후 negative cache. 리스트 제외, 요약 분모에서도 제외 |
| 4 | 스키마 조회 일시 실패 | **negative로 기록하지 않는다.** skip + `done.skipped++`. 다음 스캔 재시도 |
| 5 | 개인 데이터 조회 일시 실패 | 동일 |
| 6 | 최초 스캔 (기준선 없음) | G3로 변경 알림 없음. UI에 "다음 스캔부터 변경을 감지합니다" |
| 7 | 전역 달성률에 스키마에 없는 `name` 포함 | 무시 (스키마 기준 표시) |
| 8 | 스키마에 있는데 전역 달성률에 없는 과제 | `globalPercent: null` → "-" 표시. 신규 과제는 집계 전일 수 있다 |
| 9 | `unlocked > total` (스키마 축소 직후) | `Math.min(unlocked, total)`로 클램프. 100% 초과 바 방지 |
| 10 | 스캔 중 페이지 이탈 | `cancel()` 콜백에서 플래그 세팅, 다음 배치 전 중단. 부분 저장은 유효하므로 롤백하지 않고, 재방문 시 §5.3.4로 이어서 진행 |
| 11 | 두 탭 동시 스캔 | 같은 값 upsert이므로 무해. 단 §5.4.4 판정이 두 번 돌면 중복 알림이 가능하므로, `insertAlerts`는 `(user_id, app_id, kind, detected_at 일자)` 기준 중복을 무시한다 |
| 12 | 게임이 Steam에서 삭제/이관 | 스키마 조회 실패 → skip. 기존 progress 행은 남지만 리스트가 라이브러리와 조인되므로 표시되지 않는다 |
| 13 | 전역 세마포어 대기 60초 초과 | 해당 앱 skip + `done.skipped++`. 스캔 전체를 실패시키지 않는다 |
| 14 | 일일 예산 80,000콜 초과 | 새 스캔 거부, `done.budgetExceeded = true`. UI: "오늘의 조회 한도에 도달했습니다. 내일 다시 시도해주세요." 캐시 결과는 정상 표시 |

---

## 9. 테스트 계획

`__tests__/` 규약(Vitest)을 따른다. **현재 17파일**이다 — README의 "13파일 128개"(`README.md:61`)는 낡은 값이며 본 작업에서 함께 정정한다 (E4).

| 파일 | Phase | 핵심 케이스 |
|------|-------|-------------|
| `achievement-diff.test.ts` | 1(가드) / 3(diff) | **G1 빈 배열 방어**, **G2 50% 초과 삭제 보류 후 2회차 확정**, `icon`만 변경 시 hash 불변, 순서만 변경 시 hash 불변 / 추가·삭제·개명·설명변경·unhidden 각 1건, G3 기준선 무알림, G4 50건 상한 |
| `achievement-normalize.test.ts` | 1 | **`apiname` → `name` 매핑**(V4), `percent` 문자열 → 숫자, 잘못된 percent 제외, `hidden` 0/1 → boolean, `icon` URL → 파일명, **`classifyPlayerStatsError`가 private/unavailable/error를 구분** |
| `achievement-store.test.ts` | 1 | upsert 멱등성, 손상 JSON 시 null + 경고, negative row 왕복, `bumpSchemaMiss` 누적, 사용자 행 부재 시 no-op |
| `achievement-scan.test.ts` | 1 | `vi.mock("@/lib/steam/api")` 패턴(`__tests__/media-api.test.ts:17-22` 선례). **`status:'error'`인 앱이 negative cache에 기록되지 않는다**(C2 회귀), `private` 1건은 중단시키지 않고 2건 연속에서 중단, `unavailable`은 중단시키지 않음, 신선한 progress를 가진 앱이 후보에서 제외됨(§5.3.4), **`unlocked_30d` 집계** — 30일 경계 안/밖 `unlockTime`을 섞은 응답에서 경계 내 건수만 셈, 진행률 없음(private/unavailable/error)이면 `0` |
| `outbound-limit.test.ts` | 1 | 상한 초과 시 대기, 예외 발생 시에도 슬롯 반납(`finally`), 대기 타임아웃 |
| `db.test.ts` (기존 수정) | 1 | **`cleanupExpiredUsers`가 `user_achievement_progress`를 삭제**(§4.2 회귀) |

**`db.test.ts` 격리 주의** (M2): `__tests__/db.test.ts:10-12`는 실제 `data/steam_review_feed.db`를 사용한다. `cleanupExpiredUsers()`를 그대로 호출하면 6개월 이상 미접속 **실제 사용자를 전부 삭제**한다. 기존 테스트의 `uniqueSteamId()` 격리가 통하지 않는 전역 삭제다. 따라서 이 케이스는 `cleanupExpiredUsers()`를 호출하지 않고, **동일 조건의 DELETE 대상 집합을 SELECT로 검증**하는 방식으로 작성한다(테이블이 대상 목록에 포함되는지 확인). 실제 삭제 동작 검증이 필요하면 `getDb()`에 테스트용 경로 주입을 도입하는 별도 작업으로 분리한다.

네트워크는 모킹하지 않지만 **모듈 경계는 모킹한다** — `media-api.test.ts:17`의 확립된 선례를 따른다.

---

## 10. 완료 기준

각 항목은 검증 방법과 통과 임계값을 가진다.

### Phase 0

| # | 기준 | 검증 방법 | 통과 임계값 |
|---|------|-----------|-------------|
| 0-1 | V1~V9 판정 완료 | §3.5에 항목별 판정 + 원문 발췌 기록 | 9개 항목 모두 "확인"/"반증" 중 하나로 기재. "미확인" 0건 |
| 0-2 | V9 부하 판정 | `scripts/probe-achievements.ts` 300콜 로그 | 429 발생률 < 1%. 초과 시 딜레이 500ms 재측정 후 채택값을 `constants.ts`에 반영 |

### Phase 1

| # | 기준 | 검증 방법 | 통과 임계값 |
|---|------|-----------|-------------|
| 1-1 | 달성률 표시 | 본인 계정으로 `/achievements` 진입, 임의 게임 3개를 Steam 프로필 페이지와 수동 대조 | 3개 모두 `unlocked/total` 일치 |
| 1-2 | `cached` 즉시 표시 | 1회 스캔 후 새로고침, DevTools Network에서 첫 SSE 이벤트 도착 시각 측정 | `cached` 이벤트가 최초 Steam API 요청보다 먼저, 진입 후 1초 이내 도착 |
| 1-3 | 재개 동작 | 스캔 중 페이지 이탈 → 재진입 | `done.remaining`이 이탈 시점보다 감소. 이미 처리된 앱을 재조회하지 않음(로그로 확인) |
| 1-4 | 비공개 프로필 안내 | V5 절차로 프로필 비공개 전환 후 진입, 측정 후 원복 | 안내 문구 표시 + `logEvent` 기준 Steam 호출이 2건 이하에서 중단 |
| 1-5 | 인증 가드 | 시크릿 창에서 `/achievements`, `/recommend`, `/api/achievements/stream`, `/api/recommend` 접근 | 페이지 2건은 `/`로 리다이렉트, API 2건은 401 |
| 1-6 | 상세 라우트 비보호 | 시크릿 창에서 `/api/achievements/{appId}` 접근 | 200 + `achieved` 필드 없음 (401이 아님) |
| 1-7 | 정리 회귀 | `npm test` — `db.test.ts` 신규 케이스 | 통과 |
| 1-8 | `/feed` 회귀 | `/feed`에서 소스 탭 3종 전환, 모바일 폭(375px)에서 AppNav 3항목 노출 확인 | 소스 탭 동작 유지, 3항목 모두 도달 가능 |
| 1-9 | 개인정보 문서 | `app/privacy/page.tsx` | 수집 항목에 도전과제 관련 문구 존재 |
| 1-10 | 정적 검증 | `npx tsc --noEmit` / `npm run lint` | 오류 0 |
| 1-11 | 테스트 회귀 | 베이스 commit `81553c3`에서 `npm test` 통과 수 기록 → 현재와 비교 | 기존 통과 수 유지 + 신규 케이스 전부 통과 |
| 1-12 | 빌드 | `npm run build` (postbuild의 standalone 복사 포함) | 성공 (L4) |
| 1-13 | 문서 | `README.md`/`README.en.md`/`CHANGELOG.md`, `docs/planning.md` 기능 서술 | `/achievements` 반영 + `__tests__` 파일 수 정정 (L7, L8) |
| 1-14 | 30일 획득 지표 | 최근 30일 내 과제를 딴 게임 2개를 Steam과 대조, 요약 카드 값 확인 | 요약의 "최근 30일 획득 수"가 `SUM(unlocked_30d)`와 일치. `last_unlock_at` 기반 계산이 아님(코드 확인) |

### Phase 2

| # | 기준 | 검증 방법 | 통과 임계값 |
|---|------|-----------|-------------|
| 2-1 | 과제 상세 | 게임 행 펼침 | 과제 목록 + 전역 달성률 표시, 한국어 문구 |
| 2-2 | 희귀도 정렬 | 정렬 토글 | 전역 % 오름차순 정렬, `null`은 최하단 |
| 2-3 | 숨김 과제 | 미획득 숨김 과제 확인 | 기본 접힘, 클릭 시 공개. 획득한 것은 접히지 않음 |
| 2-4 | 게임 상세 페이지 | 로그인/비로그인 각각 `/game/{appId}` | 로그인 시 진행률+희귀 미획득 3개, 비로그인 시 전역 달성률만 |
| 2-5 | ko 폴백 | ko 스키마 조회 실패를 강제 | 영어 문구로 폴백, 오류 표시 없음 |

### Phase 3

| # | 기준 | 검증 방법 | 통과 임계값 |
|---|------|-----------|-------------|
| 3-1 | 변경 기록 | 로컬에서 스냅샷을 수동 수정 후 스캔 | `app_achievement_change`에 해당 행 생성 |
| 3-2 | G1/G2 | 빈 응답·대량 삭제를 모킹한 단위 테스트 | 변경 기록 0건, 스냅샷 미갱신 |
| 3-3 | G3 | 신규 앱 최초 스캔 | 변경 기록 0건 |
| 3-4 | 완벽달성 해제 | progress를 `unlocked==total`로 세팅 후 total 증가를 모킹 | `perfect_broken` 알림 생성, 배너 표시 |
| 3-5 | 중복 알림 | 같은 날 두 번 스캔 | 알림 1건만 (§8 #11) |
| 3-6 | 이력 정리 | `cleanupOldAchievementChanges()` 단위 테스트 | 1년 경과 행만 삭제 |

---

## 11. 리스크

| ID | 리스크 | 영향 | 완화 |
|----|--------|------|------|
| R1 | V4(`apiname`) 가정이 틀림 | 정규화 재작성 | Phase 0 선검증. 정규화를 단일 함수로 격리 |
| R2 | V7 부재/부정확 | 첫 스캔이 3,482콜 → 최대 6,964콜(§7.1 하단 행) | 대체안(§5.3.1) + 재개 지원(§5.3.4) + UI 안내. **V7이 성공해도 기준 사용자는 ~7,000콜/10분**이므로 세마포어는 무조건 필요 |
| R3 | diff 오탐으로 잘못된 알림 | 신뢰도 훼손 — 최대 실패 모드 | G1~G4 + `achievement-diff.test.ts` 집중 |
| R4 | 다수 사용자 동시 스캔으로 429 / 일 한도 소진 | 스캔 실패 | §5.8 전역 세마포어(8) + 일일 예산 가드(80,000) |
| R5 | 스키마 저장 용량 | SQLite 비대 | 정규화 후 ~20MB(§4.3). 문제 없음 |
| R6 | Steam이 스키마 로케일 기본값 변경 | 전 앱 오탐 | `l=english` 명시 고정 + G2가 방어벽 |
| **R7** | **V5/V6 응답이 구별 불가능 → `unavailable`을 `private`으로 오분류** | **과제 없는 게임 1개 때문에 3,482개 스캔이 통째로 중단** | `classifyPlayerStatsError` 순수 함수 격리 + 단위 테스트, **연속 2건에서만 중단**(§5.3.2). V6에서 구별 불가로 판명되면 중단 로직 자체를 폐기하고 앱별 skip으로 전환 |
| R8 | 변경 감지가 최대 7일 지연 | 알림이 늦게 도착 | 스키마 TTL과의 트레이드오프를 §5.5.3에 명시. Phase 3 운영 후 재평가 |
| R9 | `/feed` 소스 탭 이동으로 기존 UX 회귀 | 사용자 혼란 | §10 1-8 회귀 검증 |
| R10 | "최근 30일 획득 수"가 마지막 스캔 시점 기준이라 조회 시점과 최대 24시간 드리프트 | 요약 수치가 실제와 소폭 어긋남 | 스캔 신선도 창(24h, Q1)과 동일 상한. "마지막 갱신: N시간 전" 병기(§5.6.1). 과제별 unlockTime 영속 저장은 §4.1이 배제한 17만 행이므로 채택하지 않음 |

### 확정된 결정 (v1의 미해결 질문 — C8)

| # | 질문 | 결정 | 반영 위치 |
|---|------|------|-----------|
| Q1 | 재스캔 트리거 | progress `fetched_at` 24시간 초과 앱이 있을 때만 자동. 그 외 캐시 표시 + `?force=true` 수동 버튼 | §5.5.1, §5.6.1, §7.1 |
| Q2 | 미착수 게임 포함 기본값 | **기본 제외.** `includeUnplayed` 파라미터로 제공 | §5.3.1, §5.5.1, §5.6.1 |
| Q3 | 변경 이력 보존 | **1년.** `cleanupOldAchievementChanges()`를 `startCleanupScheduler`에서 호출 | §4.2 |

---

## 12. 변경 파일 요약

| 파일 | 종류 | Phase | 변경 내용 |
|------|------|-------|-----------|
| `lib/db.ts` | 수정 | 1/2/3 | 테이블 5개 추가(`user_achievement_progress`에 `unlocked_30d` 컬럼 포함), `cleanupExpiredUsers`에 사용자 테이블 2개 삭제 추가(users보다 앞), `cleanupOldAchievementChanges` 신규 + 스케줄러 등록 |
| `lib/cache.ts` | 수정 | 1/2 | `CACHE_TTL` 4개 항목 추가 |
| `lib/constants.ts` | 수정 | 1 | `STEAM_API_DELAY.achievements`, `ACHIEVEMENT_CONCURRENCY`, `ACHIEVEMENT_GLOBAL_CONCURRENCY`. 기존 JSDoc에 "appDetails 전용" 단서 추가 |
| `lib/steam/types.ts` | 수정 | 1/2 | 원형 응답 타입 4종, `AchievementDef`, `SteamOwnedGame.has_community_visible_stats?` |
| `lib/steam/api.ts` | 수정 | 1/2 | `getAchievementSchema`, `getPlayerAchievements`, `classifyPlayerStatsError`, `getGlobalAchievementPercentages`, ko 스키마 조회 |
| `lib/achievement-store.ts` | 신규 | 1/2/3 | 영속 계층 (§5.2) |
| `lib/achievement-scan.ts` | 신규 | 1 | 스캔 오케스트레이션 (§5.3). `unlocked_30d` 스캔 시점 집계 포함(§5.3.2 6단계) |
| `lib/achievement-diff.ts` | 신규 | 1/3 | 가드(1) + diff(3) (§5.4) |
| `lib/outbound-limit.ts` | 신규 | 1 | 전역 세마포어 + 일일 예산 가드 (§5.8) |
| `app/api/achievements/stream/route.ts` | 신규 | 1 | SSE 스캔 |
| `app/api/achievements/[appId]/route.ts` | 신규 | 2 | 온디맨드 상세 (비보호) |
| `app/achievements/page.tsx` | 신규 | 1/2/3 | 탭 본체 |
| `components/AppNav.tsx` | 신규 | 1 | 네비 3종 통합 |
| `components/AchievementProgress.tsx` | 신규 | 1 | 달성률 바 |
| `components/AchievementRow.tsx` | 신규 | 2 | 과제 행 |
| `app/feed/page.tsx` | 수정 | 1 | AppNav 도입, 소스 탭을 필터 영역으로 이동, `hidden sm:inline` 링크 제거 |
| `app/recommend/page.tsx` | 수정 | 1 | AppNav 도입 |
| `app/game/[appId]/page.tsx` | 수정 | 2 | 도전과제 요약 섹션 |
| `app/privacy/page.tsx` | 수정 | 1 | 수집 항목 추가 |
| `middleware.ts` | 수정 | 1 | `PROTECTED_PAGES`/`PROTECTED_API`/`matcher` (E1, E2, C3) |
| `scripts/probe-achievements.ts` | 신규 | 0 | 실측 스크립트 |
| `package.json` | 수정 | 0 | devDependency `tsx` |
| `.gitignore` | 수정 | 0 | `scripts/probe-*` |
| `__tests__/achievement-diff.test.ts` | 신규 | 1/3 | |
| `__tests__/achievement-normalize.test.ts` | 신규 | 1 | |
| `__tests__/achievement-store.test.ts` | 신규 | 1 | |
| `__tests__/achievement-scan.test.ts` | 신규 | 1 | |
| `__tests__/outbound-limit.test.ts` | 신규 | 1 | |
| `__tests__/db.test.ts` | 수정 | 1 | cleanup 회귀 (격리 주의 §9) |
| `README.md`, `README.en.md` | 수정 | 1 | 기능 추가, `__tests__` 파일 수 정정 |
| `CHANGELOG.md` | 수정 | 1/2/3 | |
| `docs/planning.md` | 수정 | 1 | 기능 구성 서술에 도전과제 탭 반영 |

**참고**: `app/api/cache/invalidate/route.ts`는 **변경하지 않는다.** Q1을 `?force=true`(SSE 파라미터)로 확정했으므로 LRU 무효화 경로가 필요 없다. 이 라우트의 `allowedPrefixes`(`route.ts:30-33`)는 LRU만 지우는데, 진행률의 실제 신선도 기준은 SQLite `fetched_at`이라 LRU를 지워도 재스캔이 트리거되지 않는다 (M9).
