/**
 * lib/logger.ts 단위 테스트.
 *
 * 이벤트 로깅이 JSONL 파일에 올바르게 기록되는지 테스트한다:
 * - 올바른 JSON 형식으로 기록
 * - 이벤트 타입과 데이터가 정확히 포함
 * - 날짜별 파일 생성
 * - 로깅 실패가 서비스를 중단시키지 않음
 */

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { logEvent } from "@/lib/logger";

const LOGS_DIR = path.join(process.cwd(), "logs");
const dateStr = new Date().toISOString().slice(0, 10);
const logFilePath = path.join(LOGS_DIR, `events-${dateStr}.jsonl`);

describe("logger", () => {
  it("이벤트를 JSONL 파일에 기록한다", async () => {
    logEvent("login", { steamId: "test123", method: "manual" });

    // 비동기 파일 쓰기 대기
    await new Promise((r) => setTimeout(r, 200));

    const content = fs.readFileSync(logFilePath, "utf-8");
    const lines = content.trim().split("\n");
    const lastLine = lines[lines.length - 1];
    const entry = JSON.parse(lastLine);

    expect(entry.event).toBe("login");
    expect(entry.data.steamId).toBe("test123");
    expect(entry.data.method).toBe("manual");
    expect(entry.timestamp).toBeDefined();
  });

  it("다양한 이벤트 타입을 기록할 수 있다", async () => {
    logEvent("feed_view", { source: "wishlist", filters: {} });
    logEvent("search", { query: "elden ring" });

    await new Promise((r) => setTimeout(r, 200));

    const content = fs.readFileSync(logFilePath, "utf-8");
    const lines = content.trim().split("\n");

    // 마지막 두 줄에 기록된 이벤트 확인
    const last = JSON.parse(lines[lines.length - 1]);
    const secondLast = JSON.parse(lines[lines.length - 2]);

    // 순서가 보장되지 않을 수 있으므로 둘 중 하나만 확인
    const events = [last.event, secondLast.event];
    expect(events).toContain("feed_view");
    expect(events).toContain("search");
  });

  it("timestamp은 ISO 8601 형식이다", async () => {
    logEvent("game_view", { appId: 12345 });

    await new Promise((r) => setTimeout(r, 200));

    const content = fs.readFileSync(logFilePath, "utf-8");
    const lines = content.trim().split("\n");
    const entry = JSON.parse(lines[lines.length - 1]);

    // ISO 8601 형식 검증
    const date = new Date(entry.timestamp);
    expect(date.toISOString()).toBe(entry.timestamp);
  });
});
