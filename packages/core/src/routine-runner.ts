// packages/core/src/routine-runner.ts
import type { ActionTool, ConverseDeps, ConvoMsg, ToolCall } from "./converse.js";
import type { Routine, RoutineStep, RunRecord } from "./routine-store.js";
import type { Skill } from "./types.js";

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
}

export interface StepResult { index: number; kind: "delegate" | "chat"; ok: boolean; output: string }
export interface RoutineRunResult { record: RunRecord; digest: string; results: StepResult[] }

export const ROUTINE_STEP_TIMEOUT_MS = 15 * 60_000;
const MAX_TOOL_ROUNDS = 5;
const PRIOR_OUTPUT_CAP = 4000; // chars per prior step folded into later prompts

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
              "Lead with a one-line overall status, then a short section per step. Call out any FAILED " +
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

/** Executes a routine's steps sequentially (continue-on-failure), then composes the digest.
 * Pure and DI'd: no filesystem, no Electron, no clock beyond deps.now. */
export async function runRoutine(routine: Routine, deps: RoutineRunnerDeps): Promise<RoutineRunResult> {
  const now = deps.now ?? (() => new Date());
  const timeoutMs = deps.stepTimeoutMs ?? ROUTINE_STEP_TIMEOUT_MS;
  const startedAt = now().toISOString();
  const results: StepResult[] = [];

  for (const [index, step] of routine.steps.entries()) {
    const prior = priorOutputsBlock(results);
    try {
      const output = step.kind === "delegate"
        ? await deps.delegate({
            skill: deps.findSkill(step.skill),
            projectPath: step.project,
            instruction: step.instruction,
            model: step.model,
            priorOutputs: prior,
          })
        : await withTimeout(runChatStep(routine, step, index, prior, deps), timeoutMs, `step ${index + 1}`);
      results.push({ index, kind: step.kind, ok: true, output });
    } catch (err) {
      results.push({ index, kind: step.kind, ok: false, output: err instanceof Error ? err.message : String(err) });
    }
  }

  const digest = await composeDigest(routine, results, deps, timeoutMs);
  const record: RunRecord = {
    startedAt,
    finishedAt: now().toISOString(),
    status: results.every((r) => r.ok) ? "ok" : "failed",
    digest,
    steps: results.map((r) => ({ kind: r.kind, ok: r.ok, summary: r.output.slice(0, 200) })),
  };
  return { record, digest, results };
}
