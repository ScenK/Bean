import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../db.js";
import { formatMuteEnd } from "./chatter.js";

/** The owner's away mode on one chat surface (`chatops_away`, #903). A missing row means off. */
export interface AwayState {
  on: boolean;
  /** Epoch ms away mode was turned on; set only while on. */
  since?: number;
  reason?: string;
}

export interface Away {
  readonly surface: "discord" | "teams";
  get(): AwayState;
  /** On again while already on keeps `since` and replaces the reason. */
  setOn(reason: string | undefined, now: number): void;
  setOff(): void;
}

export const AWAY_REASON_MAX = 200;

export function makeAway(opts: { dbPath: string; surface: "discord" | "teams" }): Away {
  const db: DatabaseSync = openDb(opts.dbPath);
  const { surface } = opts;
  return {
    surface,
    get() {
      const row = db.prepare("SELECT is_on, since, reason FROM chatops_away WHERE surface = ?")
        .get(surface) as { is_on: number; since: number | null; reason: string | null } | undefined;
      if (!row || row.is_on !== 1) return { on: false };
      return { on: true, ...(row.since !== null ? { since: row.since } : {}), ...(row.reason ? { reason: row.reason } : {}) };
    },
    setOn(reason, now) {
      db.prepare(
        `INSERT INTO chatops_away (surface, is_on, since, reason) VALUES (?, 1, ?, ?)
         ON CONFLICT (surface) DO UPDATE SET reason = excluded.reason,
           since = CASE WHEN is_on = 1 THEN since ELSE excluded.since END, is_on = 1`,
      ).run(surface, now, reason ?? null);
    },
    setOff() {
      db.prepare("UPDATE chatops_away SET is_on = 0, since = NULL, reason = NULL WHERE surface = ?").run(surface);
    },
  };
}

export type AwayCommand = { kind: "on"; reason?: string } | { kind: "off" } | { kind: "status" };

/** `away on [reason]`, `away off`, `away status` — the whole message, optional leading slash.
 * The reason is literal text: whitespace collapsed to one line, capped at AWAY_REASON_MAX. */
export function parseAwayCommand(text: string): AwayCommand | undefined {
  const m = /^\/*away\s+(on|off|status)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!m) return undefined;
  const kind = m[1]!.toLowerCase() as AwayCommand["kind"];
  const rest = (m[2] ?? "").replace(/\s+/g, " ").trim();
  if (kind !== "on") return rest ? undefined : { kind };
  return rest ? { kind, reason: rest.slice(0, AWAY_REASON_MAX).trim() } : { kind };
}

const label = (surface: Away["surface"]): string => surface === "teams" ? "Teams" : "Discord";

/** Every refused use (not the owner, or not their real DM) hears this one line — never the state. */
export const awayRefusal = (ownerName: string): string =>
  `Only ${ownerName} can use \`away\`, and only in a direct message with me.`;

/** Runs an owner-DM `away` command and returns the one-line answer. */
export function runAwayCommand(away: Away, c: AwayCommand, now: number): string {
  const where = label(away.surface);
  const before = away.get();
  if (c.kind === "status") {
    if (!before.on) return `Away mode is off for ${where}.`;
    return `Away mode is on for ${where}${before.since !== undefined ? ` since ${formatMuteEnd(before.since)}` : ""}` +
      `${before.reason ? ` (reason: ${before.reason})` : ""}.`;
  }
  if (c.kind === "off") {
    if (!before.on) return `Away mode was already off for ${where}.`;
    away.setOff();
    return `Away mode is off for ${where}.`;
  }
  away.setOn(c.reason, now);
  return `Away mode is ${before.on ? "still " : ""}on for ${where}${c.reason ? ` (reason: ${c.reason})` : ""}. \`away off\` ends it.`;
}

/** Appended to the owner's own answers on a surface where away mode is on. */
export const awayReminder = (away: Away): string =>
  `(Away mode is on for ${label(away.surface)} — \`away off\` in our DM ends it.)`;
