/**
 * 도전과제 스캔 오케스트레이션 (신규, Phase 1). 작업 지시서 20260825_01 §5.3.
 *
 * 흐름(앱 1건, §5.3.2): 스키마 확보(store→API) → 스냅샷 가드 후 저장 → 개인 진행률
 * → unlocked_30d 집계 → progress upsert(배치). Phase 1이라 diff 기록/완벽달성 해제
 * 판정(Phase 3)은 하지 않는다.
 *
 * 대상 선정(§5.3.1): pt>0(옵션) → negative cache 제외 → 신선도 창(24h) 밖 → 플레이
 * 타임 내림차순. V7(has_community_visible_stats) 필드 부재 확정이라 pt>0 전체를
 * 시도하고 `none`을 negative cache한다.
 *
 * 동시성: 스캔 내부는 ACHIEVEMENT_CONCURRENCY 풀, 개별 아웃바운드 콜은 프로세스
 * 전역 세마포어(withOutboundSlot)를 통과한다. 각 콜 앞에 achievements 딜레이를 둔다
 * (단순 구현 — 슬롯을 쥔 채 대기하므로 실효율은 §7.1 주석대로 이론치의 절반 수준.
 * 처리량 튜닝은 후속).
 */

import {
  getOwnedGames,
  getAchievementSchema,
  getPlayerAchievements,
} from "@/lib/steam/api";
import type { AchievementDef, SteamOwnedGame } from "@/lib/steam/types";
import {
  getSchemaFromStore,
  setSchemaInStore,
  bumpSchemaMiss,
  getProgress,
  upsertProgressBatch,
  insertChanges,
  insertAlerts,
  type ProgressRow,
  type ProgressUpsertRow,
} from "@/lib/achievement-store";
import { applySnapshotGuards, diffSchemas, type AchievementChange } from "@/lib/achievement-diff";
import { withOutboundSlot, isDailyBudgetExceeded } from "@/lib/outbound-limit";
import { getAppMeta } from "@/lib/app-meta-cache";
import { ACHIEVEMENT_CONCURRENCY, STEAM_API_DELAY } from "@/lib/constants";

/**
 * 리스트 화면 1행 (SSE `games[]` 원소, §5.5.1 M3).
 * `unlocked30d`를 포함해 클라이언트가 스캔 중에도 요약(최근 30일 획득 포함)을
 * 부분결과로부터 실시간 파생할 수 있게 한다.
 */
export interface AchievementGameRow {
  appId: number;
  name: string;
  headerImage: string | null;
  unlocked: number;
  total: number;
  lastUnlockAt: number | null;
  unlocked30d: number;
  fetchedAt: number;
}

export interface ScanOptions {
  /** 신선도 창을 무시하고 전체 재스캔 (?force=true). */
  force?: boolean;
  /** playtime_forever>0 필터 해제. */
  includeUnplayed?: boolean;
}

export interface ScanCallbacks {
  onProgress?: (loaded: number, total: number) => void;
  /** 부분 결과(누적 rows) 통지. throttle은 caller 책임. */
  onPartial?: (rows: AchievementGameRow[]) => void;
  /** true면 다음 앱 처리 전에 중단. */
  isCancelled?: () => boolean;
}

export interface ScanResult {
  rows: AchievementGameRow[];
  // 요약(총 획득/완벽/평균/최근30일)은 **클라이언트가 rows에서 파생**한다(코드리뷰
  // #4: 서버/클라 이중 정의 제거). 따라서 payload에 summary를 싣지 않는다.
  done: {
    scanned: number;
    skipped: number;
    remaining: number;
    profilePrivate: boolean;
    libraryFetchFailed: boolean;
    budgetExceeded: boolean;
  };
}

/** 진행률 신선도 창 — 이 안에 있으면 재조회하지 않는다(재개 지원, §5.3.4). */
const FRESHNESS_MS = 24 * 60 * 60 * 1000;
/** 스키마 store 신선도 — 이 안이면 API 재조회 없이 store 스냅샷 사용(§5.5.3, 7일). */
const SCHEMA_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const THIRTY_DAYS_SEC = 30 * 24 * 60 * 60;
/** progress upsert 배치 크기(§7.4). */
const UPSERT_BATCH = 20;
/** 연속 private 몇 건에서 전체 스캔을 중단할지(§5.3.2, M13). */
const PRIVATE_ABORT_THRESHOLD = 2;

function toRow(g: SteamOwnedGame, prog: ProgressRow): AchievementGameRow {
  return {
    appId: g.appid,
    name: g.name,
    headerImage: getAppMeta(g.appid)?.headerImage ?? null,
    unlocked: prog.unlocked,
    total: prog.total,
    lastUnlockAt: prog.lastUnlockAt,
    unlocked30d: prog.unlocked30d,
    fetchedAt: prog.fetchedAt,
  };
}

/**
 * 라이브러리 전체를 스캔해 진행률을 갱신하고 리스트 행을 만든다.
 */
export async function scanAchievements(
  steamId: string,
  opts: ScanOptions = {},
  cb: ScanCallbacks = {}
): Promise<ScanResult> {
  const done = {
    scanned: 0,
    skipped: 0,
    remaining: 0,
    profilePrivate: false,
    libraryFetchFailed: false,
    budgetExceeded: false,
  };
  const rows: AchievementGameRow[] = [];

  const owned = await getOwnedGames(steamId);
  if (!owned) {
    done.libraryFetchFailed = true;
    return { rows, done };
  }

  let games = owned.data;
  if (!opts.includeUnplayed) {
    games = games.filter((g) => g.playtime_forever > 0);
  }

  const now = Date.now();
  const progressMap = getProgress(steamId);

  // 후보 선정: negative cache 제외 + 신선 progress는 즉시 행으로.
  const candidates: SteamOwnedGame[] = [];
  for (const g of games) {
    const schemaRow = getSchemaFromStore(g.appid);
    if (schemaRow && !schemaRow.hasAchievements) continue; // 과제 없음 확정 → 제외
    const prog = progressMap.get(g.appid);
    if (prog && !opts.force && now - prog.fetchedAt < FRESHNESS_MS) {
      rows.push(toRow(g, prog)); // 신선 → 재조회 없이 표시
      continue;
    }
    candidates.push(g);
  }
  candidates.sort((a, b) => b.playtime_forever - a.playtime_forever);

  // 일일 예산 초과 시 새 스캔 거부 — 캐시 행만 반환(§8 #14).
  if (isDailyBudgetExceeded()) {
    done.budgetExceeded = true;
    done.remaining = candidates.length;
    cb.onProgress?.(0, candidates.length);
    return { rows, done };
  }

  const total = candidates.length;
  let processed = 0; // 결정(성공/스킵)에 도달한 앱 수 — 진행률·remaining 산출용.
  let privateCount = 0;
  let aborted = false;
  const pending: ProgressUpsertRow[] = [];

  const flush = () => {
    if (pending.length > 0) {
      upsertProgressBatch(steamId, pending.splice(0, pending.length));
    }
  };

  const cancelled = () => aborted || cb.isCancelled?.() === true;

  const processOne = async (g: SteamOwnedGame): Promise<void> => {
    if (cancelled()) return;

    // 1. 스키마 확보 — store 신선 hit이면 API 생략, 아니면 API 후 가드→저장.
    let defs: AchievementDef[] | null = null;
    // Phase 3: 이번 스캔에서 새로 감지한 스키마 변경(없으면 빈 배열).
    let schemaChanges: AchievementChange[] = [];
    const stored = getSchemaFromStore(g.appid);
    // store-hit은 실제 스키마(defs 비어있지 않음)일 때만. bumpSchemaMiss가 남기는
    // miss placeholder(schema='[]', hasAchievements=1, missStreak 1)를 유효 스키마로
    // 오인하지 않도록 defs.length>0을 함께 요구한다.
    // force면 스키마도 재조회한다(#4): 그래야 '지금 새로고침'이 스키마 변경/완벽
    // 달성 해제를 신선 store(7일 내)여도 감지한다. force가 아니면 신선 store-hit 사용.
    if (
      !opts.force &&
      stored &&
      stored.hasAchievements &&
      stored.defs.length > 0 &&
      now - stored.fetchedAt < SCHEMA_TTL_MS
    ) {
      defs = stored.defs;
    } else {
      // 딜레이는 세마포어 슬롯 **밖**에서 대기한다(#10) — 슬롯을 쥔 채 sleep하면
      // 전역 동시성 슬롯이 유휴가 되어 실효 처리량이 절반이 된다(§7.1).
      await delay(STEAM_API_DELAY.achievements);
      const schema = await withOutboundSlot(() => getAchievementSchema(g.appid));
      if (schema.status === "error") {
        // 일시 실패 — negative로 기록하지 않는다(C2). 다음 스캔 재시도.
        done.skipped++;
        return;
      }
      if (schema.status === "none") {
        bumpSchemaMiss(g.appid); // 연속 2회에서 has_achievements=0 확정(store 내부)
        done.skipped++;
        return;
      }
      // ok — 스냅샷 가드(G1/G2) 통과 시에만 저장.
      const guard = applySnapshotGuards(stored?.defs ?? null, schema.defs);
      if (guard.shouldWrite) {
        // Phase 3: 기준선이 있었으면 diff를 기록한다(G3: 기준선 없으면 [] 반환).
        // 가드 통과(=기준선 갱신) 시에만 diff/알림 — 그래야 다음 스캔이 재감지·중복
        // 기록하지 않는다(§5.4.3). 저장 전에 이전 defs와 비교해야 하므로 순서 주의.
        if (stored && stored.hasAchievements && stored.defs.length > 0) {
          schemaChanges = diffSchemas(stored.defs, schema.defs);
          if (schemaChanges.length > 0) insertChanges(g.appid, schemaChanges);
        }
        setSchemaInStore(g.appid, schema.defs, schema.hash);
      }
      defs = schema.defs;
    }
    if (cancelled() || !defs) {
      if (!defs) done.skipped++;
      return;
    }

    // 4. 개인 진행률. (딜레이는 슬롯 밖, #10)
    await delay(STEAM_API_DELAY.achievements);
    const player = await withOutboundSlot(() =>
      getPlayerAchievements(steamId, g.appid)
    );
    if (player.status === "private") {
      privateCount++;
      // 누적 2건에서 중단(1건은 오분류 가능성 대비, M13). 프로필 비공개는 사실상
      // 전 게임 공통이라 '누적'과 '연속'이 실질적으로 같다(#9).
      if (privateCount >= PRIVATE_ABORT_THRESHOLD) {
        aborted = true;
        done.profilePrivate = true;
      }
      done.skipped++;
      return;
    }
    if (player.status === "unavailable" || player.status === "error") {
      done.skipped++;
      return;
    }

    // 6. unlocked_30d 집계 + unlocked/total 산출(§5.3.2 6단계).
    // unlocked는 **현재 스키마에 존재하는** 획득 과제만 센다(#1). 스키마가 축소된
    // 게임에서 플레이어가 옛 과제를 계속 achieved로 보고해 unlocked>total이 되면
    // 평균 달성률이 100%를 넘는 등 요약이 왜곡되므로(§8 #9), name 집합으로 교집합.
    const schemaNames = new Set(defs.map((d) => d.name));
    // fetchedAt은 스캔 시작 시각(now)이 아니라 이 게임의 실제 조회 시각을 쓴다(#6):
    // 수천 개 스캔이 수십 분 걸리면 말미 게임의 fetchedAt이 크게 과거로 기록되어
    // 재개 신선도·30일 창 경계가 어긋나기 때문.
    const fetchedAt = Date.now();
    const totalCount = defs.length;
    let unlocked = 0;
    let unlocked30d = 0;
    let lastUnlockSec = 0;
    const cutoffSec = Math.floor(fetchedAt / 1000) - THIRTY_DAYS_SEC;
    for (const a of player.achievements) {
      if (!a.achieved || !schemaNames.has(a.name)) continue;
      unlocked++;
      if (a.unlockTime > 0) {
        if (a.unlockTime >= cutoffSec) unlocked30d++;
        if (a.unlockTime > lastUnlockSec) lastUnlockSec = a.unlockTime;
      }
    }
    // unlockTime은 Unix 초 → 저장/표시는 ms로 통일(fetchedAt과 동일 단위).
    const lastUnlockAt = lastUnlockSec > 0 ? lastUnlockSec * 1000 : null;

    // 5. 완벽달성 해제/변경 알림 판정 (Phase 3, §5.4.4). **upsert 이전에** 직전
    //    progress(progressMap = 스캔 시작 시점 스냅샷)를 읽어 판정한다 — upsert 후엔
    //    직전 상태가 사라진다. 스키마 변경이 있었던 앱만 대상.
    if (schemaChanges.length > 0) {
      const prev = progressMap.get(g.appid);
      if (prev) {
        const added = schemaChanges.filter((c) => c.kind === "added").length;
        const removed = schemaChanges.filter((c) => c.kind === "removed").length;
        const unhidden = schemaChanges.filter((c) => c.kind === "unhidden").length;
        // 구조 변화(추가/삭제/숨김해제)만 알림한다(#2). 단순 개명(renamed)·설명 수정
        // (desc)만 있는 변경은 사용자에게 노이즈이므로 changed 알림에서 제외한다.
        const structural = added > 0 || removed > 0 || unhidden > 0;
        if (prev.total > 0 && prev.unlocked === prev.total && totalCount > prev.total) {
          // 100% 달성했던 게임에 과제가 추가되어 완벽 달성이 해제됨(높음). 동시에
          // 삭제가 있었을 수 있으므로 removed도 함께 담아 문구가 삭제분을 숨기지
          // 않게 한다(#6).
          insertAlerts(steamId, [
            { appId: g.appid, kind: "perfect_broken", payload: { gameName: g.name, added, removed } },
          ]);
        } else if (prev.unlocked > 0 && structural) {
          // 착수한 게임의 구성 변경(보통). 미착수(prev.unlocked===0)·텍스트만 변경은 제외.
          insertAlerts(steamId, [
            { appId: g.appid, kind: "changed", payload: { gameName: g.name, added, removed } },
          ]);
        }
      }
    }

    // 7. progress upsert(배치).
    pending.push({
      appId: g.appid,
      unlocked,
      total: totalCount,
      lastUnlockAt,
      unlocked30d,
      fetchedAt,
    });
    if (pending.length >= UPSERT_BATCH) flush();

    rows.push({
      appId: g.appid,
      name: g.name,
      headerImage: getAppMeta(g.appid)?.headerImage ?? null,
      unlocked,
      total: totalCount,
      lastUnlockAt,
      unlocked30d,
      fetchedAt,
    });
    done.scanned++;
  };

  // 동시성 풀. 진행률·부분결과 통지는 워커 루프에서 처리해, 스킵된 앱도 진행률에
  // 반영되도록 한다(성공 앱만 세면 진행 바가 100%에 못 닿는다).
  let idx = 0;
  const worker = async (): Promise<void> => {
    try {
      while (idx < candidates.length && !cancelled()) {
        const i = idx++;
        await processOne(candidates[i]);
        processed++;
        cb.onProgress?.(processed, total);
        cb.onPartial?.(rows);
      }
    } finally {
      // 이 워커가 중단(cancel)·소진·예외로 빠져나올 때, 지금까지 모은 배치를
      // 즉시 저장한다. 중단 시 그동안 스캔한 진행률이 유실되지 않도록.
      flush();
    }
  };
  const poolSize = Math.min(ACHIEVEMENT_CONCURRENCY, candidates.length || 1);
  try {
    await Promise.all(Array.from({ length: poolSize }, () => worker()));
  } finally {
    flush(); // 최종 backstop — 정상 종료·중단·예외 무관하게 남은 배치 확정.
  }

  // 남은 = 결정에 도달하지 못한 후보(중단/취소 시 > 0, 정상 완료 시 0).
  done.remaining = total - processed;
  return { rows, done };
}

/**
 * 스캔 없이 **저장된 progress로 즉시** 리스트를 구성한다 (SSE `cached` 이벤트용).
 *
 * progress 테이블에는 이름·이미지가 없으므로 `app_meta`와 조인해 채운다(§5.5.1).
 * app_meta에 없는 앱은 `AppID {id}` 폴백. 사용자 부재/무진행이면 빈 rows.
 *
 * **현재 라이브러리(owned)와 교집합**해, 환불/삭제되어 더 이상 소유하지 않는 게임의
 * 과거 progress를 유령으로 표시하지 않는다(코드리뷰 #2, §8 #12). getOwnedGames는
 * LRU 캐시(24h)라 이 호출은 뒤이은 스캔의 getOwnedGames와 캐시를 공유한다.
 * owned 조회 실패 시엔 필터 없이 전체를 반환한다(표시 못 하는 것보다 낫다).
 *
 * 요약은 반환하지 않는다 — 클라이언트가 rows에서 파생한다(#4).
 */
export async function buildCachedResult(
  steamId: string
): Promise<{ rows: AchievementGameRow[] }> {
  const owned = await getOwnedGames(steamId);
  const ownedIds = owned ? new Set(owned.data.map((g) => g.appid)) : null;

  const progress = getProgress(steamId);
  const rows: AchievementGameRow[] = [];
  for (const [appId, prog] of progress) {
    if (ownedIds && !ownedIds.has(appId)) continue; // 미소유(유령) 제외
    const meta = getAppMeta(appId);
    rows.push({
      appId,
      name: meta?.name ?? `AppID ${appId}`,
      headerImage: meta?.headerImage ?? null,
      unlocked: prog.unlocked,
      total: prog.total,
      lastUnlockAt: prog.lastUnlockAt,
      unlocked30d: prog.unlocked30d,
      fetchedAt: prog.fetchedAt,
    });
  }
  return { rows };
}

/** Rate Limit 준수용 지연. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
