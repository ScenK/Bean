import { formatMemoryDigest, getMemoryMeta, memoriesSavedBetween, setMemoryMeta, type OutboxMessage } from "@bean/core";
import type { ChatopsBot } from "./chatops-servers.js";

export const MEMORY_DIGEST_EVERY_MS = 24 * 60 * 60 * 1000;
const CHECK_EVERY_MS = 10 * 60 * 1000;

export interface MemoryDigestDeps {
  dbFile: string;
  /** The scheduler lease: a host without it sends nothing. */
  canRun: () => boolean;
  /** Bots this host is supervising with a live process right now. */
  runningBots: () => ChatopsBot[];
  /** Every id the owner's private rows live under (core `ownerSubjectIds`). */
  ownerIds: () => Promise<string[]>;
  /** Current destination names by `<surface>:<id>`, for channel groups. */
  labels: () => ReadonlyMap<string, string>;
  enqueue: (msg: Omit<OutboxMessage, "id" | "createdAt">) => Promise<string>;
  now?: () => Date;
}

/** The owner's daily memory digest (#859): when a day has passed since `lastDigestAt`, the rows the
 * owner may see that were saved since go to the owner's DM on every running bot. Not a routine —
 * nothing is kept in run records, chat history (`context` false, no `displayBody`) or logs.
 * The watermark advances only after the enqueue; with no bot running it stays put, so the rows
 * wait for the next bot. Returns how many messages were queued. */
export async function sendMemoryDigestIfDue(deps: MemoryDigestDeps): Promise<number> {
  if (!deps.canRun()) return 0;
  const now = (deps.now ?? (() => new Date()))();
  const until = now.toISOString();
  const last = await getMemoryMeta(deps.dbFile, "lastDigestAt");
  // First run: start the clock instead of sending every row ever saved.
  if (typeof last !== "string") {
    await setMemoryMeta(deps.dbFile, "lastDigestAt", until);
    return 0;
  }
  if (now.getTime() - Date.parse(last) < MEMORY_DIGEST_EVERY_MS) return 0;
  const bots = deps.runningBots();
  if (bots.length === 0) return 0;
  const body = formatMemoryDigest(
    await memoriesSavedBetween(deps.dbFile, last, until, await deps.ownerIds()),
    { labels: deps.labels() },
  );
  let queued = 0;
  if (body) {
    for (const bot of bots) {
      // One destination failing must not cost the other its digest.
      try {
        await deps.enqueue({ transport: bot, title: "Memory digest", body, context: false });
        queued++;
      } catch (err) {
        console.error(`bean: memory digest enqueue failed (${bot})`, err);
      }
    }
    if (queued === 0) return 0;
  }
  await setMemoryMeta(deps.dbFile, "lastDigestAt", until);
  return queued;
}

/** Checks now (the startup due check) and every 10 minutes after. Returns the stop. */
export function startMemoryDigest(deps: MemoryDigestDeps): () => void {
  // ponytail: due = 24h since the last send, so the send time drifts up to one check interval a
  // day; pin a time of day if that ever matters.
  const tick = (): void => {
    sendMemoryDigestIfDue(deps).catch((err: unknown) => console.error("bean: memory digest failed", err));
  };
  tick();
  const timer = setInterval(tick, CHECK_EVERY_MS);
  return () => clearInterval(timer);
}
