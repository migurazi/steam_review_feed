/**
 * 환경변수 검증 유틸리티.
 *
 * 서버 시작 시점에 필수 환경변수의 존재와 형식을 검증한다.
 * 런타임에 뒤늦게 발견되는 설정 오류를 방지한다.
 *
 * 사용법: 서버 초기화 시 validateEnv()를 호출하거나,
 *         개별 함수(getSteamApiKey, getSessionSecret)로 접근한다.
 */

/** 필수 환경변수 목록과 설명 */
const REQUIRED_VARS = {
  STEAM_API_KEY: 'Steam Web API Key (https://steamcommunity.com/dev/apikey)',
  SESSION_SECRET: '세션 암호화 키 (32자 이상 권장)',
} as const;

/**
 * 모든 필수 환경변수가 설정되었는지 검증한다.
 * 누락된 변수가 있으면 명확한 에러 메시지와 함께 예외를 던진다.
 *
 * @throws Error 누락된 환경변수가 있는 경우
 */
export function validateEnv(): void {
  const missing: string[] = [];

  for (const [key, desc] of Object.entries(REQUIRED_VARS)) {
    if (!process.env[key]?.trim()) {
      missing.push(`  - ${key}: ${desc}`);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `필수 환경변수가 설정되지 않았습니다. .env.local 파일을 확인하세요:\n${missing.join('\n')}`
    );
  }
}

/**
 * Steam API Key를 반환한다.
 * 설정되지 않았으면 명확한 에러와 함께 예외를 던진다.
 */
export function getSteamApiKey(): string {
  const key = process.env.STEAM_API_KEY?.trim();
  if (!key) {
    throw new Error(
      'STEAM_API_KEY 환경변수가 설정되지 않았습니다. .env.local 파일을 확인하세요.'
    );
  }
  return key;
}

/**
 * IsThereAnyDeal API 키를 반환한다 (번들 차트 메이커 /bundle 전용, **선택적**).
 *
 * 설정되지 않았으면 null — ITAD 기능(번들 목록·번들 전개)만 비활성화되고, 수동 게임 목록·Steam 번들
 * 전개 등 ITAD가 필요 없는 경로는 그대로 동작한다(graceful degrade). 그래서 REQUIRED_VARS에는 넣지 않는다.
 */
export function getItadApiKey(): string | null {
  return process.env.ITAD_API_KEY?.trim() || null;
}

/**
 * Session Secret을 반환한다.
 * 설정되지 않았으면 명확한 에러와 함께 예외를 던진다.
 */
export function getSessionSecret(): string {
  const secret = process.env.SESSION_SECRET?.trim();
  if (!secret) {
    throw new Error(
      'SESSION_SECRET 환경변수가 설정되지 않았습니다. .env.local 파일을 확인하세요.'
    );
  }
  return secret;
}
