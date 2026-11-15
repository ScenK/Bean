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
import { listStepAttempts } from "../src/step-attempts.js";
import { saveSkillProposals } from "../src/retro.js";
import { addTodo, claimTodo, listTodos } from "../src/todo-store.js";

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
    delegateStep: async () => ({ output: "delegate output", cli: "claude", sessionId: "11111111-2222-3333-4444-555555555555" }),
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
  it("a claimed todo runs as its own bubble (routine:<name>:<todoId>, todo text label) in its own scratch dir", async () => {
    const reqs: DelegateStepRequest[] = [];
    const h = host({ delegateStep: async (req) => { reqs.push(req); return { output: "fixed", cli: "claude" }; } });
    await addTodo(dbFile(dir), "r", "fix the login bug");
    const todo = (await claimTodo(dbFile(dir), "r"))!;
    const res = await h.runOneRoutine(routine([{ kind: "delegate", instruction: "work" }], { todoDriven: true, maxParallel: 2 }), todo);
    expect(res.record.status).toBe("ok");
    expect(h.status[0]).toMatchObject({ type: "start", id: `routine:r:${todo.id}`, name: "fix the login bug", routine: "r", detail: "Sprout: r" });
    expect(h.status.at(-1)).toMatchObject({ type: "finish", id: `routine:r:${todo.id}`, state: "done" });
    expect(reqs[0]?.todoId).toBe(todo.id);
    expect((await listTodos(dbFile(dir), "r"))[0]?.status).toBe("done");
  });

  it("a claimed todo ends failed when the skills can't load", async () => {
    const h = host({ loadSkills: async () => { throw new Error("skills dir unreadable"); } });
    await addTodo(dbFile(dir), "r", "t");
    const todo = (await claimTodo(dbFile(dir), "r"))!;
    await expect(h.runOneRoutine(routine([{ kind: "chat", instruction: "x" }], { todoDriven: true, maxParallel: 2 }), todo)).rejects.toThrow("unreadable");
    expect((await listTodos(dbFile(dir), "r"))[0]).toMatchObject({ status: "failed", resultSummary: "skills dir unreadable" });
    expect(h.status.at(-1)).toMatchObject({ type: "finish", state: "failed" });
  });

  it("runs a lone delegate step: verbatim digest with no session footer, status start/step/finish, attempt recorded", async () => {
    const h = host();
    const res = await h.runOneRoutine(routine([{ kind: "delegate", instruction: "check the build please" }]));
    expect(res.record.status).toBe("ok");
    // Session ids stay out of what sinks receive; the Dashboard reads them from the attempt.
    expect(res.digest).toBe("delegate output");
    expect(res.record.digest).toBe("delegate output");
    expect(h.status).toEqual([
      { type: "start", id: "routine:r", name: "r", routine: "r", detail: "", steps: ["check the build please"], startedAt: expect.any(Number) },
      { type: "step", id: "routine:r", step: 0, line: "check the build please" },
      { type: "finish", id: "routine:r", state: "done", line: "Done · 1 step", startedAt: res.record.startedAt },
    ]);
    expect(listStepAttempts(dbFile(dir), res.record.id!)).toMatchObject([{ sessionId: "11111111-2222-3333-4444-555555555555" }]);
  });

  it("reports a failed step", async () => {
    const h = host({
      delegateStep: async () => { throw new Error("boom"); },
    });
    const res = await h.runOneRoutine(routine([{ kind: "delegate", project: "/work/proj", instruction: "x" }]));
    expect(res.record.status).toBe("failed");
    expect(h.status.at(-1)).toEqual({ type: "finish", id: "routine:r", state: "failed", line: "Finished with a failed step", startedAt: res.record.startedAt });
  });

  // The Dashboard keys a run by its record's startedAt; with no record there's nothing to name.
  it("finish carries no startedAt when the run threw", async () => {
    const threw = host({ getModel: () => { throw new Error("no model"); } });
    await expect(threw.runOneRoutine(routine([{ kind: "chat", instruction: "hi" }]))).rejects.toThrow("no model");
    expect(threw.status.at(-1)).toEqual({ type: "finish", id: "routine:r", state: "failed", line: "Run failed" });
  });

  it("gives chat steps the host tools plus save_note", async () => {
    const extra = { spec: { name: "fetch_url", description: "", parameters: {} }, run: async () => "" };
    const h = host({ tools: [extra] });
    await h.runOneRoutine(routine([{ kind: "chat", instruction: "hi" }]));
    expect(h.toolNames[0]).toEqual(["fetch_url", "save_note"]);
  });

  it("gated run: holds scratch across rounds, removes it at the end, labels rounds", async () => {
    const project = join(dir, "proj");
    const scratch = join(dir, "scratch-todo");
    const holds: unknown[] = [];
    let reviews = 0;
    const delegateStep = vi.fn(async (req: DelegateStepRequest, hold) => {
      holds.push(hold);
      if (hold) { mkdirSync(scratch, { recursive: true }); hold.scratch.add(scratch); }
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
    await h.deliverDigest(r, { digest: "hello", results: [], record: { startedAt: "2026-10-23T06:00:00.000Z" } as never });
    const notes = await loadNotes(dbFile(dir));
    expect(notes.map((n) => [n.slug, n.title, n.body])).toEqual([["routine-r", "sprout: r", "hello"]]);
    const out = await claimOutbox(outboxDir(dir), "discord");
    expect(out).toEqual([expect.objectContaining({ id: "id-1", transport: "discord", channel: "c1", title: "Sprout: r", body: "hello", context: true })]);
    expect(notify).toHaveBeenCalledWith({
      title: "Sprout: r", body: "hello", target: { routine: "r", startedAt: "2026-10-23T06:00:00.000Z" },
    });
  });

  it("maps a user sink to outbox userId with a whose-routine footer", async () => {
    const h = host();
    const r = routine([], { sinks: { chatops: [{ transport: "discord", user: "u1" }] } });
    await h.deliverDigest(r, { digest: "hello", results: [], record: { startedAt: "2026-10-23T06:00:00.000Z" } as never });
    const [msg] = await claimOutbox(outboxDir(dir), "discord");
    expect(msg).toMatchObject({ userId: "u1", body: 'hello\n\n_Sent by Bean\'s owner\'s sprout "r"._' });
    expect(msg?.channel).toBeUndefined();
  });

  it("chatopsOnlyOnProblems: ok posts no chat message; failed / needs-attention post one per sink; note + notify fire for all", async () => {
    const sinks = { note: true, notify: true, chatops: [{ transport: "discord" as const }, { transport: "teams" as const, channel: "conv" }] };
    const run = async (status: "ok" | "failed" | "needs-attention", flag?: boolean) => {
      const notify = vi.fn(async () => {});
      let n = 0;
      const h = host({ notify, newId: () => `id-${status}-${n++}` });
      const r = routine([{ kind: "chat", instruction: "x" }], { sinks: { ...sinks, ...(flag === undefined ? {} : { chatopsOnlyOnProblems: flag }) } });
      await h.deliverDigest(r, { digest: `d-${status}`, results: [], record: { startedAt: "2026-10-23T06:00:00.000Z", status } as never });
      const posted = [...await claimOutbox(outboxDir(dir), "discord"), ...await claimOutbox(outboxDir(dir), "teams")];
      const notes = await loadNotes(dbFile(dir));
      return { posted: posted.length, notified: notify.mock.calls.length, note: notes[0]?.body };
    };
    expect(await run("ok", true)).toEqual({ posted: 0, notified: 1, note: "d-ok" });
    expect(await run("failed", true)).toEqual({ posted: 2, notified: 1, note: "d-failed" });
    expect(await run("needs-attention", true)).toEqual({ posted: 2, notified: 1, note: "d-needs-attention" });
    // Without the flag (or with it off) every run posts.
    expect(await run("ok")).toEqual({ posted: 2, notified: 1, note: "d-ok" });
    expect(await run("ok", false)).toEqual({ posted: 2, notified: 1, note: "d-ok" });
  });

  it("chatopsOnlyOnProblems doesn't mute a notify-only watch fire (always ok)", async () => {
    const h = host();
    const r = routine([], { cron: undefined, watch: { kind: "feed", url: "https://x" }, sinks: { chatops: [{ transport: "discord" }], chatopsOnlyOnProblems: true } });
    await h.deliverDigest(r, { digest: "new item", results: [], record: { status: "ok" } as never });
    expect(await claimOutbox(outboxDir(dir), "discord")).toHaveLength(1);
  });

  describe("chat brief", () => {
    const REPORT = "Checked 3 repos. PR #42 is green: https://github.com/x/y/pull/42 — merged at 10:15.";
    const BRIEF = "I checked 3 repos for you. PR #42 is green (https://github.com/x/y/pull/42), and I merged it at 10:15.";
    const sinks = { note: true, notify: true, chatops: [{ transport: "discord" as const }, { transport: "teams" as const, channel: "conv" }] };
    /** A converse fake: step calls answer with the report, the brief call (system starts with the persona) with BRIEF. */
    const briefHost = (over: Partial<RoutineHostDeps> = {}, brief = BRIEF) => {
      const calls: { model: string; system: string }[] = [];
      const notify = vi.fn(async () => {});
      let n = 0;
      const h = host({
        notify, newId: () => `id-${n++}`,
        converse: async (a) => {
          const system = String(a.messages[0]?.content ?? "");
          if (system.includes("fidelity rules")) { calls.push({ model: a.model, system }); return { content: brief, toolCalls: [] }; }
          return { content: REPORT, toolCalls: [] };
        },
        ...over,
      });
      return { h, calls, notify };
    };
    const posted = async () => [...await claimOutbox(outboxDir(dir), "discord"), ...await claimOutbox(outboxDir(dir), "teams")];

    it("an ok single-step run posts one brief to every chat sink; record, note and notification keep the digest", async () => {
      const { h, calls, notify } = briefHost({ loadPersona: async () => ({ name: "Pip", tags: ["Playful"] }) });
      const r = routine([{ kind: "chat", instruction: "check" }], { sinks });
      const res = await h.runOneRoutine(r);
      await h.deliverDigest(r, res);
      expect(res.digest).toBe(REPORT);
      expect(res.record.digest).toBe(REPORT);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.model).toBe("gpt-test");
      expect(calls[0]!.system).toContain("You are Pip");
      expect(calls[0]!.system).not.toContain(REPORT);
      expect((await posted()).map((m) => m.body)).toEqual([BRIEF, BRIEF]);
      expect((await loadNotes(dbFile(dir)))[0]?.body).toBe(REPORT);
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({ body: REPORT }));
    });

    it("the brief is written from every step; a skipped brief posts the final step's output, not the digest", async () => {
      const users: string[] = [];
      let reply = "Shipped: PR #7 is open.";
      let n = 0;
      const h = host({ newId: () => `id-${n++}`, converse: async (a) => { users.push(String(a.messages[1]?.content)); return { content: reply, toolCalls: [] }; } });
      const r = routine([{ kind: "chat", instruction: "a" }, { kind: "chat", instruction: "b" }], { sinks: { chatops: [{ transport: "discord" }] } });
      const step = (index: number, output: string) => ({ index, kind: "chat" as const, ok: true, output });
      const res = { digest: "DIGEST", results: [step(0, "implemented 12 files\nROUTE: ready"), step(1, "PR #7 is open\nVERDICT: PASS")], record: { status: "ok" } as never };
      await h.deliverDigest(r, res);
      expect(users).toEqual([expect.stringContaining("implemented 12 files\n\nPR #7 is open")]);
      reply = "I merged 99 PRs."; // a number the run never reported
      await h.deliverDigest(r, res);
      expect((await claimOutbox(outboxDir(dir), "discord")).map((m) => m.body)).toEqual(["Shipped: PR #7 is open.", "PR #7 is open"]);
    });

    it("an ok multi-step run is briefed from the step outputs, with one brief call", async () => {
      const { h, calls } = briefHost({}, `${BRIEF}\n\n${BRIEF}`);
      const r = routine([{ kind: "chat", instruction: "a" }, { kind: "chat", instruction: "b" }], { sinks });
      const res = await h.runOneRoutine(r);
      await h.deliverDigest(r, res);
      expect(calls).toHaveLength(1);
      expect(res.digest).toBe(REPORT); // the composed digest (the fake answers every non-brief call alike)
      expect((await posted()).map((m) => m.body)).toEqual([`${BRIEF}\n\n${BRIEF}`, `${BRIEF}\n\n${BRIEF}`]);
    });

    it("briefModel wins when set; the retro footer follows the brief once, unchanged", async () => {
      const { h, calls } = briefHost({ getBriefModel: () => "small-m" });
      const r = routine([{ kind: "chat", instruction: "check" }], { sinks });
      const res = await h.runOneRoutine(r);
      await h.deliverDigest(r, { ...res, digest: `${res.digest}\n\n1 skill proposal waiting in Bean → Skills`, footer: "\n\n1 skill proposal waiting in Bean → Skills" });
      expect(calls[0]!.model).toBe("small-m");
      expect((await posted())[0]?.body).toBe(`${BRIEF}\n\n1 skill proposal waiting in Bean → Skills`);
    });

    it("a reply that fails the guard posts the final step's output as it is", async () => {
      const { h, calls } = briefHost({}, "All good after 99 tries!"); // a number the run never reported
      const r = routine([{ kind: "chat", instruction: "check" }], { sinks });
      await h.deliverDigest(r, await h.runOneRoutine(r));
      expect(calls).toHaveLength(1);
      expect((await posted()).map((m) => m.body)).toEqual([REPORT, REPORT]);
    });

    it("verbatim shapes make no brief call: not ok, stepless, no pending todos, chatopsVerbatim, muted, no chat sink", async () => {
      const { h, calls } = briefHost();
      const okResult = await h.runOneRoutine(routine([{ kind: "chat", instruction: "check" }]));
      calls.length = 0;
      const deliver = (over: Partial<Routine>, res = okResult) => h.deliverDigest(routine([{ kind: "chat", instruction: "check" }], { sinks, ...over }), res);
      await deliver({}, { ...okResult, record: { ...okResult.record, status: "failed" } });
      await deliver({}, { ...okResult, record: { ...okResult.record, status: "needs-attention" } });
      await deliver({}, { ...okResult, results: [] }); // stepless / "No pending todos"
      await deliver({ sinks: { ...sinks, chatopsVerbatim: true } });
      expect(calls).toHaveLength(0);
      expect((await posted()).map((m) => m.body).every((b) => b === REPORT)).toBe(true);
      await deliver({ sinks: { ...sinks, chatopsOnlyOnProblems: true } });
      await deliver({ sinks: { note: true } });
      expect(calls).toHaveLength(0);
    });
  });

  it("skips the notify sink when the host has no notifier", async () => {
    const h = host();
    await expect(h.deliverDigest(routine([], { sinks: { notify: true } }), { digest: "x", results: [], record: {} as never })).resolves.toBeUndefined();
  });
});
