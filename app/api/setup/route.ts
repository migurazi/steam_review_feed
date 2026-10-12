/**
 * 최초 설정 API — Steam Web API 키(필수)·ITAD API 키(선택)를 브라우저에서 입력받아 검증·저장한다.
 *
 * 설계:
 *   - GET  : 현재 키 설정 여부만 반환(값은 노출하지 않음). STEAM·ITAD 각각 독립.
 *   - POST : body에 key(STEAM)·itadKey(ITAD) 둘 다/각각 올 수 있다. 각 키는 **독립 판정**으로
 *            처리한다 — 한쪽만 와도 그쪽만 설정한다. 이미 설정된 키는 그 키만 건너뛰고(skipped)
 *            나머지는 계속 저장한다. 요청된 키가 **전부** 이미 설정돼 저장할 게 없을 때만 409.
 *            STEAM 키는 형식 검사 + 실제 Steam 호출로 유효성 검증. ITAD 키는 주입 문자 차단용
 *            형식 검사(`^[A-Za-z0-9._~-]{8,128}$`). STEAM 미설정이어도 ITAD 추가 허용, 그 반대도.
 *            형식/유효성 실패는 400으로 전체 요청을 거른다. 하나라도 저장되면 200(skipped 안내 포함).
 *            성공 시 (1) 런타임 process.env 즉시 주입 + (2) .env.local upsert.
 *
 * 보안: 이 라우트는 **로컬 셀프호스팅**(각자 PC에서 실행) 전제의 최초 설정 도구다.
 *   - 이미 설정된 키는 웹으로 덮어쓰지 못하게 409로 막는다(키 교체는 .env.local 직접 편집).
 *   - 미들웨어 matcher에 /api/setup이 없으므로 인증 게이트 없이 접근 가능하다(최초 설정은 로그인 이전).
 */

import { NextRequest, NextResponse } from "next/server";
import { upsertEnvVar } from "@/lib/env-file";

export const dynamic = "force-dynamic";

function isConfigured(): boolean {
  return !!process.env.STEAM_API_KEY?.trim();
}

/** ITAD 키 설정 여부. STEAM과 독립 판정 — ITAD 키가 이미 있으면 그 재설정만 409로 막는다(L-b). */
function isItadConfigured(): boolean {
  return !!process.env.ITAD_API_KEY?.trim();
}

export async function GET() {
  return NextResponse.json({
    configured: isConfigured(),
    itadConfigured: isItadConfigured(),
  });
}

export async function POST(request: NextRequest) {
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
  const itadKey =
    typeof (body as { itadKey?: unknown })?.itadKey === "string"
      ? (body as { itadKey: string }).itadKey.trim()
      : "";

  const wantSteam = key.length > 0;
  const wantItad = itadKey.length > 0;

  if (!wantSteam && !wantItad) {
    return NextResponse.json({ ok: false, error: "키를 입력하세요." }, { status: 400 });
  }

  // 각 키를 **독립 판정**한다 — "이미 설정됨"은 그 키만 건너뛰고(skipped) 나머지는 계속.
  // 형식/실유효성 검증 실패만 즉시 400으로 전체 요청을 거른다.
  let saveSteam = false;
  let saveItad = false;
  const skipped: string[] = [];

  // --- STEAM 키 처리 ---
  if (wantSteam) {
    if (isConfigured()) {
      // 이미 설정됨 → 이 키만 건너뛴다(웹 덮어쓰기 차단). 다른 키 저장은 계속.
      skipped.push("STEAM");
    } else {
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
      saveSteam = true;
    }
  }

  // --- ITAD 키 처리 (STEAM과 독립 — L-b) ---
  if (wantItad) {
    if (isItadConfigured()) {
      // ITAD 키가 이미 있으면 그 재설정만 건너뛴다(STEAM 설정 여부와 무관). 다른 키 저장은 계속.
      skipped.push("ITAD");
    } else {
      // 주입 문자(공백·개행·`=` 등) 차단 — trim 후 허용 문자 집합·길이만 통과.
      // 실측 ITAD 키는 40자 hex라 이 집합에 포함된다.
      if (!/^[A-Za-z0-9._~-]{8,128}$/.test(itadKey)) {
        return NextResponse.json(
          { ok: false, error: "ITAD 키 형식이 올바르지 않습니다." },
          { status: 400 }
        );
      }
      saveItad = true;
    }
  }

  // 저장할 게 하나도 없으면(요청된 키가 전부 이미 설정됨) 409 — 어떤 키들이 이미 설정됐는지 알린다.
  if (!saveSteam && !saveItad) {
    const which = skipped.join("·");
    return NextResponse.json(
      {
        ok: false,
        error: `${which} 키가 이미 설정되어 있습니다. 바꾸려면 .env.local을 직접 편집하세요.`,
      },
      { status: 409 }
    );
  }

  // --- 저장: (1) 런타임 즉시 주입 + (2) .env.local upsert ---
  //     주의: process.env는 **이 프로세스에만** 반영된다. 이 앱은 단일 프로세스
  //     셀프호스팅(next start / start:standalone)을 전제하므로 충분하다.
  try {
    if (saveSteam) {
      process.env.STEAM_API_KEY = key;
      upsertEnvVar("STEAM_API_KEY", key);
    }
    if (saveItad) {
      process.env.ITAD_API_KEY = itadKey;
      upsertEnvVar("ITAD_API_KEY", itadKey);
    }
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: `키 저장에 실패했습니다: ${String(err)}` },
      { status: 500 }
    );
  }

  // 하나라도 저장됨 → 200. 일부가 이미 설정돼 건너뛰었으면 skipped로 안내.
  return NextResponse.json(skipped.length > 0 ? { ok: true, skipped } : { ok: true });
}
