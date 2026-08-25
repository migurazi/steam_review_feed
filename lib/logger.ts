/**
 * 이벤트 로깅 유틸리티.
 *
 * 사용 패턴 추적을 위해 구조화된 이벤트를 JSONL 파일에 기록한다.
 * KPI 측정: 통합 피드 vs 게임별 조회 비율, 필터 사용 비율 등.
 *
 * 로그 파일: logs/events-YYYY-MM-DD.jsonl (날짜별 로테이션)
 *
 * 주의: 모든 I/O를 비동기로 수행하여 이벤트 루프 블로킹을 방지한다.
 *       로깅 실패는 서비스를 중단시키지 않는다.
 */

import fs from "fs";
import path from "path";
import { APP_ROOT } from "./app-root";

// standalone 서버의 cwd 변경(.next/standalone) 문제를 피해 프로젝트 루트에 고정.
const LOGS_DIR = path.join(APP_ROOT, "logs");
let logsDirEnsured = false;

/** 로그 이벤트 타입 */
export type EventType =
  | "login"
  | "feed_view"
  | "game_view"
  | "filter_change"
  | "search"
  | "load_more"
  | "recommend_analyze"
  | "recommend_cardfarming_skipped"
  | "recommend_fastmode_capped"
  | "achievement_scan";

interface LogEntry {
  timestamp: string;
  event: EventType;
  data: Record<string, unknown>;
}

/**
 * 로그 디렉토리 존재를 비동기로 확인/생성한다.
 * 최초 1회만 실행하며, 이후에는 캐시된 결과를 사용한다.
 */
async function ensureLogsDir(): Promise<void> {
  if (logsDirEnsured) return;
  try {
    await fs.promises.mkdir(LOGS_DIR, { recursive: true });
    logsDirEnsured = true;
  } catch (err) {
    console.error("[logger] Failed to create logs directory:", err);
  }
}

/**
 * 이벤트를 JSONL 파일에 기록한다.
 * 비동기로 파일에 append하며, 실패 시 콘솔에만 출력 (서비스 중단 방지).
 *
 * @param event 이벤트 타입 (login, feed_view 등)
 * @param data 이벤트에 첨부할 구조화된 데이터
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

  // fire-and-forget: 로깅은 요청 처리를 블로킹하지 않는다
  ensureLogsDir()
    .then(() => fs.promises.appendFile(filePath, line, "utf-8"))
    .catch((err) => {
      console.error("[logger] Failed to write event log:", err);
    });
}
