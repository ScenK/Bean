import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** One queued chatops message (~/.bean/outbox/<transport>-<id>.json). The main app
 * enqueues routine digests; each bot server claims (reads + deletes) its own transport's
 * files on a short poll. Files survive bot restarts — messages queue until a bot runs. */
export interface OutboxMessage {
  id: string;
  transport: "teams" | "discord";
  channel: string; // discord: channel id; teams: conversation id
  title?: string;
  body: string;
  createdAt: string; // ISO
}

export async function enqueueOutbox(
  dir: string,
  msg: Omit<OutboxMessage, "id" | "createdAt">,
  newId: () => string,
  now: () => Date = () => new Date(),
): Promise<string> {
  const full: OutboxMessage = { ...msg, id: newId(), createdAt: now().toISOString() };
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${full.transport}-${full.id}.json`), JSON.stringify(full, null, 2) + "\n", "utf8");
  return full.id;
}

export async function claimOutbox(dir: string, transport: "teams" | "discord"): Promise<OutboxMessage[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const out: OutboxMessage[] = [];
  for (const file of entries.filter((f) => f.endsWith(".json"))) {
    const path = join(dir, file);
    const isOwnTransport = file.startsWith(`${transport}-`);
    // orphan: doesn't belong to either known transport, so no poll loop owns cleaning it up
    const isOrphan = !file.startsWith("teams-") && !file.startsWith("discord-");
    if (!isOwnTransport && !isOrphan) continue; // other transport's file — leave it untouched

    if (isOrphan) {
      // unattributable to any transport — sweep it (matches "malformed files are deleted and
      // skipped"), but never return it: it's not a valid message for this or any poll loop.
      await rm(path, { force: true });
      continue;
    }
    let parsed: OutboxMessage;
    try {
      parsed = JSON.parse(await readFile(path, "utf8")) as OutboxMessage;
    } catch {
      // malformed — delete unconditionally so junk can't wedge *this transport's* own poll loop
      await rm(path, { force: true });
      continue;
    }
    // ponytail: only claim (and delete) files for this transport — leave other transports' files
    // untouched so a discord claim can't eat teams' queue, or vice versa.
    if (parsed.transport === transport && typeof parsed.channel === "string" && typeof parsed.body === "string") {
      out.push(parsed);
      await rm(path, { force: true });
    } else {
      // filename says this transport, but body disagrees (only via hand-editing) — same
      // treatment as a parse failure: delete rather than leave it stranded forever.
      await rm(path, { force: true });
    }
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
