import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../db.js";

/** Per-channel chime-in state (`chatops_chatty`). A missing row means off. */
export interface ChattyState {
  enabled: boolean;
  /** Epoch ms; absent or past = not muted. */
  mutedUntil?: number;
}

export interface Chatter {
  get(scopeId: string): ChattyState;
  /** Turning it on also clears any mute. */
  setEnabled(scopeId: string, enabled: boolean): void;
  /** `until` = epoch ms; undefined unmutes. */
  setMutedUntil(scopeId: string, until: number | undefined): void;
}

export function makeChatter(opts: { dbPath: string; surface: "discord" | "teams" }): Chatter {
  const db: DatabaseSync = openDb(opts.dbPath);
  const { surface } = opts;
  return {
    get(scopeId) {
      const row = db.prepare("SELECT enabled, muted_until FROM chatops_chatty WHERE surface = ? AND scope_id = ?")
        .get(surface, scopeId) as { enabled: number; muted_until: number | null } | undefined;
      return row ? { enabled: row.enabled === 1, ...(row.muted_until !== null ? { mutedUntil: row.muted_until } : {}) } : { enabled: false };
    },
    setEnabled(scopeId, enabled) {
      db.prepare(
        `INSERT INTO chatops_chatty (surface, scope_id, enabled) VALUES (?, ?, ?)
         ON CONFLICT (surface, scope_id) DO UPDATE SET enabled = excluded.enabled,
           muted_until = CASE WHEN excluded.enabled = 1 THEN NULL ELSE muted_until END`,
      ).run(surface, scopeId, enabled ? 1 : 0);
    },
    setMutedUntil(scopeId, until) {
      db.prepare("UPDATE chatops_chatty SET muted_until = ? WHERE surface = ? AND scope_id = ?")
        .run(until ?? null, surface, scopeId);
    },
  };
}

export const MUTE_DEFAULT_MIN = 30;
export const MUTE_MAX_MIN = 24 * 60;

export type ChatterCommand =
  | { kind: "chatty"; arg: "on" | "off" | "status" }
  | { kind: "mute"; minutes: number }
  | { kind: "unmute" };

/** Whole-message parser for the addressed, de-mentioned typed text: `chatty on|off|status`,
 * `quiet|hush|mute|be quiet|stay quiet [for] <n><unit>` (no duration = 30 min, clamped to
 * 1 min–24 h), and `unmute`. Anything longer ("be quiet about X and do Y") is a normal turn. */
export function parseChatterCommand(text: string): ChatterCommand | undefined {
  const t = text.trim().toLowerCase().replace(/^\/+/, "").replace(/[.!]+$/, "").trim();
  const chatty = /^chatty(?:\s+(on|off|status))?$/.exec(t);
  if (chatty) return { kind: "chatty", arg: (chatty[1] ?? "status") as "on" | "off" | "status" };
  if (t === "unmute") return { kind: "unmute" };
  const mute = /^(?:be quiet|stay quiet|quiet|hush|mute)(?:\s+(?:for\s+)?(\d{1,6})\s*(m|mins?|minutes?|h|hrs?|hours?))?$/.exec(t);
  if (!mute) return undefined;
  const n = mute[1] === undefined ? MUTE_DEFAULT_MIN : Number(mute[1]) * (mute[2]!.startsWith("h") ? 60 : 1);
  return { kind: "mute", minutes: Math.min(MUTE_MAX_MIN, Math.max(1, n)) };
}

/** The real end time in the bot's TZ, e.g. "Tue 3:45 PM EDT". */
export const formatMuteEnd = (until: number): string =>
  new Date(until).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit", timeZoneName: "short" });

export const NOT_CHATTY = "I'm not chiming in here anyway — I only answer when someone addresses me.";
