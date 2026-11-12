import type { AvailableModel, CliName, LiveCli } from "@bean/core";
import type { HandoffItem, LiveEvent } from "../../../live-tasks.js";
import type { CloseTurn } from "../../../ipc.js";
import { AGENT_NAMES } from "../../shared/AgentAvatar.js";
import type { AgentId, ChatItem } from "../../shared/chat-types.js";
import { pdfPlaceholder } from "./chat-thread.js";

// Agent mode's pure pieces — slash parsing, the shared history mapper and the live-event reducer —
// kept out of ChatWindow so they test without a DOM. See .memory/project-live-sessions.md.

// Renderer copy of core's LIVE_CLIS (node-free bundle rule: types only from the barrel).
export const LIVE_AGENTS: readonly LiveCli[] = ["claude", "codex", "opencode"];
export const isLiveAgent = (a: unknown): a is LiveCli => LIVE_AGENTS.includes(a as LiveCli);

/** Renderer copy of live-tasks' HANDOFF_ITEMS (that module is main-only) — for the placeholder's count. */
export const HANDOFF_ITEMS = 20;
/** An agent's final, as Bean's history sees it. */
export const AGENT_FINAL_CHARS = 4000;
/** An agent's final as memory extraction's (non-citable) context. */
const MEMORY_FINAL_CHARS = 1000;
const TAIL_LINES = 30;

type ChatStatus = "idle" | "working" | "done" | "error";
/** Who the chat header shows (#794): Bean while Bean's own turn runs, else the open live session's
 * agent (working while it runs or stops; model = its launch `--model`, unset = the agent's default),
 * else Bean with its own status and model. */
export function chatHeader(p: {
  live?: { agent: LiveCli; model?: string; busy: boolean; stopping?: boolean };
  status: ChatStatus;
  model: string;
}): { agent: AgentId; status: ChatStatus; model?: string } {
  const { live, status, model } = p;
  if (status === "working" || !live) return { agent: "bean", status, model };
  return { agent: live.agent, status: live.busy || live.stopping ? "working" : "idle", ...(live.model ? { model: live.model } : {}) };
}

/** The engine a hand-off offer starts: Claude Code when it's enabled, else the first enabled live agent. */
export function offerAgent(enabled: readonly CliName[]): LiveCli | undefined {
  return enabled.includes("claude") ? "claude" : LIVE_AGENTS.find((a) => enabled.includes(a));
}

/** One agent's chip picks, remembered per agent (#612). `project`: undefined = keep the window's,
 * "" = scratch. `model`: undefined or "" = the agent's own default. */
export type AgentPick = { project?: string; model?: string };
export type AgentPicks = Partial<Record<LiveCli, AgentPick>>;

/** Model-memory keys. The model key is shared with chatops (bot.ts liveModelKey), so a pick on one
 * surface is the next default on the other; the project key is desktop-only — chatops' global
 * `live:project` is never read or written here. */
export const liveModelKey = (cli: LiveCli): string => `live:model:${cli}`;
export const liveProjectKey = (cli: LiveCli): string => `desktop:live:project:${cli}`;

/** The models the chip offers an agent: clis.json's, for that CLI. */
export const agentModels = (models: readonly AvailableModel[], agent: LiveCli): AvailableModel[] =>
  models.filter((m) => m.availableOn.includes(agent));

/** A picked/remembered model the agent still offers; anything stale is the agent default (undefined). */
export const validModel = (models: readonly AvailableModel[], agent: LiveCli, model: string | undefined): string | undefined =>
  model && agentModels(models, agent).some((m) => m.id === model) ? model : undefined;

/** A remembered project to restore: a removed one becomes scratch; undefined = keep the window's. */
export const validProject = (projects: readonly { path: string }[], project: string | undefined): string | undefined =>
  project === undefined || project === "" || projects.some((p) => p.path === project) ? project : "";

/** What a hand-off offer's Start launches — the card shows the same. A registered project in the
 * offer wins, else the agent's remembered one (else scratch); the model is the agent's remembered one. */
export function offerLaunch(
  offerPath: string, agent: LiveCli, picks: AgentPicks, projects: readonly { path: string }[], models: readonly AvailableModel[],
): { projectPath: string; model?: string } {
  const pick = picks[agent];
  const projectPath = projects.some((p) => p.path === offerPath) ? offerPath : validProject(projects, pick?.project) ?? "";
  const model = validModel(models, agent, pick?.model);
  return { projectPath, ...(model ? { model } : {}) };
}

/** Whether a delegate card or an ended live session's status row offers Continue live: its receipt
 * carries a live session id (main set it only for a live CLI's id shape), that CLI is enabled, and
 * the window has no live session. A row whose child is still `exiting` shows it disabled. */
export function canContinueLive(item: ChatItem, enabled: readonly CliName[], liveInWindow: boolean): boolean {
  const receipt = item.kind === "delegate" || item.kind === "status" ? item.receipt : undefined;
  return !liveInWindow && !!receipt?.sessionId && !!receipt.agent && enabled.includes(receipt.agent);
}

/** `/claude fix X` → { agent: "claude", rest: "fix X" }; a bare alias has rest "". Only the four
 * aliases parse — any other `/text` stays a normal message. Installed-ness is the caller's check. */
export function parseSlash(text: string): { agent: AgentId; rest: string } | undefined {
  const m = /^\/(claude|codex|opencode|bean)(?:\s+([\s\S]*))?$/.exec(text.trim());
  return m ? { agent: m[1] as AgentId, rest: (m[2] ?? "").trim() } : undefined;
}

/** The one mapper behind Bean's `history` and `closeTranscript`. An agent's final becomes
 * `[Claude Code] <result>` (capped) so Bean can refer to what the agent did. `memory: true` is the
 * close-time transcript: what the user typed to an agent is citable like any typed turn (a composed
 * `/skill` prompt is not — `display` marks it), agent finals ride as short non-citable context, and
 * user turns keep their id (main skips turns per-turn capture already handled). */
export function chatTurns(items: ChatItem[], opts: { memory?: boolean } = {}): CloseTurn[] {
  return items.flatMap((it): CloseTurn[] => {
    if (it.kind === "user") {
      if (opts.memory) {
        const source = it.source === "live" ? (it.display ? "skill" : "typed") : it.source;
        return [{ role: "user", content: it.text, source, id: it.id }];
      }
      // Image bytes ride only on the current turn; older turns keep a text placeholder.
      const text = it.images?.length ? `${it.text}\n[image attached]` : it.text;
      return [{ role: "user", content: it.pdf ? `${text}\n${pdfPlaceholder(it.pdf.name)}` : text, source: it.source }];
    }
    if (it.kind !== "reply") return [];
    if (!isLiveAgent(it.agent)) return [{ role: "assistant", content: it.text }];
    const text = it.text.trim();
    if (it.streaming || !text) return [];
    const max = opts.memory ? MEMORY_FINAL_CHARS : AGENT_FINAL_CHARS;
    const capped = text.length > max ? `${text.slice(0, max)}…` : text;
    return [{ role: "assistant", content: `[${AGENT_NAMES[it.agent]}] ${capped}` }];
  });
}

/** What the renderer offers main for the opening turn's handoff (main keeps the tail). Bean-mode
 * image and PDF bytes never reach an agent — the turn says one was there. */
export function handoffItems(items: ChatItem[]): HandoffItem[] {
  return items.flatMap((it): HandoffItem[] => {
    if (it.kind === "user") {
      const marks = [...(it.images?.length ? [IMAGE_NOT_HANDED] : []), ...(it.pdf ? [pdfNotHanded(it.pdf.name)] : [])];
      return [{ role: "user", text: [it.text, ...marks].join("\n") }];
    }
    if (it.kind !== "reply" || it.streaming) return [];
    return [{ role: "reply", text: it.text, ...(isLiveAgent(it.agent) ? { agent: it.agent } : {}) }];
  });
}

export const IMAGE_NOT_HANDED = "[image attached — not handed over]";
/** A Bean-mode PDF turn in the handoff: the name only, never its path or bytes. */
export const pdfNotHanded = (name: string): string => `[PDF attached: ${name} — not handed over]`;
/** Renderer copy of live-tasks' LABEL_LIMIT (main-only module). */
export const LABEL_LIMIT = 2000;

// Agent-mode images (#628): the transcript, the saved thread and `typed` hold only `[Image #N]`
// labels; the chat-scoped label map (N → staged/dropped file path) is applied only to the text
// sent to the agent, so no path is ever stored.
export type ImageLabels = ReadonlyMap<number, { path: string; agent: LiveCli }>;
export const imageLabel = (n: number): string => `[Image #${n}]`;

/** The `[Image #N]` numbers in `text`, in order (repeats kept). */
export const imageLabelNumbers = (text: string): number[] =>
  [...text.matchAll(/\[Image #(\d{1,9})\]/g)].map((m) => Number(m[1]));

/** The labels in `text` that the map knows, once each, in number order. */
export const mappedImageLabels = (text: string, labels: ImageLabels): number[] =>
  [...new Set(imageLabelNumbers(text))].filter((n) => labels.has(n)).sort((a, b) => a - b);

/** The next label number: one past the highest in the chat's user turns, the composer and the map,
 * so a number is never reused (not even one deleted from the composer before sending). */
export function nextImageNumber(items: readonly ChatItem[], composer: string, labels: ImageLabels): number {
  const seen = [
    ...items.flatMap((it) => (it.kind === "user" ? imageLabelNumbers(`${it.text} ${it.display ?? ""}`) : [])),
    ...imageLabelNumbers(composer), ...labels.keys(),
  ];
  return Math.max(0, ...seen) + 1;
}

/** What the agent gets: the label-only text, a blank line, then `[Image #N]: /abs/path` for each
 * mapped label still in it. Unknown or hand-typed labels stay plain text. */
export function withImagePaths(text: string, labels: ImageLabels): string {
  const lines = mappedImageLabels(text, labels).map((n) => `${imageLabel(n)}: ${labels.get(n)!.path}`);
  return lines.length ? `${text}\n\n${lines.join("\n")}` : text;
}

/** The newest `count` handed-over items, as the expandable lines under "Handed over N messages".
 * Mirrors buildHandoff's pick: the tail of the non-empty items. */
export function handoffLines(history: HandoffItem[], count: number): string[] {
  if (count <= 0) return [];
  return history.filter((h) => h.text.trim()).slice(-count).map((h) =>
    `${h.role === "user" ? "You" : AGENT_NAMES[h.agent ?? "bean"]}: ${h.text.trim()}`);
}

export function turnFooter(t: { durationMs?: number; costUsd?: number; failed?: string; interrupted?: true }): string {
  // Ahead of failed: a stopped turn is the user's doing, not a failure.
  if (t.interrupted) return "— turn interrupted";
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

/** The agent picked up `count` messages sent to session `key` (#746): their oldest `count` pending
 * rows clear. If the session's open bubble sits above the newest cleared row, it closes there — kept
 * without a footer when it has content, dropped when empty — and the Working bubble reopens below,
 * so the agent's output after pickup reads under the message it answers. Clears nothing = no change. */
export function consumeLive(items: ChatItem[], session: string, key: string, agent: LiveCli, count: number, id: string): ChatItem[] {
  const cleared = items.flatMap((it, i) => (it.kind === "user" && it.pending === key ? [i] : [])).slice(0, Math.max(0, count));
  const newest = cleared.at(-1);
  if (newest === undefined) return items;
  const open = items.findLastIndex((it) => it.kind === "reply" && it.session === session && it.streaming);
  const next = items.flatMap((it, i): ChatItem[] => {
    if (it.kind === "user" && cleared.includes(i)) { const { pending: _, ...rest } = it; return [rest]; }
    if (i === open && open < newest && it.kind === "reply") return it.display || it.tail?.length ? [{ ...it, streaming: false }] : [];
    return [it];
  });
  return ensureStreaming(next, session, agent, id);
}

/** Fold a live event into the transcript. Rows about the session (handoff, end, failure) are the
 * caller's: this only touches the session's own bubbles, so a late event from an ended session
 * still closes its bubble without speaking for the current mode. */
export function applyLiveEvent(items: ChatItem[], e: LiveEvent, newId: () => string): ChatItem[] {
  const open = items.findLastIndex((it) => it.kind === "reply" && it.session === e.sessionId && it.streaming);
  const patch = (fn: (it: Extract<ChatItem, { kind: "reply" }>) => ChatItem): ChatItem[] =>
    items.map((it, i) => (i === open && it.kind === "reply" ? fn(it) : it));
  if (e.type === "started") return ensureStreaming(items, e.sessionId, e.agent, newId());
  // consumed is the caller's (consumeLive): only it knows which rows belong to the session.
  if (e.type === "session" || e.type === "turn-start" || e.type === "consumed") return items;
  // The agent's messages show as `display`; `text` stays the turn's final result, so history
  // (chatTurns) and saved chats never lose the answer behind long progress prose.
  if (e.type === "text") {
    if (open < 0) return [...items, { kind: "reply", id: newId(), text: "", display: e.text, agent: e.agent, session: e.sessionId, tail: [], streaming: true }];
    return patch((it) => ({ ...it, display: it.display ? `${it.display}\n\n${e.text}` : e.text }));
  }
  if (e.type === "output") {
    // Prose arrives as `text` events; the collapsed steps keep only the `▸ tool` parts.
    const tools = e.line.split(" · ").filter((part) => part.startsWith("▸ "));
    if (!tools.length) return items;
    if (open < 0) return [...items, { kind: "reply", id: newId(), text: "", agent: e.agent, session: e.sessionId, tail: tools, streaming: true }];
    return patch((it) => ({ ...it, tail: [...(it.tail ?? []), ...tools].slice(-TAIL_LINES) }));
  }
  if (e.type === "turn") {
    const done = { text: e.result, footer: turnFooter(e), streaming: false };
    if (open < 0) return [...items, { kind: "reply", id: newId(), agent: e.agent, session: e.sessionId, tail: [], ...done }];
    // The final answer is usually the last streamed message already — don't show it twice.
    return patch((it) => {
      if (!it.display) return { ...it, ...done };
      return { ...it, ...done, display: it.display.endsWith(e.result.trim()) ? it.display : `${it.display}\n\n${e.result}` };
    });
  }
  // ended: no turn is coming for an open bubble, and the child is gone — Continue live may run.
  return items.map((it) => {
    if (it.kind === "reply" && it.session === e.sessionId && it.streaming) return { ...it, streaming: false, footer: "— turn interrupted" };
    if (it.kind === "status" && it.exiting === e.sessionId) { const { exiting: _, ...rest } = it; return rest; }
    return it;
  });
}
