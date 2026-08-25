/**
 * 도전과제 스키마 diff 엔진 + 스냅샷 저장 가드 (순수 함수).
 *
 * 외부 의존이 없다 — 입력 두 스냅샷을 비교만 한다. 이 기능의 실패 모드는 "동작
 * 안 함"이 아니라 **"틀린 알림을 보냄"**이며 그 대부분이 여기서 나온다. 따라서
 * 규칙을 표(§5.4.2)로 못 박고 단위 테스트로 고정한다.
 *
 * 작업 지시서 20260825_01 §5.4.
 *
 * 계층 분리:
 *   - applySnapshotGuards (G1/G2, Phase 1): "이 스냅샷을 **저장해도 되는가**".
 *     diff 기록 여부와 무관하게 항상 호출한다. API 일시 장애의 빈/부분 응답이
 *     스냅샷을 파괴하는 것을 막는다.
 *   - diffSchemas (G3/G4, Phase 3): "무엇이 **바뀌었는가**". 저장된 기준선이
 *     있을 때만 의미가 있다.
 *   - computeSchemaHash: diff를 매번 돌리지 않기 위한 빠른 동일성 판정.
 */

import { createHash } from "crypto";
import type { AchievementDef } from "./steam/types";

export interface AchievementChange {
  kind: "added" | "removed" | "renamed" | "desc" | "unhidden";
  /** 안정 키(API명). before/after 모두에서 이 값으로 식별한다. */
  apiName: string;
  /** 변경 전 값 (renamed/desc: 이전 문자열, removed: 사라진 displayName). */
  before?: string;
  /** 변경 후 값 (renamed/desc: 새 문자열, added: 추가된 displayName). */
  after?: string;
}

/**
 * 한 앱의 한 스캔에서 기록하는 변경 상한 (G4). UI/DB 폭주 방지.
 */
const MAX_CHANGES_PER_SCAN = 50;

/**
 * "값 변경"으로 취급하는 문자열 필드와 그에 대응하는 change kind.
 *
 * **단일 소스(single source of truth)**: computeSchemaHash와 diffSchemas가 이 목록을
 * 공유한다. "무엇이 유의미한 변경인가"의 정의가 두 함수에서 갈라지면, 해시는
 * 같은데(=diff 생략) 실제로는 바뀐 상황이 생겨 변경 알림이 조용히 누락된다
 * (이 모듈이 가장 피하려는 실패 모드). 필드를 추가/제거하면 여기 한 곳만 고치면
 * 해시와 diff가 함께 반영된다. hidden(→unhidden)은 boolean·단방향이라 아래에서
 * 별도 처리하되, 해시에는 동일하게 포함한다.
 */
const VALUE_DIFF_FIELDS = [
  { field: "displayName", kind: "renamed" },
  { field: "description", kind: "desc" },
] as const;

/**
 * 해시/비교에 쓰는 "유의 필드"만 남긴 정규화 튜플. icon과 배열 순서는 제외한다.
 * VALUE_DIFF_FIELDS + hidden을 name(안정 키)과 함께 담는다. description 등 원형
 * optional 필드가 undefined로 새어들면 JSON에서 null로 뭉개지므로 ""로 통일한다.
 */
function significantTuple(d: AchievementDef): (string | number)[] {
  return [
    d.name,
    ...VALUE_DIFF_FIELDS.map(({ field }) => d[field] ?? ""),
    d.hidden ? 1 : 0,
  ];
}

/**
 * 스냅샷을 저장해도 되는지 판정한다 (Phase 1, G1/G2).
 *
 * diff 기록과 무관하게 스냅샷을 새로 받을 때마다 호출한다. `shouldWrite: false`면
 * 스키마를 갱신하지 않고 **기존 기준선을 보존**한다.
 *
 * **G2와 영구 보류 문제**: G2(대량 삭제)는 stateless로 판정하므로, 저장을 거부하면
 * 기준선이 그대로 남아 다음 스캔에서도 같은 대량 삭제가 다시 거부된다 — 즉 정당한
 * 대규모 개편이 영영 반영되지 않는다. 이를 풀려면 caller가 "직전에 거부한 after의
 * 시그니처(computeSchemaHash)"를 영속해 두었다가, 이번 after가 그와 동일하면(=2회
 * 연속 동일 관측) `opts.force = true`로 재호출해 보류를 해제해야 한다. 이 함수는
 * 그 탈출구(force)를 제공하고, "연속성 추적"은 상태를 가진 caller(스캔)의 책임이다.
 *
 * force여도 **G1(빈 응답)은 절대 우회하지 않는다** — 빈 스냅샷 저장은 어떤 경우에도
 * 복구 불가한 파괴이며, 진짜 "과제 전부 삭제"는 negative(has_achievements=0) 경로로
 * 처리된다(§5.1.1).
 *
 * @param before 직전 스냅샷. 최초 관측이면 null.
 * @param after  이번에 받은 스냅샷 (정규화 후).
 * @param opts.force true면 G2 대량삭제 보류를 해제한다(2회 연속 동일 확인 후 caller가 설정).
 */
export function applySnapshotGuards(
  before: AchievementDef[] | null,
  after: AchievementDef[],
  opts: { force?: boolean } = {}
): { shouldWrite: boolean; reason?: "empty-response" | "mass-removal" } {
  // 기준선이 없으면 무조건 저장한다 — 첫 스냅샷은 보호할 대상이 없다.
  if (!before || before.length === 0) {
    return { shouldWrite: true };
  }

  // G1 전멸 방지: before가 있는데 after가 빈 배열이면 API 일시 장애일 개연성이
  // 높다. 저장하면 스냅샷이 파괴되어 복구 불가 → 저장하지 않는다. force로도 불가.
  if (after.length === 0) {
    return { shouldWrite: false, reason: "empty-response" };
  }

  // G2 대량 삭제 보류: 사라진 과제가 전체(before 기준)의 50% 초과면 부분 장애로
  // 보고 보류한다. caller가 force로 확정 신호를 주면 통과시킨다(위 주석 참조).
  if (!opts.force) {
    const afterNames = new Set(after.map((d) => d.name));
    const removedCount = before.filter((d) => !afterNames.has(d.name)).length;
    if (removedCount > before.length * 0.5) {
      return { shouldWrite: false, reason: "mass-removal" };
    }
  }

  return { shouldWrite: true };
}

/**
 * 변경 목록을 상한(MAX_CHANGES_PER_SCAN) 이하로 **공정하게** 줄인다 (G4).
 *
 * 단순 slice(0, N)는 목록이 [removed…, added…, renamed…] 순으로 쌓이므로, 삭제가
 * 상한을 넘으면 rename/desc/unhidden이 통째로 잘려나간다. kind별로 묶어 라운드로빈
 * 으로 뽑아 **모든 종류가 대표되도록** 한다.
 */
function capChangesFairly(
  changes: AchievementChange[],
  max: number
): AchievementChange[] {
  // kind별 버킷 (첫 등장 순서 유지 → 결과 결정론적).
  const buckets = new Map<AchievementChange["kind"], AchievementChange[]>();
  for (const c of changes) {
    const arr = buckets.get(c.kind);
    if (arr) arr.push(c);
    else buckets.set(c.kind, [c]);
  }

  const result: AchievementChange[] = [];
  const lists = [...buckets.values()];
  for (let i = 0; result.length < max; i++) {
    let progressed = false;
    for (const list of lists) {
      if (list.length > i) {
        result.push(list[i]);
        progressed = true;
        if (result.length >= max) break;
      }
    }
    if (!progressed) break; // 모든 버킷 소진
  }
  return result;
}

/**
 * 두 스냅샷의 변경 목록을 산출한다 (Phase 3, G3/G4).
 *
 * 매칭 키는 `name`(API명) — 유일하게 안정적인 식별자다. displayName/description은
 * 표시·공략용이라 값 변경으로 취급한다(VALUE_DIFF_FIELDS). icon과 배열 순서는
 * 노이즈라 무시한다(§5.4.2).
 *
 * G3 기준선 무알림: before가 비어 있으면(최초 관측) 빈 배열을 반환한다 — 첫
 * 관측에서 전 과제가 `added`로 뜨는 것을 방지한다.
 * G4 폭주 제한: 최대 MAX_CHANGES_PER_SCAN 건까지, kind별 공정 분배로 줄인다.
 *
 * hidden 전이는 비대칭이다: true→false만 `unhidden`으로 기록하고, false→true는
 * 실질적으로 발생하지 않으므로 무시한다(§5.4.2).
 */
export function diffSchemas(
  before: AchievementDef[],
  after: AchievementDef[]
): AchievementChange[] {
  // G3: 기준선 없음 → 알림 없음.
  if (before.length === 0) return [];

  const beforeByName = new Map(before.map((d) => [d.name, d]));
  const afterByName = new Map(after.map((d) => [d.name, d]));
  const changes: AchievementChange[] = [];

  // removed: before에만 있는 과제.
  for (const b of before) {
    if (!afterByName.has(b.name)) {
      changes.push({ kind: "removed", apiName: b.name, before: b.displayName });
    }
  }

  // added: after에만 있는 과제.
  for (const a of after) {
    if (!beforeByName.has(a.name)) {
      changes.push({ kind: "added", apiName: a.name, after: a.displayName });
    }
  }

  // 양쪽에 존재하는 과제: 값 변경 판정. VALUE_DIFF_FIELDS를 순회하므로 해시가
  // 보는 "유의 필드"와 항상 일치한다. 한 과제가 rename + desc 를 동시에 겪으면
  // 두 건으로 기록한다(각각 사용자에게 의미가 다르다).
  for (const a of after) {
    const b = beforeByName.get(a.name);
    if (!b) continue;
    for (const { field, kind } of VALUE_DIFF_FIELDS) {
      const bv = b[field] ?? "";
      const av = a[field] ?? "";
      if (bv !== av) {
        changes.push({ kind, apiName: a.name, before: bv, after: av });
      }
    }
    // 숨김 과제가 공개로 전환. 반대(공개→숨김)는 무시.
    if (b.hidden && !a.hidden) {
      changes.push({ kind: "unhidden", apiName: a.name });
    }
  }

  // G4: 상한 초과 시 kind별 공정 분배로 줄인다(단순 절단 금지).
  return changes.length > MAX_CHANGES_PER_SCAN
    ? capChangesFairly(changes, MAX_CHANGES_PER_SCAN)
    : changes;
}

/**
 * diff 대상 필드만으로 스키마 해시를 계산한다.
 *
 * 목적: 스캔 시 이전 해시와 같으면 diff를 통째로 건너뛴다. 따라서 **무시하는
 * 필드(icon, 배열 순서)는 해시에 넣지 않는다** — icon만 바뀌어도 매번 diff 경로를
 * 타면 무의미하다(§5.4.2).
 *
 * 유의 필드는 significantTuple(=VALUE_DIFF_FIELDS + name + hidden)이 단일 정의한다.
 * diffSchemas가 보는 필드와 항상 일치하므로 "해시는 같은데 diff는 다름"이 생기지
 * 않는다. name으로 정렬해 배열 순서에 의존하지 않게 하고, 튜플 배열을 통째로
 * JSON.stringify한다 — JSON이 문자열 경계를 이스케이프하므로 경계 모호성이 없다.
 */
export function computeSchemaHash(defs: AchievementDef[]): string {
  const canonical = JSON.stringify(
    [...defs]
      .sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))
      .map(significantTuple)
  );
  return createHash("sha1").update(canonical).digest("hex");
}
