// packages/core/src/routine-host.ts
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import type { ActionTool } from "./converse.js";
import type { CliName } from "./launcher.js";
import type { CommandStepOutcome } from "./command-step.js";
import type { Memory } from "./memory/memory.js";
import { DEFAULT_PERSONA, type Persona } from "./persona.js";
import { chatBriefInput, composeChatBrief, finalStepOutput } from "./routine-chat-brief.js";
import type { Skill } from "./types.js";
import { dbFile, outboxDir, routinesDir, routineStateFile } from "./config.js";
import { enqueueOutbox } from "./outbox.js";
import { saveNote } from "./note-store.js";
import { listSkillProposals, RETRO_SKILL, saveSkillProposals, withProposalFooter } from "./retro.js";
import { listStepAttempts, recordStepAttempt } from "./step-attempts.js";
import { claimTodo, listTodos, updateTodoStatus, type TodoItem, type TodoStatus } from "./todo-store.js";
import { DEFAULT_GATE_ROUNDS, loadRoutines, loadRoutineStates, resolveSinkAlias, sinkAliasProblems, usesGates, type Routine, type RoutineChatopsSink } from "./routine-store.js";
import { listDestinations } from "./destinations.js";
import { todoDispatchOrigins } from "./dispatch-store.js";
import { insertHomePost } from "./home-posts.js";
import type { RunOrigin } from "./routine-scheduler.js";
import { stepGroups } from "./routine-graph.js";
import {
  runRoutine,
  type CommandStepRequest, type DelegateStepRequest, type DelegateStepResult, type RoutineRunnerDeps, type RoutineRunResult,
} from "./routine-runner.js";

/** Gated routines and ones with a `continues` step: a todo's per-todo scratch dirs outlive each
 * step (so a resumed session keeps its workspace); the host removes them when the run ends. */
export interface RoutineHold { scratch: Set<string> }

/** Status bubble events — the desktop maps them onto its task-status registry. */
export type RoutineHostStatus =
  /** `name` is display text (a todo's text for a todo run); `routine` is the sprout's own name. */
  | { type: "start"; id: string; name: string; routine: string; detail: string; steps: string[]; startedAt: number }
  | { type: "step"; id: string; step: number; line: string }
  /** `startedAt` is the run record's — what the Dashboard keys a run by. Absent when nothing was
   * recorded (the run threw). */
  | { type: "finish"; id: string; state: "done" | "failed"; line: string; startedAt?: string; stopped?: true };

export interface RoutineHostDeps {
  /** ~/.bean — bean.db, outbox, routines and run records all derive from it. */
  dir: string;
  converse: RoutineRunnerDeps["chat"];
  /** Read per run, so a Settings change applies to the next run. */
  getModel: () => string;
  /** config.json's `briefModel` for the chat brief; absent/undefined = getModel(). */
  getBriefModel?: () => string | undefined;
  /** The persona the chat brief speaks in, loaded per delivery; absent = the default persona. */
  loadPersona?: () => Promise<Persona>;
  /** Spawns a delegate step. */
  delegateStep: (
    req: DelegateStepRequest,
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
  /** The scheduler lease: only its holder writes `sinks.home` posts. Absent = held. */
  holdsLease?: () => boolean;
}

export interface RoutineHost {
  /** `todo` (already claimed): run just that todo, as its own bubble/record/digest. `signal` =
   * the run's Stop (see RoutineRunnerDeps.signal). */
  runOneRoutine: (routine: Routine, todo?: TodoItem, signal?: AbortSignal) => Promise<RoutineRunResult>;
  /** Resolves with the chat sinks' body when `brief` is set (computed even with no chat sink). */
  deliverDigest: (routine: Routine, result: RoutineRunResult, brief?: boolean, origin?: RunOrigin) => Promise<string | undefined>;
  /** Alias sinks that can't be delivered right now (unknown name, wrong platform). */
  sinkProblems: (routine: Routine) => string[];
}

/** The glue between the scheduler and `runRoutine()` shared by every routine host (desktop
 * today): builds the runner deps, writes the proposal footer, and fans digests to sinks. */
/** A chat sink posts to the origin's conversation: same transport and resolved conversation id (a
 * thread and its parent channel differ). No channel on both = the owner's DM — except a Discord
 * sink with `user`, which DMs that user instead (Teams ignores `user`). */
export function sameChatTarget(origin: RunOrigin, t: { sink: RoutineChatopsSink; channel?: string | undefined }): boolean {
  if (origin.transport !== t.sink.transport || origin.channel !== t.channel) return false;
  return origin.channel !== undefined || t.sink.transport === "teams" || t.sink.user === undefined;
}

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

  const runOneRoutine = async (routine: Routine, todo?: TodoItem, signal?: AbortSignal): Promise<RoutineRunResult> => {
    const id = todo ? `routine:${routine.name}:${todo.id}` : `routine:${routine.name}`;
    const steps = routine.steps.map((st) => {
      const text = st.kind === "command" ? st.command : st.instruction;
      return st.skill || (text.length > 60 ? `${text.slice(0, 59)}…` : text);
    });
    deps.onStatus?.({ type: "start", id, name: todo?.text ?? routine.name, routine: routine.name, detail: todo ? `Sprout: ${routine.name}` : routine.description ?? "", steps, startedAt: Date.now() });
    let result: RoutineRunResult | undefined;
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
        delegate: (req) => deps.delegateStep(req, hold),
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
        ...(signal ? { signal } : {}),
      }, todo);
      // Before the scheduler saves the record and delivers it to sinks.
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
      // A Stop holds only this run: say what's still queued and how to hold it too.
      const queued = result?.stopped && routine.todoDriven
        ? (await listTodos(dbFile(dir), routine.name).catch(() => [])).filter((t) => t.status === "pending").length : 0;
      deps.onStatus?.({
        type: "finish", id, state: status === "ok" ? "done" : "failed",
        ...(result ? { startedAt: result.record.startedAt } : {}),
        ...(result?.stopped ? { stopped: true as const } : {}),
        line: !status ? "Run failed"
          : result?.stopped ? (queued ? `Stopped · ${queued} still queued — disable in Sprouts to hold` : "Stopped")
          : status === "failed" ? `Finished with a failed step${failedMembers(result!)}`
          : status === "needs-attention" ? "Needs attention — a gate stopped it"
          : `Done · ${steps.length} step${steps.length === 1 ? "" : "s"}`,
      });
    }
  };

  /** What chat sinks post: an ok run summed up as one short brief in the persona's voice,
   * conclusion first (one model call over every step's output, shared by every chat sink). Brief
   * skipped = the final step's output as it is; the sprout asks for it, or nothing to brief = the
   * full digest. Only the chat copy is rewritten: record, note and notification keep `result.digest`. */
  const chatSinkBody = async (routine: Routine, result: RoutineRunResult): Promise<string> => {
    // Failed / needs-attention runs keep their problem lines out of a model; a stepless run
    // ("No pending todos", a notify-only watch fire) has nothing to brief.
    if (routine.sinks.chatopsVerbatim === true || result.record.status !== "ok" || result.stopped || result.results.length === 0) {
      return result.digest;
    }
    let persona: Persona;
    try {
      persona = deps.loadPersona ? await deps.loadPersona() : DEFAULT_PERSONA;
    } catch {
      persona = DEFAULT_PERSONA;
    }
    const final = finalStepOutput(routine, result.results);
    const brief = await composeChatBrief({
      input: chatBriefInput(result.results), final, persona, chat: deps.converse, model: deps.getBriefModel?.() || deps.getModel(),
    });
    const body = brief ?? final;
    return body ? body + (result.footer ?? "") : result.digest;
  };

  /** `origin` = the chat conversation that triggered this run: it gets the result itself (#920),
   * so a chat sink resolving there is skipped. A drain covers many todos: then a conversation
   * counts only when every todo of the run was dispatched from it. */
  const deliverDigest = async (routine: Routine, result: RoutineRunResult, brief = false, origin?: RunOrigin): Promise<string | undefined> => {
    if (routine.sinks.note) {
      await saveNote(dbFile(dir), {
        title: `sprout: ${routine.name}`,
        body: result.digest,
        source: "manual",
        slug: `routine-${routine.name}`, // update-in-place: one living note per routine
      }, undefined, { upsert: true }); // the only upsert caller: the sink (re)creates its note
    }
    // A notify-only watch fire is always "ok", so the rule would mute it entirely — it doesn't apply there.
    const quiet = routine.sinks.chatopsOnlyOnProblems === true && result.record.status === "ok" && routine.steps.length > 0;
    const sinks = quiet ? [] : routine.sinks.chatops ?? [];
    // Read at enqueue, so a retarget in Settings applies to the next digest.
    const named = sinks.some((s) => s.alias !== undefined) ? listDestinations(dbFile(dir)) : [];
    const targets = sinks.flatMap((sink) => {
      if (sink.alias === undefined) return [{ sink, channel: sink.channel }];
      const resolved = resolveSinkAlias(sink, named);
      // Unresolved: sinkProblems already marked the run; never fall back to the owner's DM.
      return "error" in resolved ? [] : [{ sink, channel: resolved.channel }];
    });
    const asked = targets.length > 0 ? askedFrom(result, origin) : [];
    const kept = targets.filter((t) => !asked.some((o) => sameChatTarget(o, t)));
    const home = routine.sinks.home !== undefined && (deps.holdsLease?.() ?? true) ? routine.sinks.home : undefined;
    const chatBody = kept.length > 0 || brief || home ? await chatSinkBody(routine, result) : result.digest;
    if (home) {
      insertHomePost(dbFile(dir), {
        sprout: routine.name, body: chatBody, ...(home.ttlMinutes !== undefined ? { ttlMinutes: home.ttlMinutes } : {}),
      }, newId);
    }
    for (const { sink, channel } of kept) {
      await enqueueOutbox(outboxDir(dir), {
        transport: sink.transport, channel, userId: sink.user,
        title: `Sprout: ${routine.name}`,
        // A member DM says whose routine it is — they didn't set it up.
        body: sink.user ? `${chatBody}\n\n_Sent by Bean's owner's sprout "${routine.name}"._` : chatBody,
        context: deps.getRoutineDigestContext(),
      }, newId);
    }
    if (routine.sinks.notify && deps.notify) {
      await deps.notify({
        title: `Sprout: ${routine.name}`, body: result.digest,
        target: { routine: routine.name, startedAt: result.record.startedAt },
      });
    }
    return brief ? chatBody : undefined;
  };

  const askedFrom = (result: RoutineRunResult, origin: RunOrigin | undefined): RunOrigin[] => {
    if (!result.todoIds) return origin ? [origin] : [];
    try {
      return todoDispatchOrigins(dbFile(dir), result.todoIds);
    } catch (err) {
      console.error("bean: reading todo dispatch origins failed — every chat sink gets the digest", err);
      return [];
    }
  };

  const sinkProblems = (routine: Routine): string[] =>
    routine.sinks.chatops?.some((s) => s.alias !== undefined) ? sinkAliasProblems(routine, listDestinations(dbFile(dir))) : [];

  return { runOneRoutine, deliverDigest, sinkProblems };
}
