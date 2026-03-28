/**
 * Steam OpenID 2.0 인증 유틸리티.
 *
 * Steam OpenID는 사용자의 Steam64 ID를 얻기 위한 수단이며,
 * API 호출 인증과는 별개 (기획서 7.1절 v1.3).
 *
 * openid npm 패키지의 RelyingParty를 사용하여 서명 검증을 수행한다.
 */

import openid from "openid";

const STEAM_OPENID_URL = "https://steamcommunity.com/openid";

/**
 * openid.RelyingParty 인스턴스를 생성한다.
 * returnUrl: OpenID 콜백을 받을 우리 서버의 URL
 * realm: 우리 서비스의 최상위 URL (예: http://localhost:3000)
 */
function createRelyingParty(returnUrl: string, realm: string) {
  return new openid.RelyingParty(
    returnUrl, // 콜백 URL
    realm, // realm (서비스 도메인)
    true, // stateless (별도 association 저장 없이 direct verification)
    false, // strict mode off
    [] // extensions (사용 안 함)
  );
}

/**
 * Steam OpenID 인증 시작 URL을 생성한다.
 * 사용자를 이 URL로 리다이렉트하면 Steam 로그인 페이지가 표시된다.
 *
 * @param returnUrl OpenID 콜백을 받을 URL (예: http://localhost:3000/api/auth/callback)
 * @param realm 서비스 도메인 (예: http://localhost:3000)
 */
export function getAuthUrl(returnUrl: string, realm: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const rp = createRelyingParty(returnUrl, realm);
    rp.authenticate(STEAM_OPENID_URL, false, (err: unknown, authUrl: string | null) => {
      if (err || !authUrl) {
        reject(err || new Error("Failed to generate auth URL"));
        return;
      }
      resolve(authUrl);
    });
  });
}

/**
 * OpenID 콜백을 검증하고 Steam64 ID를 추출한다.
 * Steam 서버에 direct verification 요청을 보내 서명을 검증한다.
 *
 * @param callbackUrl 콜백으로 들어온 전체 URL (쿼리 파라미터 포함)
 * @param realm 서비스 도메인
 * @returns Steam64 ID 문자열. 검증 실패 시 null.
 */
export async function verifyCallback(
  callbackUrl: string,
  realm: string
): Promise<string | null> {
  return new Promise((resolve) => {
    // returnUrl은 realm(baseUrl) 기준으로 구성한다.
    // standalone 모드에서 request.url의 origin이 다를 수 있으므로
    // 항상 realm의 origin을 사용하여 openid 라이브러리의 "Invalid return URL" 방지.
    const callbackPath = new URL(callbackUrl).pathname;
    const realmOrigin = new URL(realm).origin;
    const returnUrl = `${realmOrigin}${callbackPath}`;
    const rp = createRelyingParty(returnUrl, realm);

    rp.verifyAssertion(callbackUrl, (err: unknown, result?: { authenticated: boolean; claimedIdentifier?: string }) => {
      if (err || !result?.authenticated || !result.claimedIdentifier) {
        if (err) console.error("[openid] Verification failed:", err);
        resolve(null);
        return;
      }

      // claimedIdentifier 형식: https://steamcommunity.com/openid/id/76561198056932899
      const match = result.claimedIdentifier.match(/\/id\/(\d+)$/);
      resolve(match ? match[1] : null);
    });
  });
}
