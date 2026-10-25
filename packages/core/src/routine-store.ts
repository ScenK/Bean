// packages/core/src/routine-store.ts
import { randomUUID } from "node:crypto";
import { link, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isValidCron, nextRun } from "./cron.js";
import { describeWatchWindowError, type WatchWindow } from "./watch-window.js";
import { CLI_NAMES, type CliName } from "./launcher.js";
import type { CliModels } from "./cli-models.js";
import { describeEdgeError, describeGroupErrors } from "./routine-graph.js";

// Absent/empty channel = DM the user directly (the default); a non-empty channel targets a
// specific discord channel id or teams conversation id instead.
// `user` (Discord only, exclusive with `channel`): DM that Discord user id instead of the owner.
export interface RoutineChatopsSink { transport: "teams" | "discord"; channel?: string; user?: string }
export interface RoutineSinks { chatops?: RoutineChatopsSink[]; note?: boolean; notify?: boolean }

/** A gated step ends its output with `VERDICT: PASS|FAIL`; FAIL either stops the run or jumps
 * to another step: forward = a branch, backward = a loop of at most `maxRounds` executions of
 * the gated step (default 3, cap 5). PASS follows `next`. */
export interface StepGate { onFail: "stop" | { goto: string; maxRounds?: number } }
export { DEFAULT_GATE_ROUNDS, MAX_GATE_ROUNDS } from "./routine-graph.js";

/** A step that ends its output with `ROUTE: <label>` picks the next step: the path whose `when`
 * is that label, else `otherwise`, else the run stops needs-attention. Each `goto`/`otherwise` is
 * a later step's id or "end". Exclusive with `gate` and `next`. */
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
   * fallback); absent = today's inference from `model` + the Settings preference. */
  | { kind: "delegate"; id?: string; skill: string; project?: string; cli?: CliName; model?: string; timeoutMinutes?: number; instruction: string }
  | { kind: "chat"; id?: string; skill?: string; model?: string; instruction: string }
  /** A deterministic check: runs `command` in a shell (in `project`, else the run's scratch dir)
   * — no model, memories, or skill (the `never`s keep `step.skill`/`.model` readable on the
   * union; the validator rejects them). Exit 0 = PASS, non-zero = FAIL, timeout = step error. */
  | { kind: "command"; id?: string; command: string; project?: string; timeoutMinutes?: number; skill?: never; model?: never; cli?: never });

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
  steps: RoutineStep[];
  sinks: RoutineSinks;
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
  if (s.kind === "command") {
    if (!str(s.command) || !s.command.trim()) return `${at} (command) needs a command to run`;
    for (const k of ["skill", "model", "cli", "instruction"]) {
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
    // Only when the caller hands us clis.json: loading must never drop a routine because this
    // Mac's model list changed — the run refuses with a clear error instead.
    const offered = s.cli !== undefined && cliModels?.find((c) => c.provider === s.cli)?.models;
    if (offered && str(s.model) && !offered.includes(s.model)) return `${at}: ${String(s.cli)} doesn't offer model "${s.model}"`;
    if (!str(s.skill) || !s.skill) return `${at} (delegate) needs a skill`;
    if (s.project !== undefined && !str(s.project)) return `${at} has an invalid project`;
    return null;
  }
  if (s.kind === "chat") {
    if (s.skill !== undefined && !str(s.skill)) return `${at} has an invalid skill`;
    if (s.cli !== undefined) return `${at}: chat steps run on Bean's own model — a coding agent only applies to delegate steps`;
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
  // Ignored (not rejected) on a plain sprout: the panel's type toggle keeps the field, and a
  // switch back to plain must still save.
  if (r.maxParallel !== undefined && (typeof r.maxParallel !== "number" || !Number.isInteger(r.maxParallel) || r.maxParallel < 1 || r.maxParallel > MAX_PARALLEL)) {
    return `maxParallel must be a whole number from 1 to ${MAX_PARALLEL}`;
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
  for (let i = 0; i < r.steps.length; i++) {
    const edgeError = describeEdgeError(r.steps[i] as Record<string, unknown>, i, ids) ?? groupErrors[i];
    if (edgeError) return edgeError;
  }
  if (typeof r.sinks !== "object" || r.sinks === null) return "sinks must be an object";
  const sinks = r.sinks as Record<string, unknown>;
  if (sinks.note !== undefined && typeof sinks.note !== "boolean") return "the note sink must be true or false";
  if (sinks.notify !== undefined && typeof sinks.notify !== "boolean") return "the notify sink must be true or false";
  if (sinks.chatops !== undefined) {
    if (!Array.isArray(sinks.chatops)) return "the chatops sink must be a list";
    for (let i = 0; i < sinks.chatops.length; i++) {
      const cs = sinks.chatops[i] as Record<string, unknown> | null;
      const at = `chatops sink ${i + 1}`;
      if (typeof cs !== "object" || cs === null) return `${at} is malformed`;
      if (cs.transport !== "teams" && cs.transport !== "discord") return `${at} needs transport "teams" or "discord"`;
      if (cs.channel !== undefined && !str(cs.channel)) return `${at} has an invalid channel`;
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
 * channel, which would bypass the recipient check. */
export function chatRoutineProblem(
  v: unknown, transport: RoutineChatopsSink["transport"], recipients: { id: string }[],
  cliModels?: CliModels[], channelId?: string,
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
  for (const s of r.sinks.chatops ?? []) {
    if (s.transport !== transport) return `only ${transport === "discord" ? "Discord" : "Teams"} delivery can be set up from this chat`;
    if (s.user !== undefined && !recipients.some((p) => p.id === s.user)) {
      return `user ${s.user} isn't the owner or a household member — sprouts only DM the household`;
    }
    if (s.channel !== undefined && s.channel !== channelId) {
      return "sprouts from chat can only post in the channel they're drafted in — set other channels on the desktop";
    }
  }
  return null;
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
export function resolveTodoRoutine(routines: Routine[], name: string, member = false): Routine {
  const target = routines.find((r) => r.name === name);
  if (!target) throw new Error(`no sprout named "${name}"`);
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

export async function loadRoutines(dir: string): Promise<Routine[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const routines: Routine[] = [];
  for (const file of entries.filter((f) => f.endsWith(".json") && !f.startsWith(".")).sort()) {
    try {
      const parsed: unknown = JSON.parse(await readFile(join(dir, file), "utf8"));
      if (isValidRoutine(parsed)) routines.push(parsed);
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
  await writeAtomic(join(dir, `${routine.name}.json`), JSON.stringify(routine, null, 2) + "\n");
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
  await writeFile(tmp, JSON.stringify(routine, null, 2) + "\n", "utf8");
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
