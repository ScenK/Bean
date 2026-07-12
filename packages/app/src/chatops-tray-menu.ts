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

export function chatopsMenuRows(status: Record<ChatopsBot, ChatopsState>): ChatopsMenuRow[] {
  return BOT_ORDER.map((bot) => {
    const s = status[bot];
    const dot: ChatopsMenuRow["dot"] = s.error ? "🔴" : s.running ? "🟢" : "⚪";
    return { bot, label: BOT_LABELS[bot], dot, checked: s.running, ...(s.error ? { error: s.error } : {}) };
  });
}
