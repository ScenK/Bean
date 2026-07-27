import type { ProposedDelegate, ProposedNote, ProposedRun, ProposedSkill, ProposedTodo } from "@bean/core";

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

export type ChatItem =
  // `display` collapses a long auto-sent skill prompt to a short label in the transcript;
  // `text` (what the model gets) still drives the history.
  // `images` are data URLs for attached-image thumbnails; presence also drives the
  // "[image attached]" history placeholder (the bytes go only to the current turn's API call).
  | { kind: "user"; id: string; text: string; display?: string; images?: string[] }
  // Same `display`/`text` split as above, in the other direction: an interrupted-run notice
  // needs its full instruction in `text` so a later "retry" has context (it drives history the
  // same as any other reply), but shows a short `display` instead of dumping that wall of text.
  | { kind: "reply"; id: string; text: string; display?: string; images?: Array<{ path: string; dataUrl: string }> }
  | { kind: "working"; id: string; text: string }
  | { kind: "proposal"; id: string; run: ProposedRun; state: "pending" | "confirmed" | "cancelled" }
  | { kind: "delegate"; id: string; proposal: ProposedDelegate;
      state: "pending" | "starting" | "running" | "done" | "failed" | "cancelled" | "dismissed";
      taskId?: string; tail: string[]; result?: string; error?: string }
  // A propose_note draft awaiting confirmation — notes are never saved silently.
  | { kind: "note"; id: string; note: ProposedNote; state: "pending" | "saved" | "dismissed" }
  // A propose_skill draft awaiting confirmation — skills are never written silently.
  | { kind: "skill"; id: string; skill: ProposedSkill; state: "pending" | "saved" | "dismissed" }
  // A propose_todo draft awaiting confirmation — todos are never queued silently.
  | { kind: "todo"; id: string; todo: ProposedTodo; state: "pending" | "queued" | "dismissed" }
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
