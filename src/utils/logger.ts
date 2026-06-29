/**
 * LOG_LEVEL に従う構造化ログ (spec §16)。
 *
 * 出してよい: job_id / page_id / event type / status / skip reason / HTTP status code。
 * 出さない:   トークン・APIキー・Notion 本文全文・Gemini プロンプト全文。
 * 秘密情報を渡さない責務は呼び出し側にあるが、本モジュールは余計な値を勝手に展開しない。
 */
import type { LogLevel } from "../types.js";

const LEVEL_ORDER: Record<LogLevel, number> = {
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  ERROR: 40,
};

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export function createLogger(level: LogLevel): Logger {
  const threshold = LEVEL_ORDER[level] ?? LEVEL_ORDER.INFO;

  function emit(lineLevel: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (LEVEL_ORDER[lineLevel] < threshold) return;
    const entry = { level: lineLevel, message, ...(fields ?? {}) };
    const line = safeStringify(entry);
    if (lineLevel === "ERROR") {
      console.error(line);
    } else if (lineLevel === "WARN") {
      console.warn(line);
    } else {
      console.log(line);
    }
  }

  return {
    debug: (m, f) => emit("DEBUG", m, f),
    info: (m, f) => emit("INFO", m, f),
    warn: (m, f) => emit("WARN", m, f),
    error: (m, f) => emit("ERROR", m, f),
  };
}

/** 循環参照などで JSON 化に失敗しても落とさない。 */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
