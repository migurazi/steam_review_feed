/**
 * 최초 설정 API·env-file 안전성 단위 테스트 (코드리뷰 버그 #1·#5).
 *
 *   - upsertEnvVar: value에 CR/LF가 있으면 throw(쓰기 전 방어 — fs.writeFileSync 미호출).
 *   - POST /api/setup #1: itadKey 형식 검증(주입 문자 차단) → 400.
 *   - POST /api/setup #5: STEAM/ITAD 독립 처리 — 한쪽이 "이미 설정됨"이어도 다른 키는 저장.
 *
 * route handler를 직접 import해 Request mock으로 호출한다. env-file(upsert)·Steam 유효성 fetch는
 * mock으로 치환해 네트워크/파일 없이 검증한다.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// --- upsertEnvVar 직접 테스트: fs를 mock해 실제 파일을 건드리지 않는다 ---
// vi.mock은 호이스팅되므로 mock 함수도 vi.hoisted로 끌어올려 초기화 순서를 맞춘다.
const { writeFileSyncMock, readFileSyncMock, existsSyncMock } = vi.hoisted(() => ({
  writeFileSyncMock: vi.fn<(p: string, data: string, enc: string) => void>(),
  readFileSyncMock: vi.fn<(p: string, enc: string) => string>(() => ""),
  existsSyncMock: vi.fn<(p: string) => boolean>(() => false),
}));
vi.mock("fs", () => ({
  default: {
    existsSync: (p: string) => existsSyncMock(p),
    readFileSync: (p: string, enc: string) => readFileSyncMock(p, enc),
    writeFileSync: (p: string, data: string, enc: string) => writeFileSyncMock(p, data, enc),
  },
  existsSync: (p: string) => existsSyncMock(p),
  readFileSync: (p: string, enc: string) => readFileSyncMock(p, enc),
  writeFileSync: (p: string, data: string, enc: string) => writeFileSyncMock(p, data, enc),
}));

import { upsertEnvVar } from "@/lib/env-file";
import { POST as setupPost } from "@/app/api/setup/route";

type AnyReq = Parameters<typeof setupPost>[0];

function postReq(body: unknown): AnyReq {
  const url = "http://localhost/api/setup";
  const req = new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as AnyReq;
  (req as unknown as { nextUrl: URL }).nextUrl = new URL(url);
  return req;
}

const VALID_STEAM = "a".repeat(32); // 32자리 16진수
const VALID_ITAD = "0123456789abcdef0123456789abcdef01234567"; // 40자 hex

const fetchMock = vi.fn<typeof fetch>();
const originalEnv = { ...process.env };

beforeEach(() => {
  writeFileSyncMock.mockClear();
  readFileSyncMock.mockClear();
  existsSyncMock.mockClear();
  readFileSyncMock.mockReturnValue("");
  existsSyncMock.mockReturnValue(false);
  fetchMock.mockReset();
  // Steam 유효성 검증은 기본 200(유효)로 둔다.
  fetchMock.mockResolvedValue(new Response("", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  delete process.env.STEAM_API_KEY;
  delete process.env.ITAD_API_KEY;
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...originalEnv };
});

describe("upsertEnvVar — 개행 주입 방어 (#1)", () => {
  it("value에 \\n이 있으면 throw하고 쓰지 않는다", () => {
    expect(() => upsertEnvVar("K", "a\nMALICIOUS=1")).toThrow("환경변수 값에 개행 문자를 포함할 수 없습니다.");
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });

  it("value에 \\r이 있으면 throw하고 쓰지 않는다", () => {
    expect(() => upsertEnvVar("K", "a\rb")).toThrow("환경변수 값에 개행 문자를 포함할 수 없습니다.");
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });

  it("개행이 없으면 정상적으로 쓴다", () => {
    upsertEnvVar("K", "clean-value");
    expect(writeFileSyncMock).toHaveBeenCalledTimes(1);
    const written = String(writeFileSyncMock.mock.calls[0][1]);
    expect(written).toContain("K=clean-value");
  });
});

describe("POST /api/setup — itadKey 형식 검증 (#1)", () => {
  it("itadKey에 주입 문자(개행)가 있으면 400", async () => {
    const res = await setupPost(postReq({ itadKey: "abcd1234\nX=1" }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("ITAD 키 형식이 올바르지 않습니다.");
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });

  it("itadKey에 '=' 가 있으면 400", async () => {
    const res = await setupPost(postReq({ itadKey: "abcdefgh=injected" }));
    expect(res.status).toBe(400);
  });

  it("itadKey가 너무 짧으면 400", async () => {
    const res = await setupPost(postReq({ itadKey: "short" }));
    expect(res.status).toBe(400);
  });

  it("실측형 40자 hex itadKey는 통과해 저장된다", async () => {
    const res = await setupPost(postReq({ itadKey: VALID_ITAD }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(process.env.ITAD_API_KEY).toBe(VALID_ITAD);
  });
});

describe("POST /api/setup — STEAM/ITAD 독립 처리 (#5)", () => {
  it("STEAM만 최초 설정 → 200 저장", async () => {
    const res = await setupPost(postReq({ key: VALID_STEAM }));
    expect(res.status).toBe(200);
    expect(process.env.STEAM_API_KEY).toBe(VALID_STEAM);
  });

  it("STEAM만 이미 설정 + STEAM 재요청 → 409 (기존 동작 보존)", async () => {
    process.env.STEAM_API_KEY = VALID_STEAM;
    const res = await setupPost(postReq({ key: VALID_STEAM }));
    expect(res.status).toBe(409);
  });

  it("STEAM 이미 설정 + ITAD 신규 → ITAD만 저장 200 (STEAM은 skipped)", async () => {
    process.env.STEAM_API_KEY = VALID_STEAM;
    const res = await setupPost(postReq({ key: VALID_STEAM, itadKey: VALID_ITAD }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.skipped).toContain("STEAM");
    // ITAD는 저장됨, STEAM은 건드리지 않음.
    expect(process.env.ITAD_API_KEY).toBe(VALID_ITAD);
    // upsert는 ITAD 1건만.
    const keysWritten = writeFileSyncMock.mock.calls.length;
    expect(keysWritten).toBe(1);
  });

  it("두 키 모두 이미 설정 → 409 (저장할 게 없음)", async () => {
    process.env.STEAM_API_KEY = VALID_STEAM;
    process.env.ITAD_API_KEY = VALID_ITAD;
    const res = await setupPost(postReq({ key: VALID_STEAM, itadKey: VALID_ITAD }));
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toContain("STEAM");
    expect(json.error).toContain("ITAD");
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });

  it("STEAM 신규 + ITAD 이미 설정 → STEAM만 저장 200 (ITAD는 skipped)", async () => {
    process.env.ITAD_API_KEY = VALID_ITAD;
    const res = await setupPost(postReq({ key: VALID_STEAM, itadKey: VALID_ITAD }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.skipped).toContain("ITAD");
    expect(process.env.STEAM_API_KEY).toBe(VALID_STEAM);
  });

  it("STEAM 형식 오류면 ITAD가 신규여도 400 (전체 거름)", async () => {
    const res = await setupPost(postReq({ key: "not-hex", itadKey: VALID_ITAD }));
    expect(res.status).toBe(400);
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });

  it("빈 요청(키 없음)이면 400", async () => {
    const res = await setupPost(postReq({}));
    expect(res.status).toBe(400);
  });
});
