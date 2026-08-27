/**
 * copilot-auto — structured logger with rotation.
 *
 * Mirrors the smart-approve Logger: timestamped lines to
 * ~/.omp/logs/copilot-auto.log (rotated at 5 MB / 3 files / 30 days).
 * Every module routes diagnostics through this single sink.
 * Session tokens and bearer credentials are NEVER passed to log().
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { RotatingLog } from "./utils/rotating-log.ts";
import type { LoggerLike } from "./types.ts";

export class Logger implements LoggerLike {
  private readonly rotatingLog: RotatingLog;

  constructor(logDir?: string) {
    const dir = logDir ?? this.defaultLogDir();
    const logPath = path.join(dir, "copilot-auto.log");

    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    } catch {}

    this.rotatingLog = new RotatingLog({
      filePath: logPath,
      maxBytes: 5 * 1024 * 1024,
      maxFiles: 3,
      maxAgeMs: 30 * 24 * 60 * 60 * 1000,
    });
    this.rotatingLog.cleanStale();
  }

  private defaultLogDir(): string {
    const home = os.homedir();
    const ompLogs = path.join(home, ".omp", "logs");
    const piLogs = path.join(home, ".pi", "logs");
    if (fs.existsSync(ompLogs)) return ompLogs;
    if (fs.existsSync(piLogs)) return piLogs;
    return path.join(home, ".omp", "agent");
  }

  /** Write a line. Never throws — diagnostics are best-effort. */
  log(message: string): void {
    const line = `${new Date().toISOString()} ${message}\n`;
    this.rotatingLog.write(line);
  }
}
