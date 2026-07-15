// packages/core/src/routine-runner.ts
import type { ActionTool, ConverseDeps, ConvoMsg, ToolCall } from "./converse.js";
import type { Routine, RoutineStep, RunRecord } from "./routine-store.js";
import type { Skill } from "./types.js";
import type { TodoItem, TodoStatus } from "./todo-store.js";

export interface DelegateStepRequest {
  skill?: Skill;
  projectPath?: string; // undefined = no-project scratch run (caller supplies the scratch dir)
  instruction: string;
  model?: string;
  priorOutputs: string;
}

export interface RoutineRunnerDeps {
  chat: ConverseDeps["chat"];
  model: string;
  /** Runs a delegate step to completion; rejects on failure/cancel/timeout (timeout owned by the impl). */
  delegate: (req: DelegateStepRequest) => Promise<string>;
  /** Act-now tool pool for chat steps. Routine runs are pre-authorized: no propose_* tools here. */
  tools: ActionTool[];
  findSkill: (name: string) => Skill | undefined;
  now?: () => Date;
  stepTimeoutMs?: number;
  /** Injected by the app for todo-driven routines: core never touches the DB itself. */
  todos?: {
    listPending: (routine: string) => Promise<TodoItem[]>;
    setStatus: (id: string, status: TodoStatus, resultSummary?: string) => Promise<void>;
  };
}

export interface StepResult { index: number; kind: "delegate" | "chat"; ok: boolean; output: string }
export interface RoutineRunResult { record: RunRecord; digest: string; results: StepResult[] }

export const ROUTINE_STEP_TIMEOUT_MS = 15 * 60_000;
const MAX_TOOL_ROUNDS = 5;
const PRIOR_OUTPUT_CAP = 4000; // chars per prior step folded into later prompts
const SUMMARY_CAP = 200;

function priorOutputsBlock(results: StepResult[]): string {
  if (results.length === 0) return "";
  return results
    .map((r) => `--- step ${r.index + 1} (${r.kind}, ${r.ok ? "ok" : "FAILED"}) ---\n${r.output.slice(0, PRIOR_OUTPUT_CAP)}`)
    .join("\n\n");
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 60_000)} minutes`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e: unknown) => { clearTimeout(t); reject(e as Error); });
  });
}

async function runChatStep(
  routine: Routine,
  step: Extract<RoutineStep, { kind: "chat" }>,
  index: number,
  prior: string,
  deps: RoutineRunnerDeps,
): Promise<string> {
  const skill = step.skill ? deps.findSkill(step.skill) : undefined;
  const systemParts = [
    `You are Bean executing step ${index + 1} of the scheduled routine "${routine.name}" unattended. ` +
      "There is no user present: never ask questions, never wait for confirmation. Use the tools you are " +
      "given directly when the task calls for them, then reply with a concise plain-text report of what " +
      "you did and found — that report becomes this step's output for later steps and the final digest.",
    ...(skill ? [`Skill instructions:\n${skill.body}`] : []),
    ...(prior ? [`Output of the routine's earlier steps:\n${prior}`] : []),
    `Current date and time: ${(deps.now ?? (() => new Date()))().toString()}`,
  ];
  const messages: ConvoMsg[] = [
    { role: "system", content: systemParts.join("\n\n") },
    { role: "user", content: step.instruction },
  ];
  const tools = deps.tools.map((t) => t.spec);
  const byName = new Map(deps.tools.map((t) => [t.spec.name, t]));
  let content = "";
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const res = await deps.chat({ model: step.model ?? deps.model, messages, tools });
    content = res.content;
    const actionCalls = res.toolCalls.filter((c: ToolCall) => byName.has(c.name));
    if (actionCalls.length === 0) return content;
    messages.push({ role: "assistant", content: res.content, toolCalls: actionCalls });
    for (const call of actionCalls) {
      const result = await byName.get(call.name)!.run(call.args);
      messages.push({ role: "tool", content: result, toolCallId: call.id ?? call.name });
    }
  }
  return content;
}

async function composeDigest(
  routine: Routine,
  results: StepResult[],
  deps: RoutineRunnerDeps,
  timeoutMs: number,
): Promise<string> {
  const fallback = `Routine "${routine.name}" finished.\n\n${priorOutputsBlock(results)}`;
  try {
    const res = await withTimeout(
      deps.chat({
        model: deps.model,
        messages: [
          {
            role: "system",
            content:
              `Compose one digest of this run of the routine "${routine.name}" for the user. ` +
              "Lead with a one-line overall status, then a short section per step. When step outputs are " +
              "prefixed with [todo: ...], group the sections by todo instead — one briefing per task. " +
              "Call out any FAILED " +
              "step explicitly with its error. Plain text/markdown, no preamble, no questions.",
          },
          { role: "user", content: priorOutputsBlock(results) },
        ],
        tools: [],
      }),
      timeoutMs,
      "digest",
    );
    return res.content.trim() || fallback;
  } catch {
    return fallback;
  }
}

/** Runs one pass of `routine.steps` sequentially, appending to `results` (also the
 * priorOutputs scope for later steps in this pass). `instructionSuffix` is folded into every
 * step's instruction ("" for plain routines; the todo block for todo runs); `labelPrefix` is
 * prepended to each step's recorded output. Returns true iff every step in this pass ok'd.
 * Asymmetry (deliberate): plain routines (`instructionSuffix === ""`) continue past a failed
 * step; a todo pipeline abandons the rest of that todo's steps on its first failure. */
async function runSteps(
  routine: Routine,
  deps: RoutineRunnerDeps,
  timeoutMs: number,
  results: StepResult[],
  instructionSuffix: string,
  labelPrefix: string,
): Promise<boolean> {
  let allOk = true;
  for (const [index, step] of routine.steps.entries()) {
    const prior = priorOutputsBlock(results);
    const effective = { ...step, instruction: step.instruction + instructionSuffix } as RoutineStep;
    try {
      const output = effective.kind === "delegate"
        ? await deps.delegate({
            skill: deps.findSkill(effective.skill),
            projectPath: effective.project,
            instruction: effective.instruction,
            model: effective.model,
            priorOutputs: prior,
          })
        : await withTimeout(runChatStep(routine, effective, index, prior, deps), timeoutMs, `step ${index + 1}`);
      results.push({ index, kind: step.kind, ok: true, output: labelPrefix + output });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ index, kind: step.kind, ok: false, output: labelPrefix + message });
      allOk = false;
      if (instructionSuffix) return false; // todo pipeline: a failed step abandons this todo
    }
  }
  return allOk;
}

/** Executes a routine's steps sequentially, then composes the digest. Pure and DI'd: no
 * filesystem, no Electron, no clock beyond deps.now. Plain routines (`routine.todoDriven`
 * unset, or set with no `deps.todos` injected) run the step pipeline once, continuing past a
 * failed step. Todo-driven routines drain `deps.todos.listPending`, running the whole step
 * pipeline once per pending todo (prior-outputs chaining scoped per-todo); a failed step
 * aborts that todo and moves to the next. An empty queue is a successful no-op. */
export async function runRoutine(routine: Routine, deps: RoutineRunnerDeps): Promise<RoutineRunResult> {
  const now = deps.now ?? (() => new Date());
  const timeoutMs = deps.stepTimeoutMs ?? ROUTINE_STEP_TIMEOUT_MS;
  const startedAt = now().toISOString();
  const results: StepResult[] = [];
  let allOk = true;

  if (routine.todoDriven && deps.todos) {
    const pending = await deps.todos.listPending(routine.name);
    if (pending.length === 0) {
      // Scheduler already skips empty queues; this is the race backstop (and covers runNow).
      const digest = `Routine "${routine.name}" finished.\n\nNo pending todos.`;
      return {
        record: { startedAt, finishedAt: now().toISOString(), status: "ok", digest, steps: [] },
        digest,
        results: [],
      };
    }
    for (const item of pending) {
      await deps.todos.setStatus(item.id, "running");
      const scoped: StepResult[] = []; // prior-outputs chain is per-todo, never cross-todo
      const labelPrefix = `[todo: ${item.text}] `;
      const ok = await runSteps(
        routine, deps, timeoutMs, scoped,
        `\n\nQueued task:\n${item.text}`,
        labelPrefix,
      );
      results.push(...scoped);
      const last = scoped[scoped.length - 1];
      // Strip the label prefix for the setStatus summary — it's redundant there since the
      // caller already knows which todo this is; `results`/the digest keep the labeled form.
      const rawOutput = last?.output.startsWith(labelPrefix) ? last.output.slice(labelPrefix.length) : last?.output ?? "";
      const summary = rawOutput.slice(0, SUMMARY_CAP);
      await deps.todos.setStatus(item.id, ok ? "done" : "failed", summary);
      if (!ok) allOk = false;
    }
  } else {
    allOk = await runSteps(routine, deps, timeoutMs, results, "", "");
  }

  const digest = await composeDigest(routine, results, deps, timeoutMs);
  const record: RunRecord = {
    startedAt,
    finishedAt: now().toISOString(),
    status: allOk ? "ok" : "failed",
    digest,
    steps: results.map((r) => ({ kind: r.kind, ok: r.ok, summary: r.output.slice(0, SUMMARY_CAP) })),
  };
  return { record, digest, results };
}
