import type { ChatopsBot, ChatopsState } from "./chatops-servers.js";

export interface ChatopsMenuRow {
  bot: ChatopsBot;
  label: string;
  dot: "🟢" | "⚪" | "🔴";
  checked: boolean;
  error?: string;
}

const BOT_LABELS: Record<ChatopsBot, string> = { discord: "Discord", teams: "Teams" };
const BOT_ORDER: ChatopsBot[] = ["discord", "teams"];

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
