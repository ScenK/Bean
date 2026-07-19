# Live Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Chat-bridged interactive coding-agent sessions: a Discord channel launches a long-lived Claude Code process on the host Mac, streams its output into the channel via progressively edited messages, and routes channel messages back as agent turns.

**Architecture:** A new pure core module `live-session.ts` (sibling of `delegate.ts`) spawns and drives a multi-turn `claude -p --input-format stream-json` process. A new chatops module `live-sessions.ts` holds a channel→session registry plus a throttled message renderer. `converse()` gains a `propose_live_session` tool; `bot.ts` gains a sixth confirm-first proposal store and card, and captures channel messages for active sessions. Discord wires it up; Teams passes `liveSessionsEnabled: () => false` for now.

**Tech Stack:** TypeScript ESM (`.js` import extensions, `import type`), Node child_process, vitest, discord.js (payloads are plain JSON — no new dependencies).

**Spec:** `docs/superpowers/specs/2026-07-18-live-sessions-design.md`

## Global Constraints

- Pure ESM everywhere; relative imports use `.js` extensions; type-only imports use `import type` (`verbatimModuleSyntax` is on).
- `strict` + `noUncheckedIndexedAccess`: array indexing yields `T | undefined` — handle it.
- `@bean/core` stays Electron-free and dependency-injected (`.memory/convention-core-is-electron-free.md`).
- Import from `@bean/core` in other packages, never deep paths — new symbols must be re-exported from `packages/core/src/index.ts`.
- No new npm dependencies.
- Validation gate before claiming done: `pnpm test && pnpm typecheck` both exit 0.
- Claude CLI invocation for live sessions is exactly: `claude -p --input-format stream-json --output-format stream-json --verbose --dangerously-skip-permissions [--model <literal>]` — the spec's deliberate "true bypass" choice.
- Idle timeout default: 30 minutes. Renderer throttle default: 1500 ms. Message rollover limit: 1900 chars (headroom under Discord's 2000).
- Kebab-case filenames.

---

### Task 1: `liveSessions` config flag

**Files:**
- Modify: `packages/core/src/types.ts` (the `BeanConfig` interface)
- Modify: `packages/core/src/config.ts` (`loadConfig`, `saveConfig`)
- Test: `packages/core/__test__/config.test.ts`

**Interfaces:**
- Consumes: existing `BeanConfig` / `loadConfig` / `saveConfig`.
- Produces: `BeanConfig.liveSessions: boolean` (default `false`) — read later by `packages/discord/src/server.ts` (Task 9) as `beanConfig.liveSessions`.

- [ ] **Step 1: Write the failing test**

Add to `packages/core/__test__/config.test.ts`, following the file's existing tmp-dir fixture style:

```typescript
it("defaults liveSessions to false and round-trips it through saveConfig", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bean-config-"));
  const file = join(dir, "config.json");
  await writeFile(file, JSON.stringify({ openaiApiKey: "k", model: "m" }), "utf8");
  const cfg = await loadConfig(file, dir);
  expect(cfg.liveSessions).toBe(false);

  await saveConfig(file, { openaiApiKey: "k", model: "m", liveSessions: true });
  const cfg2 = await loadConfig(file, dir);
  expect(cfg2.liveSessions).toBe(true);
});
```

(Reuse the file's existing imports for `mkdtemp`/`tmpdir`/`writeFile` if already present.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @bean/core exec vitest run __test__/config.test.ts`
Expected: FAIL — `liveSessions` does not exist on the returned config / `saveConfig` arg type error.

- [ ] **Step 3: Implement**

In `packages/core/src/types.ts`, add to the `BeanConfig` interface (beside `systemControls`):

```typescript
  /** Opt-in for chat-launched live coding-agent sessions (spec: live-sessions). */
  liveSessions: boolean;
```

In `packages/core/src/config.ts` `loadConfig`, add to the returned object (beside `systemControls`):

```typescript
    liveSessions: parsed.liveSessions ?? false,
```

In `saveConfig`, add `liveSessions?: boolean` to the parameter type and to `out`:

```typescript
    liveSessions: config.liveSessions ?? false,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @bean/core exec vitest run __test__/config.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/config.ts packages/core/__test__/config.test.ts
git commit -m "feat(core): add liveSessions config flag (default off)"
```

---

### Task 2: `live-session.ts` pure functions (command, stdin line, turn summary)

**Files:**
- Create: `packages/core/src/live-session.ts`
- Test: `packages/core/__test__/live-session.test.ts`

**Interfaces:**
- Consumes: `claudeTailLine` from `./delegate.js` (already exported there).
- Produces:
  - `interface LiveSessionRequest { projectPath: string; prompt: string; model?: string }`
  - `liveSessionCommand(req: LiveSessionRequest): { command: string; args: string[] }`
  - `userTurnLine(text: string): string` — one newline-terminated JSON line for the CLI's stdin
  - `interface TurnSummary { result: string; durationMs?: number; costUsd?: number }`
  - `claudeTurnSummary(event: unknown): TurnSummary | undefined`

- [ ] **Step 1: Write the failing tests**

Create `packages/core/__test__/live-session.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { claudeTurnSummary, liveSessionCommand, userTurnLine } from "../src/live-session.js";

describe("liveSessionCommand", () => {
  it("builds the multi-turn stream-json claude invocation with permissions bypassed", () => {
    const { command, args } = liveSessionCommand({ projectPath: "/p", prompt: "hi" });
    expect(command).toBe("claude");
    expect(args).toEqual([
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
    ]);
  });

  it("appends --model verbatim when set", () => {
    const { args } = liveSessionCommand({ projectPath: "/p", prompt: "hi", model: "sonnet" });
    expect(args.slice(-2)).toEqual(["--model", "sonnet"]);
  });
});

describe("userTurnLine", () => {
  it("emits one newline-terminated stream-json user message", () => {
    const line = userTurnLine("fix the bug");
    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line)).toEqual({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "fix the bug" }] },
    });
  });
});

describe("claudeTurnSummary", () => {
  it("extracts result, duration, and cost from a result event", () => {
    expect(claudeTurnSummary({ type: "result", result: "done", duration_ms: 1200, total_cost_usd: 0.004 }))
      .toEqual({ result: "done", durationMs: 1200, costUsd: 0.004 });
  });

  it("tolerates a result event missing optional fields", () => {
    expect(claudeTurnSummary({ type: "result" })).toEqual({ result: "", durationMs: undefined, costUsd: undefined });
  });

  it("returns undefined for non-result events", () => {
    expect(claudeTurnSummary({ type: "assistant" })).toBeUndefined();
    expect(claudeTurnSummary(null)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @bean/core exec vitest run __test__/live-session.test.ts`
Expected: FAIL — cannot resolve `../src/live-session.js`.

- [ ] **Step 3: Implement**

Create `packages/core/src/live-session.ts`:

```typescript
// Multi-turn interactive counterpart to delegate.ts's one-shot runDelegate: a long-lived
// `claude -p` process fed user turns over stdin (stream-json), streaming events back on
// stdout, driven remotely from a chatops channel. Spec: docs/superpowers/specs/
// 2026-07-18-live-sessions-design.md — permissions are deliberately bypassed (true bypass).

export interface LiveSessionRequest {
  projectPath: string;
  /** The opening instruction — written to stdin as the first user turn. */
  prompt: string;
  /** Literal --model value (clis.json); flag omitted when unset. */
  model?: string;
}

export function liveSessionCommand(req: LiveSessionRequest): { command: string; args: string[] } {
  const modelArgs = req.model ? ["--model", req.model] : [];
  return {
    command: "claude",
    args: [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
      ...modelArgs,
    ],
  };
}

/** One stdin line = one user turn, per claude's stream-json input protocol. */
export function userTurnLine(text: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } }) + "\n";
}

/** Per-turn completion event — claude emits one `result` event at the end of every turn. */
export interface TurnSummary {
  result: string;
  durationMs?: number;
  costUsd?: number;
}

export function claudeTurnSummary(event: unknown): TurnSummary | undefined {
  const e = event as { type?: unknown; result?: unknown; duration_ms?: unknown; total_cost_usd?: unknown } | null;
  if (e?.type !== "result") return undefined;
  return {
    result: typeof e.result === "string" ? e.result : "",
    durationMs: typeof e.duration_ms === "number" ? e.duration_ms : undefined,
    costUsd: typeof e.total_cost_usd === "number" ? e.total_cost_usd : undefined,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @bean/core exec vitest run __test__/live-session.test.ts`
Expected: PASS (3 describes, 6 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/live-session.ts packages/core/__test__/live-session.test.ts
git commit -m "feat(core): live-session command builder and stream-json helpers"
```

---

### Task 3: `startLiveSession()` runtime

**Files:**
- Modify: `packages/core/src/live-session.ts`
- Test: `packages/core/__test__/live-session.test.ts`

**Interfaces:**
- Consumes: `claudeTailLine`, `BEAN_GIT_IDENTITY`, `GIT_TRAILER_INSTRUCTION` from `./delegate.js`; Task 2's helpers.
- Produces:
  - `interface LiveSessionCallbacks { onOutput: (line: string) => void; onTurnComplete: (summary: TurnSummary) => void; onExit: (err?: Error) => void }`
  - `interface LiveSessionHandle { send: (text: string) => void; stop: () => void; pid: number | undefined }`
  - `type LiveSessionSpawnFn = (command: string, args: string[], cwd: string) => ChildProcess`
  - `startLiveSession(req: LiveSessionRequest, cbs: LiveSessionCallbacks, spawnFn?: LiveSessionSpawnFn, idleTimeoutMs?: number): LiveSessionHandle`
  - `const LIVE_SESSION_IDLE_MS = 30 * 60_000`
- Semantics later tasks rely on: `onExit(undefined)` = clean end (stop, idle timeout, or exit 0); `onExit(Error)` = crash. `onExit` fires exactly once. `stop()` is idempotent.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/__test__/live-session.test.ts`. The fake child mirrors the fake in `packages/core/__test__/delegate.test.ts` — check that file first and reuse its helper shape if one exists; otherwise use this:

```typescript
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { vi } from "vitest";
import { startLiveSession, LIVE_SESSION_IDLE_MS } from "../src/live-session.js";

function fakeChild(): { child: ChildProcess; stdin: PassThrough; stdout: PassThrough; emit: (ev: string, ...a: unknown[]) => void } {
  const child = new EventEmitter() as unknown as ChildProcess & EventEmitter;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  Object.assign(child, { stdin, stdout, stderr: new PassThrough(), pid: 4242, kill: vi.fn() });
  return { child, stdin, stdout, emit: (ev, ...a) => child.emit(ev, ...a) };
}

describe("startLiveSession", () => {
  it("writes the opening prompt (with git trailer) as the first stdin turn", () => {
    const f = fakeChild();
    const written: string[] = [];
    f.stdin.on("data", (c: Buffer) => written.push(c.toString("utf8")));
    startLiveSession({ projectPath: "/p", prompt: "investigate" }, { onOutput: () => {}, onTurnComplete: () => {}, onExit: () => {} }, () => f.child);
    const first = JSON.parse(written.join("").split("\n")[0]!);
    expect(first.message.content[0].text).toContain("investigate");
    expect(first.message.content[0].text).toContain("Co-Authored-By: Bean");
  });

  it("streams assistant tail lines and per-turn summaries, and send() writes further turns", () => {
    const f = fakeChild();
    const outputs: string[] = [];
    const turns: unknown[] = [];
    const handle = startLiveSession({ projectPath: "/p", prompt: "go" }, { onOutput: (l) => outputs.push(l), onTurnComplete: (s) => turns.push(s), onExit: () => {} }, () => f.child);
    f.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "looking" }] } }) + "\n");
    f.stdout.write(JSON.stringify({ type: "result", result: "found it", duration_ms: 10 }) + "\n");
    expect(outputs).toEqual(["looking"]);
    expect(turns).toEqual([{ result: "found it", durationMs: 10, costUsd: undefined }]);
    const written: string[] = [];
    f.stdin.on("data", (c: Buffer) => written.push(c.toString("utf8")));
    handle.send("next hint");
    expect(JSON.parse(written.join("")).message.content[0].text).toBe("next hint");
  });

  it("stop() SIGTERMs the process group and close then reports a clean exit", () => {
    const f = fakeChild();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    let exitErr: Error | undefined | null = null;
    const handle = startLiveSession({ projectPath: "/p", prompt: "go" }, { onOutput: () => {}, onTurnComplete: () => {}, onExit: (e) => { exitErr = e; } }, () => f.child);
    handle.stop();
    expect(killSpy).toHaveBeenCalledWith(-4242, "SIGTERM");
    f.emit("close", null);
    expect(exitErr).toBeUndefined();
    killSpy.mockRestore();
  });

  it("a non-zero exit without stop() reports an error", () => {
    const f = fakeChild();
    let exitErr: Error | undefined;
    startLiveSession({ projectPath: "/p", prompt: "go" }, { onOutput: () => {}, onTurnComplete: () => {}, onExit: (e) => { exitErr = e; } }, () => f.child);
    f.emit("close", 1);
    expect(exitErr?.message).toContain("code 1");
  });

  it("kills the session after the idle timeout", () => {
    vi.useFakeTimers();
    const f = fakeChild();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    startLiveSession({ projectPath: "/p", prompt: "go" }, { onOutput: () => {}, onTurnComplete: () => {}, onExit: () => {} }, () => f.child, 1000);
    vi.advanceTimersByTime(1001);
    expect(killSpy).toHaveBeenCalledWith(-4242, "SIGTERM");
    killSpy.mockRestore();
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @bean/core exec vitest run __test__/live-session.test.ts`
Expected: FAIL — `startLiveSession` is not exported.

- [ ] **Step 3: Implement**

Append to `packages/core/src/live-session.ts` (add the imports at the top of the file):

```typescript
import { spawn, type ChildProcess } from "node:child_process";
import { BEAN_GIT_IDENTITY, GIT_TRAILER_INSTRUCTION, claudeTailLine } from "./delegate.js";

export interface LiveSessionCallbacks {
  onOutput: (line: string) => void;
  onTurnComplete: (summary: TurnSummary) => void;
  /** Fires exactly once. undefined = clean end (stop/idle/exit 0); Error = crash. */
  onExit: (err?: Error) => void;
}

export interface LiveSessionHandle {
  send: (text: string) => void;
  stop: () => void;
  pid: number | undefined;
}

export type LiveSessionSpawnFn = (command: string, args: string[], cwd: string) => ChildProcess;

// stdin is "pipe" (delegate uses "ignore") — the whole point is writing further turns.
const defaultLiveSpawn: LiveSessionSpawnFn = (command, args, cwd) =>
  spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"], detached: true, env: { ...process.env, ...BEAN_GIT_IDENTITY } });

export const LIVE_SESSION_IDLE_MS = 30 * 60_000;

export function startLiveSession(
  req: LiveSessionRequest,
  cbs: LiveSessionCallbacks,
  spawnFn: LiveSessionSpawnFn = defaultLiveSpawn,
  idleTimeoutMs: number = LIVE_SESSION_IDLE_MS,
): LiveSessionHandle {
  const { command, args } = liveSessionCommand(req);
  const child = spawnFn(command, args, req.projectPath);

  let exited = false;
  let stopping = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;

  const kill = (signal: NodeJS.Signals): void => {
    try {
      if (typeof child.pid === "number") process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      child.kill(signal);
    }
  };

  const beginStop = (): void => {
    if (exited || stopping) return;
    stopping = true;
    kill("SIGTERM");
    killTimer = setTimeout(() => kill("SIGKILL"), 5_000);
  };

  const resetIdle = (): void => {
    if (exited) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(beginStop, idleTimeoutMs);
  };

  let stdoutBuf = "";
  const handleLine = (line: string): void => {
    if (!line.trim() || exited) return;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      cbs.onOutput(line);
      return;
    }
    const summary = claudeTurnSummary(event);
    if (summary) {
      cbs.onTurnComplete(summary);
      resetIdle();
      return;
    }
    const tail = claudeTailLine(event);
    if (tail) {
      cbs.onOutput(tail);
      resetIdle();
    }
  };

  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutBuf += chunk.toString("utf8");
    for (let i = stdoutBuf.indexOf("\n"); i !== -1; i = stdoutBuf.indexOf("\n")) {
      handleLine(stdoutBuf.slice(0, i));
      stdoutBuf = stdoutBuf.slice(i + 1);
    }
  });

  const settle = (err?: Error): void => {
    if (exited) return;
    exited = true;
    clearTimeout(idleTimer);
    clearTimeout(killTimer);
    cbs.onExit(err);
  };

  child.on("error", (err: Error) => settle(err));
  child.on("close", (code: number | null) => {
    if (stopping || code === 0 || code === null) settle();
    else settle(new Error(`claude exited with code ${code}`));
  });

  child.stdin?.write(userTurnLine(req.prompt + GIT_TRAILER_INSTRUCTION));
  resetIdle();

  return {
    pid: child.pid,
    send: (text) => {
      if (exited || stopping) return;
      child.stdin?.write(userTurnLine(text));
      resetIdle();
    },
    stop: beginStop,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @bean/core exec vitest run __test__/live-session.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/live-session.ts packages/core/__test__/live-session.test.ts
git commit -m "feat(core): startLiveSession multi-turn runtime with idle timeout"
```

---

### Task 4: `LiveSessionProposalStore`

**Files:**
- Create: `packages/core/src/chatops/live-session-proposals.ts`
- Test: `packages/core/__test__/chatops-live-session-proposals.test.ts`

**Interfaces:**
- Consumes: `ProposedLiveSession` from `../converse.js` (defined in Task 5 — write this task's import against that name now; the two tasks land together at typecheck time, or reorder Steps: do Task 5's `ProposedLiveSession` interface first if executing strictly serially — it is additive and safe).
- Produces:
  - `interface PendingLiveSession { id: string; proposal: ProposedLiveSession; conversationId: string; proposedBy: string; cardActivityId?: string; createdAt: number }`
  - `class LiveSessionProposalStore { add(...); setCardActivityId(...); claim(id): PendingLiveSession | undefined }` — one-shot claim, 10-minute expiry, identical contract to `NoteProposalStore`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/__test__/chatops-live-session-proposals.test.ts` (mirror `chatops-note-proposals.test.ts`):

```typescript
import { describe, expect, it } from "vitest";
import { LiveSessionProposalStore } from "../src/chatops/live-session-proposals.js";

const proposal = { projectPath: "/p", instruction: "debug prod" };

describe("LiveSessionProposalStore", () => {
  it("claim is one-shot", () => {
    const store = new LiveSessionProposalStore();
    const p = store.add({ proposal, conversationId: "c1", proposedBy: "sam" });
    expect(store.claim(p.id)?.proposal.instruction).toBe("debug prod");
    expect(store.claim(p.id)).toBeUndefined();
  });

  it("expired proposals cannot be claimed", () => {
    let now = 0;
    const store = new LiveSessionProposalStore(() => now);
    const p = store.add({ proposal, conversationId: "c1", proposedBy: "sam" });
    now = 11 * 60_000;
    expect(store.claim(p.id)).toBeUndefined();
  });

  it("setCardActivityId attaches the card id", () => {
    const store = new LiveSessionProposalStore();
    const p = store.add({ proposal, conversationId: "c1", proposedBy: "sam" });
    store.setCardActivityId(p.id, "act-9");
    expect(store.claim(p.id)?.cardActivityId).toBe("act-9");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @bean/core exec vitest run __test__/chatops-live-session-proposals.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `packages/core/src/chatops/live-session-proposals.ts`:

```typescript
import type { ProposedLiveSession } from "../converse.js";

/** A pending confirm-first live-session launch awaiting a Start/Cancel tap on its card. */
export interface PendingLiveSession {
  id: string;
  proposal: ProposedLiveSession;
  conversationId: string;
  proposedBy: string;
  cardActivityId?: string;
  createdAt: number;
}

const EXPIRY_MS = 10 * 60_000;

/** Pending confirm-first live-session proposals — the live-session counterpart to
 * ProposalStore. claim() is one-shot so two members tapping Start on the same card
 * can't double-launch. */
export class LiveSessionProposalStore {
  private byId = new Map<string, PendingLiveSession>();
  private seq = 0;

  constructor(private nowMs: () => number = () => Date.now()) {}

  add(p: Omit<PendingLiveSession, "id" | "createdAt">): PendingLiveSession {
    const full: PendingLiveSession = { ...p, id: `live-${++this.seq}`, createdAt: this.nowMs() };
    this.byId.set(full.id, full);
    return full;
  }

  setCardActivityId(id: string, activityId: string): void {
    const p = this.byId.get(id);
    if (p) p.cardActivityId = activityId;
  }

  claim(id: string): PendingLiveSession | undefined {
    const p = this.byId.get(id);
    if (!p) return undefined;
    this.byId.delete(id);
    if (this.nowMs() - p.createdAt > EXPIRY_MS) return undefined;
    return p;
  }
}
```

Note: this imports `ProposedLiveSession` from `converse.ts`. If executing tasks strictly in order, add the interface to `converse.ts` now (it is Task 5 Step 3's first snippet, additive-only) so this task compiles; Task 5's tests still drive the rest.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @bean/core exec vitest run __test__/chatops-live-session-proposals.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/chatops/live-session-proposals.ts packages/core/__test__/chatops-live-session-proposals.test.ts packages/core/src/converse.ts
git commit -m "feat(core): LiveSessionProposalStore for confirm-first launches"
```

---

### Task 5: `propose_live_session` tool in `converse()`

**Files:**
- Modify: `packages/core/src/converse.ts`
- Test: `packages/core/__test__/converse.test.ts`

**Interfaces:**
- Consumes: existing `converse()` internals — `ToolSpec`, `AvailableModel`, tool-call loop.
- Produces:
  - `interface ProposedLiveSession { projectPath: string; instruction: string; model?: string }`
  - `ConverseResult.proposedLiveSession?: ProposedLiveSession`
  - `ConverseInput.liveSessionAvailable?: boolean` (default false)
- Tool offered only when `liveSessionAvailable && projects.length > 0`. `model` arg enum = models with `"claude"` in `availableOn`; values pass through verbatim (they are literal `--model` strings per clis.json).

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/__test__/converse.test.ts`, following the file's existing fake-chat fixture pattern (a `deps.chat` stub returning canned `toolCalls`; reuse the file's existing `skills`/`projects`/`persona` fixtures):

```typescript
it("returns proposedLiveSession when the model calls propose_live_session", async () => {
  const chat = async () => ({
    content: "Starting a live session.",
    toolCalls: [{ name: "propose_live_session", args: { project: "/proj/a", instruction: "debug the outage", model: "sonnet" } }],
  });
  const result = await converse({
    history: [], latestUserText: "start a live session",
    skills: [], projects: [{ name: "a", path: "/proj/a" }], persona, memories: [],
    deps: { chat, model: "m" },
    liveSessionAvailable: true,
    models: [{ id: "sonnet", label: "Sonnet", availableOn: ["claude"] }],
  });
  expect(result.proposedLiveSession).toEqual({ projectPath: "/proj/a", instruction: "debug the outage", model: "sonnet" });
});

it("drops an invalid project in propose_live_session instead of proposing", async () => {
  const chat = async () => ({
    content: "hm",
    toolCalls: [{ name: "propose_live_session", args: { project: "/nope", instruction: "x" } }],
  });
  const result = await converse({
    history: [], latestUserText: "go",
    skills: [], projects: [{ name: "a", path: "/proj/a" }], persona, memories: [],
    deps: { chat, model: "m" },
    liveSessionAvailable: true,
  });
  expect(result.proposedLiveSession).toBeUndefined();
  expect(result.reply).toBe("hm");
});

it("does not offer propose_live_session when liveSessionAvailable is false", async () => {
  let offeredTools: string[] = [];
  const chat = async (req: { tools?: { name: string }[] }) => {
    offeredTools = (req.tools ?? []).map((t) => t.name);
    return { content: "ok", toolCalls: [] };
  };
  await converse({
    history: [], latestUserText: "hi",
    skills: [], projects: [{ name: "a", path: "/proj/a" }], persona, memories: [],
    deps: { chat, model: "m" },
  });
  expect(offeredTools).not.toContain("propose_live_session");
});
```

Adapt the fixture names (`persona`, chat-stub typing) to what the file already uses.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @bean/core exec vitest run __test__/converse.test.ts`
Expected: new tests FAIL (`proposedLiveSession` undefined in the first test / type errors on the input field).

- [ ] **Step 3: Implement**

In `packages/core/src/converse.ts`:

(a) Beside `ProposedDelegate` (~line 40), add:

```typescript
/** A confirm-first live interactive agent session bound to this chat channel:
 * a long-lived claude process whose output streams into the channel and whose next
 * turns come from channel messages. Spec: live-sessions design. */
export interface ProposedLiveSession {
  projectPath: string;
  instruction: string;
  /** Literal --model value (clis.json) the user explicitly asked for. */
  model?: string;
}
```

(b) Add `proposedLiveSession?: ProposedLiveSession;` to `ConverseResult`.

(c) Beside `proposeDelegateTool` (~line 218), add:

```typescript
// Only offered where the caller can actually host a live session (Discord chatops with
// the feature flag on and claude detected). Model values pass through verbatim to --model.
function proposeLiveSessionTool(projects: Project[], models: AvailableModel[]): ToolSpec {
  const properties: Record<string, unknown> = {
    project: { type: "string", enum: projects.map((p) => p.path), description: "the project path to work in" },
    instruction: {
      type: "string",
      description: "the opening instruction for the live agent — include all context it needs to start",
    },
  };
  const modelIds = models.filter((m) => m.availableOn.includes("claude")).map((m) => m.id);
  if (modelIds.length > 0) {
    properties.model = {
      type: "string",
      enum: modelIds,
      description: "only when the user explicitly asked for a specific model; omit otherwise",
    };
  }
  return {
    name: "propose_live_session",
    description:
      "Start a live, multi-turn interactive coding-agent session bound to THIS channel: the agent's " +
      "output streams here in real time and every further channel message becomes its next " +
      "instruction, until someone says 'stop'. Use it when the user wants an interactive working " +
      "session they can steer (e.g. live debugging together) rather than a one-shot background " +
      "task — for fire-and-forget tasks use propose_delegate instead. Confirm-first via the card " +
      "shown after you propose.",
    parameters: { type: "object", properties, required: ["project", "instruction"] },
  };
}
```

(d) Add `liveSessionAvailable?: boolean;` to `ConverseInput`, and `liveSessionAvailable = false` to the destructuring defaults in `converse()`.

(e) In the `tools` array (after the `proposeDelegateTool` entry):

```typescript
    ...(liveSessionAvailable && projects.length > 0 ? [proposeLiveSessionTool(projects, models)] : []),
```

(f) In the tool-call loop, after the `propose_delegate` block:

```typescript
    const liveCall = toolCalls.find((c) => c.name === "propose_live_session");
    if (liveCall) {
      const args = (liveCall.args ?? {}) as { project?: unknown; instruction?: unknown; model?: unknown };
      const project = projects.find((p) => p.path === args.project);
      if (!project || typeof args.instruction !== "string" || !args.instruction.trim()) {
        return { reply: content, model: deps.model };
      }
      return {
        reply: content,
        model: deps.model,
        proposedLiveSession: {
          projectPath: project.path,
          instruction: args.instruction,
          model: models.some((m) => m.id === args.model && m.availableOn.includes("claude"))
            ? (args.model as string)
            : undefined,
        },
      };
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @bean/core exec vitest run __test__/converse.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/converse.ts packages/core/__test__/converse.test.ts
git commit -m "feat(core): propose_live_session converse tool"
```

---

### Task 6: card types and surface builders

**Files:**
- Modify: `packages/core/src/chatops/cards-api.ts`
- Modify: `packages/discord/src/components.ts`
- Modify: `packages/teams/src/cards.ts`

**Interfaces:**
- Produces (consumed by Task 8's bot wiring):
  - `interface LiveSessionProposalCardInput { proposalId: string; projectName: string; instruction: string; model?: string }`
  - `interface LiveSessionResultCardInput { projectName: string; startedBy: string; outcome: "started" | "cancelled" | "ended" }`
  - `CardBuilders.liveSessionProposalCard` / `CardBuilders.liveSessionResultCard`
- Discord button custom_ids: `bean:start-live:<proposalId>` and `bean:cancel-live:<proposalId>` — the server's existing `/^bean:([a-z-]+):(.*)$/` interaction regex maps these to `beanAction: "start-live" | "cancel-live"` with no server changes.

No unit tests: card builders are pure JSON with no existing test coverage in either surface package (matches current convention); `pnpm typecheck` is the gate.

- [ ] **Step 1: Add the card input types**

In `packages/core/src/chatops/cards-api.ts`, after `SkillResultCardInput`:

```typescript
export interface LiveSessionProposalCardInput {
  proposalId: string;
  projectName: string;
  instruction: string;
  model?: string;
}

export interface LiveSessionResultCardInput {
  projectName: string;
  startedBy: string;
  outcome: "started" | "cancelled" | "ended";
}
```

And add to the `CardBuilders` interface:

```typescript
  liveSessionProposalCard: (input: LiveSessionProposalCardInput) => object;
  liveSessionResultCard: (input: LiveSessionResultCardInput) => object;
```

- [ ] **Step 2: Add the Discord builders**

In `packages/discord/src/components.ts`, add the two input types to the `import type` list, then after `consolidationResultCard`:

```typescript
function liveSessionProposalCard(input: LiveSessionProposalCardInput): object {
  return {
    embeds: [{
      title: "Bean proposes a live agent session",
      description: input.instruction,
      fields: [
        { name: "Project", value: input.projectName, inline: true },
        ...(input.model ? [{ name: "Model", value: input.model, inline: true }] : []),
        { name: "How it works", value: "Output streams here; every message in this channel becomes the agent's next turn. Say `stop` to end it." },
      ],
    }],
    components: [row([
      { type: BUTTON, style: 3, label: "Start session", custom_id: `bean:start-live:${input.proposalId}` },
      { type: BUTTON, style: 2, label: "Cancel", custom_id: `bean:cancel-live:${input.proposalId}` },
    ])],
  };
}

function liveSessionResultCard(input: LiveSessionResultCardInput): object {
  const title = input.outcome === "started"
    ? `Live session started in ${input.projectName} (by ${input.startedBy})`
    : input.outcome === "cancelled"
      ? `Live session cancelled (by ${input.startedBy})`
      : `Live session in ${input.projectName} ended`;
  return { embeds: [{ title }], components: [] };
}
```

Add both to the `discordCards` export object.

- [ ] **Step 3: Add the Teams builders**

In `packages/teams/src/cards.ts`, mirror the file's existing adaptive-card builder style (read the file's `proposalCard` first and copy its Action.Submit `data` shape — the `beanAction`/`proposalId` keys must match what `packages/teams/src/server.ts` forwards). Minimal versions:

```typescript
function liveSessionProposalCard(input: LiveSessionProposalCardInput): object {
  return {
    type: "AdaptiveCard", version: "1.4",
    body: [
      { type: "TextBlock", text: "Bean proposes a live agent session", weight: "Bolder" },
      { type: "TextBlock", text: input.instruction, wrap: true },
      { type: "TextBlock", text: `Project: ${input.projectName}${input.model ? ` · Model: ${input.model}` : ""}`, isSubtle: true },
    ],
    actions: [
      { type: "Action.Submit", title: "Start session", data: { beanAction: "start-live", proposalId: input.proposalId } },
      { type: "Action.Submit", title: "Cancel", data: { beanAction: "cancel-live", proposalId: input.proposalId } },
    ],
  };
}

function liveSessionResultCard(input: LiveSessionResultCardInput): object {
  const text = input.outcome === "started"
    ? `Live session started in ${input.projectName} (by ${input.startedBy})`
    : input.outcome === "cancelled"
      ? `Live session cancelled (by ${input.startedBy})`
      : `Live session in ${input.projectName} ended`;
  return { type: "AdaptiveCard", version: "1.4", body: [{ type: "TextBlock", text, weight: "Bolder" }] };
}
```

Add both to the file's exported `CardBuilders` object. (Teams never offers the tool in this iteration — `liveSessionsEnabled: () => false` in Task 9 — these builders exist only to satisfy the `CardBuilders` interface.)

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: FAILS only in `packages/core/src/chatops/bot.ts`-adjacent code IF Task 8 hasn't landed — it must NOT fail inside cards-api/components/cards. If `bot.ts` doesn't reference the new builders yet, expect exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/chatops/cards-api.ts packages/discord/src/components.ts packages/teams/src/cards.ts
git commit -m "feat(chatops): live-session proposal and result cards"
```

---

### Task 7: `LiveSessionRegistry` + throttled stream renderer

**Files:**
- Create: `packages/core/src/chatops/live-sessions.ts`
- Test: `packages/core/__test__/chatops-live-sessions.test.ts`

**Interfaces:**
- Consumes: `startLiveSession`, `LiveSessionHandle`, `LiveSessionCallbacks`, `TurnSummary` from `../live-session.js`.
- Produces:
  - `interface LiveSessionSink { post: (text: string) => Promise<string>; edit: (id: string, text: string) => Promise<void> }`
  - `interface LiveSessionStart { channelId: string; projectPath: string; instruction: string; model?: string; sink: LiveSessionSink; onTurnResult?: (result: string) => void; onEnded?: (notice: string) => void }`
  - `class LiveSessionRegistry { constructor(startFn?, opts?: { throttleMs?: number; idleTimeoutMs?: number }); start(input: LiveSessionStart): boolean; has(channelId: string): boolean; send(channelId: string, text: string): void; stop(channelId: string): boolean; stopAll(): void }`
- Semantics Task 8 relies on: `start()` returns `false` when the channel already has a session. `has()` gates message capture. `stop()` returns `false` for an unknown channel. `onEnded(notice)` fires exactly once per session, after cleanup, with a human-readable notice.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/__test__/chatops-live-sessions.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveSessionRegistry, type LiveSessionSink } from "../src/chatops/live-sessions.js";
import type { LiveSessionCallbacks, LiveSessionHandle, LiveSessionRequest } from "../src/live-session.js";

function fakeStart() {
  const sent: string[] = [];
  let cbs!: LiveSessionCallbacks;
  let stopped = false;
  const startFn = (req: LiveSessionRequest, callbacks: LiveSessionCallbacks): LiveSessionHandle => {
    cbs = callbacks;
    sent.push(req.prompt);
    return {
      pid: 1,
      send: (t) => sent.push(t),
      stop: () => { stopped = true; queueMicrotask(() => cbs.onExit(undefined)); },
    };
  };
  return { startFn, sent, cbs: () => cbs, wasStopped: () => stopped };
}

function fakeSink() {
  const posts: string[] = [];
  const edits: [string, string][] = [];
  const sink: LiveSessionSink = {
    post: async (text) => { posts.push(text); return `msg-${posts.length}`; },
    edit: async (id, text) => { edits.push([id, text]); },
  };
  return { sink, posts, edits };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const flushTicks = async (reg: { /* just to satisfy lint */ } | unknown, ms: number): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
};

describe("LiveSessionRegistry", () => {
  it("start binds the channel; a second start on the same channel is refused", () => {
    const f = fakeStart();
    const reg = new LiveSessionRegistry(f.startFn as never);
    const { sink } = fakeSink();
    expect(reg.start({ channelId: "c", projectPath: "/p", instruction: "go", sink })).toBe(true);
    expect(reg.has("c")).toBe(true);
    expect(reg.start({ channelId: "c", projectPath: "/p", instruction: "again", sink })).toBe(false);
  });

  it("posts buffered output on the throttle tick, then edits the same message", async () => {
    const f = fakeStart();
    const reg = new LiveSessionRegistry(f.startFn as never, { throttleMs: 1000 });
    const s = fakeSink();
    reg.start({ channelId: "c", projectPath: "/p", instruction: "go", sink: s.sink });
    f.cbs().onOutput("line one");
    await flushTicks(reg, 1001);
    expect(s.posts).toEqual(["line one"]);
    f.cbs().onOutput("line two");
    await flushTicks(reg, 1001);
    expect(s.edits).toEqual([["msg-1", "line one\nline two"]]);
  });

  it("rolls over to a new message when the buffer exceeds the limit", async () => {
    const f = fakeStart();
    const reg = new LiveSessionRegistry(f.startFn as never, { throttleMs: 1000 });
    const s = fakeSink();
    reg.start({ channelId: "c", projectPath: "/p", instruction: "go", sink: s.sink });
    f.cbs().onOutput("a".repeat(1500));
    await flushTicks(reg, 1001);
    f.cbs().onOutput("b".repeat(1500));
    await flushTicks(reg, 1001);
    // first message finalized at <=1900 chars, remainder became a new post
    expect(s.posts.length + s.edits.length).toBeGreaterThanOrEqual(2);
    const rendered = [...s.posts, ...s.edits.map(([, t]) => t)];
    expect(Math.max(...rendered.map((t) => t.length))).toBeLessThanOrEqual(1900);
  });

  it("turn completion appends a footer, reports the result, and the next turn starts a fresh message", async () => {
    const f = fakeStart();
    const results: string[] = [];
    const reg = new LiveSessionRegistry(f.startFn as never, { throttleMs: 1000 });
    const s = fakeSink();
    reg.start({ channelId: "c", projectPath: "/p", instruction: "go", sink: s.sink, onTurnResult: (r) => results.push(r) });
    f.cbs().onOutput("working");
    f.cbs().onTurnComplete({ result: "all done", durationMs: 2000, costUsd: 0.01 });
    await flushTicks(reg, 1001);
    expect(results).toEqual(["all done"]);
    expect(s.posts[0]).toContain("working");
    expect(s.posts[0]).toContain("turn done");
    f.cbs().onOutput("next turn output");
    await flushTicks(reg, 1001);
    expect(s.posts[1]).toBe("next turn output"); // fresh message, not an edit
  });

  it("send forwards to the handle; stop tears down and fires onEnded once", async () => {
    const f = fakeStart();
    const notices: string[] = [];
    const reg = new LiveSessionRegistry(f.startFn as never, { throttleMs: 1000 });
    const s = fakeSink();
    reg.start({ channelId: "c", projectPath: "/p", instruction: "go", sink: s.sink, onEnded: (n) => notices.push(n) });
    reg.send("c", "a hint");
    expect(f.sent).toContain("a hint");
    expect(reg.stop("c")).toBe(true);
    await flushTicks(reg, 1);
    expect(f.wasStopped()).toBe(true);
    expect(reg.has("c")).toBe(false);
    expect(notices).toHaveLength(1);
    expect(reg.stop("c")).toBe(false);
  });

  it("a crash exit produces an error notice", async () => {
    const f = fakeStart();
    const notices: string[] = [];
    const reg = new LiveSessionRegistry(f.startFn as never, { throttleMs: 1000 });
    const s = fakeSink();
    reg.start({ channelId: "c", projectPath: "/p", instruction: "go", sink: s.sink, onEnded: (n) => notices.push(n) });
    f.cbs().onExit(new Error("claude exited with code 1"));
    await flushTicks(reg, 1);
    expect(reg.has("c")).toBe(false);
    expect(notices[0]).toContain("code 1");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @bean/core exec vitest run __test__/chatops-live-sessions.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `packages/core/src/chatops/live-sessions.ts`:

```typescript
import {
  startLiveSession as defaultStartLiveSession,
  type LiveSessionCallbacks, type LiveSessionHandle, type LiveSessionRequest, type TurnSummary,
} from "../live-session.js";

/** Surface-agnostic "post or edit a plain text message". Chatops builds this on top of
 * BotEffects: post = postCard({content}), edit = updateCard(id, {content}). */
export interface LiveSessionSink {
  post: (text: string) => Promise<string>;
  edit: (id: string, text: string) => Promise<void>;
}

export interface LiveSessionStart {
  channelId: string;
  projectPath: string;
  instruction: string;
  model?: string;
  sink: LiveSessionSink;
  /** Each completed turn's final result — callers append it to conversation history. */
  onTurnResult?: (result: string) => void;
  /** Fires exactly once, after cleanup, with a human-readable end notice. */
  onEnded?: (notice: string) => void;
}

type StartFn = (
  req: LiveSessionRequest,
  cbs: LiveSessionCallbacks,
  spawnFn?: never,
  idleTimeoutMs?: number,
) => LiveSessionHandle;

// Headroom under Discord's 2000-char message cap (embeds/formatting stay clear of the edge).
const MSG_LIMIT = 1900;
const DEFAULT_THROTTLE_MS = 1500;

function turnFooter(s: TurnSummary): string {
  const parts: string[] = [];
  if (s.durationMs !== undefined) parts.push(`${(s.durationMs / 1000).toFixed(1)}s`);
  if (s.costUsd !== undefined) parts.push(`$${s.costUsd.toFixed(4)}`);
  return `— turn done${parts.length > 0 ? ` (${parts.join(", ")})` : ""}`;
}

interface ActiveSession {
  handle: LiveSessionHandle;
  sink: LiveSessionSink;
  timer: ReturnType<typeof setInterval>;
  /** Current turn's text not yet finalized into a full message — the source of truth;
   * a failed post/edit just leaves it dirty for the next tick. */
  buf: string;
  msgId: string | undefined;
  dirty: boolean;
  rendering: boolean;
  /** Set on turn completion: after the next successful flush, reset for a fresh message. */
  closeAfterFlush: boolean;
  onEnded?: (notice: string) => void;
}

/** channelId → active live session. One session per channel; while bound, the bot routes
 * that channel's messages to the session instead of converse(). */
export class LiveSessionRegistry {
  private byChannel = new Map<string, ActiveSession>();

  constructor(
    private startFn: StartFn = defaultStartLiveSession as StartFn,
    private opts: { throttleMs?: number; idleTimeoutMs?: number } = {},
  ) {}

  has(channelId: string): boolean {
    return this.byChannel.has(channelId);
  }

  start(input: LiveSessionStart): boolean {
    if (this.byChannel.has(input.channelId)) return false;
    const s: ActiveSession = {
      handle: undefined as unknown as LiveSessionHandle,
      sink: input.sink,
      timer: setInterval(() => void this.flush(input.channelId), this.opts.throttleMs ?? DEFAULT_THROTTLE_MS),
      buf: "", msgId: undefined, dirty: false, rendering: false, closeAfterFlush: false,
      onEnded: input.onEnded,
    };
    this.byChannel.set(input.channelId, s);
    s.handle = this.startFn(
      { projectPath: input.projectPath, prompt: input.instruction, model: input.model },
      {
        onOutput: (line) => {
          s.buf += (s.buf ? "\n" : "") + line;
          s.dirty = true;
        },
        onTurnComplete: (summary) => {
          input.onTurnResult?.(summary.result);
          s.buf += (s.buf ? "\n" : "") + turnFooter(summary);
          s.dirty = true;
          s.closeAfterFlush = true;
        },
        onExit: (err) => this.teardown(input.channelId, err),
      },
      undefined,
      this.opts.idleTimeoutMs,
    );
    return true;
  }

  send(channelId: string, text: string): void {
    this.byChannel.get(channelId)?.handle.send(text);
  }

  stop(channelId: string): boolean {
    const s = this.byChannel.get(channelId);
    if (!s) return false;
    s.handle.stop(); // teardown happens via onExit once the process is confirmed dead
    return true;
  }

  stopAll(): void {
    for (const [, s] of this.byChannel) s.handle.stop();
  }

  private teardown(channelId: string, err?: Error): void {
    const s = this.byChannel.get(channelId);
    if (!s) return;
    clearInterval(s.timer);
    this.byChannel.delete(channelId);
    // Final flush of anything buffered, then the end notice.
    void this.flushSession(s).then(() => {
      s.onEnded?.(err ? `Live session died: ${err.message}` : "Live session ended.");
    });
  }

  private async flush(channelId: string): Promise<void> {
    const s = this.byChannel.get(channelId);
    if (s) await this.flushSession(s);
  }

  private async flushSession(s: ActiveSession): Promise<void> {
    if (!s.dirty || s.rendering) return;
    s.rendering = true;
    s.dirty = false;
    try {
      while (s.buf.length > MSG_LIMIT) {
        const cut = s.buf.lastIndexOf("\n", MSG_LIMIT);
        const at = cut > 0 ? cut : MSG_LIMIT;
        const head = s.buf.slice(0, at);
        s.buf = s.buf.slice(at).replace(/^\n/, "");
        if (s.msgId !== undefined) {
          await s.sink.edit(s.msgId, head);
          s.msgId = undefined;
        } else {
          await s.sink.post(head);
        }
      }
      if (s.buf) {
        if (s.msgId !== undefined) await s.sink.edit(s.msgId, s.buf);
        else s.msgId = await s.sink.post(s.buf);
      }
      if (s.closeAfterFlush) {
        s.closeAfterFlush = false;
        s.msgId = undefined;
        s.buf = "";
      }
    } catch {
      // Rate limit or transient send failure: buffer is the source of truth — retry next tick.
      s.dirty = true;
    } finally {
      s.rendering = false;
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @bean/core exec vitest run __test__/chatops-live-sessions.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/chatops/live-sessions.ts packages/core/__test__/chatops-live-sessions.test.ts
git commit -m "feat(chatops): LiveSessionRegistry with throttled stream renderer"
```

---

### Task 8: `bot.ts` wiring — capture, proposal card, card actions

**Files:**
- Modify: `packages/core/src/chatops/bot.ts`
- Test: `packages/core/__test__/chatops-bot.test.ts`

**Interfaces:**
- Consumes: Tasks 4–7 (`LiveSessionProposalStore`, `LiveSessionRegistry`, `proposedLiveSession`, card builders).
- Produces — new required `TeamsBotDeps` fields (Task 9 must supply them in both servers):
  - `liveSessions: LiveSessionRegistry`
  - `liveSessionProposals: LiveSessionProposalStore`
  - `liveSessionsEnabled: () => boolean`
- New card actions: `"start-live"` and `"cancel-live"` (matching Task 6's custom_ids).
- Message capture contract: while `liveSessions.has(conversationId)`, every non-`stop` message is forwarded to the session and converse is bypassed; `stop` (case-insensitive, trimmed) ends the session.

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/__test__/chatops-bot.test.ts`. **Read the file first** and extend its existing deps-builder fixture (it constructs a full `TeamsBotDeps` with fakes — add the three new fields to that builder so every existing test keeps passing):

```typescript
// In the shared deps builder, add:
//   liveSessions: new LiveSessionRegistry(fakeStartFn),
//   liveSessionProposals: new LiveSessionProposalStore(),
//   liveSessionsEnabled: () => false,
// with fakeStartFn a controllable fake as in chatops-live-sessions.test.ts.

it("posts a live-session proposal card when converse proposes one", async () => {
  // deps.chat fake returns a propose_live_session toolCall; liveSessionsEnabled: () => true;
  // detectClis returns ["claude"].
  const { bot, fx, deps } = makeBotWithLiveSessionProposal(); // adapt to the file's fixture helper
  await bot.onMessage({ conversationId: "c1", text: "start live session", fromId: "u", fromName: "sam" }, fx);
  expect(fx.postedCards.some((c) => JSON.stringify(c).includes("start-live"))).toBe(true);
});

it("start-live card action starts the session and binds the channel", async () => {
  const { bot, fx, deps } = makeBotWithLiveSessionProposal();
  await bot.onMessage({ conversationId: "c1", text: "start live session", fromId: "u", fromName: "sam" }, fx);
  const proposalId = latestProposalIdFrom(fx.postedCards); // parse bean:start-live:<id> out of the card JSON
  await bot.onCardAction({ actorName: "sam", value: { beanAction: "start-live", proposalId } }, fx);
  expect(deps.liveSessions.has("c1")).toBe(true);
});

it("channel messages route to an active session instead of converse, and stop ends it", async () => {
  const { bot, fx, deps, chatCalls } = makeBotWithActiveLiveSession("c1"); // registry pre-bound to c1
  await bot.onMessage({ conversationId: "c1", text: "look at the auth module", fromId: "u", fromName: "sam" }, fx);
  expect(chatCalls()).toBe(0); // converse never invoked
  await bot.onMessage({ conversationId: "c1", text: "stop", fromId: "u", fromName: "sam" }, fx);
  expect(deps.liveSessions.has("c1")).toBe(false);
});
```

Adapt helper names to the file's actual fixture functions; the assertions above are the contract.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @bean/core exec vitest run __test__/chatops-bot.test.ts`
Expected: new tests FAIL; existing tests must still pass after the deps-builder gets the three new fields.

- [ ] **Step 3: Implement**

In `packages/core/src/chatops/bot.ts`:

(a) Imports:

```typescript
import { LiveSessionProposalStore, type PendingLiveSession } from "./live-session-proposals.js";
import { LiveSessionRegistry, type LiveSessionSink } from "./live-sessions.js";
```

(b) Add to `TeamsBotDeps`:

```typescript
  /** Active chat-bridged agent sessions; while a channel is bound, its messages bypass converse. */
  liveSessions: LiveSessionRegistry;
  liveSessionProposals: LiveSessionProposalStore;
  /** Gates the propose_live_session tool (config liveSessions flag + surface support). */
  liveSessionsEnabled: () => boolean;
```

(c) Add a start handler beside `startRun`:

```typescript
  async function startLiveSessionAction(p: PendingLiveSession, startedBy: string, fx: BotEffects): Promise<void> {
    const projects = await deps.loadProjects();
    const projectName = projects.find((pr) => pr.path === p.proposal.projectPath)?.name ?? p.proposal.projectPath;
    const updateTo = async (card: object): Promise<void> => {
      if (p.cardActivityId !== undefined) await fx.updateCard(p.cardActivityId, card);
    };
    // Plain-text stream messages ride the card channel: postCard({content}) / updateCard(id, {content}).
    const sink: LiveSessionSink = {
      post: (text) => fx.postCard({ content: text }),
      edit: (id, text) => fx.updateCard(id, { content: text }),
    };
    const started = deps.liveSessions.start({
      channelId: p.conversationId,
      projectPath: p.proposal.projectPath,
      instruction: p.proposal.instruction,
      model: p.proposal.model,
      sink,
      onTurnResult: (result) =>
        deps.conversations.append(p.conversationId, { role: "assistant", content: `[live session] ${result}` }),
      onEnded: (notice) => {
        void updateToEnded();
        void fx.post(notice);
      },
    });
    async function updateToEnded(): Promise<void> {
      await updateTo(deps.cards.liveSessionResultCard({ projectName, startedBy, outcome: "ended" }));
    }
    if (!started) {
      await fx.post("A live session is already running in this channel — say `stop` to end it first.");
      return;
    }
    await updateTo(deps.cards.liveSessionResultCard({ projectName, startedBy, outcome: "started" }));
  }
```

(d) At the very top of `onMessage` (before the `"cancel"` check — an active session owns the channel outright):

```typescript
      if (deps.liveSessions.has(msg.conversationId)) {
        if (msg.text.trim().toLowerCase() === "stop") {
          deps.liveSessions.stop(msg.conversationId);
          return; // the registry's onEnded posts the end notice
        }
        deps.conversations.append(msg.conversationId, { role: "user", content: msg.text });
        deps.liveSessions.send(msg.conversationId, msg.text);
        return;
      }
```

(e) In `converseBase`, add:

```typescript
          liveSessionAvailable: deps.liveSessionsEnabled() && detected.includes("claude"),
```

(f) In `onMessage`'s result handling, after the `result.proposedRun` block (beside `proposedNote`):

```typescript
        if (result.proposedLiveSession) {
          const live = result.proposedLiveSession;
          const projectName = projects.find((p) => p.path === live.projectPath)?.name ?? live.projectPath;
          const pending = deps.liveSessionProposals.add({ proposal: live, conversationId: msg.conversationId, proposedBy: msg.fromName });
          const activityId = await fx.postCard(deps.cards.liveSessionProposalCard({
            proposalId: pending.id, projectName, instruction: live.instruction, model: live.model,
          }));
          deps.liveSessionProposals.setCardActivityId(pending.id, activityId);
          return;
        }
```

(g) In `onCardAction`, add cases following the note-handler pattern:

```typescript
      if (action.value.beanAction === "start-live" || action.value.beanAction === "cancel-live") {
        const proposalId = action.value.proposalId;
        if (!proposalId) return;
        const pending = deps.liveSessionProposals.claim(proposalId);
        if (!pending) {
          await fx.post("That live-session proposal expired — ask me to start one again.");
          return;
        }
        if (action.value.beanAction === "cancel-live") {
          const projects = await deps.loadProjects();
          const projectName = projects.find((p) => p.path === pending.proposal.projectPath)?.name ?? pending.proposal.projectPath;
          if (pending.cardActivityId !== undefined) {
            await fx.updateCard(pending.cardActivityId, deps.cards.liveSessionResultCard({ projectName, startedBy: actorName, outcome: "cancelled" }));
          }
          return;
        }
        await startLiveSessionAction(pending, actorName, fx);
        return;
      }
```

(Match `actorName` to whatever identifier `onCardAction` already uses for the acting user — read the surrounding handlers and use the same variable.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @bean/core exec vitest run __test__/chatops-bot.test.ts`
Expected: PASS — new tests and all pre-existing ones.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/chatops/bot.ts packages/core/__test__/chatops-bot.test.ts
git commit -m "feat(chatops): live-session capture, proposal card, and card actions in bot"
```

---

### Task 9: exports + server wiring (Discord on, Teams off)

**Files:**
- Modify: `packages/core/src/index.ts`
- Modify: `packages/discord/src/server.ts`
- Modify: `packages/teams/src/server.ts`

**Interfaces:**
- Consumes: everything above via `@bean/core`.
- Produces: running feature on Discord. Teams compiles with the feature disabled.

- [ ] **Step 1: Re-export from core**

In `packages/core/src/index.ts`, beside the delegate/chatops exports add:

```typescript
export * from "./live-session.js";
export * from "./chatops/live-sessions.js";
export * from "./chatops/live-session-proposals.js";
```

(Match the file's existing export style — if it uses named exports rather than `export *`, list: `startLiveSession`, `liveSessionCommand`, `userTurnLine`, `claudeTurnSummary`, `LIVE_SESSION_IDLE_MS`, types `LiveSessionRequest`/`LiveSessionCallbacks`/`LiveSessionHandle`/`LiveSessionSpawnFn`/`TurnSummary`, `LiveSessionRegistry`, types `LiveSessionSink`/`LiveSessionStart`, `LiveSessionProposalStore`, type `PendingLiveSession`.)

- [ ] **Step 2: Wire Discord**

In `packages/discord/src/server.ts`:

```typescript
// add to the @bean/core import list:
LiveSessionProposalStore, LiveSessionRegistry,
```

Above the `buildTeamsBot` call:

```typescript
const liveSessions = new LiveSessionRegistry();
```

Add to the `buildTeamsBot({...})` deps:

```typescript
  liveSessions,
  liveSessionProposals: new LiveSessionProposalStore(),
  liveSessionsEnabled: () => beanConfig.liveSessions && clis.includes("claude"),
```

Find where the server handles shutdown (search for `interruptAll` / `SIGTERM` / `exitWhenOrphaned` usage in this file) and add `liveSessions.stopAll();` alongside the existing run interruption so orphaned claude processes don't outlive the bot.

- [ ] **Step 3: Wire Teams (disabled)**

In `packages/teams/src/server.ts`, add the same imports and deps but hard-off:

```typescript
  liveSessions: new LiveSessionRegistry(),
  liveSessionProposals: new LiveSessionProposalStore(),
  liveSessionsEnabled: () => false, // live sessions are Discord-first; Teams sink untested (spec: out of scope)
```

- [ ] **Step 4: Full validation gate**

Run: `pnpm test && pnpm typecheck`
Expected: both exit 0 across all four packages.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/index.ts packages/discord/src/server.ts packages/teams/src/server.ts
git commit -m "feat(discord): wire live sessions behind liveSessions config flag"
```

---

### Task 10: manual smoke test + memory entry

**Files:**
- Create: `.memory/project-live-sessions.md`
- Modify: `.memory/INDEX.md`

**Interfaces:** none — verification and documentation.

- [ ] **Step 1: Build and run the Discord bot from this checkout**

```bash
pnpm build
# temporarily set "liveSessions": true in ~/.bean/config.json
node packages/discord/dist/server.js
```

Expected: bot logs in; no startup errors.

- [ ] **Step 2: Smoke-test the full loop in a test Discord channel**

1. `@Bean start a live coding session on <project>, summarize the repo structure` → proposal card appears.
2. Tap **Start session** → card flips to "Live session started"; agent output starts streaming as an edited message; a `— turn done (…)` footer appears when the turn ends.
3. Post a follow-up message (no @mention needed) → it becomes the agent's next turn; new output streams in a fresh message.
4. Say `stop` → "Live session ended." posts; a further @Bean message gets a normal converse reply (channel released).
5. Confirm the `claude` process is gone: `pgrep -fl "claude -p"` shows nothing from this session.

Also verify the crash path once: start a session, `kill -9` the claude pid, expect "Live session died: …" in the channel and the channel released.

Per AGENTS.md dev/compiled verification: the Discord bot ships as `node dist/server.js` (no Electron packaging involved), so this compiled-server smoke test IS the packaged-world check for this feature.

- [ ] **Step 3: Write the memory entry**

Create `.memory/project-live-sessions.md`:

```markdown
# Live sessions (chat-bridged interactive agent)

- `core/live-session.ts` = multi-turn sibling of `delegate.ts`: long-lived
  `claude -p --input-format stream-json --output-format stream-json --verbose
  --dangerously-skip-permissions`, user turns written as JSON lines to stdin, one `result`
  event per turn. Permissions bypass is a deliberate spec decision (true bypass, NOT the
  UI's "Auto" mode) — see docs/superpowers/specs/2026-07-18-live-sessions-design.md.
- `chatops/live-sessions.ts` `LiveSessionRegistry` binds channelId → session; while bound,
  `bot.onMessage` routes the channel's messages to the session (converse bypassed) until
  `stop` or the 30-min idle timeout. The render buffer is the source of truth — failed
  Discord edits retry on the next 1.5s tick, output is never lost.
- The stream sink rides BotEffects: `postCard({content})` / `updateCard(id, {content})` —
  works on Discord (plain MessageCreateOptions), NOT on Teams (adaptive-card attachment),
  which is why Teams passes `liveSessionsEnabled: () => false`. Enabling Teams needs a
  real text-post-and-edit path there first.
- Feature is invisible unless `~/.bean/config.json` has `"liveSessions": true` AND
  `claude` is on PATH.
```

Add to `.memory/INDEX.md` under the project entries:

```markdown
- [project-live-sessions](project-live-sessions.md) — chat-bridged interactive agent sessions: stream-json bridge, channel capture, why Teams is off
```

- [ ] **Step 4: Restore config and commit**

Set `"liveSessions"` back to your preferred value in `~/.bean/config.json` (it is per-user, not repo state).

```bash
git add .memory/project-live-sessions.md .memory/INDEX.md
git commit -m "docs(memory): record live-sessions subsystem gotchas"
```
