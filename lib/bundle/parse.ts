/**
 * 번들 차트 메이커 — 자유 텍스트 입력 파서 (순수 모듈).
 *
 * 사용자가 붙여넣은 텍스트에서 Steam·ITAD 식별자를 추출한다.
 * 공백/개행/쉼표/세미콜론으로 토큰을 나누고, 각 토큰에 패턴을 적용한다.
 */

/** 파서 출력. 각 배열은 중복 제거 + 입력 순서 보존. */
export interface ParsedInput {
  appIds: number[];           // store.steampowered.com/app/{id} 또는 맨숫자
  steamBundleIds: number[];   // store.steampowered.com/bundle/{id}
  steamPackageIds: number[];  // store.steampowered.com/sub/{id}
  itadBundleIds: number[];    // isthereanydeal.com/bundles/{id} 또는 /bundle/{id}
  unresolved: string[];       // 어디에도 안 맞은 토큰
}

// 호스트 뒤에 오는 경로 패턴. 맨 앞 /는 소비된 상태.
const RE_STEAM_APP    = /steampowered\.com\/app\/(\d+)/i;
const RE_STEAM_BUNDLE = /steampowered\.com\/bundle\/(\d+)/i;
const RE_STEAM_SUB    = /steampowered\.com\/sub\/(\d+)/i;
// ITAD: /bundles/{id} 또는 /bundle/{id}
const RE_ITAD_BUNDLE  = /isthereanydeal\.com\/bundles?\/(\d+)/i;
// 순수 정수 (1~9자리, 앞뒤 공백 없는 단독 토큰)
const RE_PURE_INT     = /^\d{1,9}$/;

/**
 * 텍스트에서 Steam·ITAD 식별자를 추출한다.
 *
 * 토큰 분리 기준: 공백·탭·개행·쉼표·세미콜론.
 * 빈 토큰은 무시한다.
 */
export function parseBundleInput(text: string): ParsedInput {
  const tokens = text.split(/[\s,;]+/).filter(t => t.length > 0);

  const appIds: number[]          = [];
  const steamBundleIds: number[]  = [];
  const steamPackageIds: number[] = [];
  const itadBundleIds: number[]   = [];
  const unresolved: string[]      = [];

  // 중복 추적 (입력 순서 보존을 위해 Set으로 seen 관리)
  const seenApp     = new Set<number>();
  const seenBundle  = new Set<number>();
  const seenSub     = new Set<number>();
  const seenItad    = new Set<number>();
  const seenUnres   = new Set<string>();

  const addUniq = <T>(arr: T[], seen: Set<T>, val: T): void => {
    if (!seen.has(val)) { seen.add(val); arr.push(val); }
  };

  for (const token of tokens) {
    // Steam 앱 URL
    const mApp = RE_STEAM_APP.exec(token);
    if (mApp) {
      addUniq(appIds, seenApp, parseInt(mApp[1], 10));
      continue;
    }

    // Steam 번들 URL
    const mBundle = RE_STEAM_BUNDLE.exec(token);
    if (mBundle) {
      addUniq(steamBundleIds, seenBundle, parseInt(mBundle[1], 10));
      continue;
    }

    // Steam 패키지(sub) URL
    const mSub = RE_STEAM_SUB.exec(token);
    if (mSub) {
      addUniq(steamPackageIds, seenSub, parseInt(mSub[1], 10));
      continue;
    }

    // ITAD 번들 URL (steampowered 패턴보다 먼저 없지만 별도 호스트이므로 순서 무관)
    const mItad = RE_ITAD_BUNDLE.exec(token);
    if (mItad) {
      addUniq(itadBundleIds, seenItad, parseInt(mItad[1], 10));
      continue;
    }

    // 순수 양의 정수 (1~9자리) → appId
    if (RE_PURE_INT.test(token)) {
      const n = parseInt(token, 10);
      if (n > 0) {
        addUniq(appIds, seenApp, n);
        continue;
      }
    }

    // 어디에도 해당 없음
    addUniq(unresolved, seenUnres, token);
  }

  return { appIds, steamBundleIds, steamPackageIds, itadBundleIds, unresolved };
}

/** Steam 스토어 링크를 반환한다. */
export function steamStoreUrl(appId: number): string {
  return `https://store.steampowered.com/app/${appId}/`;
}
