import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../db.js";
import type { ConverseDeps } from "../converse.js";
import { composePersonaPrompt, type Persona } from "../persona.js";
import { memoriesBlock, type Memory } from "../memory/memory.js";
import { selectRelevantMemories } from "../memory/store.js";
import { formatAmbientBlock, type AmbientMessage } from "./ambient.js";
import { localDay } from "./turn-cap.js";

/** Per-channel chime-in state (`chatops_chatty`). A missing row means off. */
export interface ChattyState {
  enabled: boolean;
  /** Epoch ms; absent or past = not muted. */
  mutedUntil?: number;
}

export interface Chatter {
  get(scopeId: string): ChattyState;
  /** Turning it on also clears any mute. */
  setEnabled(scopeId: string, enabled: boolean): void;
  /** `until` = epoch ms; undefined unmutes. */
  setMutedUntil(scopeId: string, until: number | undefined): void;
  /** Atomically admit one chime-in attempt at `now` (enabled, unmuted, cooled down, under the
   * daily caps, nothing in flight) and count it. False = not admitted. */
  claim(scopeId: string, now: number): boolean;
  /** Ends a claimed attempt; `spoke` counts a chime-in and restarts the cooldown. */
  release(scopeId: string, spoke: boolean, now: number): void;
}

export const CHIME_COOLDOWN_MS = 10 * 60_000;
export const CHIME_DAILY_SPOKEN = 24;
export const CHIME_DAILY_ATTEMPTS = 100;
/** A claim outlives any real attempt (the call times out well before), so only a crash hits it. */
const CLAIM_TTL_MS = 5 * 60_000;

export function makeChatter(opts: { dbPath: string; surface: "discord" | "teams" }): Chatter {
  const db: DatabaseSync = openDb(opts.dbPath);
  const { surface } = opts;
  return {
    get(scopeId) {
      const row = db.prepare("SELECT enabled, muted_until FROM chatops_chatty WHERE surface = ? AND scope_id = ?")
        .get(surface, scopeId) as { enabled: number; muted_until: number | null } | undefined;
      return row ? { enabled: row.enabled === 1, ...(row.muted_until !== null ? { mutedUntil: row.muted_until } : {}) } : { enabled: false };
    },
    setEnabled(scopeId, enabled) {
      db.prepare(
        `INSERT INTO chatops_chatty (surface, scope_id, enabled) VALUES (?, ?, ?)
         ON CONFLICT (surface, scope_id) DO UPDATE SET enabled = excluded.enabled,
           muted_until = CASE WHEN excluded.enabled = 1 THEN NULL ELSE muted_until END`,
      ).run(surface, scopeId, enabled ? 1 : 0);
    },
    setMutedUntil(scopeId, until) {
      db.prepare("UPDATE chatops_chatty SET muted_until = ? WHERE surface = ? AND scope_id = ?")
        .run(until ?? null, surface, scopeId);
    },
    claim(scopeId, now) {
      // One UPDATE so two fires can't both pass the checks; SET reads the row's old values, so the
      // counters reset on a new local day.
      const day = localDay(new Date(now));
      return db.prepare(
        `UPDATE chatops_chatty SET
           spoken = CASE WHEN day IS ? THEN spoken ELSE 0 END,
           attempts = CASE WHEN day IS ? THEN attempts ELSE 0 END + 1,
           day = ?, inflight_until = ?
         WHERE surface = ? AND scope_id = ? AND enabled = 1
           AND (muted_until IS NULL OR muted_until <= ?)
           AND (last_spoke_at IS NULL OR last_spoke_at <= ?)
           AND (day IS NOT ? OR (spoken < ? AND attempts < ?))
           AND (inflight_until IS NULL OR inflight_until <= ?)`,
      ).run(day, day, day, now + CLAIM_TTL_MS, surface, scopeId, now, now - CHIME_COOLDOWN_MS,
        day, CHIME_DAILY_SPOKEN, CHIME_DAILY_ATTEMPTS, now).changes === 1;
    },
    release(scopeId, spoke, now) {
      db.prepare(
        `UPDATE chatops_chatty SET inflight_until = NULL,
           spoken = spoken + ?, last_spoke_at = CASE WHEN ? THEN ? ELSE last_spoke_at END
         WHERE surface = ? AND scope_id = ?`,
      ).run(spoke ? 1 : 0, spoke ? 1 : 0, now, surface, scopeId);
    },
  };
}

export const MUTE_DEFAULT_MIN = 30;
export const MUTE_MAX_MIN = 24 * 60;

export type ChatterCommand =
  | { kind: "chatty"; arg: "on" | "off" | "status" }
  | { kind: "mute"; minutes: number }
  | { kind: "unmute" };

/** Whole-message parser for the addressed, de-mentioned typed text: `chatty on|off|status`,
 * `quiet|hush|mute|be quiet|stay quiet [for] <n><unit>` (no duration = 30 min, clamped to
 * 1 min–24 h), and `unmute`. Anything longer ("be quiet about X and do Y") is a normal turn. */
export function parseChatterCommand(text: string): ChatterCommand | undefined {
  // Every command is short; capping length also bounds the trailing-punctuation regex (CodeQL js/polynomial-redos).
  if (text.length > 64) return undefined;
  const t = text.trim().toLowerCase().replace(/^\/+/, "").replace(/[.!]+$/, "").trim();
  const chatty = /^chatty(?:\s+(on|off|status))?$/.exec(t);
  if (chatty) return { kind: "chatty", arg: (chatty[1] ?? "status") as "on" | "off" | "status" };
  if (t === "unmute") return { kind: "unmute" };
  const mute = /^(?:be quiet|stay quiet|quiet|hush|mute)(?:\s+(?:for\s+)?(\d{1,6})\s*(m|mins?|minutes?|h|hrs?|hours?))?$/.exec(t);
  if (!mute) return undefined;
  const n = mute[1] === undefined ? MUTE_DEFAULT_MIN : Number(mute[1]) * (mute[2]!.startsWith("h") ? 60 : 1);
  return { kind: "mute", minutes: Math.min(MUTE_MAX_MIN, Math.max(1, n)) };
}

/** The real end time in the bot's TZ, e.g. "Tue 3:45 PM EDT". */
export const formatMuteEnd = (until: number): string =>
  new Date(until).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit", timeZoneName: "short" });

export const NOT_CHATTY = "I'm not chiming in here anyway — I only answer when someone addresses me.";

export const CHIME_LULL_MS = 30_000;
export const CHIME_FORCE_MS = 2 * 60_000;
const CHIME_MIN_NEW = 2;
const CHIME_TIMEOUT_MS = 30_000;
const CHIME_MAX_CHARS = 500;
export const SILENT = "<silent>";

const CHIME_INSTRUCTION =
  "You are reading a group channel. Nobody addressed you; you may add one short message to the " +
  "conversation, the way a person in a group chat speaks up once it pauses. Only speak if you add " +
  "something genuinely useful (a fact, an answer, a pointer). If you do, reply in at most 2 short " +
  `sentences of plain text. Otherwise output exactly ${SILENT} and nothing else — most of the time, ` +
  "that is the right answer. You can't run anything here: never offer or claim to do something.";

/** The reply cut at its last sentence end within 500 chars; undefined when there is none. */
export function trimChimeIn(text: string): string | undefined {
  let end = 0;
  for (const m of text.matchAll(/[.!?…]["'”’)\]]*(?=\s|$)/g)) {
    const e = m.index + m[0].length;
    if (e > CHIME_MAX_CHARS) break;
    end = e;
  }
  return end > 0 ? text.slice(0, end) : undefined;
}

export interface ChimeInFx {
  /** Un-addressed messages in this conversation since the epoch ms, oldest first. */
  fetchRecent: (sinceMs: number) => Promise<AmbientMessage[]>;
  post: (text: string) => Promise<void>;
}

export interface ChimeInDeps {
  chatter: Chatter;
  chat: ConverseDeps["chat"];
  model: string;
  loadPersona: () => Promise<Persona>;
  /** core's loadMemories scoping — the engine always passes `null` (household-shared only). */
  loadMemories: (subject: null) => Promise<Memory[]>;
  conversations: {
    append(conversationId: string, turn: { role: "user" | "assistant"; content: string }): void;
    ambientCutoff(conversationId: string): number;
    setAmbientCutoff(conversationId: string, cutoffMs: number): void;
  };
  liveSession: (conversationId: string) => boolean;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => () => void;
  onError?: (err: unknown) => void;
}

export interface ChimeIn {
  /** An un-addressed human message arrived in `conversationId` (scope = its channel). */
  onAmbient(conversationId: string, scopeId: string, fx: ChimeInFx): void;
  /** An addressed turn here: drop the pending timer and any in-flight reply. */
  cancel(conversationId: string): void;
}

/** Waits for a lull per conversation, then makes one tool-less call that is both the decision and
 * the reply. Silent outcomes persist nothing and leave the ambient cutoff alone. */
export function makeChimeIn(deps: ChimeInDeps): ChimeIn {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); });
  // Bumped on every message and addressed turn, so an in-flight call can tell it went stale.
  const epoch = new Map<string, number>();
  const pending = new Map<string, { stop: () => void; firstAt: number | undefined; count: number }>();
  const bump = (conv: string): number => { const e = (epoch.get(conv) ?? 0) + 1; epoch.set(conv, e); return e; };

  async function fire(conv: string, scopeId: string, fx: ChimeInFx): Promise<void> {
    const p = pending.get(conv);
    if (!p) return;
    if (p.count < CHIME_MIN_NEW || deps.liveSession(conv) || !deps.chatter.claim(scopeId, now())) {
      // Not evaluated: keep the count, but the next message starts a fresh lull.
      p.firstAt = undefined;
      return;
    }
    pending.delete(conv);
    const myEpoch = epoch.get(conv);
    let spoke = false;
    try {
      const startedAt = now();
      const window = (await fx.fetchRecent(Math.max(startedAt - 15 * 60_000, deps.conversations.ambientCutoff(conv)))).slice(-50);
      if (window.length === 0) return;
      const block = formatAmbientBlock(window, startedAt);
      const [persona, memories] = await Promise.all([deps.loadPersona(), deps.loadMemories(null)]);
      // Shared rows only (the null above), and never a local project path.
      const shared = selectRelevantMemories(memories.filter((m) => !m.subjectId), window.map((m) => m.text).join("\n"))
        .map(({ projectPath: _, ...m }) => m);
      const recall = memoriesBlock(shared, [], { ids: false, subject: "the household" });
      let timer: (() => void) | undefined;
      const res = await Promise.race([
        deps.chat({
          model: deps.model, tools: [], webSearch: false,
          messages: [
            { role: "system", content: [composePersonaPrompt(persona), CHIME_INSTRUCTION, recall].filter(Boolean).join("\n\n") },
            { role: "user", content: block },
          ],
        }),
        new Promise<undefined>((resolve) => { timer = setTimer(() => resolve(undefined), CHIME_TIMEOUT_MS); }),
      ]).finally(() => timer?.());
      if (!res || res.toolCalls.length > 0) return;
      const out = res.content.trim();
      const reply = out === "" || out === SILENT ? undefined : trimChimeIn(out);
      if (!reply) return;
      // Re-check: muted/turned off, newer chatter, an addressed turn, or a live session drops it.
      const state = deps.chatter.get(scopeId);
      const t = now();
      if (!state.enabled || (state.mutedUntil ?? 0) > t || epoch.get(conv) !== myEpoch || deps.liveSession(conv)) return;
      // Persisted synchronously before the send, so no addressed turn can interleave.
      deps.conversations.append(conv, { role: "user", content: block });
      deps.conversations.append(conv, { role: "assistant", content: reply });
      deps.conversations.setAmbientCutoff(conv, Math.max(deps.conversations.ambientCutoff(conv), window[window.length - 1]!.at + 1));
      spoke = true;
      deps.chatter.release(scopeId, true, t);
      await fx.post(reply);
    } finally {
      if (!spoke) deps.chatter.release(scopeId, false, now());
    }
  }

  return {
    onAmbient(conv, scopeId, fx) {
      bump(conv);
      if (deps.liveSession(conv) || !deps.chatter.get(scopeId).enabled) return;
      const t = now();
      const prev = pending.get(conv);
      prev?.stop();
      const firstAt = prev?.firstAt ?? t;
      const p: { stop: () => void; firstAt: number | undefined; count: number } = { firstAt, count: (prev?.count ?? 0) + 1, stop: (): void => {} };
      pending.set(conv, p);
      p.stop = setTimer(() => {
        fire(conv, scopeId, fx).catch((err: unknown) => deps.onError?.(err));
      }, Math.max(0, Math.min(CHIME_LULL_MS, firstAt + CHIME_FORCE_MS - t)));
    },
    cancel(conv) {
      bump(conv);
      pending.get(conv)?.stop();
      pending.delete(conv);
    },
  };
}
