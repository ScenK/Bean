// packages/core/src/routine-store.ts
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { link, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isValidCron, nextRun } from "./cron.js";
import { describeWatchWindowError, type WatchWindow } from "./watch-window.js";
import { CLI_NAMES, type CliName } from "./launcher.js";
import { cliOffersEffort, cliOffersModel, type CliModels } from "./cli-models.js";
import type { Destination } from "./destinations.js";
import { describeContinueErrors, describeEdgeError, describeGroupErrors, isDoneEnd } from "./routine-graph.js";

// Absent/empty channel = DM the user directly (the default); a non-empty channel targets a
// specific discord channel id or teams conversation id instead.
// `user` (Discord only, exclusive with `channel`): DM that Discord user id instead of the owner.
// `alias` (exclusive with both): a named `chat_destinations` row, resolved to its id at enqueue —
// renaming the target is one retarget in Settings, not an edit per sprout.
export interface RoutineChatopsSink { transport: "teams" | "discord"; channel?: string; user?: string; alias?: string }
/** `chatopsOnlyOnProblems`: the chatops sinks post only when a run isn't `ok` (failed /
 * needs-attention); note, notify and run history still get every run. Absent = every run.
 * `chatopsVerbatim`: chat sinks get the full digest as-is instead of the short brief in the
 * persona's voice an ok run gets by default (routine-chat-brief.ts) — for sprouts where fidelity
 * beats brevity. Note, notify and the record never get the brief. */
/** `home`: each delivered run leaves one post (the chat brief) for the desktop's Home chat
 * (home-posts.ts); `ttlMinutes` = drop it if still unread that long after the run, absent = keep. */
/** A year: keeps `expires_at` a valid, sortable ISO date. */
export const HOME_TTL_MAX_MINUTES = 365 * 24 * 60;
export interface RoutineSinks {
  chatops?: RoutineChatopsSink[]; chatopsOnlyOnProblems?: boolean; chatopsVerbatim?: boolean; note?: boolean; notify?: boolean;
  home?: { ttlMinutes?: number };
}

/** A gated step ends its output with `VERDICT: PASS|FAIL`; FAIL either stops the run or jumps
 * to another step: forward = a branch, backward = a loop of at most `maxRounds` executions of
 * the gated step (default 3, cap 5). PASS follows `next`. */
export interface StepGate { onFail: "stop" | { goto: string; maxRounds?: number } }
export { DEFAULT_GATE_ROUNDS, MAX_GATE_ROUNDS } from "./routine-graph.js";

/** A step that ends its output with `ROUTE: <label>` picks the next step: the path whose `when`
 * is that label, else `otherwise`, else the run stops needs-attention. Each `goto`/`otherwise` is
 * a later step's id, "end", "quiet" (ends ok and delivers nothing — `RunRecord.quiet`) or "done"
 * (delivers, then ends the sprout — `RunRecord.done`).
 * Exclusive with `gate` and `next`. */
export interface StepRoute { paths: { when: string; goto: string }[]; otherwise?: string }

/** Graph fields shared by every step kind. `next`: a later step's id or "end"; absent = the
 * following step. `alongside`: starts at the same time as the step above — that step plus the run
 * of `alongside` steps below it is one parallel group (rules: `describeGroupErrors`). Routines
 * with none of these fields anywhere run exactly as before (legacy). */
interface StepEdges { gate?: StepGate; next?: string; route?: StepRoute; alongside?: true }

/** `id` is a stable handle other steps (gates, graph edges) can point at — unique within the
 * routine, `[a-z0-9-]`, assigned by the editor, never typed. Absent on legacy routines. */
export type RoutineStep = StepEdges & (
  /** `timeoutMinutes` overrides the default delegate step timeout (ROUTINE_STEP_TIMEOUT_MS)
   * for long unattended runs, e.g. implement + review loops. No panel field; set it in the JSON.
   * `cli` pins the coding-agent harness: unavailable = the step refuses before spawning (no
   * fallback); absent = today's inference from `model` + the Settings preference.
   * `continues`: an earlier delegate step's id — this step resumes the newest session of that
   * step's lane (same `cli` and `project` required; rules: `describeContinueErrors`). */
  | { kind: "delegate"; id?: string; skill?: string; project?: string; cli?: CliName; model?: string; effort?: string; timeoutMinutes?: number; instruction: string; continues?: string }
  | { kind: "chat"; id?: string; skill?: string; model?: string; effort?: never; instruction: string; continues?: never }
  /** A deterministic check: runs `command` in a shell (in `project`, else the run's scratch dir)
   * — no model, memories, or skill (the `never`s keep `step.skill`/`.model` readable on the
   * union; the validator rejects them). Exit 0 = PASS, non-zero = FAIL, timeout = step error. */
  | { kind: "command"; id?: string; command: string; project?: string; timeoutMinutes?: number; skill?: never; model?: never; effort?: never; cli?: never; continues?: never });

export type StepKind = RoutineStep["kind"];

/** True when any step has a gate, a `next` edge, a route, or `alongside` — the runner then walks the step graph. */
export const usesGates = (steps: RoutineStep[]): boolean =>
  steps.some((s) => s.gate !== undefined || s.next !== undefined || s.route !== undefined || s.alongside !== undefined);

export const STEP_ID_RE = /^[a-z0-9-]+$/;

/** Deterministic polled trigger — no model per check. `everyMinutes` defaults to 15. `window`
 * limits scheduled polls to a local time of day; it's not part of the source key (no re-seed). */
export type RoutineWatch =
  | { kind: "feed"; url: string; everyMinutes?: number; window?: WatchWindow }
  | { kind: "command"; command: string; everyMinutes?: number; window?: WatchWindow };

export const DEFAULT_WATCH_MINUTES = 15;
export const watchEveryMinutes = (w: RoutineWatch): number => w.everyMinutes ?? DEFAULT_WATCH_MINUTES;

/** A saved routine definition (~/.bean/routines/<name>.json). Runtime state (last run,
 * history) lives separately in .state.json so definitions stay clean and shareable. */
export interface Routine {
  name: string;
  description?: string;
  enabled: boolean;
  /** 5-field cron, local time. Exactly one of `cron` / `watch` is set. */
  cron?: string;
  /** Poll a feed or command; each new item fires the routine. Steps `[]` = notify-only;
   * otherwise the routine must be todoDriven (each new item is queued as a todo). */
  watch?: RoutineWatch;
  /** true = the steps are a pipeline run once per queued todo; the scheduled run is
   * skipped entirely while the routine's queue has no pending items. */
  todoDriven?: boolean;
  /** Todo-driven only (ignored otherwise): how many queued todos may run at once (integer 1–4).
   * Absent = 1 — one run drains the queue in order. Above 1, each todo is its own run (bubble,
   * record, digest). The panel's "Run up to N at once" sets it and drops it with todo-driven. */
  maxParallel?: number;
  /** Opt-in: this routine's chat steps may search the public web. Off by default — report
   * routines don't need it and each search is billed. No panel toggle; set it in the JSON. */
  webSearch?: boolean;
  /** Display only: the registered project paths this sprout is listed under (usage-sections.ts)
   * — never a cwd, command, permission or recipient. Unknown paths are kept and ignored; `[]` is
   * stored as absent. Absent = derived from the steps' folders. */
  projects?: string[];
  /** When the sprout ends (#980): an ISO date (`YYYY-MM-DD` = the end of that core-local day) or
   * an ISO date-time. Past it, the scheduler posts "Nothing by <date>" once and pauses it; a route
   * to `done` sets it to the moment the goal was met. Paused and `ARCHIVE_GRACE_DAYS` past it =
   * archived (`isArchived`). Absent = runs until turned off. */
  until?: string;
  steps: RoutineStep[];
  sinks: RoutineSinks;
}

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `until` as epoch ms (a bare date = the end of that core-local day), or undefined when absent
 * or not a valid date. */
export function untilTime(until: string | undefined): number | undefined {
  if (until === undefined) return undefined;
  const d = DATE_ONLY_RE.exec(until);
  if (d) {
    const [y, m, day] = [Number(d[1]), Number(d[2]), Number(d[3])];
    const start = new Date(y, m - 1, day);
    // Rejects 2026-02-30 (rolls over into March).
    if (start.getFullYear() !== y || start.getMonth() !== m - 1 || start.getDate() !== day) return undefined;
    return new Date(y, m - 1, day + 1).getTime();
  }
  // A date-time: its calendar date must exist (Date.parse rolls 2026-02-30 into March).
  const dt = /^(\d{4})-(\d{2})-(\d{2})T/.exec(until);
  if (!dt) return undefined;
  const [y, m, day] = [Number(dt[1]), Number(dt[2]), Number(dt[3])];
  const probe = new Date(Date.UTC(y, m - 1, day));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== day) return undefined;
  const t = Date.parse(until);
  return Number.isFinite(t) ? t : undefined;
}

/** `until` as the owner would say it — "Dec 20, 2026" (a bare date is that day, not its end). */
export function untilLabel(until: string | undefined): string {
  const d = until === undefined ? null : DATE_ONLY_RE.exec(until);
  const t = d ? new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3])).getTime() : untilTime(until);
  return t === undefined ? String(until) : new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** How long an ended (paused, past `until`) sprout stays among live ones before it's archived.
 * The done message's "I'll file this away in a week" says this length. */
export const ARCHIVE_GRACE_DAYS = 7;
const GRACE_MS = ARCHIVE_GRACE_DAYS * 24 * 60 * 60_000;

/** Ended and past the grace: off every run/check/todo path and out of every catalog. Derived, not
 * stored — a later `until` (restore) makes it live again. */
export function isArchived(r: Pick<Routine, "enabled" | "until">, now: Date): boolean {
  const end = untilTime(r.until);
  return !r.enabled && end !== undefined && end + GRACE_MS < now.getTime();
}

/** Past its `until` (on = expired, off = ended): nothing new is admitted, claimed or handed off. */
export function hasEnded(r: Pick<Routine, "until">, now: Date): boolean {
  const end = untilTime(r.until);
  return end !== undefined && end <= now.getTime();
}

/** Still on but past its `until`: the scheduler's expiry ends it. */
export function isExpired(r: Pick<Routine, "enabled" | "until">, now: Date): boolean {
  const end = untilTime(r.until);
  return r.enabled && end !== undefined && end < now.getTime();
}

/** Why an ended sprout ended: found = a done run whose finish time is the current `until` (the done
 * ending stamps exactly that), so a sibling run recorded later, or a restore that later expired,
 * doesn't change the answer; else its `until` passed. Undefined = it hasn't ended (on, or paused
 * before its `until`). */
export function endReason(r: Pick<Routine, "enabled" | "until">, state: RoutineState | undefined, now: Date): "found" | "expired" | undefined {
  const end = untilTime(r.until);
  if (r.enabled || end === undefined || end > now.getTime()) return undefined;
  return state?.history.some((h) => h.done && h.finishedAt === r.until) ? "found" : "expired";
}

const dayLabel = (t: number): string => new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/** An ended sprout as the Sprouts panel lists it (#983), in core time so a remote shell sorts and
 * words it the same: archived → "Found Nov 28" / "Nothing by Dec 20"; still in the grace →
 * "Paused — found Nov 28 · archives Dec 5". Undefined = it hasn't ended. */
export function endedView(r: Pick<Routine, "enabled" | "until">, state: RoutineState | undefined, now: Date): { archived: boolean; text: string } | undefined {
  const reason = endReason(r, state, now);
  const end = untilTime(r.until);
  if (!reason || end === undefined) return undefined;
  // A bare date is that day, not its end (untilTime's midnight after).
  const d = DATE_ONLY_RE.exec(r.until!);
  const on = dayLabel(d ? new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3])).getTime() : end);
  const how = reason === "found" ? `found ${on}` : `nothing by ${on}`;
  if (isArchived(r, now)) return { archived: true, text: how[0]!.toUpperCase() + how.slice(1) };
  return { archived: false, text: `Paused — ${how} · archives ${dayLabel(end + GRACE_MS)}` };
}

export type RunStatus = "ok" | "failed" | "needs-attention";

export interface RunRecord {
  /** uuid; keys the run's `routine_step_attempts` rows. Absent on records written before #258. */
  id?: string;
  startedAt: string;  // ISO
  finishedAt: string; // ISO
  /** failed = a step errored; needs-attention = a gate stopped the run, a loop ran out of
   * rounds, or the run's last gate decision was FAIL. */
  status: RunStatus;
  digest: string;
  /** `chose`: a route step's picked label — set only on route steps, so the Dashboard can mark the
   * decision without mistaking a free-text `VERDICT:` line for one. */
  steps: { kind: StepKind; id?: string; cli?: CliName; round?: number; verdict?: string; chose?: string; ok: boolean; summary: string }[];
  /** A route chose "quiet" (on every todo of a drain): the run is recorded but no sink gets it.
   * The deciding step's one-line reason. */
  quiet?: string;
  /** A route reached `done` (#980): the goal was met, so the sprout ended after delivering this run. */
  done?: true;
}

export interface RoutineState {
  lastRun?: string; // ISO of the last started run (schedule base)
  missed?: boolean; // a scheduled fire time passed while Bean was closed
  history: RunRecord[]; // newest first, capped
  lastPoll?: string;  // ISO of the last watch poll attempt (ok or failed)
  pollError?: string; // last poll's error; absent when the last poll succeeded
}

const HISTORY_CAP = 20;
export const MAX_PARALLEL = 4;
const badName = /[/\\]|\.\.|^$/;
const str = (v: unknown): v is string => typeof v === "string";

function describeStepError(v: unknown, index: number, cliModels?: CliModels[]): string | null {
  const at = `step ${index + 1}`;
  if (typeof v !== "object" || v === null) return `${at} is malformed`;
  const s = v as Record<string, unknown>;
  if (s.id !== undefined && (!str(s.id) || !STEP_ID_RE.test(s.id))) return `${at} has an invalid id (use a-z, 0-9, "-")`;
  if (s.timeoutMinutes !== undefined && (!Number.isInteger(s.timeoutMinutes) || (s.timeoutMinutes as number) < 1)) {
    return `${at} timeout must be a whole number of minutes, at least 1`;
  }
  if (s.continues !== undefined) {
    if (s.kind !== "delegate") return `${at}: only a delegate step can continue another step's session`;
    if (!str(s.continues) || !STEP_ID_RE.test(s.continues)) return `${at} has an invalid continues id (use a-z, 0-9, "-")`;
  }
  if (s.kind === "command") {
    if (!str(s.command) || !s.command.trim()) return `${at} (command) needs a command to run`;
    for (const k of ["skill", "model", "effort", "cli", "instruction"]) {
      if (s[k] !== undefined) return `${at}: a command step runs no model — remove its ${k}`;
    }
    if (s.project !== undefined && !str(s.project)) return `${at} has an invalid project`;
    return null;
  }
  if (!str(s.instruction) || !s.instruction.trim()) return `${at} needs an instruction`;
  if (s.model !== undefined && !str(s.model)) return `${at} has an invalid model`;
  if (s.kind === "delegate") {
    if (s.cli !== undefined && !CLI_NAMES.includes(s.cli as CliName)) {
      return `${at} has an unknown coding agent ${JSON.stringify(s.cli)} (use ${CLI_NAMES.join(", ")})`;
    }
    if (s.effort !== undefined && (!str(s.effort) || !s.effort.trim())) return `${at} has an invalid effort`;
    // Only when the caller hands us clis.json: loading must never drop a routine because this
    // Mac's model list changed — the run refuses with a clear error instead.
    if (cliModels && s.cli !== undefined) {
      const cli = s.cli as CliName;
      if (str(s.model) && !cliOffersModel(cliModels, cli, s.model)) {
        return `${at}: ${cli} doesn't offer model "${s.model}"`;
      }
      if (str(s.model) && str(s.effort) && !cliOffersEffort(cliModels, cli, s.model, s.effort)) {
        return `${at}: ${cli} doesn't offer effort "${s.effort}" on model "${s.model}"`;
      }
    }
    // Optional: a skill-less delegate step runs on its instruction alone. "No skill" omits the key.
    if (s.skill !== undefined && (!str(s.skill) || !s.skill)) return `${at} has an invalid skill`;
    if (s.project !== undefined && !str(s.project)) return `${at} has an invalid project`;
    return null;
  }
  if (s.kind === "chat") {
    if (s.skill !== undefined && !str(s.skill)) return `${at} has an invalid skill`;
    if (s.cli !== undefined) return `${at}: chat steps run on Bean's own model — a coding agent only applies to delegate steps`;
    if (s.effort !== undefined) return `${at}: chat steps run on Bean's own model — effort only applies to delegate steps`;
    return null;
  }
  return `${at} has an unknown kind`;
}

function describeWatchError(v: unknown): string | null {
  if (typeof v !== "object" || v === null) return "watch must be an object";
  const w = v as Record<string, unknown>;
  if (w.everyMinutes !== undefined && (!Number.isInteger(w.everyMinutes) || (w.everyMinutes as number) < 1)) {
    return "watch interval must be a whole number of minutes, at least 1";
  }
  if (w.window !== undefined) {
    const windowError = describeWatchWindowError(w.window);
    if (windowError) return windowError;
  }
  if (w.kind === "feed") {
    if (!str(w.url) || !/^https?:\/\//i.test(w.url.trim())) return "the watched feed needs an http(s) URL";
    return null;
  }
  if (w.kind === "command") {
    if (!str(w.command) || !w.command.trim()) return "the watch needs a command to run";
    return null;
  }
  return 'watch kind must be "feed" or "command"';
}

/** Validates a routine and describes the first problem found, or null if valid. Used both to
 * decide validity (isValidRoutine) and to give the save-time error a specific, actionable
 * reason instead of a bare "invalid routine". */
export function describeRoutineError(v: unknown, cliModels?: CliModels[]): string | null {
  if (typeof v !== "object" || v === null) return "sprout must be an object";
  const r = v as Record<string, unknown>;
  if (!str(r.name) || !r.name) return "sprout needs a name";
  if (badName.test(r.name)) return `sprout name ${JSON.stringify(r.name)} can't contain "/", "\\", or ".."`;
  if (r.description !== undefined && !str(r.description)) return "description must be text";
  if (typeof r.enabled !== "boolean") return "enabled must be true or false";
  if (r.cron !== undefined && r.watch !== undefined) return "a sprout runs on a schedule or a watch, not both";
  if (r.watch !== undefined) {
    const watchError = describeWatchError(r.watch);
    if (watchError) return watchError;
  } else {
    if (!str(r.cron)) return "cron schedule is required";
    if (!isValidCron(r.cron)) return `cron schedule ${JSON.stringify(r.cron)} is not a valid 5-field cron expression`;
  }
  if (r.todoDriven !== undefined && typeof r.todoDriven !== "boolean") return "todoDriven must be true or false";
  if (r.webSearch !== undefined && typeof r.webSearch !== "boolean") return "webSearch must be true or false";
  if (r.projects !== undefined && (!Array.isArray(r.projects) || r.projects.some((p) => !str(p) || !p))) {
    return "projects must be a list of folder paths";
  }
  // Ignored (not rejected) on a plain sprout: the panel's type toggle keeps the field, and a
  // switch back to plain must still save.
  if (r.maxParallel !== undefined && (typeof r.maxParallel !== "number" || !Number.isInteger(r.maxParallel) || r.maxParallel < 1 || r.maxParallel > MAX_PARALLEL)) {
    return `maxParallel must be a whole number from 1 to ${MAX_PARALLEL}`;
  }
  if (r.until !== undefined && (!str(r.until) || untilTime(r.until) === undefined)) {
    return "until must be a date (YYYY-MM-DD) or an ISO date-time";
  }
  if (!Array.isArray(r.steps)) return "steps must be a list";
  if (r.steps.length === 0 && r.watch === undefined) return "add at least one step";
  if (r.watch !== undefined && r.steps.length > 0 && r.todoDriven !== true) {
    return "a watch sprout with steps must be todo-driven — each new item is queued as a todo";
  }
  const ids = new Map<string, number>();
  for (let i = 0; i < r.steps.length; i++) {
    const stepError = describeStepError(r.steps[i], i, cliModels);
    if (stepError) return stepError;
    const id = (r.steps[i] as { id?: string }).id;
    if (id !== undefined) {
      if (ids.has(id)) return `step ${i + 1} reuses id "${id}" — step ids must be unique`;
      ids.set(id, i);
    }
  }
  const groupErrors = describeGroupErrors(r.steps as Record<string, unknown>[], ids);
  const continueErrors = describeContinueErrors(r.steps as Record<string, unknown>[], ids);
  for (let i = 0; i < r.steps.length; i++) {
    const edgeError = describeEdgeError(r.steps[i] as Record<string, unknown>, i, ids) ?? groupErrors[i] ?? continueErrors[i];
    if (edgeError) return edgeError;
  }
  if (typeof r.sinks !== "object" || r.sinks === null) return "sinks must be an object";
  const sinks = r.sinks as Record<string, unknown>;
  if (sinks.note !== undefined && typeof sinks.note !== "boolean") return "the note sink must be true or false";
  if (sinks.notify !== undefined && typeof sinks.notify !== "boolean") return "the notify sink must be true or false";
  if (sinks.chatopsOnlyOnProblems !== undefined && typeof sinks.chatopsOnlyOnProblems !== "boolean") return "chatopsOnlyOnProblems must be true or false";
  if (sinks.chatopsVerbatim !== undefined && typeof sinks.chatopsVerbatim !== "boolean") return "chatopsVerbatim must be true or false";
  if (sinks.home !== undefined) {
    if (typeof sinks.home !== "object" || sinks.home === null || Array.isArray(sinks.home)) return "the home sink must be an object";
    const ttl = (sinks.home as Record<string, unknown>).ttlMinutes;
    if (ttl !== undefined && (!Number.isInteger(ttl) || (ttl as number) < 1 || (ttl as number) > HOME_TTL_MAX_MINUTES)) {
      return `the home sink's ttlMinutes must be a whole number of minutes, 1 to ${HOME_TTL_MAX_MINUTES}`;
    }
  }
  if (sinks.chatops !== undefined) {
    if (!Array.isArray(sinks.chatops)) return "the chatops sink must be a list";
    for (let i = 0; i < sinks.chatops.length; i++) {
      const cs = sinks.chatops[i] as Record<string, unknown> | null;
      const at = `chatops sink ${i + 1}`;
      if (typeof cs !== "object" || cs === null) return `${at} is malformed`;
      if (cs.transport !== "teams" && cs.transport !== "discord") return `${at} needs transport "teams" or "discord"`;
      if (cs.channel !== undefined && !str(cs.channel)) return `${at} has an invalid channel`;
      if (cs.alias !== undefined) {
        if (!str(cs.alias) || !cs.alias.trim()) return `${at} has an invalid destination name`;
        if (cs.channel !== undefined || cs.user !== undefined) return `${at} can't have a destination name and a channel or user`;
      }
      if (cs.user !== undefined) {
        if (!str(cs.user) || !cs.user.trim()) return `${at} has an invalid user`;
        if (cs.channel !== undefined) return `${at} can't have both a channel and a user`;
        if (cs.transport !== "discord") return `${at}: user is Discord-only`;
      }
    }
  }
  return null;
}

export function isValidRoutine(v: unknown): v is Routine {
  return describeRoutineError(v) === null;
}

/** A routine the owner drafts in chat (#285): the store's validator, plus what chat may not
 * create — command steps/watches (same trust as hand-edited shell), delivery on any transport but
 * the drafting surface's own (#320) — and DMs only to `recipients`
 * (the owner and household members), never an arbitrary user id the model wrote. A channel sink
 * may only be `channelId`, the server channel it was drafted in: any other id could be a DM
 * channel, which would bypass the recipient check. The desktop (#982) is the owner's own machine:
 * its chat sinks may DM the owner on either surface or name a known destination, never an id. */
export function chatRoutineProblem(
  v: unknown, transport: RoutineChatopsSink["transport"] | "desktop", recipients: { id: string }[],
  cliModels?: CliModels[], channelId?: string, destinations: readonly Destination[] = [],
): string | null {
  const error = describeRoutineError(v, cliModels);
  if (error) return error;
  const r = v as Routine;
  // Lowercase-only so a draft can't hit `.state.json` or case-collide with another routine
  // on a case-insensitive volume (#319). Desktop and hand-edited names keep the looser rule.
  if (!/^[a-z0-9][a-z0-9-]*$/.test(r.name)) {
    return `sprout name ${JSON.stringify(r.name)} must be lowercase letters, digits, and dashes (starting with a letter or digit)`;
  }
  if (r.steps.some((s) => s.kind === "command") || r.watch?.kind === "command") {
    return "command steps and command watches can't be set up from chat — add them on the desktop";
  }
  for (const sink of r.sinks.chatops ?? []) {
    // A named destination is checked as the conversation it names.
    const resolved = sink.alias === undefined ? undefined : resolveSinkAlias(sink, destinations);
    if (resolved && "error" in resolved) return resolved.error;
    if (transport === "desktop") {
      if (sink.alias === undefined && (sink.user !== undefined || sink.channel !== undefined)) {
        return "sprouts from this chat post to your main chat or DM you — pick other chat destinations in the sprout's editor";
      }
      continue;
    }
    const s = resolved ? { transport: sink.transport, channel: resolved.channel } as RoutineChatopsSink : sink;
    if (s.transport !== transport) return `only ${transport === "discord" ? "Discord" : "Teams"} delivery can be set up from this chat`;
    if (s.user !== undefined && !recipients.some((p) => p.id === s.user)) {
      return `user ${s.user} isn't the owner or a member — sprouts only DM the owner and members`;
    }
    if (s.channel !== undefined && s.channel !== channelId) {
      return "sprouts from chat can only post in the channel they're drafted in — set other channels on the desktop";
    }
  }
  return null;
}

/** True when a step routes to the `done` ending — a commitment that stops once it finds its answer. */
export function routesToDone(r: Pick<Routine, "steps">): boolean {
  // Defensive about shape: withDefaultUntil runs it on a raw draft, before validation.
  const ids = new Set(r.steps.flatMap((s) => (typeof s.id === "string" ? [s.id] : [])));
  return r.steps.some((s) => typeof s.route === "object" && s.route !== null && Array.isArray(s.route.paths)
    && [...s.route.paths.map((p) => (p as { goto?: unknown } | null)?.goto), s.route.otherwise].some((g) => isDoneEnd(g, ids)));
}

/** How long a chat-drafted commitment watches when the owner names no end (#982). */
export const COMMITMENT_DAYS = 30;

/** A chat draft with its default end: a commitment (it routes to `done`) with no `until` ends
 * COMMITMENT_DAYS after `now` (core-local date); anything else comes back as it was. */
export function withDefaultUntil(v: unknown, now: Date): unknown {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return v;
  const r = v as Record<string, unknown>;
  if (r.until !== undefined || !Array.isArray(r.steps) || r.steps.some((s) => typeof s !== "object" || s === null)) return v;
  if (!routesToDone(r as unknown as Routine)) return v;
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + COMMITMENT_DAYS);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return { ...r, until: `${end.getFullYear()}-${pad(end.getMonth() + 1)}-${pad(end.getDate())}` };
}

/** "Dec 20, 2026, or sooner if found" — when a draft stops; undefined = it runs until turned off. */
export function stopsLabel(r: Pick<Routine, "until" | "steps">): string | undefined {
  if (r.until === undefined) return undefined;
  return `${untilLabel(r.until)}${routesToDone(r) ? ", or sooner if found" : ""}`;
}

/** At most this many archived names ride the propose_routine text (the most recently ended). */
const LISTED_ARCHIVED = 10;

/** The names a propose_routine draft sees (#982): `existing` = every name (a draft reusing any
 * replaces it), `live` + the most recently `archived` = what the tool text lists. Each list is
 * sorted by code point so the tool spec stays byte-stable until the set itself changes. */
export function draftNames(routines: Routine[], now: Date): { existing: string[]; live: string[]; archived: string[] } {
  const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const archived = routines.filter((r) => isArchived(r, now))
    .sort((a, b) => (untilTime(b.until) ?? 0) - (untilTime(a.until) ?? 0) || byName(a.name, b.name))
    .slice(0, LISTED_ARCHIVED).map((r) => r.name);
  return {
    existing: routines.map((r) => r.name).sort(byName),
    live: routines.filter((r) => !isArchived(r, now)).map((r) => r.name).sort(byName),
    archived: archived.sort(byName),
  };
}

const SURFACE = { discord: "Discord", teams: "Teams" } as const;

/** A chat sink's alias → the conversation it names now, or why it can't be delivered. Never a
 * fallback: an unresolved alias posts nowhere (not to the owner's DM). */
export function resolveSinkAlias(
  sink: RoutineChatopsSink, destinations: readonly Destination[],
): { channel: string } | { error: string } {
  const row = destinations.find((d) => d.alias === sink.alias);
  if (!row) return { error: `chat destination "${sink.alias}" isn't known — pick it again in the sprout's editor` };
  if (row.surface !== sink.transport) {
    return { error: `chat destination "${sink.alias}" is a ${SURFACE[row.surface]} conversation, but this sink posts to ${SURFACE[sink.transport]}` };
  }
  return { channel: row.conversationId };
}

/** Every alias sink of `routine` that can't be delivered, as user-facing lines. */
export function sinkAliasProblems(routine: Routine, destinations: readonly Destination[]): string[] {
  return (routine.sinks.chatops ?? []).flatMap((s) => {
    if (s.alias === undefined) return [];
    const r = resolveSinkAlias(s, destinations);
    return "error" in r ? [r.error] : [];
  });
}

/** A step that runs a CLI or shell with the todo text as its input — owner-only (#283). */
const privilegedStep = (r: Routine): RoutineStep | undefined =>
  r.steps.find((s) => s.kind === "delegate" || s.kind === "command");

/** Whether a non-owner's todo may run on `r`: todo-driven with no delegate or command steps.
 * Checked at catalog, confirm, and again at drain against the routine's current definition. */
/** How many of the routine's todos may run at once — 1 unless it's todo-driven with maxParallel. */
export const parallelSlots = (r: Routine): number => (r.todoDriven ? r.maxParallel ?? 1 : 1);

export const memberTodoEligible = (r: Routine): boolean => r.todoDriven === true && !privilegedStep(r);

export const MEMBER_TODO_REFUSAL = "runs delegate or command steps — only the owner can queue on it";

/** Resolves `name` to a todo-driven routine in `routines`, or throws with the same
 * error messages every todo-queueing caller (app IPC, Teams, Discord) needs. `member` = a
 * non-owner is queueing, so the routine must also be `memberTodoEligible`. */
export function resolveTodoRoutine(routines: Routine[], name: string, member = false, now = new Date()): Routine {
  const target = routines.find((r) => r.name === name);
  // Archived reads as gone: its queue is closed for good until it's restored.
  if (!target || isArchived(target, now)) throw new Error(`no sprout named "${name}"`);
  if (!target.todoDriven) throw new Error(`sprout "${name}" is not todo-driven`);
  if (member && !memberTodoEligible(target)) throw new Error(`sprout "${name}" ${MEMBER_TODO_REFUSAL}`);
  return target;
}

/** The queued receipt's "when": the next cron fire (process-local time, i.e. `TZ`), the next
 * scheduler tick (a watch routine drains its queue whenever it has work), or a note that it's off. */
export function todoRunHint(r: Routine, now: Date): string {
  if (!r.enabled) return "The sprout is off — it runs once the owner turns it on.";
  if (r.cron) {
    let next: Date;
    try { next = nextRun(r.cron, now); } catch { return ""; } // e.g. Feb 29: no fire within a year
    const at = next.toLocaleString("en-US", {
      month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
    });
    return `It runs next at ${at}.`;
  }
  return r.watch ? "It runs within a minute or so." : "";
}

/** No channel, user or destination name: the owner's DM on that surface. */
export const isOwnerDmSink = (c: RoutineChatopsSink): boolean => c.channel === undefined && c.user === undefined && c.alias === undefined;

/** Owner-DM chat sinks fold into Home (#1068): the phone copy is the per-bot `homeDiscordDm` /
 * `homeTeamsDm` setting now. Other chat sinks, TTL and flags are kept (`chatopsOnlyOnProblems` mutes
 * the phone leg, `chatopsVerbatim` its display); idempotent. */
export function foldOwnerDmSinks(s: RoutineSinks): RoutineSinks {
  const chatops = s.chatops?.filter((c) => !isOwnerDmSink(c));
  if (!chatops || chatops.length === s.chatops?.length) return s;
  const { chatops: _, ...rest } = s;
  return { ...rest, ...(chatops.length > 0 ? { chatops } : {}), home: s.home ?? {} };
}

/** `projects: []` is stored as absent; owner-DM sinks become Home (persisted on the next save). */
function normalizeRoutine(r: Routine): Routine {
  const sinks = foldOwnerDmSinks(r.sinks);
  const out = sinks === r.sinks ? r : { ...r, sinks };
  if (out.projects?.length !== 0) return out;
  const { projects: _, ...rest } = out;
  return rest;
}

/** The surfaces whose owner DM any routine file still names, read raw (before load folds them).
 * Sync, so a caller reads the files before a scheduler tick can re-save one already folded. */
export function ownerDmSinkTransports(dir: string): RoutineChatopsSink["transport"][] {
  const found = new Set<RoutineChatopsSink["transport"]>();
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return []; }
  for (const file of entries.filter((f) => f.endsWith(".json") && !f.startsWith("."))) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(dir, file), "utf8"));
      if (!isValidRoutine(parsed)) continue;
      for (const c of parsed.sinks.chatops ?? []) if (isOwnerDmSink(c)) found.add(c.transport);
    } catch {
      // unreadable/invalid file — skipped, as loadRoutines does
    }
  }
  return [...found].sort();
}

/** `strict`: a routines dir that exists but can't be read throws instead of reading as "no
 * sprouts" (for callers that must tell unknown from empty). A missing dir is `[]` either way. */
export async function loadRoutines(dir: string, strict = false): Promise<Routine[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if (strict && (err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return [];
  }
  const routines: Routine[] = [];
  for (const file of entries.filter((f) => f.endsWith(".json") && !f.startsWith(".")).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))) {
    try {
      const parsed: unknown = JSON.parse(await readFile(join(dir, file), "utf8"));
      if (isValidRoutine(parsed)) routines.push(normalizeRoutine(parsed));
    } catch {
      // unreadable/invalid file — skip, same policy as skills/projects loaders
    }
  }
  return routines;
}

/** `cliModels` (clis.json) additionally checks each pinned `cli` offers its `model` — pass it
 * from user-facing saves; internal state flips (enable/seed) skip it. */
/** Temp file + rename, so a crash (or a container kill) mid-write never leaves a torn file. The
 * temp name ends in `.tmp`, not `.json`: loadRoutines and the outbox sweep must not pick it up. */
async function writeAtomic(file: string, body: string): Promise<void> {
  const tmp = `${file}.${randomUUID()}.tmp`; // unique: overlapping saves of one file never share a temp
  await writeFile(tmp, body, "utf8");
  await rename(tmp, file);
}

export async function saveRoutine(dir: string, routine: Routine, cliModels?: CliModels[]): Promise<void> {
  const error = describeRoutineError(routine as unknown, cliModels);
  if (error) throw new Error(error);
  await mkdir(dir, { recursive: true });
  await writeAtomic(join(dir, `${routine.name}.json`), JSON.stringify(normalizeRoutine(routine), null, 2) + "\n");
}

/** Create-only save (non-owner drafts, #322): validated like saveRoutine, but `link` refuses an
 * existing file, so a draft can never replace a routine — even one created mid-save. Throws
 * an `EEXIST` error on a clash. */
export async function createRoutine(dir: string, routine: Routine, cliModels?: CliModels[]): Promise<void> {
  const error = describeRoutineError(routine as unknown, cliModels);
  if (error) throw new Error(error);
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${routine.name}.json`);
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(normalizeRoutine(routine), null, 2) + "\n", "utf8");
  try {
    await link(tmp, file);
  } finally {
    await rm(tmp, { force: true });
  }
}

export async function deleteRoutine(dir: string, name: string): Promise<void> {
  if (badName.test(name)) throw new Error(`invalid sprout name: ${name}`);
  await rm(join(dir, `${name}.json`), { force: true });
}

export async function loadRoutineStates(file: string): Promise<Record<string, RoutineState>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, RoutineState> = {};
    for (const [name, s] of Object.entries(parsed as Record<string, unknown>)) {
      const st = s as Partial<RoutineState> | null;
      if (typeof st !== "object" || st === null) continue;
      out[name] = {
        lastRun: str(st.lastRun) ? st.lastRun : undefined,
        missed: st.missed === true ? true : undefined,
        history: Array.isArray(st.history) ? (st.history as RunRecord[]) : [],
        lastPoll: str(st.lastPoll) ? st.lastPoll : undefined,
        pollError: str(st.pollError) ? st.pollError : undefined,
      };
    }
    return out;
  } catch {
    return {};
  }
}

export async function saveRoutineStates(file: string, states: Record<string, RoutineState>): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeAtomic(file, JSON.stringify(states, null, 2) + "\n");
}

/** Newest-first history, capped; a completed run clears any missed flag. lastRun never moves
 * back: parallel todo runs finish out of start order. */
export function appendRunRecord(state: RoutineState | undefined, record: RunRecord): RoutineState {
  return {
    ...state,
    lastRun: state?.lastRun && state.lastRun > record.startedAt ? state.lastRun : record.startedAt,
    missed: false,
    history: [record, ...(state?.history ?? [])].slice(0, HISTORY_CAP),
  };
}
