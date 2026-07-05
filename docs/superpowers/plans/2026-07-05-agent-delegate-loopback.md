# Agent Delegate Loopback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Bean delegate a task to a headless external agent (`claude -p` / `opencode run`), track it as an async cancellable task with a live tail, and feed the result back into the chat so Bean's model can summarize and chain.

**Architecture:** New parallel subsystem beside the untouched fire-and-forget launcher: a pure DI'd `delegate.ts` in `@bean/core` (command mapping, stream parsing, spawn/collect/cancel), a confirm-first `propose_delegate` tool in `converse()`, a task registry in `@bean/app` pushing lifecycle events over a new `bean:delegate-event` channel, and a `DelegateCard` chat component whose `done` event loops the result back through `window.bean.chat`.

**Tech Stack:** TypeScript ESM, vitest, Electron IPC, preact renderer. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-05-agent-delegate-loopback-design.md`

## Global Constraints

- Both packages are ESM with `verbatimModuleSyntax`: use `.js` extensions in relative imports and `import type` for type-only imports.
- `strict` + `noUncheckedIndexedAccess` are on: array access is `T | undefined`.
- `@bean/core` stays Electron-free and dependency-injected (`.memory/convention-core-is-electron-free.md`).
- IPC channel names only in `packages/app/src/channels.ts` (`.memory/convention-ipc-channels.md`).
- `launcher.ts` and the Terminal-launch path are NOT modified.
- Never use `--dangerously-skip-permissions`; the claude allowlist is exactly `Bash,Edit,Write,Read,Glob,Grep`.
- Validation gate before claiming done: `pnpm test && pnpm typecheck` both exit 0 (run from repo root).
- Single-package test runs: `pnpm --filter @bean/core exec vitest run __test__/delegate.test.ts` (same shape for `@bean/app`).
- Work on branch `feat/agent-delegate-loopback` (already created).

---

### Task 1: Core delegate command mapping + claude stream parsing (pure functions)

**Files:**
- Create: `packages/core/src/delegate.ts`
- Create: `packages/core/__test__/delegate.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `CliName` from `packages/core/src/launcher.ts` (`"opencode" | "claude"`).
- Produces: `DelegateRequest { cli: CliName; projectPath: string; prompt: string }`, `delegateCommand(req): { command: string; args: string[] }`, `claudeTailLine(event: unknown): string | undefined`, `claudeResult(event: unknown): string | undefined`. Task 2 adds `runDelegate` to this same file.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/__test__/delegate.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { delegateCommand, claudeTailLine, claudeResult } from "../src/delegate.js";

describe("delegateCommand", () => {
  it("maps claude to headless -p with stream-json and the explicit tool allowlist", () => {
    const { command, args } = delegateCommand({ cli: "claude", projectPath: "/p", prompt: "fix the bug" });
    expect(command).toBe("claude");
    expect(args).toEqual([
      "-p", "fix the bug",
      "--output-format", "stream-json",
      "--verbose",
      "--allowedTools", "Bash,Edit,Write,Read,Glob,Grep",
    ]);
  });

  it("maps opencode to headless run", () => {
    const { command, args } = delegateCommand({ cli: "opencode", projectPath: "/p", prompt: "fix the bug" });
    expect(command).toBe("opencode");
    expect(args).toEqual(["run", "fix the bug"]);
  });
});

describe("claudeTailLine", () => {
  it("turns assistant text blocks into a tail line", () => {
    const event = { type: "assistant", message: { content: [{ type: "text", text: "Looking at router.ts" }] } };
    expect(claudeTailLine(event)).toBe("Looking at router.ts");
  });

  it("turns tool_use blocks into a ▸-prefixed tail line", () => {
    const event = { type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: {} }] } };
    expect(claudeTailLine(event)).toBe("▸ Edit");
  });

  it("joins mixed blocks with a separator", () => {
    const event = {
      type: "assistant",
      message: { content: [{ type: "text", text: "Fixing" }, { type: "tool_use", name: "Bash", input: {} }] },
    };
    expect(claudeTailLine(event)).toBe("Fixing · ▸ Bash");
  });

  it("returns undefined for non-assistant events and empty content", () => {
    expect(claudeTailLine({ type: "system", subtype: "init" })).toBeUndefined();
    expect(claudeTailLine({ type: "assistant", message: { content: [] } })).toBeUndefined();
    expect(claudeTailLine("not an object")).toBeUndefined();
  });
});

describe("claudeResult", () => {
  it("extracts the final result string from a result event", () => {
    expect(claudeResult({ type: "result", subtype: "success", result: "All tests pass." })).toBe("All tests pass.");
  });

  it("returns undefined for anything else", () => {
    expect(claudeResult({ type: "assistant", message: { content: [] } })).toBeUndefined();
    expect(claudeResult({ type: "result", result: 42 })).toBeUndefined();
    expect(claudeResult(null)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @bean/core exec vitest run __test__/delegate.test.ts`
Expected: FAIL — cannot resolve `../src/delegate.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/delegate.ts`:

```typescript
import type { CliName } from "./launcher.js";

export interface DelegateRequest {
  cli: CliName;
  projectPath: string;
  prompt: string;
}

// Headless one-shot delegation, unlike launcher.ts's interactive TUI launches. claude gets
// stream-json so Bean can show a live tail and read a machine-parseable final `result`
// event; write access comes from an explicit tool allowlist — never
// --dangerously-skip-permissions. opencode run prints plain text; the whole stdout is
// both tail and result.
export function delegateCommand(req: DelegateRequest): { command: string; args: string[] } {
  if (req.cli === "claude") {
    return {
      command: "claude",
      args: [
        "-p", req.prompt,
        "--output-format", "stream-json",
        "--verbose",
        "--allowedTools", "Bash,Edit,Write,Read,Glob,Grep",
      ],
    };
  }
  return { command: "opencode", args: ["run", req.prompt] };
}

// One parsed stream-json event → a short human-readable tail line, or undefined to skip.
export function claudeTailLine(event: unknown): string | undefined {
  const e = event as { type?: unknown; message?: { content?: unknown } } | null;
  if (e?.type !== "assistant" || !Array.isArray(e.message?.content)) return undefined;
  const parts: string[] = [];
  for (const block of e.message.content as { type?: unknown; text?: unknown; name?: unknown }[]) {
    if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) parts.push(block.text.trim());
    else if (block?.type === "tool_use" && typeof block.name === "string") parts.push(`▸ ${block.name}`);
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

// The final `result` event carries the agent's answer as one string.
export function claudeResult(event: unknown): string | undefined {
  const e = event as { type?: unknown; result?: unknown } | null;
  return e?.type === "result" && typeof e.result === "string" ? e.result : undefined;
}
```

Add to `packages/core/src/index.ts` after the `launcher.js` line:

```typescript
export * from "./delegate.js";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @bean/core exec vitest run __test__/delegate.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/delegate.ts packages/core/src/index.ts packages/core/__test__/delegate.test.ts
git commit -m "feat(core): delegate command mapping and claude stream-json parsing"
```

---

### Task 2: Core `runDelegate` — spawn, stream, collect, cancel, timeout

**Files:**
- Modify: `packages/core/src/delegate.ts`
- Modify: `packages/core/__test__/delegate.test.ts`

**Interfaces:**
- Consumes: `delegateCommand`, `claudeTailLine`, `claudeResult` from Task 1.
- Produces (used by Task 5's registry):
  - `DelegateCallbacks { onOutput(line: string): void; onDone(result: string): void; onError(err: Error): void }`
  - `DelegateHandle { cancel(): void }` — cancel kills the process tree and settles **silently** (no callback fires; the caller who cancelled emits its own "cancelled" state).
  - `DelegateSpawnFn = (command: string, args: string[], cwd: string) => ChildProcess`
  - `runDelegate(req: DelegateRequest, callbacks: DelegateCallbacks, spawnFn?: DelegateSpawnFn, timeoutMs?: number): DelegateHandle`
  - `DELEGATE_TIMEOUT_MS = 30 * 60_000`

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/__test__/delegate.test.ts` (add `vi`, `afterEach` to the vitest import, plus the new imports):

```typescript
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { runDelegate, DELEGATE_TIMEOUT_MS, type DelegateCallbacks } from "../src/delegate.js";

// pid deliberately undefined so cancel/timeout fall through to child.kill() — a fake pid
// would make runDelegate call process.kill(-pid) against a real process group.
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid: number | undefined = undefined;
  killed = false;
  kill(): boolean {
    this.killed = true;
    return true;
  }
}
const asChild = (c: FakeChild): ChildProcess => c as unknown as ChildProcess;

function collect(): { cbs: DelegateCallbacks; outputs: string[]; dones: string[]; errors: string[] } {
  const outputs: string[] = [];
  const dones: string[] = [];
  const errors: string[] = [];
  return {
    outputs, dones, errors,
    cbs: {
      onOutput: (l) => outputs.push(l),
      onDone: (r) => dones.push(r),
      onError: (e) => errors.push(e.message),
    },
  };
}

describe("runDelegate", () => {
  afterEach(() => vi.useRealTimers());

  it("spawns in the project directory", () => {
    const child = new FakeChild();
    const seen: { command: string; args: string[]; cwd: string }[] = [];
    runDelegate(
      { cli: "opencode", projectPath: "/my/project", prompt: "go" },
      collect().cbs,
      (command, args, cwd) => { seen.push({ command, args, cwd }); return asChild(child); },
    );
    expect(seen).toEqual([{ command: "opencode", args: ["run", "go"], cwd: "/my/project" }]);
  });

  it("claude: streams tail lines and resolves onDone with the result event", () => {
    const child = new FakeChild();
    const { cbs, outputs, dones } = collect();
    runDelegate({ cli: "claude", projectPath: "/p", prompt: "go" }, cbs, () => asChild(child));
    child.stdout.emit("data", Buffer.from(
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit" }] } }) + "\n" +
      JSON.stringify({ type: "result", subtype: "success", result: "Fixed it." }) + "\n",
    ));
    child.emit("close", 0);
    expect(outputs).toEqual(["▸ Edit"]);
    expect(dones).toEqual(["Fixed it."]);
  });

  it("claude: falls back to accumulated raw output when no result event arrives", () => {
    const child = new FakeChild();
    const { cbs, dones } = collect();
    runDelegate({ cli: "claude", projectPath: "/p", prompt: "go" }, cbs, () => asChild(child));
    child.stdout.emit("data", Buffer.from("not json at all\n"));
    child.emit("close", 0);
    expect(dones).toEqual(["not json at all"]);
  });

  it("claude: passes unparsable lines through as raw tail output", () => {
    const child = new FakeChild();
    const { cbs, outputs } = collect();
    runDelegate({ cli: "claude", projectPath: "/p", prompt: "go" }, cbs, () => asChild(child));
    child.stdout.emit("data", Buffer.from("warning: something\n"));
    expect(outputs).toEqual(["warning: something"]);
  });

  it("opencode: every line is tail and the whole stdout is the result, including a trailing partial line", () => {
    const child = new FakeChild();
    const { cbs, outputs, dones } = collect();
    runDelegate({ cli: "opencode", projectPath: "/p", prompt: "go" }, cbs, () => asChild(child));
    child.stdout.emit("data", Buffer.from("line one\nline "));
    child.stdout.emit("data", Buffer.from("two"));
    child.emit("close", 0);
    expect(outputs).toEqual(["line one", "line two"]);
    expect(dones).toEqual(["line one\nline two"]);
  });

  it("reports a non-zero exit as onError with the stderr tail", () => {
    const child = new FakeChild();
    const { cbs, errors, dones } = collect();
    runDelegate({ cli: "opencode", projectPath: "/p", prompt: "go" }, cbs, () => asChild(child));
    child.stderr.emit("data", Buffer.from("boom: no api key\n"));
    child.emit("close", 1);
    expect(dones).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("code 1");
    expect(errors[0]).toContain("boom: no api key");
  });

  it("reports a spawn error (ENOENT) as onError", () => {
    const child = new FakeChild();
    const { cbs, errors } = collect();
    runDelegate({ cli: "claude", projectPath: "/p", prompt: "go" }, cbs, () => asChild(child));
    child.emit("error", new Error("spawn claude ENOENT"));
    expect(errors).toEqual(["spawn claude ENOENT"]);
  });

  it("cancel kills the child and settles silently — later close fires no callback", () => {
    const child = new FakeChild();
    const { cbs, outputs, dones, errors } = collect();
    const handle = runDelegate({ cli: "opencode", projectPath: "/p", prompt: "go" }, cbs, () => asChild(child));
    handle.cancel();
    expect(child.killed).toBe(true);
    child.emit("close", 143);
    expect(outputs).toEqual([]);
    expect(dones).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("times out after timeoutMs, killing the child and reporting onError", () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const { cbs, errors } = collect();
    runDelegate({ cli: "claude", projectPath: "/p", prompt: "go" }, cbs, () => asChild(child), 60_000);
    vi.advanceTimersByTime(60_000);
    expect(child.killed).toBe(true);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("timed out");
  });

  it("exports a 30-minute default timeout", () => {
    expect(DELEGATE_TIMEOUT_MS).toBe(30 * 60_000);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @bean/core exec vitest run __test__/delegate.test.ts`
Expected: FAIL — `runDelegate` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `packages/core/src/delegate.ts` (and extend the imports at the top of the file):

```typescript
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
```

```typescript
export interface DelegateCallbacks {
  onOutput: (line: string) => void;
  onDone: (result: string) => void;
  onError: (err: Error) => void;
}
export interface DelegateHandle {
  /** Kill the delegate's whole process tree. Settles silently — no callback fires;
   * the canceller emits its own "cancelled" state. */
  cancel: () => void;
}
export type DelegateSpawnFn = (command: string, args: string[], cwd: string) => ChildProcess;
// detached: the CLI gets its own process group so cancel can kill its child shells too.
const defaultDelegateSpawn: DelegateSpawnFn = (command, args, cwd) =>
  spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });

export const DELEGATE_TIMEOUT_MS = 30 * 60_000;

// The tracked counterpart to launcher.ts's fire-and-forget launchInTerminal(): spawn the
// headless CLI in the project dir, stream a human tail via onOutput, and settle exactly once
// with onDone (exit 0) or onError (spawn failure / non-zero exit / timeout).
export function runDelegate(
  req: DelegateRequest,
  callbacks: DelegateCallbacks,
  spawnFn: DelegateSpawnFn = defaultDelegateSpawn,
  timeoutMs: number = DELEGATE_TIMEOUT_MS,
): DelegateHandle {
  const { command, args } = delegateCommand(req);
  const child = spawnFn(command, args, req.projectPath);

  let settled = false;
  let result: string | undefined;
  const rawLines: string[] = [];
  let stdoutBuf = "";
  let stderrBuf = "";

  const settle = (fn: () => void): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    fn();
  };

  const kill = (): void => {
    // Negative pid targets the detached process group (the CLI plus its child shells);
    // fall back to killing just the top process when there's no pid or the group is gone.
    try {
      if (typeof child.pid === "number") process.kill(-child.pid, "SIGTERM");
      else child.kill("SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  };

  const timer = setTimeout(() => {
    kill();
    settle(() => callbacks.onError(new Error(`delegate timed out after ${Math.round(timeoutMs / 60_000)} minutes`)));
  }, timeoutMs);

  const handleLine = (line: string): void => {
    if (!line.trim() || settled) return;
    rawLines.push(line);
    if (req.cli !== "claude") {
      callbacks.onOutput(line);
      return;
    }
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      callbacks.onOutput(line);
      return;
    }
    const r = claudeResult(event);
    if (r !== undefined) {
      result = r;
      return;
    }
    const tail = claudeTailLine(event);
    if (tail) callbacks.onOutput(tail);
  };

  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutBuf += chunk.toString("utf8");
    for (let i = stdoutBuf.indexOf("\n"); i !== -1; i = stdoutBuf.indexOf("\n")) {
      handleLine(stdoutBuf.slice(0, i));
      stdoutBuf = stdoutBuf.slice(i + 1);
    }
  });
  // Keep only the stderr tail — enough to explain a failure without buffering a flood.
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrBuf = (stderrBuf + chunk.toString("utf8")).slice(-4000);
  });

  child.on("error", (err: Error) => settle(() => callbacks.onError(err)));
  child.on("close", (code: number | null) => {
    if (settled) return;
    if (stdoutBuf.trim()) handleLine(stdoutBuf);
    if (code === 0) {
      // Prefer claude's structured result event; the raw output is the fallback (and is
      // the entire answer for opencode).
      settle(() => callbacks.onDone(result ?? rawLines.join("\n")));
    } else {
      const tail = stderrBuf.trim().split("\n").slice(-5).join("\n");
      settle(() => callbacks.onError(new Error(`${command} exited with code ${code}${tail ? ` — ${tail}` : ""}`)));
    }
  });

  return {
    cancel: () => {
      kill();
      settle(() => {});
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @bean/core exec vitest run __test__/delegate.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/delegate.ts packages/core/__test__/delegate.test.ts
git commit -m "feat(core): runDelegate — spawn, stream, collect, cancel, timeout"
```

---

### Task 3: `propose_delegate` tool in `converse()`

**Files:**
- Modify: `packages/core/src/converse.ts`
- Modify: `packages/core/__test__/converse.test.ts`

**Interfaces:**
- Consumes: `composePrompt(skill, instruction, url?)` (already imported in converse.ts).
- Produces (used by Tasks 6–7):
  - `ProposedDelegate { projectPath: string; instruction: string; skillName?: string; composedPrompt: string }`
  - `ConverseResult.proposedDelegate?: ProposedDelegate`
  - New trailing `converse()` parameter `delegateAvailable = false` (after `linkedNote`).

- [ ] **Step 1: Write the failing tests**

Add a `describe("propose_delegate", ...)` block to `packages/core/__test__/converse.test.ts`. **Reuse the fixture helpers already defined at the top of that file** (the skills/projects/persona/memories values the existing `propose_run` tests pass to `converse`) — do not invent new shapes. The essential cases, adapted to those fixtures:

```typescript
describe("propose_delegate", () => {
  // depsWith() = however this file builds ConverseDeps around a fake chat fn; reuse it.
  const delegateCall = (args: unknown) => ({ content: "on it", toolCalls: [{ name: "propose_delegate", args }] });

  it("returns proposedDelegate with the instruction as prompt when no skill is given", async () => {
    const deps = depsWith(async () => delegateCall({ project: projects[0]!.path, instruction: "fix the flaky test" }));
    const res = await converse([], "hi", skills, projects, persona, [], deps, undefined, [], undefined, undefined, true);
    expect(res.proposedDelegate).toEqual({
      projectPath: projects[0]!.path,
      instruction: "fix the flaky test",
      skillName: undefined,
      composedPrompt: "fix the flaky test",
    });
  });

  it("composes the skill body into the prompt when a known skill is given", async () => {
    const deps = depsWith(async () =>
      delegateCall({ project: projects[0]!.path, instruction: "do it", skill: skills[0]!.name }));
    const res = await converse([], "hi", skills, projects, persona, [], deps, undefined, [], undefined, undefined, true);
    expect(res.proposedDelegate?.skillName).toBe(skills[0]!.name);
    expect(res.proposedDelegate?.composedPrompt).toContain("## Task");
    expect(res.proposedDelegate?.composedPrompt).toContain("do it");
  });

  it("treats an unknown skill as no skill", async () => {
    const deps = depsWith(async () =>
      delegateCall({ project: projects[0]!.path, instruction: "do it", skill: "nope" }));
    const res = await converse([], "hi", skills, projects, persona, [], deps, undefined, [], undefined, undefined, true);
    expect(res.proposedDelegate?.skillName).toBeUndefined();
    expect(res.proposedDelegate?.composedPrompt).toBe("do it");
  });

  it("drops the proposal on an unknown project or missing instruction", async () => {
    for (const args of [{ project: "/nope", instruction: "x" }, { project: projects[0]!.path }]) {
      const deps = depsWith(async () => delegateCall(args));
      const res = await converse([], "hi", skills, projects, persona, [], deps, undefined, [], undefined, undefined, true);
      expect(res.proposedDelegate).toBeUndefined();
      expect(res.reply).toBe("on it");
    }
  });

  it("does not offer the tool when delegateAvailable is false", async () => {
    let seenTools: string[] = [];
    const deps = depsWith(async ({ tools }) => {
      seenTools = tools.map((t) => t.name);
      return { content: "ok", toolCalls: [] };
    });
    await converse([], "hi", skills, projects, persona, [], deps, undefined, [], undefined, undefined, false);
    expect(seenTools).not.toContain("propose_delegate");
  });

  it("offers the tool when delegateAvailable is true and projects exist", async () => {
    let seenTools: string[] = [];
    const deps = depsWith(async ({ tools }) => {
      seenTools = tools.map((t) => t.name);
      return { content: "ok", toolCalls: [] };
    });
    await converse([], "hi", skills, projects, persona, [], deps, undefined, [], undefined, undefined, true);
    expect(seenTools).toContain("propose_delegate");
  });
});
```

If the file has no `depsWith`-style helper, build deps inline the same way its existing tests do: `{ chat: async (a) => ..., model: "test-model" }`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @bean/core exec vitest run __test__/converse.test.ts`
Expected: new tests FAIL (`proposedDelegate` undefined / tool never offered); existing tests still PASS.

- [ ] **Step 3: Implement in `converse.ts`**

3a. Add the type and extend `ConverseResult`:

```typescript
/** A delegation draft awaiting user confirmation — a background agent runs it and reports
 * back into the chat. skillName absent = free-form instruction (delegation is not limited
 * to the skill catalog). */
export interface ProposedDelegate {
  projectPath: string;
  instruction: string;
  skillName?: string;
  composedPrompt: string;
}
```

```typescript
export interface ConverseResult { reply: string; model?: string; proposedRun?: ProposedRun; proposedNote?: ProposedNote; proposedDelegate?: ProposedDelegate; }
```

3b. Append to `BEHAVIOR_INSTRUCTIONS` (inside the existing string concatenation, at the end):

```typescript
  " If you are given a propose_delegate tool: use it when the user wants project work done " +
  "and the outcome reported back here — a background agent does the work while the chat stays " +
  "open, and its result returns to this conversation. Use propose_run instead when the user " +
  "wants to watch or continue the work in their own terminal. Both are confirm-first.";
```

3c. Add the tool builder after `proposeRunTool`:

```typescript
// skill is optional — delegation deliberately isn't limited to the skill catalog. Enums are
// per-call for the same silent-drop reason as proposeRunTool.
function proposeDelegateTool(skills: Skill[], projects: Project[]): ToolSpec {
  const properties: Record<string, unknown> = {
    project: { type: "string", enum: projects.map((p) => p.path), description: "the project path to work in" },
    instruction: {
      type: "string",
      description: "the concrete, self-contained task for the delegated agent — include all context it needs",
    },
  };
  if (skills.length > 0) {
    properties.skill = {
      type: "string",
      enum: skills.map((s) => s.name),
      description: "optional skill whose instructions frame the task; omit for a free-form task",
    };
  }
  return {
    name: "propose_delegate",
    description:
      "Delegate a task to a background coding agent that works inside the project and reports " +
      "the result back to this chat when finished. The user confirms before it starts.",
    parameters: { type: "object", properties, required: ["project", "instruction"] },
  };
}
```

3d. Extend the `converse()` signature with a trailing parameter:

```typescript
  linkedNote?: LinkedNote,
  delegateAvailable = false,
): Promise<ConverseResult> {
```

3e. Offer the tool (in the `tools` array, after the `proposeRunTool` line):

```typescript
    ...(delegateAvailable && projects.length > 0 ? [proposeDelegateTool(skills, projects)] : []),
```

3f. Handle the call in the tool loop, directly after the `propose_run` block (before the `propose_note` block):

```typescript
    const delegateToolCall = toolCalls.find((c) => c.name === "propose_delegate");
    if (delegateToolCall) {
      const args = (delegateToolCall.args ?? {}) as { project?: unknown; instruction?: unknown; skill?: unknown };
      const project = projects.find((p) => p.path === args.project);
      if (!project || typeof args.instruction !== "string" || !args.instruction.trim()) {
        return { reply: content, model: deps.model };
      }
      const skill = skills.find((s) => s.name === args.skill);
      return {
        reply: content,
        model: deps.model,
        proposedDelegate: {
          projectPath: project.path,
          instruction: args.instruction,
          skillName: skill?.name,
          composedPrompt: skill ? composePrompt(skill, args.instruction, droppedUrl) : args.instruction,
        },
      };
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @bean/core test`
Expected: PASS (all, including pre-existing).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/converse.ts packages/core/__test__/converse.test.ts
git commit -m "feat(core): confirm-first propose_delegate tool in converse"
```

---

### Task 4: `delegateCli` config plumbing + Settings picker

**Files:**
- Modify: `packages/core/src/types.ts` (BeanConfig)
- Modify: `packages/core/src/config.ts` (loadConfig/saveConfig)
- Modify: `packages/core/__test__/config.test.ts`
- Modify: `packages/app/src/channels.ts` (ConfigView/ConfigUpdate)
- Modify: `packages/app/src/runtime-config.ts`
- Modify: `packages/app/__test__/runtime-config.test.ts`
- Modify: `packages/app/src/main.ts` (bootstrap default, runtime initial, getConfig)
- Modify: `packages/app/src/renderer/components/settings/SettingsWindow.tsx`

**Interfaces:**
- Produces: `BeanConfig.delegateCli: string` (`""` = auto, first detected CLI), `ConfigView.delegateCli` / `ConfigUpdate.delegateCli`, `RuntimeConfig.getDelegateCli(): string`. Task 6's `resolveCli` consumes `getDelegateCli()`.

- [ ] **Step 1: Write the failing tests**

In `packages/core/__test__/config.test.ts`, extend the existing loadConfig/saveConfig coverage (reuse the file's tmp-dir helpers):

```typescript
it("defaults delegateCli to empty and round-trips it through save", async () => {
  // load: a config file without the key
  // (write {"openaiApiKey":"k"} to a tmp config path the way existing tests do)
  const cfg = await loadConfig(file, dir);
  expect(cfg.delegateCli).toBe("");

  await saveConfig(file, { openaiApiKey: "k", model: "m", terminalApp: "", editorApp: "", delegateCli: "claude" });
  const roundTripped = await loadConfig(file, dir);
  expect(roundTripped.delegateCli).toBe("claude");
});
```

In `packages/app/__test__/runtime-config.test.ts`, add (reusing that file's fake `makeChat`/`makeConverse`/`saveConfigFile` pattern):

```typescript
it("exposes and applies delegateCli", async () => {
  const saved: unknown[] = [];
  const runtime = createRuntimeConfig(
    { openaiApiKey: "", model: "m", terminalApp: "", editorApp: "", delegateCli: "" },
    { makeChat: () => async () => ({ content: "", toolCalls: [] }) as never,
      makeConverse: () => async () => ({ content: "", toolCalls: [] }) as never,
      saveConfigFile: async (u) => { saved.push(u); } },
  );
  expect(runtime.getDelegateCli()).toBe("");
  await runtime.apply({ openaiApiKey: "", model: "m", terminalApp: "", editorApp: "", delegateCli: "claude" });
  expect(runtime.getDelegateCli()).toBe("claude");
  expect(saved[0]).toMatchObject({ delegateCli: "claude" });
});
```

(Adapt the fake chat/converse shapes to whatever the existing tests in that file use.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test` (root)
Expected: FAIL — `delegateCli` missing from types/returns.

- [ ] **Step 3: Implement**

3a. `packages/core/src/types.ts` — add to `BeanConfig`:

```typescript
  delegateCli: string; // "" = auto: first detected CLI; else "claude"/"opencode"
```

3b. `packages/core/src/config.ts` — in `loadConfig`'s return object add:

```typescript
    delegateCli: parsed.delegateCli ?? "",
```

In `saveConfig`, extend the config parameter type with `delegateCli?: string` and the `out` object with:

```typescript
    delegateCli: config.delegateCli ?? "",
```

3c. `packages/app/src/channels.ts` — add `delegateCli: string;` to **both** `ConfigView` and `ConfigUpdate`.

3d. `packages/app/src/runtime-config.ts` — thread it through exactly like `editorApp`:
- add `delegateCli: string` to `RuntimeConfigDeps.saveConfigFile`'s update type, to `createRuntimeConfig`'s `initial` and `apply` update types;
- `let delegateCli = initial.delegateCli;`
- add `getDelegateCli: () => string` to `RuntimeConfig` and `getDelegateCli: () => delegateCli,` to the returned object;
- in `apply`: pass `delegateCli: update.delegateCli` to `saveConfigFile` and set `delegateCli = update.delegateCli;`.

3e. `packages/app/src/main.ts`:
- bootstrap default: `saveConfig(cfgPath, { openaiApiKey: "", model: "gpt-4o-mini", terminalApp: "", editorApp: "", delegateCli: "" })`
- runtime initial: add `delegateCli: cfg.delegateCli`
- `getConfig` result: add `delegateCli: runtime.getDelegateCli(),`

3f. `packages/app/src/renderer/components/settings/SettingsWindow.tsx` — add state, load, save, and a picker field:

```typescript
import type { CliName } from "@bean/core";
```

```typescript
  const [delegateCli, setDelegateCli] = useState("");
  const [clis, setClis] = useState<CliName[]>([]);
```

In the mount effect: `window.bean.availableClis().then(setClis);` and inside the `getConfig` callback: `setDelegateCli(c.delegateCli);`.

In `onSave`'s `saveConfig` payload: `delegateCli,`.

New field after the EDITOR APP label:

```tsx
        <label class="bean-field">
          <span class="bean-field-label">DELEGATE CLI</span>
          <select
            class="bean-input"
            value={delegateCli}
            onChange={(e) => { setDelegateCli((e.target as HTMLSelectElement).value); setSave("idle"); }}
          >
            <option value="">Auto (first detected{clis[0] ? `: ${clis[0]}` : ""})</option>
            {clis.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/config.ts packages/core/__test__/config.test.ts packages/app/src/channels.ts packages/app/src/runtime-config.ts packages/app/__test__/runtime-config.test.ts packages/app/src/main.ts packages/app/src/renderer/components/settings/SettingsWindow.tsx
git commit -m "feat: delegateCli config setting with Settings picker"
```

---

### Task 5: App-side delegate task registry

**Files:**
- Create: `packages/app/src/delegate-tasks.ts`
- Create: `packages/app/__test__/delegate-tasks.test.ts`

**Interfaces:**
- Consumes: `runDelegate`, `CliName`, `DelegateSpawnFn`, `DelegateCallbacks`, `DelegateHandle`, `DelegateRequest` from `@bean/core`.
- Produces (used by Tasks 6–7):
  - `DelegateEvent` union (`started` / `output` / `done` / `failed` / `cancelled`, each with `taskId`)
  - `DelegateStartRequest { projectPath: string; prompt: string }`
  - `createDelegateTasks(deps): { start(req): string; cancel(taskId): void; cancelAll(): void }`
  - Lifetime contract: tasks are bound to the chat window. `cancelAll()` cancels every still-running task (main calls it when the chat window is destroyed — the no-ghosts backstop behind the renderer's Keep working / Stop & close prompt). Terminal events (`done`/`failed`/`cancelled`) remove the task from the registry; there is no buffering or replay.

- [ ] **Step 1: Write the failing tests**

Create `packages/app/__test__/delegate-tasks.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { createDelegateTasks, type DelegateEvent } from "../src/delegate-tasks.js";
import type { DelegateCallbacks, DelegateHandle, DelegateRequest } from "@bean/core";

function harness(opts: { cli?: "claude" | "opencode" } = {}) {
  const sent: DelegateEvent[] = [];
  const cancels: string[] = [];
  const captured: DelegateCallbacks[] = [];
  const reqs: DelegateRequest[] = [];
  let nextId = 0;
  const tasks = createDelegateTasks({
    resolveCli: () => opts.cli ?? "claude",
    send: (e) => { sent.push(e); },
    newId: () => `task-${++nextId}`,
    run: (req, cbs) => {
      reqs.push(req);
      captured.push(cbs);
      return { cancel: () => cancels.push(req.prompt) } satisfies DelegateHandle;
    },
  });
  return { tasks, sent, cancels, captured, reqs, cbs: () => captured.at(-1)!, req: () => reqs.at(-1)! };
}

describe("createDelegateTasks", () => {
  it("start resolves the CLI, spawns via run, and emits started", () => {
    const h = harness({ cli: "opencode" });
    const id = h.tasks.start({ projectPath: "/p", prompt: "go" });
    expect(id).toBe("task-1");
    expect(h.req()).toEqual({ cli: "opencode", projectPath: "/p", prompt: "go" });
    expect(h.sent).toEqual([{ taskId: "task-1", type: "started" }]);
  });

  it("emits a deferred failed event when no CLI is available", async () => {
    const h = harness();
    const tasks = createDelegateTasks({
      resolveCli: () => undefined,
      send: (e) => { h.sent.push(e); },
      newId: () => "task-x",
      run: () => { throw new Error("must not spawn"); },
    });
    tasks.start({ projectPath: "/p", prompt: "go" });
    // Deferred past the invoke reply so the renderer has the taskId before the event lands.
    expect(h.sent).toEqual([]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.sent).toEqual([{ taskId: "task-x", type: "failed", message: "No delegate CLI found — install claude or opencode." }]);
  });

  it("forwards output, done, and failed callbacks as events", () => {
    const h = harness();
    const id = h.tasks.start({ projectPath: "/p", prompt: "go" });
    h.cbs().onOutput("▸ Edit");
    h.cbs().onDone("all done");
    expect(h.sent.slice(1)).toEqual([
      { taskId: id, type: "output", line: "▸ Edit" },
      { taskId: id, type: "done", result: "all done" },
    ]);
  });

  it("cancel kills the handle and emits cancelled; later callbacks are ignored", () => {
    const h = harness();
    const id = h.tasks.start({ projectPath: "/p", prompt: "go" });
    h.tasks.cancel(id);
    expect(h.cancels).toEqual(["go"]);
    expect(h.sent.at(-1)).toEqual({ taskId: id, type: "cancelled" });
    h.cbs().onDone("too late");
    h.cbs().onOutput("too late");
    expect(h.sent.filter((e) => e.type === "done" || e.type === "output")).toEqual([]);
  });

  it("cancel of an unknown or finished task is a no-op", () => {
    const h = harness();
    const id = h.tasks.start({ projectPath: "/p", prompt: "go" });
    h.cbs().onDone("done");
    const before = h.sent.length;
    h.tasks.cancel(id);
    h.tasks.cancel("nope");
    expect(h.sent.length).toBe(before);
  });

  it("cancelAll cancels every running task and emits cancelled for each", () => {
    const h = harness();
    const a = h.tasks.start({ projectPath: "/p", prompt: "one" });
    const b = h.tasks.start({ projectPath: "/p", prompt: "two" });
    h.tasks.cancelAll();
    expect(h.cancels).toEqual(["one", "two"]);
    expect(h.sent.filter((e) => e.type === "cancelled").map((e) => e.taskId)).toEqual([a, b]);
  });

  it("cancelAll skips already-finished tasks and is idempotent", () => {
    const h = harness();
    h.tasks.start({ projectPath: "/p", prompt: "one" });
    h.cbs().onDone("done");
    h.tasks.cancelAll();
    h.tasks.cancelAll();
    expect(h.cancels).toEqual([]);
    expect(h.sent.filter((e) => e.type === "cancelled")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @bean/app exec vitest run __test__/delegate-tasks.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Write the implementation**

Create `packages/app/src/delegate-tasks.ts`:

```typescript
import { runDelegate } from "@bean/core";
import type { CliName, DelegateCallbacks, DelegateHandle, DelegateRequest, DelegateSpawnFn } from "@bean/core";

export type DelegateEvent =
  | { taskId: string; type: "started" }
  | { taskId: string; type: "output"; line: string }
  | { taskId: string; type: "done"; result: string }
  | { taskId: string; type: "failed"; message: string }
  | { taskId: string; type: "cancelled" };

export interface DelegateStartRequest {
  projectPath: string;
  prompt: string;
}

export interface DelegateTasksDeps {
  /** Effective delegate CLI: the configured one when detected, else the first detected; undefined = none. */
  resolveCli: () => CliName | undefined;
  /** Push to the chat renderer (a no-op when no chat window is open — see the lifetime rule). */
  send: (event: DelegateEvent) => void;
  newId: () => string;
  /** DI seam for tests; production uses core's runDelegate. */
  run?: (req: DelegateRequest, cbs: DelegateCallbacks, spawnFn?: DelegateSpawnFn, timeoutMs?: number) => DelegateHandle;
}

const isTerminal = (e: DelegateEvent): boolean => e.type === "done" || e.type === "failed" || e.type === "cancelled";

// Tracks live delegations in the main process. Tasks are bound to the chat window's
// lifetime — no ghosts: the renderer's close-time prompt lets the user keep working or
// stop everything, and main calls cancelAll() when the chat window is destroyed as the
// hard backstop. A terminal event ends the task's registry life; nothing is buffered.
export function createDelegateTasks(deps: DelegateTasksDeps) {
  const run = deps.run ?? runDelegate;
  const tasks = new Map<string, { cancel: () => void }>();

  const emit = (event: DelegateEvent): void => {
    if (event.type !== "started" && !tasks.has(event.taskId)) return; // finished/cancelled already
    if (isTerminal(event)) tasks.delete(event.taskId);
    deps.send(event);
  };

  return {
    start(req: DelegateStartRequest): string {
      const taskId = deps.newId();
      const cli = deps.resolveCli();
      if (!cli) {
        // Straight to send, not emit: no task was registered (nothing to cancel), and
        // emit's not-registered guard would otherwise swallow this very first event.
        // Deferred so the renderer's invoke reply (carrying this taskId) lands first —
        // a synchronous send would race ahead of it and find no card to update.
        setImmediate(() => deps.send({ taskId, type: "failed", message: "No delegate CLI found — install claude or opencode." }));
        return taskId;
      }
      const handle = run(
        { cli, projectPath: req.projectPath, prompt: req.prompt },
        {
          onOutput: (line) => emit({ taskId, type: "output", line }),
          onDone: (result) => emit({ taskId, type: "done", result }),
          onError: (err) => emit({ taskId, type: "failed", message: err.message }),
        },
      );
      tasks.set(taskId, { cancel: handle.cancel });
      emit({ taskId, type: "started" });
      return taskId;
    },

    cancel(taskId: string): void {
      const t = tasks.get(taskId);
      if (!t) return;
      t.cancel();
      emit({ taskId, type: "cancelled" });
    },

    /** Cancel every still-running task — called by the renderer's Stop & close choice
     * (per-task cancel) and by main when the chat window is destroyed (this, in bulk). */
    cancelAll(): void {
      for (const [taskId, t] of [...tasks]) {
        t.cancel();
        emit({ taskId, type: "cancelled" });
      }
    },
  };
}
```

One load-bearing subtlety: `emit` drops any non-`started` event whose task is no longer registered — that's what makes "later callbacks are ignored" after cancel/done work (core's `runDelegate` settles once, but a cancelled child's stray `onOutput` could still race in). The no-CLI failure bypasses `emit` for exactly that reason (see the comment in `start`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @bean/app exec vitest run __test__/delegate-tasks.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/delegate-tasks.ts packages/app/__test__/delegate-tasks.test.ts
git commit -m "feat(app): delegate task registry bound to the chat window's lifetime"
```

---

### Task 6: IPC channels, preload bridge, and main-process wiring

**Files:**
- Modify: `packages/app/src/channels.ts`
- Modify: `packages/app/src/ipc.ts`
- Modify: `packages/app/src/preload.ts`
- Modify: `packages/app/src/renderer/bean.d.ts`
- Modify: `packages/app/src/main.ts`
- Modify: `packages/app/__test__/ipc.test.ts`

**Interfaces:**
- Consumes: `createDelegateTasks` / `DelegateEvent` / `DelegateStartRequest` (Task 5), `runtime.getDelegateCli()` (Task 4), `converse`'s `delegateAvailable` parameter (Task 3).
- Produces: channels `bean:delegate-start` (invoke → taskId), `bean:delegate-cancel` (send), `bean:delegate-event` (main→renderer push); `window.bean.delegateStart/delegateCancel/onDelegateEvent`; `ChatHandlerDeps.delegateAvailable?: () => boolean`; main-side no-ghosts backstop: chat window `closed` → `delegateTasks.cancelAll()`.

- [ ] **Step 1: Write the failing test**

In `packages/app/__test__/ipc.test.ts`, add to the existing `buildChatHandler` coverage (reuse that file's dep-fixture pattern; the only new dep is `delegateAvailable`):

```typescript
it("passes delegateAvailable through to converse", async () => {
  // Copy the existing buildChatHandler test's deps fixture; set:
  //   converse: a fake that records its arguments is NOT enough — converse is imported
  //   directly by ipc.ts. Instead assert via the tool list the fake chat fn receives:
  const seenTools: string[][] = [];
  const deps = {
    /* ...same fixture deps as the existing buildChatHandler test..., with at least one
       project returned by loadProjects, and: */
    converse: async (a: { tools: { name: string }[] }) => {
      seenTools.push(a.tools.map((t) => t.name));
      return { content: "ok", toolCalls: [] };
    },
    delegateAvailable: () => true,
  };
  const handler = buildChatHandler(deps as never);
  await handler({ history: [], message: "hi" });
  expect(seenTools[0]).toContain("propose_delegate");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @bean/app exec vitest run __test__/ipc.test.ts`
Expected: new test FAILS (`propose_delegate` not offered).

- [ ] **Step 3: Implement**

3a. `packages/app/src/channels.ts` — add to the `IPC` map:

```typescript
  delegateStart: "bean:delegate-start",
  delegateCancel: "bean:delegate-cancel",
  delegateEvent: "bean:delegate-event",
```

3b. `packages/app/src/ipc.ts`:
- Add `delegateAvailable?: () => boolean;` to `ChatHandlerDeps`, and pass it in `buildChatHandler`'s `converse(...)` call as the new trailing argument:

```typescript
    return converse(
      req.history, req.message, enabled, projects, persona, memories,
      { chat: deps.converse, model: deps.getModel() }, req.droppedUrl, deps.actions,
      undefined, req.linkedNote, deps.delegateAvailable?.() ?? false,
    );
```

- Add to `RegisterDeps`:

```typescript
  delegateTasks: {
    start: (req: DelegateStartRequest) => string;
    cancel: (taskId: string) => void;
  };
```

with the type-only import at the top: `import type { DelegateStartRequest } from "./delegate-tasks.js";`

- In `registerIpc`, after the launch handler block:

```typescript
  ipcMain.handle(IPC.delegateStart, (_e, req: DelegateStartRequest) => deps.delegateTasks.start(req));
  ipcMain.on(IPC.delegateCancel, (_e, taskId: string) => deps.delegateTasks.cancel(taskId));
```

3c. `packages/app/src/preload.ts` — type-only import (the preload is bundled CJS; a value import of delegate-tasks would drag `runDelegate`/`node:child_process` into the preload bundle — see `.memory/safety-preload-must-be-cjs.md`):

```typescript
import type { DelegateEvent, DelegateStartRequest } from "./delegate-tasks.js";
```

and in the exposed object:

```typescript
  delegateStart: (req: DelegateStartRequest): Promise<string> => ipcRenderer.invoke(IPC.delegateStart, req),
  delegateCancel: (taskId: string): void => ipcRenderer.send(IPC.delegateCancel, taskId),
  onDelegateEvent: (cb: (e: DelegateEvent) => void) =>
    ipcRenderer.on(IPC.delegateEvent, (_e, ev: DelegateEvent) => cb(ev)),
```

3d. `packages/app/src/renderer/bean.d.ts` — add the matching declarations (plus the type-only import `import type { DelegateEvent, DelegateStartRequest } from "../delegate-tasks.js";`):

```typescript
      delegateStart(req: DelegateStartRequest): Promise<string>;
      delegateCancel(taskId: string): void;
      onDelegateEvent(cb: (e: DelegateEvent) => void): void;
```

3e. `packages/app/src/main.ts`:
- Import `createDelegateTasks` from `./delegate-tasks.js`.
- Hoist the CLI detection that currently lives inline in the `getAvailableClis` dep (keep the caching comment) to just before the `try` block:

```typescript
  // PATH doesn't change mid-session — detect once, serve from cache. Finder-launched
  // Electron gets a minimal PATH missing whatever the user's shell profile adds (nvm,
  // npm/pnpm global bins, ~/.local/bin, ...) — ask the login shell for its real PATH.
  const availableClis = detectClis(
    [process.env.PATH ?? "", loginShellPath(), "/opt/homebrew/bin", "/usr/local/bin"].join(":"),
  );
```

- Inside the `try`, after `runtime` is created:

```typescript
    const delegateTasks = createDelegateTasks({
      resolveCli: () => {
        const preferred = runtime.getDelegateCli();
        if ((preferred === "claude" || preferred === "opencode") && availableClis.includes(preferred)) return preferred;
        return availableClis[0];
      },
      // Only the chat window renders delegate cards. Tasks share the chat window's
      // lifetime, so a missing/destroyed window just drops the event.
      send: (event) => {
        const chat = componentWindows.get("chat");
        if (chat && !chat.isDestroyed()) sendToWindow(chat, IPC.delegateEvent, event);
      },
      newId: () => randomUUID(),
    });
    cancelAllDelegates = delegateTasks.cancelAll;
```

- The no-ghosts backstop needs a hook in `openComponent`, which is defined **before** the
  `try` block that creates `delegateTasks` — bridge with a late-bound function. Above the
  `openComponent` definition add:

```typescript
  // Bound after delegateTasks exists (inside the try below). Chat-window destruction kills
  // all delegate tasks — the hard guarantee behind the renderer's Keep/Stop close prompt.
  let cancelAllDelegates: () => void = () => {};
```

  and inside `openComponent`'s `if (kind === "chat")` block (next to the existing
  `win.on("close", ...)` handler):

```typescript
      win.on("closed", () => cancelAllDelegates());
```

  Note it's `closed` (window destroyed — fires after the renderer's Keep/Stop prompt has
  resolved and the close was allowed), not the cancelable `close`.

- In the `registerIpc` deps: replace the old inline `getAvailableClis` IIFE with `getAvailableClis: () => availableClis,` and add:

```typescript
      delegateTasks,
      delegateAvailable: () => availableClis.length > 0,
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: both PASS (includes the new ipc test).

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/channels.ts packages/app/src/ipc.ts packages/app/src/preload.ts packages/app/src/renderer/bean.d.ts packages/app/src/main.ts packages/app/__test__/ipc.test.ts
git commit -m "feat(app): delegate IPC channels, preload bridge, and main wiring"
```

---

### Task 7: Chat UI — DelegateCard, events, result loopback

**Files:**
- Modify: `packages/app/src/renderer/shared/chat-types.ts`
- Create: `packages/app/src/renderer/components/chat/DelegateCard.tsx`
- Modify: `packages/app/src/renderer/components/chat/ChatPanel.tsx`
- Modify: `packages/app/src/renderer/components/chat/ChatWindow.tsx`

**Interfaces:**
- Consumes: `ProposedDelegate` (Task 3, type-only from `@bean/core`), `DelegateEvent` (type-only from `../../../delegate-tasks.js`), `window.bean.delegateStart/delegateCancel/onDelegateEvent` (Task 6).
- Produces: `ChatItem` gains a `"delegate"` variant; the loopback contract: on a `done` event the renderer auto-sends `[delegate result for "<instruction>"]: <result>` through `sendMessage` with a collapsed display label, so the model summarizes and the result enters history. Also: a `"delegates"` stage in the chat window's close flow — closing with a running task asks Keep working / Stop & close before the existing memory-review flow.

There are no renderer unit tests in this repo (no DOM test setup) — this task's gate is `pnpm typecheck && pnpm build`, plus a manual smoke test if `~/.bean` is configured.

- [ ] **Step 1: Extend `ChatItem`**

In `packages/app/src/renderer/shared/chat-types.ts`, change the core import to include the new type and add the variant:

```typescript
import type { ProposedDelegate, ProposedNote, ProposedRun } from "@bean/core";
```

```typescript
  // A propose_delegate draft and, after confirmation, the live background task it became.
  // tail is the last ~30 human-readable output lines; result/error land on the terminal states.
  | { kind: "delegate"; id: string; proposal: ProposedDelegate;
      state: "pending" | "running" | "done" | "failed" | "cancelled" | "dismissed";
      taskId?: string; tail: string[]; result?: string; error?: string }
```

- [ ] **Step 2: Create `DelegateCard.tsx`**

Create `packages/app/src/renderer/components/chat/DelegateCard.tsx` (mirrors ProposalCard's classes so no new CSS is required):

```tsx
import { useEffect, useState } from "preact/hooks";
import type { ChatItem } from "../../shared/chat-types.js";

type DelegateItem = Extract<ChatItem, { kind: "delegate" }>;

const STATE_LABEL: Record<DelegateItem["state"], string> = {
  pending: "Delegate",
  running: "Working…",
  done: "✓ Finished",
  failed: "Failed",
  cancelled: "Cancelled",
  dismissed: "Dismissed",
};

export function DelegateCard({
  item,
  onConfirm,
  onDismiss,
  onCancelTask,
}: {
  item: DelegateItem;
  onConfirm: (editedPrompt: string) => void;
  onDismiss: () => void;
  onCancelTask: () => void;
}) {
  const [prompt, setPrompt] = useState(item.proposal.composedPrompt);
  const [showDetail, setShowDetail] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (item.state !== "running") return;
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [item.state]);

  const pending = item.state === "pending";
  const running = item.state === "running";
  const mmss = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`;

  return (
    <div class="bean-card">
      <div class="bean-card-chips">
        <span class="bean-chip">delegate · background agent</span>
        <span class="bean-chip">project · {item.proposal.projectPath}</span>
        {item.proposal.skillName ? <span class="bean-chip">skill · {item.proposal.skillName}</span> : null}
      </div>
      {pending ? (
        <textarea
          class="bean-card-prompt"
          value={prompt}
          onInput={(e) => setPrompt((e.target as HTMLTextAreaElement).value)}
        />
      ) : null}
      {running && item.tail.length > 0 ? (
        <>
          <button type="button" class="bean-btn bean-btn--ghost" onClick={() => setShowDetail(!showDetail)}>
            {showDetail ? "Hide output" : `Show output (${item.tail.length})`}
          </button>
          {showDetail ? <pre class="bean-card-prompt">{item.tail.join("\n")}</pre> : null}
        </>
      ) : null}
      {item.state === "done" && item.result ? (
        <>
          <button type="button" class="bean-btn bean-btn--ghost" onClick={() => setShowDetail(!showDetail)}>
            {showDetail ? "Hide result" : "Show result"}
          </button>
          {showDetail ? <pre class="bean-card-prompt">{item.result}</pre> : null}
        </>
      ) : null}
      {item.state === "failed" && item.error ? <div class="bean-status bean-status--error">{item.error}</div> : null}
      <div class="bean-card-actions">
        <button
          type="button"
          class="bean-btn"
          disabled={!pending}
          onClick={() => onConfirm(prompt)}
        >
          {running ? `Working… ${mmss}` : STATE_LABEL[item.state]}
        </button>
        {pending ? (
          <button type="button" class="bean-btn bean-btn--ghost" onClick={onDismiss}>Dismiss</button>
        ) : null}
        {running ? (
          <button type="button" class="bean-btn bean-btn--ghost" onClick={onCancelTask}>Cancel</button>
        ) : null}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Render it in `ChatPanel.tsx`**

Add the import and three props, then a render branch:

```typescript
import { DelegateCard } from "./DelegateCard.js";
```

Props (add to the destructured parameter and its type):

```typescript
  onDelegateConfirm: (id: string, editedPrompt: string) => void;
  onDelegateDismiss: (id: string) => void;
  onDelegateCancelTask: (id: string) => void;
```

In the `items.map`, before the final `ProposalCard` return:

```tsx
          if (it.kind === "delegate") {
            return (
              <DelegateCard
                key={it.id}
                item={it}
                onConfirm={(edited) => onDelegateConfirm(it.id, edited)}
                onDismiss={() => onDelegateDismiss(it.id)}
                onCancelTask={() => onDelegateCancelTask(it.id)}
              />
            );
          }
```

- [ ] **Step 4: Wire `ChatWindow.tsx`**

4a. Imports:

```typescript
import type { ChatTurn, LinkedNote, MemoryCandidate, Memory, ProposedNote, RouteSuggestion } from "@bean/core";
import type { DelegateEvent } from "../../../delegate-tasks.js";
```

4b. In `sendMessage`'s result handling, after the `proposedNote` line:

```typescript
        if (res.proposedDelegate) next.push({ kind: "delegate", id: newId(), proposal: res.proposedDelegate, state: "pending", tail: [] });
```

4c. Add the delegate handlers (next to `confirmProposal`):

```typescript
  const confirmDelegate = async (id: string, editedPrompt: string): Promise<void> => {
    const item = itemsRef.current.find(
      (it): it is Extract<ChatItem, { kind: "delegate" }> => it.kind === "delegate" && it.id === id,
    );
    if (!item) return;
    const taskId = await window.bean.delegateStart({ projectPath: item.proposal.projectPath, prompt: editedPrompt });
    setItems((prev) => prev.map((it) =>
      it.id === id && it.kind === "delegate" ? { ...it, state: "running" as const, taskId } : it,
    ));
  };

  const dismissDelegate = (id: string): void => {
    setItems((prev) => prev.map((it) => (it.id === id && it.kind === "delegate" ? { ...it, state: "dismissed" as const } : it)));
  };

  const cancelDelegateTask = (id: string): void => {
    const item = itemsRef.current.find(
      (it): it is Extract<ChatItem, { kind: "delegate" }> => it.kind === "delegate" && it.id === id,
    );
    if (item?.taskId) window.bean.delegateCancel(item.taskId);
  };
```

4d. Event application + loopback. Add above the mount effect:

```typescript
  // Applies a delegate lifecycle event to the matching card; a `done` result loops back
  // through the normal chat flow (collapsed to a short label) so the model summarizes it
  // in its own voice and the result enters conversation history for chaining. Tasks share
  // this window's lifetime, so every event has a card here; no-match means the item's
  // taskId hasn't landed yet or the task predates a hot-reload — drop it.
  const applyDelegateEvent = (e: DelegateEvent): void => {
    const match = itemsRef.current.find(
      (it): it is Extract<ChatItem, { kind: "delegate" }> => it.kind === "delegate" && it.taskId === e.taskId,
    );
    if (!match) return;
    setItems((prev) => prev.map((it) => {
      if (it.kind !== "delegate" || it.taskId !== e.taskId) return it;
      if (e.type === "output") return { ...it, tail: [...it.tail.slice(-29), e.line] };
      if (e.type === "done") return { ...it, state: "done" as const, result: e.result };
      if (e.type === "failed") return { ...it, state: "failed" as const, error: e.message };
      if (e.type === "cancelled") return { ...it, state: "cancelled" as const };
      return it;
    }));
    if (e.type === "done") {
      void sendRef.current(
        `[delegate result for "${match.proposal.instruction}"]: ${e.result}\n\nBriefly summarize this outcome for the user in your own words.`,
        "📦 Delegate finished",
      );
    }
  };
```

4e. In the once-mounted effect (with the other subscriptions):

```typescript
    window.bean.onDelegateEvent(applyDelegateEvent);
```

Note: `applyDelegateEvent` is referenced from the once-mounted effect but reads live state only through `itemsRef`/`sendRef`/`setItems` (all stable), so no stale-closure ref dance is needed beyond what the file already does.

4f. Pass the new props to `<ChatPanel …>`:

```tsx
        onDelegateConfirm={(id, edited) => void confirmDelegate(id, edited)}
        onDelegateDismiss={dismissDelegate}
        onDelegateCancelTask={cancelDelegateTask}
```

4g. Close-flow prompt — closing the chat with a running delegate asks the user first (same
card pattern as the memory review; a delegate must never become a ghost without its human
context).

Extend the `CloseFlow` type with a new stage:

```typescript
type CloseFlow =
  | { stage: "delegates" }
  | { stage: "confirm" }
  | { stage: "loading" }
  | { stage: "review"; items: { text: string; projectPath?: string; checked: boolean }[] };
```

Replace the body of the existing `window.bean.onReviewBeforeClose(...)` callback so the
delegate check runs first (transcript capture stays as-is):

```typescript
    window.bean.onReviewBeforeClose(() => {
      const transcript: ChatTurn[] = itemsRef.current
        .filter((it): it is Extract<ChatItem, { kind: "user" | "reply" }> => it.kind === "user" || it.kind === "reply")
        .map((it) => ({ role: it.kind === "user" ? "user" : "assistant", content: it.text }));
      closeTranscriptRef.current = transcript;
      // A running delegate blocks the close behind an explicit choice — stop it or stay.
      if (itemsRef.current.some((it) => it.kind === "delegate" && it.state === "running")) {
        setCloseFlow({ stage: "delegates" });
        return;
      }
      if (transcript.length === 0) { window.bean.allowChatClose(); return; }
      setCloseFlow({ stage: "confirm" });
    });
```

Add the two handlers next to `dismissClose`:

```typescript
  // "Keep working": abort the close entirely — window stays open, task keeps running.
  const keepWorking = (): void => setCloseFlow(null);

  // "Stop & close": cancel every running delegate, then continue the normal close flow
  // (memory review when there's a transcript, plain close otherwise).
  const stopDelegatesAndClose = (): void => {
    for (const it of itemsRef.current) {
      if (it.kind === "delegate" && it.state === "running" && it.taskId) window.bean.delegateCancel(it.taskId);
    }
    if (closeTranscriptRef.current.length === 0) { dismissClose(); return; }
    setCloseFlow({ stage: "confirm" });
  };
```

Render the stage above the existing `closeFlow?.stage === "confirm"` block:

```tsx
      {closeFlow?.stage === "delegates" ? (
        <div class="bean-memory-review">
          <div class="bean-memory-review-card">
            <div class="bean-memory-review-title">A delegated task is still running — closing will stop it.</div>
            <div class="bean-card-actions">
              <button type="button" class="bean-btn" onClick={keepWorking}>Keep working</button>
              <button type="button" class="bean-btn bean-btn--ghost" onClick={stopDelegatesAndClose}>Stop & close</button>
            </div>
          </div>
        </div>
      ) : null}
```

- [ ] **Step 5: Typecheck, test, build**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: all PASS. (Build catches renderer-bundle issues — e.g. an accidental value import of `delegate-tasks.js` in the renderer would drag node built-ins into the browser bundle; keep it `import type`.)

- [ ] **Step 6: Manual smoke test (only if `~/.bean/config.json` has a key and a CLI is installed)**

Run `pnpm dev`. Open chat → ask e.g. "have an agent list the files in <project> and report back". Expect: DelegateCard → confirm → running with tail → done → Bean summarizes the result in a new reply. Also verify: (a) Cancel mid-run flips the card to Cancelled with no summary; (b) closing the chat window mid-run shows the "still running" card — Keep working keeps both window and task alive, Stop & close kills the task and proceeds to the memory-review flow; (c) after Stop & close, `ps aux | grep -E "claude|opencode"` shows no leftover delegate process.

- [ ] **Step 7: Commit**

```bash
git add packages/app/src/renderer/shared/chat-types.ts packages/app/src/renderer/components/chat/DelegateCard.tsx packages/app/src/renderer/components/chat/ChatPanel.tsx packages/app/src/renderer/components/chat/ChatWindow.tsx
git commit -m "feat(renderer): DelegateCard with live tail, cancel, and result loopback"
```

---

### Task 8: Team memory entries + final validation

**Files:**
- Create: `.memory/convention-delegate-loopback.md`
- Modify: `.memory/convention-launch-hands-off-to-terminal.md`
- Modify: `.memory/INDEX.md`
- Modify: `AGENTS.md` (architecture section)

- [ ] **Step 1: Create `.memory/convention-delegate-loopback.md`**

```markdown
# Delegate loopback — the tracked exception to fire-and-forget

`propose_delegate` (converse, confirm-first like `propose_run`) hands a task to a headless
agent — `claude -p --output-format stream-json` with an explicit `--allowedTools` allowlist
(never `--dangerously-skip-permissions`) or `opencode run` — via core's `runDelegate()`
(`delegate.ts`, pure/DI, sibling of the untouched `launcher.ts`). Unlike Terminal launches,
Bean **does** track these: `app/src/delegate-tasks.ts` keeps a task registry and pushes
`started/output/done/failed/cancelled` over `bean:delegate-event` (Bean's first main→renderer
push channel) to the chat's DelegateCard.

Key contracts:
- **Loopback:** on `done` the renderer auto-sends `[delegate result for "…"]: …` through the
  normal chat flow (collapsed display label), so the model summarizes and the result enters
  history for chaining.
- **Tasks share the chat window's lifetime — no ghosts:** closing the chat with a running
  delegate shows a Keep working / Stop & close card (same pattern as the memory review),
  and main calls `cancelAll()` on chat-window `closed` as the hard backstop. Nothing is
  buffered or replayed; a delegate never runs on without its human context.
- **Cancel is silent in core:** `DelegateHandle.cancel()` kills the (detached) process group
  and settles with NO callback; the registry emits the `cancelled` event itself (and drops
  the task, which is also what makes stray post-terminal callbacks no-ops).
- The delegate CLI is user-picked in Settings (`delegateCli`, "" = first detected); the chat
  model never chooses the harness.
```

- [ ] **Step 2: Update `.memory/convention-launch-hands-off-to-terminal.md`**

Append one paragraph:

```markdown
**Scope update:** this convention covers Terminal launches (`launchInTerminal`) only. The
delegate subsystem ([convention-delegate-loopback](convention-delegate-loopback.md)) is the
deliberate exception: headless runs that Bean spawns, streams, and tracks. Don't merge the
two paths — the launcher stays fire-and-forget.
```

- [ ] **Step 3: Link from `.memory/INDEX.md`**

Add under `## convention`:

```markdown
- [convention-delegate-loopback.md](convention-delegate-loopback.md) — `propose_delegate` → headless `claude -p`/`opencode run` via core `runDelegate()`; tracked tasks bound to the chat window's lifetime (Keep/Stop close prompt + `cancelAll()` backstop), result loops back into chat. The deliberate exception to launch-hands-off-to-terminal.
```

- [ ] **Step 4: Update `AGENTS.md`**

In the Project Overview paragraph, after "Bean does not stream or track the launched process's output.", add:

```markdown
The exception is **delegation**: `converse()` can also propose a delegate run
(`propose_delegate`) — a headless `claude -p` / `opencode run` that Bean spawns, streams,
and cancels via core's `delegate.ts` + app's `delegate-tasks.ts`, with the result fed back
into the chat when it finishes.
```

In the `@bean/core` architecture bullet list, add after the `launcher.ts` bullet:

```markdown
  - `delegate.ts` `runDelegate()` is the tracked counterpart to the launcher: it spawns a
    headless CLI (`delegateCommand()` maps claude/opencode flags), streams a parsed tail,
    collects the final result, and can cancel the process group. Pure and DI'd like the rest.
```

- [ ] **Step 5: Final validation gate**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: all exit 0.

- [ ] **Step 6: Commit**

```bash
git add .memory/convention-delegate-loopback.md .memory/convention-launch-hands-off-to-terminal.md .memory/INDEX.md AGENTS.md
git commit -m "docs: memory entries and AGENTS.md for delegate loopback"
```
