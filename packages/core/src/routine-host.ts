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
import { releaseRun } from "./run-queue.js";
import { listSkillProposals, RETRO_SKILL, saveSkillProposals, withProposalFooter } from "./retro.js";
import { listStepAttempts, recordStepAttempt } from "./step-attempts.js";
import { listTodos, updateTodoStatus, type TodoStatus } from "./todo-store.js";
import { DEFAULT_GATE_ROUNDS, loadRoutines, loadRoutineStates, usesGates, type Routine } from "./routine-store.js";
import { resumeCommand } from "./delegate-runs.js";
import {
  runRoutine, withResumeFooter,
  type CommandStepRequest, type DelegateStepRequest, type DelegateStepResult, type RoutineRunnerDeps, type RoutineRunResult, type StepInfo,
} from "./routine-runner.js";

/** Gated routines only: a todo's run reservations and per-todo scratch dirs outlive each step (so a
 * gate loop re-entering a step never hits RunBusyError against itself, and a resumed session keeps
 * its workspace); the host releases them when the run ends. */
export interface RoutineHold { reserved: Set<string>; scratch: Set<string> }

/** Status bubble events — the desktop maps them onto its task-status registry. */
export type RoutineHostStatus =
  | { type: "start"; id: string; name: string; detail: string; steps: string[]; startedAt: number }
  | { type: "step"; id: string; step: number; line: string }
  | { type: "finish"; id: string; state: "done" | "failed"; line: string };

export interface RoutineHostDeps {
  /** ~/.bean — bean.db, outbox, routines and run reservations all derive from it. */
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
  /** Desktop notification sink; absent = `sinks.notify` is skipped. */
  notify?: (msg: { title: string; body: string }) => Promise<void>;
  newId?: () => string;
}

export interface RoutineHost {
  runOneRoutine: (routine: Routine) => Promise<RoutineRunResult>;
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
      description: "Save a markdown note to the user's notes. Use only when the routine step's instruction asks for it.",
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

  const runOneRoutine = async (routine: Routine): Promise<RoutineRunResult> => {
    const skills = await deps.loadSkills();
    const id = `routine:${routine.name}`;
    const steps = routine.steps.map((st) => {
      const text = st.kind === "command" ? st.command : st.instruction;
      return st.skill || (text.length > 60 ? `${text.slice(0, 59)}…` : text);
    });
    deps.onStatus?.({ type: "start", id, name: routine.name, detail: routine.description ?? "", steps, startedAt: Date.now() });
    let result: RoutineRunResult | undefined;
    // Run-scoped, so concurrent routines never mix receipts. Bean writes the footer itself —
    // the model never sees or retypes an id.
    const receipts: string[] = [];
    let at: StepInfo = { index: 0 };
    const hold: RoutineHold | undefined = usesGates(routine.steps) ? { reserved: new Set(), scratch: new Set() } : undefined;
    try {
      result = await runRoutine(routine, {
        onStep: (info) => {
          at = info;
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
          const step = `step ${at.index + 1}${at.round && at.round > 1 ? ` round ${at.round}` : ""}`;
          return deps.delegateStep(req, (cli, sessionId, projectPath) => {
            receipts.push(`${step} (${req.projectPath ? basename(projectPath) : "workspace"}) — ${resumeCommand(cli, sessionId)}`);
          }, hold);
        },
        command: (req) => deps.commandStep(req, hold),
        tools: [...deps.tools, saveNoteTool],
        findSkill: (name) => skills.find((s) => s.name === name),
        memories: deps.memories,
        recordAttempt: (a) => recordStepAttempt(dbFile(dir), a),
        retro: {
          history: async (name) => {
            const analyzed = (await loadRoutines(routinesDir(dir))).find((r) => r.name === name);
            if (!analyzed) return undefined;
            const history = (await loadRoutineStates(routineStateFile(dir)))[name]?.history ?? [];
            return { routine: analyzed, runs: history.map((record) => ({ record, attempts: record.id ? listStepAttempts(dbFile(dir), record.id) : [] })) };
          },
          save: (proposals) => saveSkillProposals(dbFile(dir), proposals),
        },
        todos: {
          listPending: async (r) => (await listTodos(dbFile(dir), r)).filter((t) => t.status === "pending"),
          setStatus: (todoId, status: TodoStatus, resultSummary?: string) =>
            updateTodoStatus(dbFile(dir), todoId, status, resultSummary),
        },
      });
      // Before the scheduler saves the record and delivers it to sinks.
      result = withResumeFooter(result, receipts);
      if (routine.steps.some((st) => st.kind === "chat" && st.skill === RETRO_SKILL)) {
        result = withProposalFooter(result, listSkillProposals(dbFile(dir)).length);
      }
      return result;
    } finally {
      for (const p of hold?.reserved ?? []) releaseRun(dir, p);
      for (const p of hold?.scratch ?? []) rmSync(p, { recursive: true, force: true });
      const status = result?.record.status;
      deps.onStatus?.({
        type: "finish", id, state: status === "ok" ? "done" : "failed",
        line: !status ? "Run failed"
          : status === "failed" ? "Finished with a failed step"
          : status === "needs-attention" ? "Needs attention — a gate stopped it"
          : `Done · ${steps.length} step${steps.length === 1 ? "" : "s"}`,
      });
    }
  };

  const deliverDigest = async (routine: Routine, result: RoutineRunResult): Promise<void> => {
    if (routine.sinks.note) {
      await saveNote(dbFile(dir), {
        title: `routine: ${routine.name}`,
        body: result.digest,
        source: "manual",
        slug: `routine-${routine.name}`, // update-in-place: one living note per routine
      });
    }
    for (const sink of routine.sinks.chatops ?? []) {
      await enqueueOutbox(outboxDir(dir), {
        transport: sink.transport, channel: sink.channel,
        title: `Routine: ${routine.name}`, body: result.digest,
        context: deps.getRoutineDigestContext(),
      }, newId);
    }
    if (routine.sinks.notify && deps.notify) {
      await deps.notify({ title: `Routine: ${routine.name}`, body: result.digest });
    }
  };

  return { runOneRoutine, deliverDigest };
}
