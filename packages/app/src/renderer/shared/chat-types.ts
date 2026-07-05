import type { ProposedDelegate, ProposedNote, ProposedRun } from "@bean/core";

export type ChatItem =
  // `display` collapses a long auto-sent skill prompt to a short label in the transcript;
  // `text` (what the model gets) still drives the history.
  | { kind: "user"; id: string; text: string; display?: string }
  | { kind: "reply"; id: string; text: string }
  | { kind: "working"; id: string; text: string }
  | { kind: "proposal"; id: string; run: ProposedRun; state: "pending" | "confirmed" | "cancelled" }
  | { kind: "delegate"; id: string; proposal: ProposedDelegate;
      state: "pending" | "running" | "done" | "failed" | "cancelled" | "dismissed";
      taskId?: string; tail: string[]; result?: string; error?: string }
  // A propose_note draft awaiting confirmation — notes are never saved silently.
  | { kind: "note"; id: string; note: ProposedNote; state: "pending" | "saved" | "dismissed" }
  | { kind: "status"; id: string; text: string; tone: "info" | "done" | "error" };

let counter = 0;
export function newId(): string {
  counter += 1;
  return `item-${counter}`;
}
