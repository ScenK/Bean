// packages/core/src/card-record.ts
// Node-free (exported as `@bean/core/card-record`): the one-line, code-built record of a confirm
// card and its outcome that rides in the model's history as an assistant turn (#941), so a
// follow-up after a card knows the card exists (and doesn't propose the same action again).
// Desktop builds it from the card item's current state; chatops appends one per post and outcome.

/** The neutral line a card arrives under when nothing else introduced it (#978): the model proposed
 * it without a sentence of its own, or a command added it without the model. Neutral because the
 * card can still be refused or blocked after it is sent. */
export const CARD_LEAD = "Here's what I'd do:";

/** Every record line starts with this; the synced desktop view shows such a turn as a status row. */
export const CARD_RECORD_PREFIX = "[card: ";

export type CardRecordKind =
  | "run" | "delegate" | "note" | "note archive" | "skill" | "todo" | "sprout" | "send" | "sprout draft" | "live session";

export type CardRecordState =
  | "pending" | "starting" | "running" | "queued" | "sending" | "started" | "saved" | "sent" | "archived"
  | "finished" | "needs attention" | "failed" | "interrupted" | "checked" | "didn't start" | "unknown"
  | "cancelled" | "dismissed" | "expired";

const NAME_MAX = 60;

/** `[card: sprout "pr-digest" — running]`. `name` must be a catalog name (sprout, skill, sprout
 * draft) — never a note title/body, todo text, send body/destination, instruction, path, result or
 * error text, or who tapped. It is clipped to one short line without quotes or brackets. */
export function cardRecord(kind: CardRecordKind, state: CardRecordState, name?: string): string {
  const clean = name?.replace(/["[\]]/g, "").replace(/\s+/g, " ").trim().slice(0, NAME_MAX);
  return `${CARD_RECORD_PREFIX}${kind}${clean ? ` "${clean}"` : ""} — ${state}]`;
}

export const isCardRecord = (text: string): boolean => text.startsWith(CARD_RECORD_PREFIX);

/** How a sprout or todo card's run ended, from the outcome line its card settled with
 * (`sproutResultLine` in the renderer, `sproutFinishText` in chatops). */
export function runEndState(line: string): CardRecordState {
  const l = line.toLowerCase();
  if (l.startsWith("finished") || l.endsWith("finished ✓")) return "finished";
  if (l.includes("needs attention")) return "needs attention";
  if (l.includes("interrupted")) return "interrupted";
  return "failed";
}
