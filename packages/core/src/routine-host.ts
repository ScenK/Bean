// packages/core/src/routine-host.ts
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { basename } from "node:path";
import type { ActionTool } from "./converse.js";
import type { CliName } from "./launcher.js";
import type { CommandStepOutcome } from "./command-step.js";
import type { Memory } from "./memory/memory.js";
import type { Skill } from "./types.js";
import { dbFile, outboxDir, routinesDir, routineStateFile } from "./config.js";
import { enqueueOutbox } from "./outbox.js";
import { saveNote } from "./note-store.js";
import { listSkillProposals, RETRO_SKILL, saveSkillProposals, withProposalFooter } from "./retro.js";
import { listStepAttempts, recordStepAttempt } from "./step-attempts.js";
import { claimTodo, updateTodoStatus, type TodoItem, type TodoStatus } from "./todo-store.js";
import { DEFAULT_GATE_ROUNDS, loadRoutines, loadRoutineStates, usesGates, type Routine } from "./routine-store.js";
import { resumeCommand } from "./delegate-runs.js";
import { stepGroups } from "./routine-graph.js";
import {
  runRoutine, withResumeFooter,
  type CommandStepRequest, type DelegateStepRequest, type DelegateStepResult, type RoutineRunnerDeps, type RoutineRunResult,
} from "./routine-runner.js";

/** Gated routines and ones with a `continues` step: a todo's per-todo scratch dirs outlive each
 * step (so a resumed session keeps its workspace); the host removes them when the run ends. */
export interface RoutineHold { scratch: Set<string> }

/** Status bubble events — the desktop maps them onto its task-status registry. */
export type RoutineHostStatus =
  | { type: "start"; id: string; name: string; detail: string; steps: string[]; startedAt: number }
  | { type: "step"; id: string; step: number; line: string }
  /** `startedAt` is the run record's — what the Dashboard keys a run by. Absent when nothing was
   * recorded (the run threw). */
  | { type: "finish"; id: string; state: "done" | "failed"; line: string; startedAt?: string };

export interface RoutineHostDeps {
  /** ~/.bean — bean.db, outbox, routines and run records all derive from it. */
  dir: string;
  converse: RoutineRunnerDeps["chat"];
  /** Read per run, so a Settings change applies to the next run. */
  getModel: () => string;
  /** Spawns a delegate step. `onSession` gets the started CLI session for the resume footer. */
  delegateStep: (
    req: DelegateStepRequest,
    onSession?: (cli: CliName, sessionId: string, projectPath: string) => void,
    hold?: RoutineHold,
  ) => Promise<DelegateStepResult>;
  commandStep: (req: CommandStepRequest, hold?: RoutineHold) => Promise<CommandStepOutcome>;
  /** Act-now tools for chat steps; the host appends the routine-only `save_note`. */
  tools: ActionTool[];
  /** Loaded fresh per run. */
  loadSkills: () => Promise<Skill[]>;
  /** The recall set chat/delegate steps may draw on — the host decides. */
  memories: () => Promise<Memory[]>;
  /** Read live per digest: the Settings toggle applies to the next run without restarting bots. */
  getRoutineDigestContext: () => boolean;
  onStatus?: (e: RoutineHostStatus) => void;
  /** Desktop notification sink; absent = `sinks.notify` is skipped. `target` names the run, so a
   * click can open it (other hosts ignore it). */
  notify?: (msg: { title: string; body: string; target?: { routine: string; startedAt: string } }) => Promise<void>;
  newId?: () => string;
}

/** One delegate session of a run: every step (in order) that ran in it. */
export interface SessionReceipt { steps: { index: number; round: number }[]; project: string; cli: CliName; sessionId: string }

/** One footer line per session: `step 3 (kubernetes) — <resume command>`, or
 * `steps 2→4→6 (…)` when later steps continued it — a gate loop's rounds in one session too. */
export function formatReceipts(receipts: SessionReceipt[]): string[] {
  return receipts.map(({ steps, project, cli, sessionId }) => {
    const nums = [...new Set(steps.map((s) => s.index + 1))];
    const first = steps[0];
    const label = nums.length > 1 ? `steps ${nums.join("→")}`
      : `step ${nums[0]}${first && first.round > 1 ? ` round ${first.round}` : ""}`;
    return `${label} (${project}) — ${resumeCommand(cli, sessionId)}`;
  });
}

export interface RoutineHost {
  /** `todo` (already claimed): run just that todo, as its own bubble/record/digest. */
  runOneRoutine: (routine: Routine, todo?: TodoItem) => Promise<RoutineRunResult>;
  deliverDigest: (routine: Routine, result: RoutineRunResult) => Promise<void>;
}

/** The glue between the scheduler and `runRoutine()` shared by every routine host (desktop
 * today): builds the runner deps, writes the resume/proposal footers, and fans digests to sinks. */
export function createRoutineHost(deps: RoutineHostDeps): RoutineHost {
  const { dir } = deps;
  const newId = deps.newId ?? randomUUID;

  // Act-now note saving for routine chat steps (chat's propose_note stays confirm-first; this is the
  // pre-authorized routine counterpart — the user consented by writing the step). Deliberately not
  // in the host's shared tool pool: that also backs interactive chat, which must stay confirm-first.
  const saveNoteTool: ActionTool = {
    spec: {
      name: "save_note",
      description: "Save a markdown note to the user's notes. Use only when the sprout step's instruction asks for it.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "short note title" },
          body: { type: "string", description: "markdown body" },
        },
        required: ["title", "body"],
      },
    },
    run: async (args) => {
      const { title, body } = (args ?? {}) as { title?: unknown; body?: unknown };
      if (typeof title !== "string" || typeof body !== "string") return "error: save_note needs { title, body }";
      const slug = await saveNote(dbFile(dir), { title, body, source: "manual" });
      return `note saved as ${slug}`;
    },
  };

  const runOneRoutine = async (routine: Routine, todo?: TodoItem): Promise<RoutineRunResult> => {
    const id = todo ? `routine:${routine.name}:${todo.id}` : `routine:${routine.name}`;
    const steps = routine.steps.map((st) => {
      const text = st.kind === "command" ? st.command : st.instruction;
      return st.skill || (text.length > 60 ? `${text.slice(0, 59)}…` : text);
    });
    deps.onStatus?.({ type: "start", id, name: todo?.text ?? routine.name, detail: todo ? `Sprout: ${routine.name}` : routine.description ?? "", steps, startedAt: Date.now() });
    let result: RoutineRunResult | undefined;
    // Run-scoped, so concurrent routines never mix receipts. Bean writes the footer itself —
    // the model never sees or retypes an id.
    const receipts: SessionReceipt[] = [];
    const groups = stepGroups(routine.steps);
    const groupOf = (i: number) => groups.find((g) => i >= g.first && i <= g.last);
    // The running parallel group's bubble: one line for all members, counting down as each lands.
    // `⫴ lint · test · review (1 of 3 left) · round 2`.
    let live: { first: number; last: number; round?: number; left: number } | undefined;
    const showGroup = (g: NonNullable<typeof live>): void => {
      const size = g.last - g.first + 1;
      const tags = [`⫴ ${steps.slice(g.first, g.last + 1).join(" · ")} (${g.left} of ${size} left)`, ...(g.round && g.round > 1 ? [`round ${g.round}`] : [])];
      deps.onStatus?.({ type: "step", id, step: g.first, line: tags.join(" · ") });
    };
    /** ` — test, review failed`: group members whose latest attempt failed ("" when none). */
    const failedMembers = (r: RoutineRunResult): string => {
      const okAt = new Map(r.results.map((x) => [x.index, x.ok])); // the latest attempt wins
      const names = [...okAt].filter(([i, ok]) => !ok && groupOf(i)).map(([i]) => steps[i] || `step ${i + 1}`);
      return names.length ? ` — ${names.join(", ")} failed` : "";
    };
    // A continued session must find its workspace where the earlier step left it.
    const hold: RoutineHold | undefined = usesGates(routine.steps) || routine.steps.some((st) => st.continues !== undefined)
      ? { scratch: new Set() } : undefined;
    const setStatus = (todoId: string, status: TodoStatus, resultSummary?: string): Promise<void> =>
      updateTodoStatus(dbFile(dir), todoId, status, resultSummary);
    try {
      // Inside the try: a claimed todo must end done/failed even when the skills can't load.
      const skills = await deps.loadSkills();
      result = await runRoutine(routine, {
        onStep: (info) => {
          const g = groupOf(info.index);
          if (g) {
            // Every member reports its start; the first one draws the group's line.
            if (info.index !== g.first) return;
            live = { ...g, ...(info.round ? { round: info.round } : {}), left: g.last - g.first + 1 };
            showGroup(live);
            return;
          }
          live = undefined;
          // A looping gate shows its cap: `review · round 2/3 · codex`.
          const onFail = routine.steps[info.index]?.gate?.onFail;
          const loopTarget = typeof onFail === "object" ? routine.steps.findIndex((s) => s.id === onFail.goto) : -1;
          const cap = typeof onFail === "object" && loopTarget >= 0 && loopTarget < info.index ? `/${onFail.maxRounds ?? DEFAULT_GATE_ROUNDS}` : "";
          const tags = [steps[info.index] ?? "", ...(info.round && info.round > 1 ? [`round ${info.round}${cap}`] : []), ...(info.cli ? [info.cli] : [])];
          deps.onStatus?.({ type: "step", id, step: info.index, line: tags.filter(Boolean).join(" · ") });
        },
        chat: deps.converse,
        model: deps.getModel(),
        delegate: (req) => {
          // From the request: a group's members run at once, so the last onStep isn't this step.
          const step = { index: req.stepIndex ?? 0, round: req.round ?? 1 };
          return deps.delegateStep(req, (cli, sessionId, projectPath) => {
            // A resumed session reports the same id: one receipt per session, listing its steps.
            const same = receipts.find((r) => r.cli === cli && r.sessionId === sessionId);
            if (same) same.steps.push(step);
            else receipts.push({ steps: [step], project: req.projectPath ? basename(projectPath) : "workspace", cli, sessionId });
          }, hold);
        },
        command: (req) => deps.commandStep(req, hold),
        tools: [...deps.tools, saveNoteTool],
        findSkill: (name) => skills.find((s) => s.name === name),
        memories: deps.memories,
        recordAttempt: (a) => {
          recordStepAttempt(dbFile(dir), a);
          if (live && a.stepIndex >= live.first && a.stepIndex <= live.last) { live.left--; showGroup(live); }
        },
        retro: {
          history: async (name) => {
            const analyzed = (await loadRoutines(routinesDir(dir))).find((r) => r.name === name);
            if (!analyzed) return undefined;
            const history = (await loadRoutineStates(routineStateFile(dir)))[name]?.history ?? [];
            return { routine: analyzed, runs: history.map((record) => ({ record, attempts: record.id ? listStepAttempts(dbFile(dir), record.id) : [] })) };
          },
          save: (proposals) => saveSkillProposals(dbFile(dir), proposals),
        },
        todos: { claim: (r) => claimTodo(dbFile(dir), r), setStatus },
      }, todo);
      // Before the scheduler saves the record and delivers it to sinks.
      result = withResumeFooter(result, formatReceipts(receipts));
      if (routine.steps.some((st) => st.kind === "chat" && st.skill === RETRO_SKILL)) {
        result = withProposalFooter(result, listSkillProposals(dbFile(dir)).length);
      }
      return result;
    } catch (err) {
      if (todo && !result) {
        await setStatus(todo.id, "failed", (err instanceof Error ? err.message : String(err)).slice(0, 200)).catch(() => {});
      }
      throw err;
    } finally {
      for (const p of hold?.scratch ?? []) rmSync(p, { recursive: true, force: true });
      const status = result?.record.status;
      deps.onStatus?.({
        type: "finish", id, state: status === "ok" ? "done" : "failed",
        ...(result ? { startedAt: result.record.startedAt } : {}),
        line: !status ? "Run failed"
          : status === "failed" ? `Finished with a failed step${failedMembers(result!)}`
          : status === "needs-attention" ? "Needs attention — a gate stopped it"
          : `Done · ${steps.length} step${steps.length === 1 ? "" : "s"}`,
      });
    }
  };

  const deliverDigest = async (routine: Routine, result: RoutineRunResult): Promise<void> => {
    if (routine.sinks.note) {
      await saveNote(dbFile(dir), {
        title: `sprout: ${routine.name}`,
        body: result.digest,
        source: "manual",
        slug: `routine-${routine.name}`, // update-in-place: one living note per routine
      }, undefined, { upsert: true }); // the only upsert caller: the sink (re)creates its note
    }
    for (const sink of routine.sinks.chatops ?? []) {
      await enqueueOutbox(outboxDir(dir), {
        transport: sink.transport, channel: sink.channel, userId: sink.user,
        title: `Sprout: ${routine.name}`,
        // A member DM says whose routine it is — they didn't set it up.
        body: sink.user ? `${result.digest}\n\n_Sent by Bean's owner's sprout "${routine.name}"._` : result.digest,
        context: deps.getRoutineDigestContext(),
      }, newId);
    }
    if (routine.sinks.notify && deps.notify) {
      await deps.notify({
        title: `Sprout: ${routine.name}`, body: result.digest,
        target: { routine: routine.name, startedAt: result.record.startedAt },
      });
    }
  };

  return { runOneRoutine, deliverDigest };
}
