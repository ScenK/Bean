import { randomUUID } from "node:crypto";
import { closeAwayToOwnerDm, dbFile, makeAway, outboxDir } from "@bean/core";
import type { ChatopsBot, ChatopsState } from "@bean/host";

export interface ChatopsMenuRow {
  bot: ChatopsBot;
  label: string;
  dot: "🟢" | "⚪" | "🔴";
  checked: boolean;
  error?: string;
}

const BOT_LABELS: Record<ChatopsBot, string> = { discord: "Discord", teams: "Teams" };
export const BOT_ORDER: ChatopsBot[] = ["discord", "teams"];
export const botLabel = (bot: ChatopsBot): string => BOT_LABELS[bot];

// A raw error can be a multi-line stderr chunk; collapsed to one line and capped so the
// disabled error row can't stretch the tray's fixed-width menu (macOS doesn't wrap menu labels).
const MAX_ERROR_LENGTH = 40;
function formatError(error: string): string {
  const collapsed = error.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_ERROR_LENGTH ? `${collapsed.slice(0, MAX_ERROR_LENGTH - 1)}…` : collapsed;
}

export function chatopsMenuRows(status: Record<ChatopsBot, ChatopsState>): ChatopsMenuRow[] {
  return BOT_ORDER.map((bot) => {
    const s = status[bot];
    const dot: ChatopsMenuRow["dot"] = s.error ? "🔴" : s.running ? "🟢" : "⚪";
    // The dot reports the process; the checkbox reports the switch. They disagree while a crashed
    // bot waits on a retry (🔴 but still checked) — and that's the point: main.ts turns `checked`
    // into stop-vs-start, so an enabled-but-dead bot can still be switched off.
    return { bot, label: BOT_LABELS[bot], dot, checked: s.enabled, ...(s.error ? { error: formatError(s.error) } : {}) };
  });
}

/** The owner's away mode for a bot's surface (#906), read from bean.db each time the menu opens, so
 * a change made with `away on|off` in the DM shows up. Not tied to the bot process: stopping or
 * restarting a bot leaves it as it was. */
export function trayAwayOn(dir: string, bot: ChatopsBot): boolean {
  return makeAway({ dbPath: dbFile(dir), surface: bot }).get().on;
}

/** The tray's Away checkbox. On: away with no reason (an away period already on — say, set from the
 * DM since the menu opened — is left alone, reason and all). Off: closes the period and queues its
 * summary for the owner's DM, never a channel (core's `closeAwayToOwnerDm`). */
export async function setTrayAway(dir: string, bot: ChatopsBot, on: boolean, now = Date.now()): Promise<void> {
  const away = makeAway({ dbPath: dbFile(dir), surface: bot });
  if (!on) {
    await closeAwayToOwnerDm(away, outboxDir(dir), randomUUID);
    return;
  }
  if (!away.get().on) away.setOn(undefined, now);
}
