/**
 * 최초 실행 환경설정 부트스트랩 (start.bat이 서버 실행 전에 호출).
 *
 * 하는 일:
 *   - .env.local이 없으면 생성한다.
 *   - SESSION_SECRET이 비어 있으면 안전한 랜덤 값을 자동 생성해 채운다
 *     (사용자가 직접 만들 필요 없음).
 *   - STEAM_API_KEY 줄은 비워 둔다 — 키는 브라우저의 /setup 페이지에서 입력받는다.
 *
 * 이미 값이 있으면 건드리지 않는다(멱등). 순수 Node 내장 모듈만 사용(의존성 없음).
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ENV_PATH = join(process.cwd(), ".env.local");

/** .env 텍스트를 key→{value, line} 순서 보존 파싱. 주석/빈 줄은 그대로 보존. */
function parseEnv(text) {
  return text.split(/\r?\n/);
}

/** lines 배열에서 KEY= 줄을 찾아 값을 반환(없으면 null). */
function getValue(lines, key) {
  const prefix = `${key}=`;
  for (const line of lines) {
    if (line.startsWith(prefix)) return line.slice(prefix.length);
  }
  return null;
}

/** KEY= 줄을 upsert. 있으면 값 교체, 없으면 배열 끝에 추가. */
function upsert(lines, key, value) {
  const prefix = `${key}=`;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith(prefix)) {
      lines[i] = `${prefix}${value}`;
      return lines;
    }
  }
  lines.push(`${prefix}${value}`);
  return lines;
}

function main() {
  let lines;
  if (existsSync(ENV_PATH)) {
    lines = parseEnv(readFileSync(ENV_PATH, "utf-8"));
  } else {
    // 신규 생성 — 주석 포함 기본 골격.
    lines = [
      "# 이 파일은 setup-env.mjs와 /setup 페이지가 자동 관리합니다.",
      "# Steam Web API Key: https://steamcommunity.com/dev/apikey 에서 발급",
      "STEAM_API_KEY=",
      "SESSION_SECRET=",
      "NEXT_PUBLIC_BASE_URL=http://localhost:3000",
    ];
  }

  let changed = false;

  // SESSION_SECRET 자동 생성 (없거나 비어 있을 때만).
  const secret = getValue(lines, "SESSION_SECRET");
  if (!secret || !secret.trim()) {
    lines = upsert(lines, "SESSION_SECRET", randomBytes(32).toString("hex"));
    changed = true;
    console.log("[setup-env] SESSION_SECRET 자동 생성 완료.");
  }

  // STEAM_API_KEY 줄은 최소한 존재하도록 (값은 /setup에서 입력).
  // 구버전 setup.bat이 넣던 placeholder는 비워 정규화한다 — 그래야 /setup 게이팅
  // (isConfigured가 non-empty를 "설정됨"으로 봄)이 올바로 동작한다.
  const OLD_PLACEHOLDER = "여기에_Steam_API_키_입력";
  const steamKey = getValue(lines, "STEAM_API_KEY");
  if (steamKey === null || steamKey === OLD_PLACEHOLDER) {
    lines = upsert(lines, "STEAM_API_KEY", "");
    changed = true;
  }
  // 기본 BASE_URL 보장.
  if (getValue(lines, "NEXT_PUBLIC_BASE_URL") === null) {
    lines = upsert(lines, "NEXT_PUBLIC_BASE_URL", "http://localhost:3000");
    changed = true;
  }

  if (changed || !existsSync(ENV_PATH)) {
    writeFileSync(ENV_PATH, lines.join("\n") + "\n", "utf-8");
    console.log(`[setup-env] .env.local 준비 완료: ${ENV_PATH}`);
  } else {
    console.log("[setup-env] .env.local 이미 구성됨 — 변경 없음.");
  }

  const key = getValue(lines, "STEAM_API_KEY");
  if (!key || !key.trim()) {
    console.log("[setup-env] Steam API 키 미설정 — 브라우저 /setup 에서 입력하세요.");
  }
}

main();
