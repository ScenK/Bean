// Main-process error log (#1092): console.error/console.warn and uncaught errors, teed to a local
// file so a packaged Bean.app (stdout kept by nobody) leaves evidence. The one Bean log allowed to
// hold raw error text — message and stack — see .memory/convention-main-log.md. Every other log
// (avatar.log) stays allowlist-only. A write failure never throws and never goes back to the console.
import { appendFileSync, chmodSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { format } from "node:util";

export const MAIN_LOG_MAX_BYTES = 5 * 1024 * 1024;
export const MAIN_LOG_LINE_MAX = 4096;

export type MainLog = (level: string, args: unknown[]) => boolean;

/** Returns a writer; each call reports whether the entry landed. Rotates one generation (`.1`). */
export function createMainLog(file: string, now: () => Date = () => new Date()): MainLog {
  let dirReady = false;
  return (level, args) => {
    try {
      let text = format(...args);
      const bytes = Buffer.from(text, "utf8");
      // Cut in UTF-8 bytes; a character split at the cut decodes to U+FFFD, dropped.
      if (bytes.length > MAIN_LOG_LINE_MAX) text = `${bytes.subarray(0, MAIN_LOG_LINE_MAX).toString("utf8").replace(/\uFFFD+$/, "")} …[truncated]`;
      if (!dirReady) {
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        chmodSync(dirname(file), 0o700); // mkdir's mode is ignored for a dir that already existed
        dirReady = true;
      }
      let size = 0;
      try { size = statSync(file).size; } catch { /* first write */ }
      if (size > MAIN_LOG_MAX_BYTES) renameSync(file, `${file}.1`);
      appendFileSync(file, `${now().toISOString()} ${level} ${text}\n`, { mode: 0o600 });
      return true;
    } catch {
      return false;
    }
  };
}

/** Wraps `error`/`warn` so each call still prints, then lands in the log. */
export function teeConsole(log: MainLog, target: Pick<Console, "error" | "warn"> = console): void {
  for (const level of ["error", "warn"] as const) {
    const original = target[level].bind(target);
    target[level] = (...args: unknown[]) => {
      original(...args);
      log(level, args);
    };
  }
}
