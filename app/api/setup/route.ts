/**
 * 최초 설정 API — Steam Web API 키를 브라우저에서 입력받아 검증·저장한다.
 *
 * 설계:
 *   - GET  : 현재 키 설정 여부만 반환(값은 노출하지 않음).
 *   - POST : 키 형식 검사 → 실제 Steam 호출로 유효성 검증 → 성공 시 (1) 런타임
 *            process.env에 즉시 주입(재시작 불필요, getSteamApiKey가 매 호출 시
 *            process.env를 읽음) + (2) .env.local에 영속(다음 실행 대비).
 *
 * 보안: 이 라우트는 **로컬 셀프호스팅**(각자 PC에서 실행) 전제의 최초 설정 도구다.
 *   - 이미 설정된 상태에서는 웹으로 덮어쓰지 못하게 409로 막는다(키 교체는 사용자가
 *     .env.local 직접 편집). 이렇게 하면 웹으로 비밀을 바꿀 수 있는 창이 "최초 설정
 *     전"으로 한정된다.
 *   - 미들웨어 matcher에 /api/setup이 없으므로 인증 게이트 없이 접근 가능하다(최초
 *     설정은 로그인 이전 단계).
 */

import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { APP_ROOT } from "@/lib/app-root";

export const dynamic = "force-dynamic";

// 저장 위치는 반드시 `start:standalone`의 `--env-file .env.local`이 읽는 파일과
// 같아야 한다(프로젝트 루트). standalone 서버의 cwd 변경 문제는 APP_ROOT가 흡수한다.
const ENV_PATH = path.join(APP_ROOT, ".env.local");

function isConfigured(): boolean {
  return !!process.env.STEAM_API_KEY?.trim();
}

export async function GET() {
  return NextResponse.json({ configured: isConfigured() });
}

export async function POST(request: NextRequest) {
  // 최초 설정 전에만 허용 — 이미 있으면 웹 덮어쓰기 차단.
  if (isConfigured()) {
    return NextResponse.json(
      {
        ok: false,
        error: "이미 설정되어 있습니다. 키를 바꾸려면 .env.local을 직접 편집하세요.",
      },
      { status: 409 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "잘못된 요청입니다." }, { status: 400 });
  }
  const key =
    typeof (body as { key?: unknown })?.key === "string"
      ? (body as { key: string }).key.trim()
      : "";

  if (!key) {
    return NextResponse.json({ ok: false, error: "키를 입력하세요." }, { status: 400 });
  }
  // Steam Web API 키는 32자리 16진수. 형식 선검사로 오타를 빨리 거른다.
  if (!/^[A-Fa-f0-9]{32}$/.test(key)) {
    return NextResponse.json(
      { ok: false, error: "키 형식이 올바르지 않습니다 (32자리 16진수여야 합니다)." },
      { status: 400 }
    );
  }

  // 실제 유효성 검증: 키가 필요한 공개 호출(GetSchemaForGame)로 확인.
  // 무효 키는 403, 유효 키는 200. (appid 220 = Half-Life 2, 안정적으로 존재)
  const testUrl = `https://api.steampowered.com/ISteamUserStats/GetSchemaForGame/v2/?key=${key}&appid=220`;
  let valid = false;
  try {
    const res = await fetch(testUrl);
    valid = res.ok;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Steam API 연결에 실패했습니다. 인터넷 연결을 확인하세요." },
      { status: 502 }
    );
  }
  if (!valid) {
    return NextResponse.json(
      { ok: false, error: "키가 유효하지 않습니다 (Steam이 거부). 키를 다시 확인하세요." },
      { status: 400 }
    );
  }

  // (1) 런타임 즉시 반영 — getSteamApiKey()가 다음 호출부터 이 값을 읽는다.
  //     주의: process.env는 **이 프로세스에만** 반영된다. 이 앱은 단일 프로세스
  //     셀프호스팅(next start / start:standalone)을 전제하므로 충분하다. 다중 워커
  //     (클러스터/PM2 instances>1)로 돌리면 다른 워커는 재시작 전까지 (2)의
  //     .env.local을 다시 로드하지 못해 미설정 상태로 남는다(코드리뷰 #4).
  process.env.STEAM_API_KEY = key;
  // (2) 영속 — 다음 실행 때 .env.local에서 자동 로드.
  try {
    persistSteamApiKey(key);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: `키 저장에 실패했습니다: ${String(err)}` },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true });
}

/** .env.local의 STEAM_API_KEY 줄을 upsert한다(다른 줄은 보존). */
function persistSteamApiKey(key: string): void {
  const prefix = "STEAM_API_KEY=";
  const lines = fs.existsSync(ENV_PATH)
    ? fs.readFileSync(ENV_PATH, "utf-8").split(/\r?\n/)
    : [];
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    // 들여쓴 키 줄(`  STEAM_API_KEY=`)도 매칭해 중복 줄 생성을 막는다(#7).
    // 주석(`#STEAM_API_KEY=`)은 trim해도 접두가 다르므로 매칭되지 않고, 활성 줄을
    // 새로 append한다(주석은 dotenv가 무시하므로 활성 줄이 이긴다).
    if (lines[i].trimStart().startsWith(prefix)) {
      lines[i] = prefix + key;
      found = true;
      break;
    }
  }
  if (!found) lines.push(prefix + key);
  // 단일 후행 개행으로 정규화.
  fs.writeFileSync(ENV_PATH, lines.join("\n").replace(/\n*$/, "") + "\n", "utf-8");
}
