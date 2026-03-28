/**
 * Steam 게임 목록 정렬 유틸리티.
 *
 * 위시리스트/라이브러리 API Route와 SSE 스트리밍에서 공통으로 사용하는
 * 정렬 로직을 분리한다.
 */

import type { SteamOwnedGame } from "./types";

/**
 * 라이브러리 게임을 정렬한다.
 *
 * 정렬 우선순위:
 * 1. 최근 2주 플레이가 있는 게임이 우선
 * 2. 둘 다 있으면 최근 플레이타임이 높은 순
 * 3. 둘 다 없으면 총 플레이타임이 높은 순
 *
 * @param games 정렬 전 게임 배열
 * @returns 정렬된 새 배열 (원본 변경 없음)
 */
export function sortLibraryGames(games: SteamOwnedGame[]): SteamOwnedGame[] {
  return [...games].sort((a, b) => {
    const aRecent = a.playtime_2weeks ?? 0;
    const bRecent = b.playtime_2weeks ?? 0;

    // 최근 2주 플레이가 있는 게임 우선
    if (aRecent > 0 && bRecent === 0) return -1;
    if (aRecent === 0 && bRecent > 0) return 1;

    // 둘 다 최근 플레이가 있으면 최근 플레이타임 순
    if (aRecent > 0 && bRecent > 0) return bRecent - aRecent;

    // 둘 다 없으면 총 플레이타임 순
    return b.playtime_forever - a.playtime_forever;
  });
}
