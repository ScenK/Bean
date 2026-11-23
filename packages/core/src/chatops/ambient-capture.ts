import { randomUUID } from "node:crypto";
import type { ChatTurn, ConverseDeps } from "../converse.js";
import type { Project } from "../types.js";
import { speakerLabel as label, type Memory } from "../memory/memory.js";
import { extractMemories, synthesizeEpisode, type EpisodeLine } from "../memory/extract.js";
import type { ConversationPlace } from "./catalog.js";
import type { Chatter } from "./chatter.js";
import type { Role, Speaker } from "./roles.js";
import { localDay } from "./turn-cap.js";

/** One un-addressed channel/thread message, as the surface saw it at ingress. Identity is the
 * platform id only (`fromId`/`fromAltId`); `name` is a label. */
export interface AmbientLine {
  fromId: string;
  fromAltId?: string;
  name: string;
  text: string;
  /** epoch ms */
  at: number;
  /** Sent by a bot/app — never citable. */
  bot?: boolean;
  /** Best-effort receipt on the source message (Discord's 🧠); absent = silent (Teams). */
  react?: () => Promise<void>;
  /** The conversation as the surface sees it (its catalog `placeOf`) — titles a saved fact's source. */
  place?: ConversationPlace;
  /** User ids explicitly tagged in the sender's own words — never a reply ping, a quote or a
   * forward. Feeds the away-mode owner-tag check (#904). */
  taggedIds?: string[];
  /** The platform message id (the away capture's key) and a link to it, when the surface has them. */
  messageId?: string;
  link?: string;
}

export interface CaptureFx {
  /** A plain post in the same conversation (the one-time notice). */
  post: (text: string) => Promise<void>;
}

export interface AmbientCaptureDeps {
  chatter: Chatter;
  chat: ConverseDeps["chat"];
  model: string;
  roleOf: (s: Speaker) => Role;
  /** Shared rows this conversation may recall (dedupe context). */
  loadMemories: (subject: null, scope: { source: string }) => Promise<Memory[]>;
  appendMemories: (additions: Memory[]) => Promise<void>;
  /** Config `autoMemory`, read per batch. Absent = off. */
  autoMemoryEnabled?: () => Promise<boolean>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => () => void;
  onError?: (err: unknown) => void;
}

export interface AmbientCapture {
  onLine(conversationId: string, scopeId: string, line: AmbientLine, fx: CaptureFx): void;
  /** An addressed turn here: the episode ends now rather than at the lull. */
  flush(conversationId: string): void;
  /** The owner's steering typed into a live session in a channel or thread (#861): its latest
   * turn's facts saved shared, under the same memory switch, daily caps and source fields as
   * channel capture (`title` from the adapter). No category, no receipt, no notice. Never rejects. */
  steer(scopeId: string, title: string | undefined, transcript: ChatTurn[], projects: Project[]): Promise<void>;
}

export const CAPTURE_DAILY_CALLS = 200;
export const CAPTURE_DAILY_SAVES = 60;
/** An episode ends after this much silence, or this long after its first line. */
export const EPISODE_LULL_MS = 10 * 60_000;
export const EPISODE_FORCE_MS = 60 * 60_000;
const MAX_LINES = 200;
const MAX_LINE_CHARS = 1000;
/** Earlier lines shown as context: the last few, from the hour before a batch. */
const CONTEXT_LINES = 10;
const CONTEXT_MS = 60 * 60_000;
export const MEMORY_NOTICE = "I'll remember what matters from this chat · `memory off` to stop";

const CHANNEL_AUDIENCE =
  "This is a group chat nobody addressed you in. Lines marked (owner) are your owner's; the " +
  "others are people your owner talks with, and (bot) lines are automated. Keep what your owner " +
  "would want you to know later: what they agreed to or decided, and what the people here said " +
  "about themselves, their work and their plans. Name who said or agreed to what.";

const SOURCE_TITLE_MAX = 80;
/** A source title is the adapter's display name for the conversation: one line, ≤80 chars. */
const sourceTitle = (raw: string | undefined): string | undefined =>
  raw?.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, SOURCE_TITLE_MAX).trim() || undefined;

/** Captures memory from channel chatter Bean wasn't addressed in (#463), one episode at a time:
 * buffers each conversation, waits for it to go quiet (10 min idle, 60 min at most, or an
 * addressed turn), then one synthesis call over the whole exchange — every speaker, written in
 * Bean's words. Saved shared (`subject_id` NULL) under the conversation's `sourceId`, so it is
 * recalled there and on the owner's own surfaces only. */
export function makeAmbientCapture(deps: AmbientCaptureDeps): AmbientCapture {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); });
  // Each conversation's last lines, kept past their batch as the next batch's context.
  // ponytail: one entry per conversation ever seen, ≤10 lines each; prune if that ever matters.
  const recent = new Map<string, AmbientLine[]>();
  const pending = new Map<string, { scopeId: string; lines: AmbientLine[]; fx: CaptureFx; firstAt: number; stop: () => void }>();
  // ponytail: per-process day counters — a restart resets them; move to chatops_chatty if that matters.
  const budget = new Map<string, { day: string; calls: number; saves: number }>();
  const today = (scopeId: string): { day: string; calls: number; saves: number } => {
    const day = localDay(new Date(now()));
    let b = budget.get(scopeId);
    if (!b || b.day !== day) budget.set(scopeId, b = { day, calls: 0, saves: 0 });
    return b;
  };
  // One extraction at a time, so each sees what the last one saved.
  let chain: Promise<void> = Promise.resolve();

  async function extract(scopeId: string, lines: AmbientLine[], fx: CaptureFx, earlier: AmbientLine[]): Promise<void> {
    if (!(await deps.autoMemoryEnabled?.()) || !deps.chatter.memoryOn(scopeId)) return;
    if (!lines.some((l) => !l.bot)) return; // a bots-only batch costs no model call
    const b = today(scopeId);
    if (b.calls >= CAPTURE_DAILY_CALLS || b.saves >= CAPTURE_DAILY_SAVES) return;
    b.calls++;
    const start = lines[0]?.at ?? now();
    const context = earlier.filter((l) => l.at >= start - CONTEXT_MS);
    const all = [...context, ...lines];
    const who = (l: AmbientLine): string =>
      `${label(l.name)}${l.bot ? " (bot)" : deps.roleOf({ fromId: l.fromId, fromAltId: l.fromAltId, scopeId }) === "owner" ? " (owner)" : ""}`;
    // Source comes from the adapter (latest line's place), never from the model's call args.
    const source = { sourceId: `${deps.chatter.surface}:${scopeId}`, sourceTitle: sourceTitle(lines.findLast((l) => l.place)?.place?.title) };
    const { candidates, rejected, failed } = await synthesizeEpisode({
      lines: all.map((l): EpisodeLine => ({ who: who(l), text: l.text.slice(0, MAX_LINE_CHARS) })),
      firstNew: context.length,
      existing: await deps.loadMemories(null, { source: source.sourceId }),
      projects: [], audience: CHANNEL_AUDIENCE, now: new Date(now()),
    }, { chat: deps.chat, model: deps.model });
    if (rejected > 0) console.warn(`[memory] channel capture rejected ${rejected} candidate(s)`);
    if (failed) throw new Error("extraction model call failed");
    const kept = candidates.slice(0, Math.max(0, CAPTURE_DAILY_SAVES - b.saves));
    // Re-checked right before the insert: `memory off` (or autoMemory off) during the call wins.
    // The config read is awaited first so nothing yields between the channel check and the insert.
    if (kept.length === 0 || !(await deps.autoMemoryEnabled?.()) || !deps.chatter.memoryOn(scopeId)) return;
    b.saves += kept.length;
    const at = new Date(now()).toISOString();
    await deps.appendMemories(kept.map((c): Memory => ({
      id: randomUUID(), text: c.text, createdAt: at, ...source,
      ...(c.kind ? { kind: c.kind } : {}), ...(c.expiresAt ? { expiresAt: c.expiresAt } : {}), ...(c.evidence ? { evidence: c.evidence } : {}),
    })));
    // The receipt goes on the first new line each memory rests on (Discord's 🧠).
    for (const line of new Set(kept.flatMap((c) => all[(c.lines?.find((n) => n > context.length) ?? 0) - 1] ?? []))) {
      await line.react?.().catch(() => {});
    }
    if (deps.chatter.claimMemoryNotice(scopeId)) await fx.post(MEMORY_NOTICE);
  }

  async function steer(scopeId: string, title: string | undefined, transcript: ChatTurn[], projects: Project[]): Promise<void> {
    if (!(await deps.autoMemoryEnabled?.()) || !deps.chatter.memoryOn(scopeId)) return;
    const b = today(scopeId);
    if (b.calls >= CAPTURE_DAILY_CALLS || b.saves >= CAPTURE_DAILY_SAVES) return;
    b.calls++;
    // Shared rows only: the dedupe list a channel reader may see.
    const source = { sourceId: `${deps.chatter.surface}:${scopeId}`, sourceTitle: sourceTitle(title) };
    const { candidates, rejected, failed } = await extractMemories(
      transcript, await deps.loadMemories(null, { source: source.sourceId }), projects, { chat: deps.chat, model: deps.model }, { latestTurn: true },
    );
    if (rejected > 0) console.warn(`[memory] live steering capture rejected ${rejected} candidate(s)`);
    if (failed) throw new Error("extraction model call failed");
    const kept = candidates.slice(0, Math.max(0, CAPTURE_DAILY_SAVES - b.saves));
    // Same re-check as a channel batch: `memory off` during the call wins.
    if (kept.length === 0 || !(await deps.autoMemoryEnabled?.()) || !deps.chatter.memoryOn(scopeId)) return;
    b.saves += kept.length;
    const at = new Date(now()).toISOString();
    await deps.appendMemories(kept.map((c) => ({
      id: randomUUID(), text: c.text, createdAt: at, ...source,
      ...(c.projectPath ? { projectPath: c.projectPath } : {}),
      ...(c.kind ? { kind: c.kind } : {}), ...(c.expiresAt ? { expiresAt: c.expiresAt } : {}), ...(c.evidence ? { evidence: c.evidence } : {}),
    })));
  }

  function fire(conv: string): void {
    const p = pending.get(conv);
    if (!p) return;
    p.stop();
    pending.delete(conv);
    const earlier = recent.get(conv) ?? [];
    // Lines said under `memory off` are dropped, not kept as a later episode's context.
    if (!deps.chatter.memoryOn(p.scopeId)) { recent.delete(conv); return; }
    recent.set(conv, [...earlier, ...p.lines].slice(-CONTEXT_LINES));
    chain = chain.then(() => extract(p.scopeId, p.lines, p.fx, earlier)).catch((err: unknown) => deps.onError?.(err));
  }

  return {
    onLine(conv, scopeId, line, fx) {
      const t = now();
      const prev = pending.get(conv);
      prev?.stop();
      const p = { scopeId, lines: [...(prev?.lines ?? []), line].slice(-MAX_LINES), fx, firstAt: prev?.firstAt ?? t, stop: (): void => {} };
      pending.set(conv, p);
      p.stop = setTimer(() => fire(conv), Math.max(0, Math.min(EPISODE_LULL_MS, p.firstAt + EPISODE_FORCE_MS - t)));
    },
    flush: fire,
    // On the batch chain, so a steer and a channel batch each see what the other saved.
    steer(scopeId, title, transcript, projects) {
      return chain = chain.then(() => steer(scopeId, title, transcript, projects)).catch((err: unknown) => deps.onError?.(err));
    },
  };
}
