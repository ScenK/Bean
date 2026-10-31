import type { CliName, LiveCli, Memory, ProposedDelegate, ProposedLiveSession, ProposedNote, ProposedRun, ProposedSkill, ProposedTodo, TurnSource } from "@bean/core";

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
// Renderer copies of core's SUPPORTED_IMAGE_MIMES / MAX_IMAGES_PER_MESSAGE (converse.ts) —
// the renderer can't import core values (node-free bundle rule), only types. Keep in step.
const SUPPORTED_IMAGE_MIMES = ["image/png", "image/jpeg", "image/webp"];
export const MAX_IMAGES_PER_MESSAGE = 4;
/** Returns a user-facing error message for an unattachable file, or null when it's fine.
 * `attachedCount` = images already pending on this message (aggregate cap). */
export function imageFileGuard(type: string, size: number, attachedCount = 0): string | null {
  if (!SUPPORTED_IMAGE_MIMES.includes(type)) return "Only PNG, JPEG, or WebP images can be attached.";
  if (size > MAX_IMAGE_BYTES) return "Images must be 10 MB or smaller.";
  if (attachedCount >= MAX_IMAGES_PER_MESSAGE) return `At most ${MAX_IMAGES_PER_MESSAGE} images per message.`;
  return null;
}

/** Who wrote a reply/working bubble. Items without `agent` are Bean's. */
export type AgentId = "bean" | CliName;

export type ChatItem =
  // `display` collapses a long auto-sent skill prompt to a short label in the transcript;
  // `text` (what the model gets) still drives the history.
  // `images` are data URLs for attached-image thumbnails; presence also drives the
  // "[image attached]" history placeholder (the bytes go only to the current turn's API call).
  // `source` = provenance for memory extraction: only "typed" turns are the user's own words.
  | { kind: "user"; id: string; text: string; display?: string; images?: string[]; source?: TurnSource }
  // Same `display`/`text` split as above, in the other direction: an interrupted-run notice
  // needs its full instruction in `text` so a later "retry" has context (it drives history the
  // same as any other reply), but shows a short `display` instead of dumping that wall of text.
  // A live agent's turn (`agent` + `session`) streams in: `tail` = its tool progress, `streaming`
  // until the turn's result lands in `text`, then `footer` ("— turn done (12.3s, $0.04)").
  | { kind: "reply"; id: string; text: string; display?: string; images?: Array<{ path: string; dataUrl: string }>; agent?: AgentId;
      session?: string; tail?: string[]; footer?: string; streaming?: boolean }
  | { kind: "working"; id: string; text: string; agent?: AgentId }
  | { kind: "proposal"; id: string; run: ProposedRun; state: "pending" | "confirmed" | "cancelled" | "expired" }
  | { kind: "delegate"; id: string; proposal: ProposedDelegate;
      state: "pending" | "starting" | "running" | "done" | "failed" | "cancelled" | "dismissed" | "expired" | "interrupted";
      taskId?: string; tail: string[]; result?: string; error?: string;
      // The started CLI session's Copy chip (terminal states only) — never chat/loopback text.
      // sessionId + agent: set when the card may offer Continue live (DelegateReceipt).
      receipt?: { label: string; command: string; sessionId?: string; agent?: LiveCli } }
  // Card states `expired` (and a delegate's `interrupted`) only come from a restored thread
  // (chat-thread.ts): read-only, never actionable again.
  // A propose_note draft awaiting confirmation — notes are never saved silently.
  // `images` = the latest chat turn's attached images (data URLs), offered for the saved note.
  | { kind: "note"; id: string; note: ProposedNote; state: "pending" | "saved" | "dismissed" | "expired"; images?: string[] }
  // A propose_skill draft awaiting confirmation — skills are never written silently.
  | { kind: "skill"; id: string; skill: ProposedSkill; state: "pending" | "saved" | "dismissed" | "expired" }
  // Bean's offer to hand the chat over to a live agent (propose_live_session) — Start runs the
  // same handoff as /claude; Not now leaves Bean in charge.
  | { kind: "offer"; id: string; offer: ProposedLiveSession; state: "pending" | "started" | "dismissed" | "expired" }
  // A propose_todo draft awaiting confirmation — todos are never queued silently.
  | { kind: "todo"; id: string; todo: ProposedTodo; state: "pending" | "queued" | "dismissed" | "expired" }
  // `details` expand under the row (e.g. the messages handed over to an agent). `receipt`: an ended
  // live session's CLI session, offered as Continue live; `exiting` = Bean's id for that session
  // while its child is still stopping (the button waits for its `ended` event).
  | { kind: "status"; id: string; text: string; tone: "info" | "done" | "error"; details?: string[];
      receipt?: { sessionId: string; agent: LiveCli; label: string }; exiting?: string }
  // A per-turn memory capture's receipt: "🧠 Memory updated — … · Undo". Undo deletes exactly
  // `saved`'s ids; an undone row stays as a quiet record. `kept` = restored from history, no Undo.
  | { kind: "memory"; id: string; saved: Array<{ id: string; text: string }>; state: "saved" | "undoing" | "undone" | "kept" }
  // A forget_memory receipt, one per deleted fact: "🧠 Forgot — … · Undo". Undo re-appends `row`
  // verbatim (same id, every field); a failed append (e.g. that id exists again) is `error` with
  // Undo still offered. `row` never reaches history (chat-thread.ts): a restored receipt is `kept`
  // (no Undo) unless it was `restored`.
  | { kind: "forgot"; id: string; text: string; row?: Memory; state: "saved" | "undoing" | "restored" | "error" | "kept"; error?: string };

/** The speaker of a reply/working bubble, or undefined for every other item. */
export function itemAgent(it: ChatItem): AgentId | undefined {
  return it.kind === "reply" || it.kind === "working" ? it.agent ?? "bean" : undefined;
}

/** Whether this item opens a run of same-agent bubbles — only a run's first bubble shows the
 * avatar. Any other item (user turn, status, card) ends the run. */
export function startsAgentRun(items: ChatItem[], i: number): boolean {
  const agent = itemAgent(items[i]!);
  const prev = items[i - 1];
  return agent !== undefined && (prev === undefined || itemAgent(prev) !== agent);
}

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
