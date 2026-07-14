import type { ProposedDelegate, ProposedNote, ProposedRun } from "@bean/core";

export type ChatItem =
  // `display` collapses a long auto-sent skill prompt to a short label in the transcript;
  // `text` (what the model gets) still drives the history.
  | { kind: "user"; id: string; text: string; display?: string }
  // Same `display`/`text` split as above, in the other direction: an interrupted-run notice
  // needs its full instruction in `text` so a later "retry" has context (it drives history the
  // same as any other reply), but shows a short `display` instead of dumping that wall of text.
  | { kind: "reply"; id: string; text: string; display?: string }
  | { kind: "working"; id: string; text: string }
  | { kind: "proposal"; id: string; run: ProposedRun; state: "pending" | "confirmed" | "cancelled" }
  | { kind: "delegate"; id: string; proposal: ProposedDelegate;
      state: "pending" | "starting" | "running" | "done" | "failed" | "cancelled" | "dismissed";
      taskId?: string; tail: string[]; result?: string; error?: string }
  // A propose_note draft awaiting confirmation — notes are never saved silently.
  | { kind: "note"; id: string; note: ProposedNote; state: "pending" | "saved" | "dismissed" }
  | { kind: "status"; id: string; text: string; tone: "info" | "done" | "error" };

let counter = 0;
export function newId(): string {
  counter += 1;
  return `item-${counter}`;
}

export function insertDroppedPath(value: string, path: string, start: number, end: number): { value: string; cursor: number } {
  const before = value.slice(0, start);
  const after = value.slice(end);
  const left = before && !/\s$/.test(before) ? `${before} ` : before;
  const right = after.replace(/^\s+/, "");
  const inserted = `${path} `;
  return { value: `${left}${inserted}${right}`, cursor: left.length + inserted.length };
}
