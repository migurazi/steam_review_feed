/**
 * 이벤트 로깅 유틸리티.
 *
 * 사용 패턴 추적을 위해 구조화된 이벤트를 JSONL 파일에 기록한다.
 * KPI 측정: 통합 피드 vs 게임별 조회 비율, 필터 사용 비율 등.
 *
 * 로그 파일: logs/events-YYYY-MM-DD.jsonl (날짜별 로테이션)
 */

import fs from "fs";
import path from "path";

const LOGS_DIR = path.join(process.cwd(), "logs");
let logsDirEnsured = false;

/** 로그 이벤트 타입 */
export type EventType =
  | "login"
  | "feed_view"
  | "game_view"
  | "filter_change"
  | "search"
  | "load_more";

interface LogEntry {
  timestamp: string;
  event: EventType;
  data: Record<string, unknown>;
}

/**
 * 이벤트를 JSONL 파일에 기록한다.
 * 비동기로 파일에 append하며, 실패 시 콘솔에만 출력 (서비스 중단 방지).
 */
export function logEvent(
  event: EventType,
  data: Record<string, unknown>
): void {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    event,
    data,
  };

  const line = JSON.stringify(entry) + "\n";
  const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const filePath = path.join(LOGS_DIR, `events-${dateStr}.jsonl`);

  try {
    if (!logsDirEnsured) {
      if (!fs.existsSync(LOGS_DIR)) {
        fs.mkdirSync(LOGS_DIR, { recursive: true });
      }
      logsDirEnsured = true;
    }
    fs.appendFile(filePath, line, "utf-8", (err) => {
      if (err) console.error("[logger] Failed to write event log:", err);
    });
  } catch (err) {
    // 로깅 실패는 서비스를 중단시키지 않는다
    console.error("[logger] Failed to write event log:", err);
  }
}
