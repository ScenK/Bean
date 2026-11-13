import type { ChatopsSurface, RoutineTrigger, RoutineTriggerAnswer } from "@bean/core";
import { chatopsEnabledFile } from "@bean/core";
import { join } from "node:path";
import { applyChatopsActivity, clearBotJobs } from "./chatops-activity.js";
import { loadChatopsEnabled, migrateChatopsEnabled, saveChatopsEnabled } from "./chatops-enabled-store.js";
import { createChatopsServers, type ChatopsBot, type ChatopsEvent, type ChatopsServersDeps } from "./chatops-servers.js";
import type { createTaskStatus } from "./task-status.js";

/** A synced chat's sidebar row changed: its live session started/ended, or its history was saved. */
export interface SyncedChatEvent { surface: ChatopsSurface; conversationId?: string; saved?: boolean }

/** What the shell tells the host about bot supervision. */
export interface HostBotsOptions extends Pick<ChatopsServersDeps, "serverEntries" | "spawnFn" | "existsFn"> {
  /** Where the server bundles resolve from (the repo root in dev, the app's `Resources` packaged). */
  root: string;
  /** The pre-#805 enabled-set file (Electron userData), copied into the data directory once. */
  legacyEnabledFile?: string;
  /** Every bot state change (Start/Stop toggles, errors, the Teams endpoint). */
  onEvent: (e: ChatopsEvent) => void;
  /** A synced chat's row changed (synced-chats in the desktop sidebar). */
  onSynced: (e: SyncedChatEvent) => void;
}

interface BotsDeps extends HostBotsOptions {
  dir: string;
  builtinDir: string;
  resolvedPath: string;
  taskStatus: ReturnType<typeof createTaskStatus>;
  onQuit: (fn: () => void) => void;
  onRoutineTrigger: (bot: ChatopsBot, req: RoutineTrigger) => Promise<RoutineTriggerAnswer>;
}

/** The Discord and Teams bots as children of the host that owns the data directory: their status
 * bubbles, the synced-chat live set, the persisted enabled set (replayed here at boot), and the kill
 * at shutdown. See .memory/safety-chatops-servers-must-die-with-the-app.md before changing any of it. */
export async function startBots(deps: BotsDeps) {
  const { taskStatus } = deps;
  const enabledFile = chatopsEnabledFile(deps.dir);
  if (deps.legacyEnabledFile) {
    // A failed copy costs one boot's autostart, not the host.
    await migrateChatopsEnabled(enabledFile, deps.legacyEnabledFile).catch((err: unknown) => console.error("bean: couldn't migrate chatops-enabled.json", err));
  }
  // Conversations with a live session running, from the bots' `live` activity (its id is the conversation id).
  const liveConvs: Record<ChatopsBot, Set<string>> = { discord: new Set(), teams: new Set() };
  let save: Promise<void> = Promise.resolve();
  const servers = createChatopsServers({
    repoRoot: deps.root,
    resolvedPath: deps.resolvedPath,
    ...(deps.serverEntries ? { serverEntries: deps.serverEntries } : {}),
    ...(deps.spawnFn ? { spawnFn: deps.spawnFn } : {}),
    ...(deps.existsFn ? { existsFn: deps.existsFn } : {}),
    extraEnv: { BEAN_BUILTIN_DIR: deps.builtinDir },
    configFile: (bot) => join(deps.dir, `${bot}.json`),
    // A spawned bot's sprout-run tap (#637), answered by the host's scheduler.
    onRoutineTrigger: deps.onRoutineTrigger,
    onActivity: (bot, e) => {
      applyChatopsActivity(taskStatus, bot, e);
      if (e.type !== "live") return;
      if (e.phase === "start") liveConvs[bot].add(e.id); else liveConvs[bot].delete(e.id);
      deps.onSynced({ surface: bot, conversationId: e.id });
    },
    onSaved: (bot, conversationId) => deps.onSynced({ surface: bot, conversationId, saved: true }),
    send: (event) => {
      if (!event.running && liveConvs[event.bot].size > 0) {
        liveConvs[event.bot].clear();
        deps.onSynced({ surface: event.bot });
      }
      if (event.error) taskStatus.error(`bot:${event.bot}`, { kind: "bot", name: event.bot === "discord" ? "Discord" : "Teams", line: event.error, detail: event.error });
      if (!event.running) clearBotJobs(taskStatus, event.bot);
      deps.onEvent(event);
    },
    // Chained, not fire-and-forget: replaying two bots at boot (or a fast toggle) would otherwise put
    // two writes on the same path in flight, where an older subset can land last.
    onEnabledChange: (bots) => {
      save = save.then(() => saveChatopsEnabled(enabledFile, bots)).catch(() => {});
    },
  });
  // Spawned servers don't die with the host: without this they survive as launchd orphans holding
  // :3978 with whatever build they booted with. Their own exitWhenOrphaned() covers crash/SIGKILL.
  deps.onQuit(() => servers.stopAll());
  // Every restart path lands here (quit, dev relaunch, update install), so the bots don't quietly stay off.
  for (const bot of await loadChatopsEnabled(enabledFile)) servers.start(bot);
  return {
    ...servers,
    /** Conversations with a live session running on a bot (the synced-chat sidebar's live dot). */
    liveIds: (bot: ChatopsBot): ReadonlySet<string> => liveConvs[bot],
  };
}

export type HostBots = Awaited<ReturnType<typeof startBots>>;
