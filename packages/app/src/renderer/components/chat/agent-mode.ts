import type { CliName, LiveCli } from "@bean/core";
import type { HandoffItem, LiveEvent } from "../../../live-tasks.js";
import type { CloseTurn } from "../../../ipc.js";
import { AGENT_NAMES } from "../../shared/AgentAvatar.js";
import type { AgentId, ChatItem } from "../../shared/chat-types.js";

// Agent mode's pure pieces — slash parsing, the shared history mapper and the live-event reducer —
// kept out of ChatWindow so they test without a DOM. See .memory/project-live-sessions.md.

// Renderer copy of core's LIVE_CLIS (node-free bundle rule: types only from the barrel).
export const LIVE_AGENTS: readonly LiveCli[] = ["claude", "codex", "opencode"];
export const isLiveAgent = (a: unknown): a is LiveCli => LIVE_AGENTS.includes(a as LiveCli);

/** Renderer copy of live-tasks' HANDOFF_ITEMS (that module is main-only) — for the placeholder's count. */
export const HANDOFF_ITEMS = 20;
/** An agent's final, as Bean's history sees it. */
export const AGENT_FINAL_CHARS = 4000;
const TAIL_LINES = 30;

/** The engine a hand-off offer starts: Claude Code when it's enabled, else the first enabled live agent. */
export function offerAgent(enabled: readonly CliName[]): LiveCli | undefined {
  return enabled.includes("claude") ? "claude" : LIVE_AGENTS.find((a) => enabled.includes(a));
}

/** `/claude fix X` → { agent: "claude", rest: "fix X" }; a bare alias has rest "". Only the four
 * aliases parse — any other `/text` stays a normal message. Installed-ness is the caller's check. */
export function parseSlash(text: string): { agent: AgentId; rest: string } | undefined {
  const m = /^\/(claude|codex|opencode|bean)(?:\s+([\s\S]*))?$/.exec(text.trim());
  return m ? { agent: m[1] as AgentId, rest: (m[2] ?? "").trim() } : undefined;
}

/** The `/` popover: aliases matching what's typed so far (`/`, `/cl`), Bean first, installed agents only. */
export function slashMatches(text: string, installed: readonly LiveCli[]): AgentId[] {
  const m = /^\/(\w*)$/.exec(text);
  if (!m) return [];
  const prefix = m[1]!;
  return (["bean", ...LIVE_AGENTS.filter((a) => installed.includes(a))] as AgentId[]).filter((a) => a.startsWith(prefix));
}

/** The one mapper behind Bean's `history` and `closeTranscript`. An agent's final becomes
 * `[Claude Code] <result>` (capped) so Bean can refer to what the agent did. `memory: true` is the
 * close-time transcript: live steering and agent finals never reach memory extraction, and user
 * turns keep their id (main skips turns per-turn capture already handled). */
export function chatTurns(items: ChatItem[], opts: { memory?: boolean } = {}): CloseTurn[] {
  return items.flatMap((it): CloseTurn[] => {
    if (it.kind === "user") {
      if (opts.memory) return it.source === "live" ? [] : [{ role: "user", content: it.text, source: it.source, id: it.id }];
      // Image bytes ride only on the current turn; older turns keep a text placeholder.
      return [{ role: "user", content: it.images?.length ? `${it.text}\n[image attached]` : it.text, source: it.source }];
    }
    if (it.kind !== "reply") return [];
    if (!isLiveAgent(it.agent)) return [{ role: "assistant", content: it.text }];
    const text = it.text.trim();
    if (opts.memory || it.streaming || !text) return [];
    const capped = text.length > AGENT_FINAL_CHARS ? `${text.slice(0, AGENT_FINAL_CHARS)}…` : text;
    return [{ role: "assistant", content: `[${AGENT_NAMES[it.agent]}] ${capped}` }];
  });
}

/** What the renderer offers main for the opening turn's handoff (main keeps the tail). */
export function handoffItems(items: ChatItem[]): HandoffItem[] {
  return items.flatMap((it): HandoffItem[] => {
    if (it.kind === "user") return [{ role: "user", text: it.text }];
    if (it.kind !== "reply" || it.streaming) return [];
    return [{ role: "reply", text: it.text, ...(isLiveAgent(it.agent) ? { agent: it.agent } : {}) }];
  });
}

/** The newest `count` handed-over items, as the expandable lines under "Handed over N messages".
 * Mirrors buildHandoff's pick: the tail of the non-empty items. */
export function handoffLines(history: HandoffItem[], count: number): string[] {
  if (count <= 0) return [];
  return history.filter((h) => h.text.trim()).slice(-count).map((h) =>
    `${h.role === "user" ? "You" : AGENT_NAMES[h.agent ?? "bean"]}: ${h.text.trim()}`);
}

export function turnFooter(t: { durationMs?: number; costUsd?: number; failed?: string }): string {
  if (t.failed) return `— turn failed: ${t.failed}`;
  const parts = [
    ...(t.durationMs !== undefined ? [`${(t.durationMs / 1000).toFixed(1)}s`] : []),
    ...(t.costUsd !== undefined ? [`$${t.costUsd.toFixed(2)}`] : []),
  ];
  return parts.length ? `— turn done (${parts.join(", ")})` : "— turn done";
}

/** A streaming bubble for the session, unless one is already open (a queued message joins it). */
export function ensureStreaming(items: ChatItem[], session: string, agent: LiveCli, id: string): ChatItem[] {
  if (items.some((it) => it.kind === "reply" && it.session === session && it.streaming)) return items;
  return [...items, { kind: "reply", id, text: "", agent, session, tail: [], streaming: true }];
}

/** Fold a live event into the transcript. Rows about the session (handoff, end, failure) are the
 * caller's: this only touches the session's own bubbles, so a late event from an ended session
 * still closes its bubble without speaking for the current mode. */
export function applyLiveEvent(items: ChatItem[], e: LiveEvent, newId: () => string): ChatItem[] {
  const open = items.findLastIndex((it) => it.kind === "reply" && it.session === e.sessionId && it.streaming);
  const patch = (fn: (it: Extract<ChatItem, { kind: "reply" }>) => ChatItem): ChatItem[] =>
    items.map((it, i) => (i === open && it.kind === "reply" ? fn(it) : it));
  if (e.type === "started") return ensureStreaming(items, e.sessionId, e.agent, newId());
  if (e.type === "output") {
    if (open < 0) return [...items, { kind: "reply", id: newId(), text: "", agent: e.agent, session: e.sessionId, tail: [e.line], streaming: true }];
    return patch((it) => ({ ...it, tail: [...(it.tail ?? []).slice(-(TAIL_LINES - 1)), e.line] }));
  }
  if (e.type === "turn") {
    const done = { text: e.result, footer: turnFooter(e), streaming: false };
    if (open < 0) return [...items, { kind: "reply", id: newId(), agent: e.agent, session: e.sessionId, tail: [], ...done }];
    return patch((it) => ({ ...it, ...done }));
  }
  // ended: no turn is coming for an open bubble.
  return items.map((it) => (it.kind === "reply" && it.session === e.sessionId && it.streaming
    ? { ...it, streaming: false, footer: "— turn interrupted" } : it));
}
