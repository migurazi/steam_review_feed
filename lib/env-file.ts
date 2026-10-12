/**
 * `.env.local` 안전 upsert 유틸 (작업 지시서 20261012_01 단계 4 M6).
 *
 * `app/api/setup/route.ts`의 `persistSteamApiKey`를 키 prefix로 일반화한 것 —
 * 최초 설정 마법사가 STEAM_API_KEY·ITAD_API_KEY 등 여러 키를 같은 규칙으로 저장한다.
 *
 * 저장 위치는 반드시 `start:standalone`의 `--env-file .env.local`이 읽는 파일과
 * 같아야 한다(프로젝트 루트). standalone 서버의 cwd 변경 문제는 APP_ROOT가 흡수한다.
 */

import fs from "fs";
import path from "path";
import { APP_ROOT } from "@/lib/app-root";

const ENV_PATH = path.join(APP_ROOT, ".env.local");

/**
 * `.env.local`의 `{key}=` 줄을 upsert한다(다른 줄은 보존).
 *
 *   - 들여쓴 키 줄(`  STEAM_API_KEY=`)도 매칭해 중복 줄 생성을 막는다.
 *   - 주석(`#STEAM_API_KEY=`)은 trim해도 접두가 다르므로 매칭되지 않고, 활성 줄을
 *     새로 append한다(주석은 dotenv가 무시하므로 활성 줄이 이긴다).
 *   - 파일 끝은 단일 후행 개행으로 정규화한다.
 */
export function upsertEnvVar(key: string, value: string): void {
  // 개행 주입 방어 — value에 CR/LF가 있으면 .env.local에 새 줄(다른 키·명령)이 섞여 들어갈 수 있다.
  if (/[\r\n]/.test(value)) {
    throw new Error("환경변수 값에 개행 문자를 포함할 수 없습니다.");
  }
  const prefix = `${key}=`;
  const lines = fs.existsSync(ENV_PATH)
    ? fs.readFileSync(ENV_PATH, "utf-8").split(/\r?\n/)
    : [];
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trimStart().startsWith(prefix)) {
      lines[i] = prefix + value;
      found = true;
      break;
    }
  }
  if (!found) lines.push(prefix + value);
  fs.writeFileSync(ENV_PATH, lines.join("\n").replace(/\n*$/, "") + "\n", "utf-8");
}
