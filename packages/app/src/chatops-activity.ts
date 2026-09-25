import type { ChatopsActivity } from "@bean/core";
import type { ChatopsBot } from "./chatops-servers.js";
import type { createTaskStatus } from "./task-status.js";

type TaskStatus = ReturnType<typeof createTaskStatus>;
const SURFACE: Record<ChatopsBot, string> = { discord: "Discord", teams: "Teams" };

/** Maps a bot's reported activity onto the avatar's status bubbles. Ids are namespaced
 * `<bot>:<type>:<id>` so two bots (and the desktop's own jobs) never collide. */
export function applyChatopsActivity(status: TaskStatus, bot: ChatopsBot, e: ChatopsActivity): void {
  const id = `${bot}:${e.type}:${e.id}`;
  const surface = SURFACE[bot];
  const startedAt = Date.now();
  if (e.type === "turn") {
    if (e.phase === "start") {
      status.upsert(id, { kind: "chat", name: e.where ? `${surface} · ${e.where}` : surface, line: `Replying to ${e.who}…`, startedAt, state: "running" });
      return;
    }
    // Like a desktop chat turn: the reply is already in the channel, so only a failure stays.
    status.dismiss(id);
    if (e.error) status.error(`${bot}:chat:error`, { kind: "chat", name: surface, line: e.error, detail: e.error });
    return;
  }
  if (e.type === "live") {
    if (e.phase === "start") status.upsert(id, { kind: "delegate", name: `${e.name} · live`, line: `Live session on ${surface}`, startedAt, state: "running" });
    else if (e.error) status.finish(id, "failed", e.error);
    else status.finish(id, "done", "Session ended");
    return;
  }
  if (e.phase === "start") status.upsert(id, { kind: "delegate", name: `${e.name} · ${surface}`, line: "Running…", startedAt, state: "running" });
  else if (e.phase === "done") status.finish(id, "done", "Done");
  else if (e.phase === "failed") status.finish(id, "failed", e.error || "Failed");
  else status.finish(id, "failed", "Stopped", false); // someone's own cancel isn't a failure to chase
}

/** A bot that exited can't report its jobs ending; close them so they don't spin forever.
 * Non-sticky: a crash already has its own error bubble. */
export function clearBotJobs(status: TaskStatus, bot: ChatopsBot): void {
  for (const j of status.list()) {
    if (j.id.startsWith(`${bot}:`) && j.state === "running") status.finish(j.id, "failed", "Bot stopped", false);
  }
}
