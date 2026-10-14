// packages/core/__test__/routine-host.test.ts
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoutineHost, type RoutineHostDeps, type RoutineHostStatus } from "../src/routine-host.js";
import type { Routine, RoutineStep } from "../src/routine-store.js";
import type { DelegateStepRequest } from "../src/routine-runner.js";
import type { ToolSpec } from "../src/converse.js";
import { dbFile, outboxDir } from "../src/config.js";
import { claimOutbox } from "../src/outbox.js";
import { loadNotes } from "../src/note-store.js";
import { reserveRun } from "../src/run-queue.js";
import { listStepAttempts } from "../src/step-attempts.js";
import { saveSkillProposals } from "../src/retro.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "bean-host-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const routine = (steps: RoutineStep[], over: Partial<Routine> = {}): Routine =>
  ({ name: "r", enabled: true, cron: "0 6 * * *", steps, sinks: {}, ...over });

function host(over: Partial<RoutineHostDeps> = {}) {
  const status: RoutineHostStatus[] = [];
  const toolNames: string[][] = [];
  const deps: RoutineHostDeps = {
    dir,
    converse: async (a) => { toolNames.push(a.tools.map((t: ToolSpec) => t.name)); return { content: "the digest", toolCalls: [] }; },
    getModel: () => "gpt-test",
    delegateStep: async (_req, onSession) => {
      onSession?.("claude", "11111111-2222-3333-4444-555555555555", join(dir, "workspace"));
      return { output: "delegate output", cli: "claude" };
    },
    commandStep: async () => ({ exitCode: 0, output: "cmd ok" }),
    tools: [],
    loadSkills: async () => [],
    memories: async () => [],
    getRoutineDigestContext: () => true,
    onStatus: (e) => status.push(e),
    newId: () => "id-1",
    ...over,
  };
  return { ...createRoutineHost(deps), status, toolNames };
}

describe("createRoutineHost", () => {
  it("runs a lone delegate step: verbatim digest + resume footer, status start/step/finish, attempt recorded", async () => {
    const h = host();
    const res = await h.runOneRoutine(routine([{ kind: "delegate", instruction: "check the build please" }]));
    const footer = "\n\nResume a delegate session:\nstep 1 (workspace) — claude --resume 11111111-2222-3333-4444-555555555555";
    expect(res.record.status).toBe("ok");
    expect(res.digest).toBe(`delegate output${footer}`);
    expect(res.record.digest).toBe(`delegate output${footer}`);
    expect(h.status).toEqual([
      { type: "start", id: "routine:r", name: "r", detail: "", steps: ["check the build please"], startedAt: expect.any(Number) },
      { type: "step", id: "routine:r", step: 0, line: "check the build please" },
      { type: "finish", id: "routine:r", state: "done", line: "Done · 1 step" },
    ]);
    expect(listStepAttempts(dbFile(dir), res.record.id!)).toHaveLength(1);
  });

  it("names the project in a receipt and reports a failed step", async () => {
    const h = host({
      delegateStep: async (_req, onSession) => {
        onSession?.("codex", "abc", "/work/proj");
        throw new Error("boom");
      },
    });
    const res = await h.runOneRoutine(routine([{ kind: "delegate", project: "/work/proj", instruction: "x" }]));
    expect(res.record.status).toBe("failed");
    expect(res.digest).toContain("step 1 (proj) — codex resume abc");
    expect(h.status.at(-1)).toEqual({ type: "finish", id: "routine:r", state: "failed", line: "Finished with a failed step" });
  });

  it("gives chat steps the host tools plus save_note", async () => {
    const extra = { spec: { name: "fetch_url", description: "", parameters: {} }, run: async () => "" };
    const h = host({ tools: [extra] });
    await h.runOneRoutine(routine([{ kind: "chat", instruction: "hi" }]));
    expect(h.toolNames[0]).toEqual(["fetch_url", "save_note"]);
  });

  it("gated run: holds reservations/scratch across rounds, releases them at the end, labels rounds", async () => {
    const project = join(dir, "proj");
    const scratch = join(dir, "scratch-todo");
    const holds: unknown[] = [];
    let reviews = 0;
    const delegateStep = vi.fn(async (req: DelegateStepRequest, onSession, hold) => {
      holds.push(hold);
      if (hold && !hold.reserved.has(project)) { expect(reserveRun(dir, project, process.pid, () => "x")).toBeTruthy(); hold.reserved.add(project); }
      if (hold) { mkdirSync(scratch, { recursive: true }); hold.scratch.add(scratch); }
      onSession?.("claude", `s${holds.length}`, project);
      const isReview = req.instruction.startsWith("review");
      return { output: isReview ? (++reviews === 1 ? "bad\nVERDICT: FAIL" : "good\nVERDICT: PASS") : "built", cli: "claude" as const };
    }) as RoutineHostDeps["delegateStep"];
    const h = host({ delegateStep });
    const res = await h.runOneRoutine(routine([
      { kind: "delegate", id: "build", project, instruction: "build it" },
      { kind: "delegate", id: "review", project, instruction: "review it", gate: { onFail: { goto: "build", maxRounds: 3 } } },
    ]));
    expect(res.record.status).toBe("ok");
    expect(holds.every((x) => x && x === holds[0])).toBe(true);
    expect(existsSync(scratch)).toBe(false);
    expect(reserveRun(dir, project, process.pid, () => "y")).toBeTruthy(); // released
    expect(res.digest).toContain("step 1 (proj) — claude --resume s1\nstep 2 (proj) — claude --resume s2\nstep 1 round 2 (proj) — claude --resume s3\nstep 2 round 2 (proj) — claude --resume s4");
    expect(h.status.some((e) => e.type === "step" && e.line.includes("round 2/3"))).toBe(true);
  });

  it("appends the waiting-proposals footer to retro routines only", async () => {
    saveSkillProposals(dbFile(dir), [{
      id: "p1", routine: "r", skill: "s", baseHash: "h", body: "b", rationale: "why", evidence: [], createdAt: new Date().toISOString(),
    }]);
    const plain = await host().runOneRoutine(routine([{ kind: "chat", instruction: "hi" }]));
    expect(plain.digest).not.toContain("skill proposal");
    const retro = await host().runOneRoutine(routine([{ kind: "chat", skill: "retro", instruction: "look back" }]));
    expect(retro.digest).toContain("1 skill proposal waiting in Bean → Skills");
  });

  it("delivers a digest to the note, chatops outbox and notify sinks", async () => {
    const notify = vi.fn(async () => {});
    const h = host({ notify });
    const r = routine([], { sinks: { note: true, notify: true, chatops: [{ transport: "discord", channel: "c1" }] } });
    await h.deliverDigest(r, { digest: "hello", results: [], record: {} as never });
    const notes = await loadNotes(dbFile(dir));
    expect(notes.map((n) => [n.slug, n.title, n.body])).toEqual([["routine-r", "routine: r", "hello"]]);
    const out = await claimOutbox(outboxDir(dir), "discord");
    expect(out).toEqual([expect.objectContaining({ id: "id-1", transport: "discord", channel: "c1", title: "Routine: r", body: "hello", context: true })]);
    expect(notify).toHaveBeenCalledWith({ title: "Routine: r", body: "hello" });
  });

  it("skips the notify sink when the host has no notifier", async () => {
    const h = host();
    await expect(h.deliverDigest(routine([], { sinks: { notify: true } }), { digest: "x", results: [], record: {} as never })).resolves.toBeUndefined();
  });
});
