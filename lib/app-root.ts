/**
 * 앱의 영속 데이터 루트 경로 (DB/로그/.env.local의 기준).
 *
 * 왜 process.cwd()를 직접 쓰면 안 되나:
 *   Next.js standalone 서버는 실행 중 cwd를 `.next/standalone`으로 바꾼다. 그래서
 *   `path.join(process.cwd(), ...)`로 잡은 경로가 **빌드 산출물 안**에 생겨
 *   재빌드가 데이터를 삭제/잠그고, 최초 설정 마법사가 저장한 키가
 *   `--env-file .env.local`(프로젝트 루트 기준)과 어긋나 다음 실행 때 반영되지
 *   않는다.
 *
 * 실행 방식이 여러 가지라(위치가 제각각) 다음 순서로 프로젝트 루트를 찾는다:
 *   1) INIT_CWD — npm이 스크립트 실행 시 "npm 호출 위치(= 프로젝트 루트)"로
 *      설정한다. 서버가 cwd를 바꾼 뒤에도 유지되어 가장 신뢰할 수 있다.
 *   2) cwd에서 위로 올라가며 next.config.*(루트에만 있고 .next/standalone에는
 *      없음)를 찾는다 — Docker/systemd처럼 npm 없이 직접 `node server.js`로
 *      실행해 INIT_CWD가 없는 경우 대비.
 *   3) 최후 폴백: process.cwd() (Docker에서 standalone을 앱 루트로 복사해 그 자리에서
 *      실행하는 정석 배포는 cwd 자체가 올바른 루트다).
 */

import { existsSync } from "fs";
import { dirname, join } from "path";

const NEXT_CONFIGS = ["next.config.ts", "next.config.js", "next.config.mjs"];

function hasNextConfig(dir: string): boolean {
  return NEXT_CONFIGS.some((f) => existsSync(join(dir, f)));
}

function findProjectRoot(): string {
  const initCwd = process.env.INIT_CWD;
  if (initCwd && existsSync(join(initCwd, "package.json"))) return initCwd;

  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (hasNextConfig(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break; // 파일시스템 루트 도달
    dir = parent;
  }
  return process.cwd();
}

export const APP_ROOT = findProjectRoot();
