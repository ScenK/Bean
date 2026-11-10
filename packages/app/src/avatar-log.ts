// Append-only evidence log for avatar recovery (#757), kept inside the private ~/.bean dir.
// Only allowlisted fields are written — never validatedURL (holds the home path), task text,
// URLs, tokens, or stacks — and a write failure never throws into the caller.
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

export const AVATAR_LOG_MAX_BYTES = 1024 * 1024;
const FIELDS = new Set([
  "reason", "exitCode", "errorCode", "errorDescription", "type", "version", "os",
  "destroyed", "visible", "crashed", "bounds", "display", "mode", "statusHeight", "anchor",
  "outcome", "ms",
]);

export type AvatarLog = (event: string, fields?: Record<string, unknown>) => boolean;

/** Returns a writer; each call reports whether the line landed. Rotates one generation (`.1`). */
export function createAvatarLog(file: string, now: () => Date = () => new Date()): AvatarLog {
  return (event, fields = {}) => {
    try {
      const kept = Object.fromEntries(Object.entries(fields).filter(([k]) => FIELDS.has(k)));
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      let size = 0;
      try { size = statSync(file).size; } catch { /* first write */ }
      if (size > AVATAR_LOG_MAX_BYTES) renameSync(file, `${file}.1`);
      appendFileSync(file, `${now().toISOString()} ${event} ${JSON.stringify(kept)}\n`, { mode: 0o600 });
      return true;
    } catch {
      return false;
    }
  };
}
