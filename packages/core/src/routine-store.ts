// packages/core/src/routine-store.ts
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isValidCron } from "./cron.js";

// Absent/empty channel = DM the user directly (the default); a non-empty channel targets a
// specific discord channel id or teams conversation id instead.
export interface RoutineChatopsSink { transport: "teams" | "discord"; channel?: string }
export interface RoutineSinks { chatops?: RoutineChatopsSink[]; note?: boolean; notify?: boolean }

export type RoutineStep =
  | { kind: "delegate"; skill: string; project?: string; model?: string; instruction: string }
  | { kind: "chat"; skill?: string; model?: string; instruction: string };

/** A saved routine definition (~/.bean/routines/<name>.json). Runtime state (last run,
 * history) lives separately in .state.json so definitions stay clean and shareable. */
export interface Routine {
  name: string;
  description?: string;
  enabled: boolean;
  cron: string; // 5-field cron, local time
  /** true = the steps are a pipeline run once per queued todo; the scheduled run is
   * skipped entirely while the routine's queue has no pending items. */
  todoDriven?: boolean;
  steps: RoutineStep[];
  sinks: RoutineSinks;
}

export interface RunRecord {
  startedAt: string;  // ISO
  finishedAt: string; // ISO
  status: "ok" | "failed"; // failed = at least one step failed
  digest: string;
  steps: { kind: "delegate" | "chat"; ok: boolean; summary: string }[];
}

export interface RoutineState {
  lastRun?: string; // ISO of the last started run (schedule base)
  missed?: boolean; // a scheduled fire time passed while Bean was closed
  history: RunRecord[]; // newest first, capped
}

const HISTORY_CAP = 20;
const badName = /[/\\]|\.\.|^$/;
const str = (v: unknown): v is string => typeof v === "string";

function isValidStep(v: unknown): v is RoutineStep {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  if (!str(s.instruction) || !s.instruction.trim()) return false;
  if (s.model !== undefined && !str(s.model)) return false;
  if (s.kind === "delegate") {
    return str(s.skill) && (s.project === undefined || str(s.project));
  }
  if (s.kind === "chat") return s.skill === undefined || str(s.skill);
  return false;
}

export function isValidRoutine(v: unknown): v is Routine {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  if (!str(r.name) || badName.test(r.name)) return false;
  if (r.description !== undefined && !str(r.description)) return false;
  if (typeof r.enabled !== "boolean" || !str(r.cron) || !isValidCron(r.cron)) return false;
  if (r.todoDriven !== undefined && typeof r.todoDriven !== "boolean") return false;
  if (!Array.isArray(r.steps) || r.steps.length === 0 || !r.steps.every(isValidStep)) return false;
  if (typeof r.sinks !== "object" || r.sinks === null) return false;
  const sinks = r.sinks as Record<string, unknown>;
  if (sinks.note !== undefined && typeof sinks.note !== "boolean") return false;
  if (sinks.notify !== undefined && typeof sinks.notify !== "boolean") return false;
  if (sinks.chatops !== undefined) {
    if (!Array.isArray(sinks.chatops)) return false;
    for (const c of sinks.chatops as unknown[]) {
      const cs = c as Record<string, unknown> | null;
      if (typeof cs !== "object" || cs === null) return false;
      if (cs.transport !== "teams" && cs.transport !== "discord") return false;
      if (cs.channel !== undefined && !str(cs.channel)) return false;
    }
  }
  return true;
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

export async function saveRoutine(dir: string, routine: Routine): Promise<void> {
  if (!isValidRoutine(routine as unknown)) throw new Error(`invalid routine: ${JSON.stringify(routine.name)}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${routine.name}.json`), JSON.stringify(routine, null, 2) + "\n", "utf8");
}

export async function deleteRoutine(dir: string, name: string): Promise<void> {
  if (badName.test(name)) throw new Error(`invalid routine name: ${name}`);
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
      };
    }
    return out;
  } catch {
    return {};
  }
}

export async function saveRoutineStates(file: string, states: Record<string, RoutineState>): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(states, null, 2) + "\n", "utf8");
}

/** Newest-first history, capped; a completed run clears any missed flag. */
export function appendRunRecord(state: RoutineState | undefined, record: RunRecord): RoutineState {
  return {
    lastRun: record.startedAt,
    missed: false,
    history: [record, ...(state?.history ?? [])].slice(0, HISTORY_CAP),
  };
}
