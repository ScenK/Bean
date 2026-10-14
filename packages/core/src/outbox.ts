import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** One queued chatops message (~/.bean/outbox/<transport>-<id>.json). The main app
 * enqueues routine digests; each bot server drains its own transport's files on a short poll.
 * Files survive bot restarts — messages queue until a bot runs.
 *
 * Delivery is at-least-once: a claim renames the file to `<id>.json.sending`, a successful send
 * deletes it (`ackOutbox`), a failed one puts it back with a backoff (`nackOutbox`) until
 * OUTBOX_MAX_ATTEMPTS, then gives up. A crash between send and delete re-delivers on the next
 * boot (`recoverOutbox`) — a possible duplicate, accepted rather than adding an ack protocol.
 *
 * Uses sync fs (tiny local JSON files, not a hot path) rather than fs/promises, like
 * run-queue.ts: `enqueueOutbox` is called from `interruptAll()` (RunRegistry/delegate-tasks),
 * which in turn is called from Electron's `before-quit` and a bare `process.on("SIGTERM")` —
 * neither reliably supports awaiting real async work (before-quit needs a preventDefault/re-quit
 * dance that's known to be fragile; a SIGTERM handler racing the process's own exit is worse).
 * Sync fs means the write is guaranteed to have happened by the time the call returns, with no
 * async gating needed in either caller. The exported functions stay `async`-declared for
 * existing call-site compatibility (callers already `await` them) — with no internal `await`,
 * calling one without awaiting still completes its fs work synchronously before returning. */
export interface OutboxMessage {
  id: string;
  transport: "teams" | "discord" | "chat";
  // Absent = DM the user directly (discord: allowed user(s); teams: known personal
  // conversation(s)) — the default delivery mode. Present = a specific channel id (discord)
  // or conversation id (teams).
  channel?: string;
  // Discord only, ignored when `channel` is set: DM this user id instead of the owner. A failed
  // DM to a non-owner queues one owner notice (no retry). Teams ignores it.
  userId?: string;
  title?: string;
  body: string;
  // A shorter, human-facing rendering of `body` — set only when `body` itself is meant for
  // model/context consumption (e.g. an interrupted-run notice, which needs the full original
  // instruction preserved for a later "retry" to have context) and would be too long to post
  // as-is. Consumers show `displayBody ?? body`; `body` is always what a follow-up chat turn
  // should see. Absent for plain messages (routine digests) — those already are the display text.
  displayBody?: string;
  // true = also append `body` to the target conversation's history after delivery, so a
  // follow-up question about this message has it as context. Set by the enqueuer (routine
  // digests, gated by config's `routineDigestContext`); an interrupted-run notice appends
  // unconditionally via `displayBody` instead.
  context?: boolean;
  createdAt: string; // ISO
  // Retry bookkeeping, written by nackOutbox: failed send attempts so far, and the ISO time
  // before which claimOutbox skips the file.
  attempts?: number;
  retryAt?: string;
}

export const OUTBOX_MAX_ATTEMPTS = 5;

const fileName = (msg: Pick<OutboxMessage, "transport" | "id">): string => `${msg.transport}-${msg.id}.json`;

export async function enqueueOutbox(
  dir: string,
  msg: Omit<OutboxMessage, "id" | "createdAt">,
  newId: () => string,
  now: () => Date = () => new Date(),
): Promise<string> {
  const full: OutboxMessage = { ...msg, id: newId(), createdAt: now().toISOString() };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${full.transport}-${full.id}.json`), JSON.stringify(full, null, 2) + "\n", "utf8");
  return full.id;
}

/** Claims this transport's due messages, oldest first: each is renamed to `.json.sending` and
 * must then be acked (sent) or nacked (failed). Other transports' files are left untouched. */
export async function claimOutbox(
  dir: string,
  transport: "teams" | "discord" | "chat",
  now: () => Date = () => new Date(),
): Promise<OutboxMessage[]> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: OutboxMessage[] = [];
  for (const file of entries.filter((f) => f.endsWith(".json"))) {
    const path = join(dir, file);
    const isOwnTransport = file.startsWith(`${transport}-`);
    // orphan: doesn't belong to any known transport, so no poll/claim loop owns cleaning it up
    const isOrphan = !file.startsWith("teams-") && !file.startsWith("discord-") && !file.startsWith("chat-");
    if (!isOwnTransport && !isOrphan) continue; // other transport's file — leave it untouched

    if (isOrphan) {
      // unattributable to any transport — sweep it (matches "malformed files are deleted and
      // skipped"), but never return it: it's not a valid message for this or any poll loop.
      rmSync(path, { force: true });
      continue;
    }
    const parsed = parseOwn(path, file, transport);
    if (!parsed) continue;
    if (parsed.retryAt && parsed.retryAt > now().toISOString()) continue; // backing off
    renameSync(path, `${path}.sending`);
    out.push(parsed);
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Sent: drop the claimed file. */
export async function ackOutbox(dir: string, msg: OutboxMessage): Promise<void> {
  rmSync(join(dir, `${fileName(msg)}.sending`), { force: true });
}

/** Failed: put the claimed file back for a later retry (1, 2, 4, 8 min backoff). Returns true when
 * that was the last allowed attempt — the file is deleted and the caller should notify. */
export async function nackOutbox(dir: string, msg: OutboxMessage, now: () => Date = () => new Date()): Promise<boolean> {
  const sending = join(dir, `${fileName(msg)}.sending`);
  const attempts = (msg.attempts ?? 0) + 1;
  if (attempts >= OUTBOX_MAX_ATTEMPTS) {
    rmSync(sending, { force: true });
    return true;
  }
  const retryAt = new Date(now().getTime() + 60_000 * 2 ** (attempts - 1)).toISOString();
  writeFileSync(sending, JSON.stringify({ ...msg, attempts, retryAt }, null, 2) + "\n", "utf8");
  renameSync(sending, join(dir, fileName(msg)));
  return false;
}

/** Boot-time: a `.sending` file left by a crash mid-send counts as one failed attempt and is
 * queued again (so a message that crashes the bot every time eventually stops). Call once
 * before the first drain — a running drain's in-flight files are also `.sending`. */
export async function recoverOutbox(dir: string, transport: "teams" | "discord" | "chat"): Promise<void> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const file of entries.filter((f) => f.startsWith(`${transport}-`) && f.endsWith(".json.sending"))) {
    const msg = parseOwn(join(dir, file), file.slice(0, -".sending".length), transport);
    if (msg && (await nackOutbox(dir, msg))) console.error(`outbox: gave up on ${file} after ${OUTBOX_MAX_ATTEMPTS} attempts`);
  }
}

/** Claim → send → ack, or nack on a throw; `onGiveUp` runs once for a message that used its last attempt. */
export async function drainOutbox(
  dir: string,
  transport: "teams" | "discord" | "chat",
  send: (msg: OutboxMessage) => Promise<void>,
  onGiveUp: (msg: OutboxMessage, err: unknown) => Promise<void>,
  now: () => Date = () => new Date(),
): Promise<void> {
  for (const msg of await claimOutbox(dir, transport, now)) {
    try {
      await send(msg);
      await ackOutbox(dir, msg);
    } catch (err) {
      if (await nackOutbox(dir, msg, now)) await onGiveUp(msg, err);
    }
  }
}

// Reads one of `transport`'s files (named `file`, at `path`). Anything malformed — bad JSON, a
// body that disagrees with the filename (only via hand-editing) — is deleted rather than left to
// wedge this transport's poll loop forever.
function parseOwn(path: string, file: string, transport: string): OutboxMessage | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as OutboxMessage;
    if (
      parsed.transport === transport &&
      typeof parsed.id === "string" &&
      file === fileName(parsed) &&
      (parsed.channel === undefined || typeof parsed.channel === "string") &&
      (parsed.userId === undefined || typeof parsed.userId === "string") &&
      typeof parsed.body === "string"
    ) return parsed;
  } catch {
    // fall through to delete
  }
  rmSync(path, { force: true });
  return undefined;
}
