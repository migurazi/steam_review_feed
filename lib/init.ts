/**
 * 서버 초기화 모듈.
 *
 * 애플리케이션 시작 시 한 번만 실행되어야 하는 작업을 모아둔다:
 * - 환경변수 검증
 * - DB 정리 스케줄러 시작
 *
 * 사용법: 서버 사이드 Route Handler에서 import하여 initServer()를 호출한다.
 *         Edge Runtime(미들웨어)에서는 사용할 수 없다.
 *
 * 주의: standalone 빌드(node server.js)에서는 .env.local이 자동 로드되지 않는다.
 *       node --env-file .env.local server.js 로 실행하거나,
 *       docker-compose의 environment 설정을 사용해야 한다.
 */

import { validateEnv } from "@/lib/env";
import { startCleanupScheduler } from "@/lib/db";

let initialized = false;

/**
 * 서버 초기화를 수행한다.
 * 여러 번 호출해도 최초 1회만 실행된다.
 */
export function initServer(): void {
  if (initialized) return;
  initialized = true;

  // 1. 환경변수 검증 (누락 시 경고)
  let envValid = true;
  try {
    validateEnv();
  } catch (err) {
    envValid = false;
    // 필수 환경변수 누락을 명확히 경고한다.
    // 프로세스를 종료하지 않고 경고만 출력하여 개발 환경에서의 편의성을 유지한다.
    // 실제 API 호출 시 getSteamApiKey()/getSessionSecret()에서 에러가 발생한다.
    console.error("[init]", err);
  }

  // 2. 만료 사용자 정리 스케줄러 시작 (24시간 주기)
  startCleanupScheduler();

  if (envValid) {
    console.log("[init] Server initialized successfully");
  } else {
    console.warn(
      "[init] Server started with missing environment variables.\n" +
      "  standalone 실행 시 .env.local이 자동 로드되지 않습니다.\n" +
      "  해결 방법:\n" +
      "    node --env-file .env.local .next/standalone/server.js\n" +
      "  또는 환경변수를 직접 설정하세요."
    );
  }
}
