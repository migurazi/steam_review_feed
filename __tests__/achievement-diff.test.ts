/**
 * lib/achievement-diff.ts 단위 테스트.
 *
 * 이 기능의 실패 모드는 "틀린 알림"이므로 규칙(§5.4.2)을 케이스로 고정한다:
 *   - applySnapshotGuards: G1 빈 배열 방어, G2 50% 초과 삭제 보류
 *   - computeSchemaHash: icon/순서만 바뀌면 hash 불변, 실질 필드 변경 시 변동
 *   - diffSchemas: added/removed/renamed/desc/unhidden, G3 기준선 무알림, G4 상한
 */

import { describe, it, expect } from "vitest";
import {
  applySnapshotGuards,
  diffSchemas,
  computeSchemaHash,
} from "@/lib/achievement-diff";
import type { AchievementDef } from "@/lib/steam/types";

/** 테스트용 AchievementDef 생성 — 미지정 필드는 name 기반 기본값. */
function def(name: string, over: Partial<AchievementDef> = {}): AchievementDef {
  return {
    name,
    displayName: over.displayName ?? name,
    description: over.description ?? `${name} desc`,
    hidden: over.hidden ?? false,
    icon: over.icon ?? `${name}.jpg`,
  };
}

describe("applySnapshotGuards", () => {
  it("G1: before가 있는데 after가 빈 배열이면 저장 거부(empty-response)", () => {
    const res = applySnapshotGuards([def("a"), def("b")], []);
    expect(res.shouldWrite).toBe(false);
    expect(res.reason).toBe("empty-response");
  });

  it("기준선이 없으면(null) 빈 after라도 저장 허용 — 보호 대상 없음", () => {
    expect(applySnapshotGuards(null, []).shouldWrite).toBe(true);
  });

  it("기준선이 빈 배열이면 저장 허용 — 첫 스냅샷", () => {
    expect(applySnapshotGuards([], [def("a")]).shouldWrite).toBe(true);
  });

  it("G2: 삭제가 50% 초과면 보류(mass-removal)", () => {
    // before 4개 중 3개 삭제(75% > 50%) → 보류
    const before = [def("a"), def("b"), def("c"), def("d")];
    const after = [def("a")];
    const res = applySnapshotGuards(before, after);
    expect(res.shouldWrite).toBe(false);
    expect(res.reason).toBe("mass-removal");
  });

  it("G2: 삭제가 정확히 50%면 보류하지 않음(> 만 보류)", () => {
    // before 4개 중 2개 삭제(50%, 초과 아님) → 저장 허용
    const before = [def("a"), def("b"), def("c"), def("d")];
    const after = [def("a"), def("b")];
    expect(applySnapshotGuards(before, after).shouldWrite).toBe(true);
  });

  it("force=true면 대량 삭제 보류를 해제한다 (영구 보류 탈출구)", () => {
    const before = [def("a"), def("b"), def("c"), def("d")];
    const after = [def("a")]; // 75% 삭제
    expect(applySnapshotGuards(before, after).shouldWrite).toBe(false); // 기본 보류
    expect(applySnapshotGuards(before, after, { force: true }).shouldWrite).toBe(
      true
    );
  });

  it("force여도 G1(빈 응답)은 우회하지 않는다", () => {
    const res = applySnapshotGuards([def("a")], [], { force: true });
    expect(res.shouldWrite).toBe(false);
    expect(res.reason).toBe("empty-response");
  });
});

describe("computeSchemaHash", () => {
  it("icon만 바뀌면 hash 불변 — icon은 diff 무시 필드", () => {
    const h1 = computeSchemaHash([def("a", { icon: "old.jpg" })]);
    const h2 = computeSchemaHash([def("a", { icon: "new.jpg" })]);
    expect(h1).toBe(h2);
  });

  it("배열 순서만 바뀌면 hash 불변 — 순서는 무시", () => {
    const h1 = computeSchemaHash([def("a"), def("b")]);
    const h2 = computeSchemaHash([def("b"), def("a")]);
    expect(h1).toBe(h2);
  });

  it("displayName이 바뀌면 hash 변동", () => {
    const h1 = computeSchemaHash([def("a", { displayName: "Old" })]);
    const h2 = computeSchemaHash([def("a", { displayName: "New" })]);
    expect(h1).not.toBe(h2);
  });

  it("description이 바뀌면 hash 변동", () => {
    const h1 = computeSchemaHash([def("a", { description: "d1" })]);
    const h2 = computeSchemaHash([def("a", { description: "d2" })]);
    expect(h1).not.toBe(h2);
  });

  it("hidden이 바뀌면 hash 변동", () => {
    const h1 = computeSchemaHash([def("a", { hidden: false })]);
    const h2 = computeSchemaHash([def("a", { hidden: true })]);
    expect(h1).not.toBe(h2);
  });
});

describe("diffSchemas", () => {
  it("added: after에만 있는 과제", () => {
    const changes = diffSchemas([def("a")], [def("a"), def("b")]);
    expect(changes).toEqual([{ kind: "added", apiName: "b", after: "b" }]);
  });

  it("removed: before에만 있는 과제", () => {
    const changes = diffSchemas([def("a"), def("b")], [def("a")]);
    expect(changes).toEqual([{ kind: "removed", apiName: "b", before: "b" }]);
  });

  it("renamed: displayName 변경", () => {
    const changes = diffSchemas(
      [def("a", { displayName: "Old" })],
      [def("a", { displayName: "New" })]
    );
    expect(changes).toEqual([
      { kind: "renamed", apiName: "a", before: "Old", after: "New" },
    ]);
  });

  it("desc: description 변경", () => {
    const changes = diffSchemas(
      [def("a", { description: "d1" })],
      [def("a", { description: "d2" })]
    );
    expect(changes).toEqual([
      { kind: "desc", apiName: "a", before: "d1", after: "d2" },
    ]);
  });

  it("unhidden: hidden true→false", () => {
    const changes = diffSchemas(
      [def("a", { hidden: true })],
      [def("a", { hidden: false })]
    );
    expect(changes).toEqual([{ kind: "unhidden", apiName: "a" }]);
  });

  it("hidden false→true는 무시", () => {
    const changes = diffSchemas(
      [def("a", { hidden: false })],
      [def("a", { hidden: true })]
    );
    expect(changes).toEqual([]);
  });

  it("icon만 바뀐 경우 변경 없음 — icon 무시", () => {
    const changes = diffSchemas(
      [def("a", { icon: "old.jpg" })],
      [def("a", { icon: "new.jpg" })]
    );
    expect(changes).toEqual([]);
  });

  it("G3: 기준선(before)이 비어 있으면 변경 없음", () => {
    const changes = diffSchemas([], [def("a"), def("b")]);
    expect(changes).toEqual([]);
  });

  it("G4: 변경이 50건을 초과하면 50건으로 제한", () => {
    const before = Array.from({ length: 100 }, (_, i) =>
      def(`a${i}`, { displayName: "Old" })
    );
    const after = Array.from({ length: 100 }, (_, i) =>
      def(`a${i}`, { displayName: "New" })
    );
    const changes = diffSchemas(before, after);
    expect(changes).toHaveLength(50);
  });

  it("G4: 삭제가 상한을 넘어도 다른 kind가 통째로 잘리지 않는다 (공정 분배)", () => {
    // 60개 삭제 + 2개 개명 = 62건 > 50. 단순 slice(0,50)이면 앞쪽 removed만 남고
    // renamed가 사라지지만, kind별 공정 분배는 renamed를 보존해야 한다.
    const before = [
      ...Array.from({ length: 60 }, (_, i) => def(`r${i}`)),
      def("k0", { displayName: "Old0" }),
      def("k1", { displayName: "Old1" }),
    ];
    const after = [
      def("k0", { displayName: "New0" }),
      def("k1", { displayName: "New1" }),
    ];
    const changes = diffSchemas(before, after);
    expect(changes).toHaveLength(50);
    expect(changes.filter((c) => c.kind === "renamed")).toHaveLength(2);
    expect(changes.some((c) => c.kind === "removed")).toBe(true);
  });
});

describe("hash와 diff의 유의필드 일관성 (드리프트 방지)", () => {
  // 안전 불변식: diffSchemas가 '변경'으로 감지하는 것은 반드시 computeSchemaHash도
  // 다르게 만들어야 한다. 아니면 스캔이 '해시 동일 → diff 생략'으로 판단해 실제
  // 변경을 놓친다(이 모듈이 가장 피하려는 실패). 유의 필드가 두 함수에서 갈라지면
  // 이 테스트가 깨진다.
  const cases = [
    {
      label: "displayName(renamed)",
      before: def("a", { displayName: "Old" }),
      after: def("a", { displayName: "New" }),
    },
    {
      label: "description(desc)",
      before: def("a", { description: "d1" }),
      after: def("a", { description: "d2" }),
    },
    {
      label: "hidden true→false(unhidden)",
      before: def("a", { hidden: true }),
      after: def("a", { hidden: false }),
    },
  ];
  for (const c of cases) {
    it(`${c.label}: diff 감지 시 hash도 달라진다`, () => {
      expect(diffSchemas([c.before], [c.after]).length).toBeGreaterThan(0);
      expect(computeSchemaHash([c.before])).not.toBe(
        computeSchemaHash([c.after])
      );
    });
  }

  it("icon 변경은 diff도 hash도 무반응 — 무시 필드 일관", () => {
    const before = def("a", { icon: "old.jpg" });
    const after = def("a", { icon: "new.jpg" });
    expect(diffSchemas([before], [after])).toEqual([]);
    expect(computeSchemaHash([before])).toBe(computeSchemaHash([after]));
  });
});
