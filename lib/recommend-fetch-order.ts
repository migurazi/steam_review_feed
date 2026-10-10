/**
 * /recommend 메타 조회 순서 결정 (순수 함수).
 *
 * 배경: 메타 조회는 영속 캐시에 있으면 즉시, 없으면 게임당 ~1.5초(직렬)다. 단계 1(작업 지시서
 * 20261010_01)에서 "시드 + 위시리스트 전체 → 라이브러리 후보" 순으로 바꿨는데, 위시리스트가 수천 개
 * (실사용자 3,736개)이고 대부분 미캐시면 위시 메타에만 1시간 넘게 걸려 "라이브러리에 있지만 안 해본
 * 게임" 트랙이 그동안 비어 있었다(후보 메타는 대부분 캐시돼 있었는데도).
 *
 * 규칙:
 *   phase A (즉시 처리 가능분 + 시드): 시드 전부 → 캐시된 후보 → 캐시된 위시 → 캐시된 나머지 라이브러리.
 *     캐시분은 딜레이가 없어 순서와 무관하게 수 초 안에 끝난다. 끝나면 라우트가 위시 조기 확정을 한다.
 *   phase B (미캐시, 1.5s 직렬): 미캐시 후보 먼저(라이브러리 트랙 완성) → 그다음 나머지 라이브러리와
 *     위시를 한 개씩 번갈아(round-robin). 성향 정밀화와 위시 트랙 채우기가 어느 한쪽에 굶지 않게 한다.
 *
 * 같은 appid가 여러 목록에 있으면(소유한 위시 게임 등) 처음 등장한 자리만 남긴다.
 */

export interface MetaFetchOrderInput {
  /** 최고 playtime 상위 (성향 시드). 캐시 여부와 무관하게 phase A 맨 앞. */
  seedIds: number[];
  /** 라이브러리 미플레이 후보 (playtime 내림차순). */
  candidateIds: number[];
  /** 위시리스트 (위시 트랙이 꺼졌으면 빈 배열). */
  wishlistIds: number[];
  /** 시드 외 analyzed-tier 라이브러리 (playtime 내림차순). */
  restIds: number[];
  /** 영속 캐시에 신선한 메타가 있는 appid. */
  cachedIds: ReadonlySet<number>;
}

export function orderMetaFetch(input: MetaFetchOrderInput): { phaseA: number[]; phaseB: number[] } {
  const seen = new Set<number>();
  const take = (ids: number[]): number[] => {
    const out: number[] = [];
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out;
  };
  const isCached = (id: number) => input.cachedIds.has(id);

  const phaseA = [
    ...take(input.seedIds),
    ...take(input.candidateIds.filter(isCached)),
    ...take(input.wishlistIds.filter(isCached)),
    ...take(input.restIds.filter(isCached)),
  ];

  const uncachedCandidates = take(input.candidateIds.filter(id => !isCached(id)));
  const uncachedRest = take(input.restIds.filter(id => !isCached(id)));
  const uncachedWish = take(input.wishlistIds.filter(id => !isCached(id)));
  const interleaved: number[] = [];
  for (let i = 0; i < Math.max(uncachedRest.length, uncachedWish.length); i++) {
    if (i < uncachedRest.length) interleaved.push(uncachedRest[i]);
    if (i < uncachedWish.length) interleaved.push(uncachedWish[i]);
  }
  return { phaseA, phaseB: [...uncachedCandidates, ...interleaved] };
}
