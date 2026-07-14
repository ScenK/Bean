import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** One queued chatops message (~/.bean/outbox/<transport>-<id>.json). The main app
 * enqueues routine digests; each bot server claims (reads + deletes) its own transport's
 * files on a short poll. Files survive bot restarts — messages queue until a bot runs.
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
  title?: string;
  body: string;
  // A shorter, human-facing rendering of `body` — set only when `body` itself is meant for
  // model/context consumption (e.g. an interrupted-run notice, which needs the full original
  // instruction preserved for a later "retry" to have context) and would be too long to post
  // as-is. Consumers show `displayBody ?? body`; `body` is always what a follow-up chat turn
  // should see. Absent for plain messages (routine digests) — those already are the display text.
  displayBody?: string;
  createdAt: string; // ISO
}

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

export async function claimOutbox(dir: string, transport: "teams" | "discord" | "chat"): Promise<OutboxMessage[]> {
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
    let parsed: OutboxMessage;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8")) as OutboxMessage;
    } catch {
      // malformed — delete unconditionally so junk can't wedge *this transport's* own poll loop
      rmSync(path, { force: true });
      continue;
    }
    // ponytail: only claim (and delete) files for this transport — leave other transports' files
    // untouched so a discord claim can't eat teams' queue, or vice versa.
    if (
      parsed.transport === transport &&
      (parsed.channel === undefined || typeof parsed.channel === "string") &&
      typeof parsed.body === "string"
    ) {
      out.push(parsed);
      rmSync(path, { force: true });
    } else {
      // filename says this transport, but body disagrees (only via hand-editing) — same
      // treatment as a parse failure: delete rather than leave it stranded forever.
      rmSync(path, { force: true });
    }
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
