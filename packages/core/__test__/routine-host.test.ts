// packages/core/__test__/routine-host.test.ts
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { openDispatch } from "../src/dispatch-store.js";
import { listPendingHomePosts } from "../src/home-posts.js";
import { postTurn } from "../src/prompt.js";

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
    expect(res.todoIds).toEqual([todo.id]); // what a drain's sink skip checks (#920)
  });

  it("a claimed todo ends failed when the skills can't load", async () => {
    const h = host({ loadSkills: async () => { throw new Error("skills dir unreadable"); } });
    await addTodo(dbFile(dir), "r", "t");
    const todo = (await claimTodo(dbFile(dir), "r"))!;
    await expect(h.runOneRoutine(routine([{ kind: "chat", instruction: "x" }], { todoDriven: true, maxParallel: 2 }), todo)).rejects.toThrow("unreadable");
    expect((await listTodos(dbFile(dir), "r"))[0]).toMatchObject({ status: "failed", resultSummary: "skills dir unreadable" });
    expect(h.status.at(-1)).toMatchObject({ type: "finish", state: "failed" });
  });

  it("labels bubble steps by their hand-chosen id, so steps sharing a skill read apart", async () => {
    const h = host();
    await h.runOneRoutine(routine([
      { kind: "delegate", id: "implement", skill: "dev", instruction: "a" },
      { kind: "delegate", id: "dev-2", skill: "dev", instruction: "b" },
      { kind: "command", command: "true" },
    ])).catch(() => {});
    expect(h.status[0]).toMatchObject({ type: "start", steps: ["implement", "dev", "true"] });
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

  it("a quiet run is recorded only: no note, Home post, outbox entry or notification; a requested brief gets its line", async () => {
    const notify = vi.fn(async () => {});
    const onHomePost = vi.fn();
    const h = host({ notify, onHomePost, delegateStep: async () => ({ output: "Nothing new upstream.\nROUTE: nothing" }) });
    const r = routine([
      { kind: "delegate", id: "d", instruction: "look", route: { paths: [{ when: "news", goto: "end" }, { when: "nothing", goto: "quiet" }] } },
    ], { sinks: { note: true, notify: true, home: {}, chatops: [{ transport: "discord", channel: "c1" }] } });
    const res = await h.runOneRoutine(r);
    expect(res.record.quiet).toBe("Nothing new upstream.");
    expect(h.status.at(-1)).toMatchObject({ type: "finish", state: "done", line: "Checked · nothing new" });
    await expect(h.deliverDigest(r, res)).resolves.toBeUndefined();
    await expect(h.deliverDigest(r, res, true)).resolves.toBe(res.digest);
    expect(await loadNotes(dbFile(dir))).toEqual([]);
    expect(listPendingHomePosts(dbFile(dir))).toEqual([]);
    expect(await claimOutbox(outboxDir(dir), "discord")).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
    expect(onHomePost).not.toHaveBeenCalled();
  });

  it("an ending (done / expiry) is chat context and isn't muted by only-on-problems; a done brief keeps the next-step line", async () => {
    let n = 0;
    const h = host({
      newId: () => `id-${++n}`,
      delegateStep: async () => ({ output: "It's out at $499.\nROUTE: found" }),
      converse: async () => ({ content: "Heads up: it's out at $499.", toolCalls: [] }),
    });
    const r = routine([
      { kind: "delegate", id: "d", instruction: "look", route: { paths: [{ when: "found", goto: "done" }, { when: "nothing", goto: "quiet" }] } },
    ], { sinks: { chatopsOnlyOnProblems: true, chatops: [{ transport: "discord", channel: "c1" }] } });
    const res = await h.runOneRoutine(r);
    await h.deliverDigest(r, res);
    const expired = { digest: "Nothing by Dec 20, 2026 — extend?", results: [], ending: "expired" as const, record: { startedAt: "x", finishedAt: "x", status: "ok" as const, digest: "", steps: [] } };
    await h.deliverDigest(r, expired);
    const out = await claimOutbox(outboxDir(dir), "discord");
    expect(out.map((m) => [m.body, m.context])).toEqual([
      [expect.stringMatching(/^Heads up: it's out at \$499\.\n\nWant me to keep watching\?/), true],
      ["Nothing by Dec 20, 2026 — extend?", true],
    ]);
    // The asking chat isn't skipped for an ending: its dispatch notice doesn't carry the question.
    await h.deliverDigest(r, res, false, { transport: "discord", channel: "c1" });
    expect((await claimOutbox(outboxDir(dir), "discord")).map((m) => m.body)).toEqual([expect.stringContaining("Want me to keep watching?")]);
    // An ordinary ok run stays muted.
    await h.deliverDigest(r, { ...res, ending: undefined, record: { ...res.record, done: undefined } });
    expect(await claimOutbox(outboxDir(dir), "discord")).toEqual([]);
  });

  it("maps a user sink to outbox userId with a whose-routine footer", async () => {
    const h = host();
    const r = routine([], { sinks: { chatops: [{ transport: "discord", user: "u1" }] } });
    await h.deliverDigest(r, { digest: "hello", results: [], record: { startedAt: "2026-10-23T06:00:00.000Z" } as never });
    const [msg] = await claimOutbox(outboxDir(dir), "discord");
    expect(msg).toMatchObject({ userId: "u1", body: 'hello\n\n_Sent by Bean\'s owner\'s sprout "r"._', context: true });
    expect(msg?.channel).toBeUndefined();
  });

  it("every digest is chat context (#1066): owner DM, channel and member DM alike", async () => {
    let n = 0;
    const h = host({ newId: () => `id-${n++}` });
    const r = routine([], { sinks: { chatops: [{ transport: "discord" }, { transport: "discord", channel: "c1" }, { transport: "discord", user: "u1" }] } });
    await h.deliverDigest(r, { digest: "hello", results: [], record: { startedAt: "2026-10-23T06:00:00.000Z", status: "ok" } as never });
    expect((await claimOutbox(outboxDir(dir), "discord")).map((m) => m.context)).toEqual([true, true, true]);
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

  it("skips a chat sink that resolves to the origin; other sinks still get the digest", async () => {
    const notify = vi.fn(async () => {});
    let n = 0;
    const h = host({ notify, newId: () => `id-${n++}` });
    const chatops = [
      { transport: "discord" as const, channel: "c1" }, // the origin: skipped
      { transport: "discord" as const, channel: "c1-thread" }, // a thread isn't its parent channel
      { transport: "teams" as const, channel: "c1" }, // another transport
      { transport: "discord" as const, user: "u2" }, // a member's DM, not the owner's
    ];
    const r = routine([], { sinks: { note: true, notify: true, chatops } });
    const result = { digest: "hello", results: [], record: { startedAt: "2026-10-23T06:00:00.000Z", status: "ok" } as never };
    await h.deliverDigest(r, result, false, { transport: "discord", channel: "c1" });
    const posted = [...await claimOutbox(outboxDir(dir), "discord"), ...await claimOutbox(outboxDir(dir), "teams")];
    expect(posted.map((m) => [m.transport, m.channel ?? m.userId])).toEqual(expect.arrayContaining([["discord", "c1-thread"], ["teams", "c1"], ["discord", "u2"]]));
    expect(posted).toHaveLength(3);
    expect(notify).toHaveBeenCalledTimes(1);
    expect((await loadNotes(dbFile(dir)))[0]?.body).toBe("hello");
    // An owner-DM origin matches an owner-DM sink.
    await h.deliverDigest(routine([], { sinks: { chatops: [{ transport: "teams" }, { transport: "teams", user: "x" }] } }), result, false, { transport: "teams" });
    expect(await claimOutbox(outboxDir(dir), "teams")).toEqual([]); // Teams ignores `user`: both are the owner's DM
  });

  it("a drain skips the origin's sink only when every todo of the run was dispatched from it", async () => {
    const h = host({ newId: (() => { let n = 0; return () => `id-${n++}`; })() });
    const r = routine([], { sinks: { chatops: [{ transport: "teams", channel: "c1" }] } });
    openDispatch(dbFile(dir), { surface: "teams", conversation: "c1", routine: "r", todoId: "t1" });
    const run = (todoIds: string[]) => ({ digest: "d", results: [], todoIds, record: { status: "ok" } as never });
    await h.deliverDigest(r, run(["t1", "t2"]), false, { transport: "teams", channel: "c1" }); // t2 came from elsewhere
    expect(await claimOutbox(outboxDir(dir), "teams")).toHaveLength(1);
    await h.deliverDigest(r, run(["t1"]));
    expect(await claimOutbox(outboxDir(dir), "teams")).toEqual([]);
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

    it("a home sink inserts one post holding the brief, even with no chat sink; no home sink inserts nothing", async () => {
      const onHomePost = vi.fn();
      const { h, calls, notify } = briefHost({ onHomePost });
      const res = await h.runOneRoutine(routine([{ kind: "chat", instruction: "check" }]));
      await h.deliverDigest(routine([{ kind: "chat", instruction: "check" }], { sinks: { note: true, notify: true } }), res);
      expect(listPendingHomePosts(dbFile(dir))).toEqual([]);
      expect(calls).toHaveLength(0);
      expect(onHomePost).not.toHaveBeenCalled();
      expect(notify).toHaveBeenLastCalledWith(expect.not.objectContaining({ home: true }));
      await h.deliverDigest(routine([{ kind: "chat", instruction: "check" }], { sinks: { note: true, notify: true, home: { ttlMinutes: 30 } } }), res);
      const posts = listPendingHomePosts(dbFile(dir));
      expect(posts).toHaveLength(1);
      expect(posts[0]).toMatchObject({ sprout: "r", body: BRIEF });
      expect(Date.parse(posts[0]!.expiresAt!) - Date.parse(posts[0]!.createdAt)).toBe(30 * 60_000);
      expect(calls).toHaveLength(1);
      expect(await posted()).toEqual([]);
      expect((await loadNotes(dbFile(dir)))[0]?.body).toBe(REPORT);
      // #961: the host recounts its bubble, and the banner opens Home, where the post waits.
      expect(onHomePost).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ body: REPORT, home: true }));
    });

    it("chatopsVerbatim keeps the digest for chatops, but Home still gets the brief", async () => {
      const { h, calls } = briefHost();
      const r = routine([{ kind: "chat", instruction: "check" }], { sinks: { chatops: [{ transport: "discord" }], chatopsVerbatim: true, home: {} } });
      await h.deliverDigest(r, await h.runOneRoutine(r));
      expect((await posted()).map((m) => m.body)).toEqual([REPORT]);
      expect(listPendingHomePosts(dbFile(dir)).map((p) => p.body)).toEqual([BRIEF]);
      expect(calls).toHaveLength(1);
    });

    it("a lease lost while the brief is written inserts no home post", async () => {
      let held = true;
      const { h } = briefHost({ holdsLease: () => held });
      const r = routine([{ kind: "chat", instruction: "check" }], { sinks: { home: {} } });
      const res = await h.runOneRoutine(r);
      const { h: losing } = briefHost({
        holdsLease: () => held,
        converse: async () => { held = false; return { content: BRIEF, toolCalls: [] }; },
      });
      await losing.deliverDigest(r, res);
      expect(listPendingHomePosts(dbFile(dir))).toEqual([]);
      held = true;
      await h.deliverDigest(r, res);
      expect(listPendingHomePosts(dbFile(dir))).toHaveLength(1);
    });

    it("a host without the scheduler lease writes no home post", async () => {
      const { h } = briefHost({ holdsLease: () => false });
      const r = routine([{ kind: "chat", instruction: "check" }], { sinks: { home: {} } });
      await h.deliverDigest(r, await h.runOneRoutine(r));
      expect(listPendingHomePosts(dbFile(dir))).toEqual([]);
    });

    it("a requested brief is the chat body, written even with no chat sink and posted nowhere", async () => {
      const { h, calls } = briefHost();
      const r = routine([{ kind: "chat", instruction: "check" }], { sinks: { note: true } });
      const res = await h.runOneRoutine(r);
      await expect(h.deliverDigest(r, res, true)).resolves.toBe(BRIEF);
      expect(calls).toHaveLength(1);
      expect(await posted()).toEqual([]);
      // Not ok: the digest as it is, no model call. Unrequested: nothing returned.
      await expect(h.deliverDigest(r, { ...res, record: { ...res.record, status: "failed" } }, true)).resolves.toBe(res.digest);
      await expect(h.deliverDigest(r, res)).resolves.toBeUndefined();
      expect(calls).toHaveLength(1);
    });

    describe("Home posts to the owner's DM (#1067)", () => {
      const reachable = (teams: boolean): void => {
        writeFileSync(join(dir, "discord.json"), JSON.stringify({ ownerId: "o1" }));
        writeFileSync(join(dir, "teams.json"), JSON.stringify({ ownerId: "o2" }));
        writeFileSync(join(dir, "teams-conversations.json"), JSON.stringify(
          teams ? { a: { conversation: { conversationType: "personal" }, user: { id: "o2" } } } : {}));
      };
      const latestPost = () => listPendingHomePosts(dbFile(dir)).at(-1)!;
      const r = routine([{ kind: "chat", instruction: "check" }], { sinks: { home: {} } });

      it("off = no phone message; on = one per reachable transport, the post's turn under its key; an owner-DM sink isn't repeated", async () => {
        let dms = { discord: false, teams: false };
        const { h } = briefHost({ homeDms: () => dms });
        const res = await h.runOneRoutine(r);
        reachable(false);
        await h.deliverDigest(r, res);
        expect(await posted()).toEqual([]);
        dms = { discord: true, teams: true };
        await h.deliverDigest(r, res);
        const sent = await posted();
        expect(sent.map((m) => m.transport)).toEqual(["discord"]); // the owner's Teams chat isn't known: none enqueued
        expect(sent[0]).toMatchObject({
          body: postTurn({ sprout: "r", text: BRIEF }), displayBody: `**Sprout: r**\n\n${BRIEF}`, context: true, mainTurnKey: `post:${latestPost().id}`,
        });
        expect(sent[0]).not.toHaveProperty("channel");
        expect(sent[0]).not.toHaveProperty("userId");
        reachable(true);
        // An owner-DM chat sink on a transport the copy went to is dropped; a channel sink isn't.
        const withSinks = routine(r.steps, { sinks: { home: {}, chatops: [{ transport: "discord" }, { transport: "discord", channel: "c1" }] } });
        await h.deliverDigest(withSinks, res);
        expect((await posted()).map((m) => [m.transport, m.channel, m.mainTurnKey])).toEqual(expect.arrayContaining([
          ["discord", undefined, `post:${latestPost().id}`], ["teams", undefined, `post:${latestPost().id}`], ["discord", "c1", undefined],
        ]));
        expect(listPendingHomePosts(dbFile(dir))).toHaveLength(3); // every post stays unread
      });

      it("chatopsVerbatim shows the full digest; the main-log body stays the post's brief", async () => {
        const { h } = briefHost({ homeDms: () => ({ discord: true, teams: false }) });
        reachable(false);
        const v = routine(r.steps, { sinks: { home: {}, chatopsVerbatim: true } });
        await h.deliverDigest(v, await h.runOneRoutine(v));
        expect((await posted()).map((m) => [m.body, m.displayBody])).toEqual([[postTurn({ sprout: "r", text: BRIEF }), `**Sprout: r**\n\n${REPORT}`]]);
      });

      it("a quiet run and a run dispatched from that DM skip the phone leg; an ending is still asked there", async () => {
        const { h } = briefHost({ homeDms: () => ({ discord: true, teams: true }) });
        reachable(true);
        const q = routine(r.steps, { sinks: { home: {}, chatopsOnlyOnProblems: true } });
        const res = await h.runOneRoutine(q);
        await h.deliverDigest(q, res);
        expect(await posted()).toEqual([]);
        expect(listPendingHomePosts(dbFile(dir))).toHaveLength(1); // Home is never muted
        await h.deliverDigest(r, res, false, { transport: "discord" });
        expect((await posted()).map((m) => m.transport)).toEqual(["teams"]);
        await h.deliverDigest(q, { ...res, ending: "done" }, false, { transport: "discord" });
        expect((await posted()).map((m) => m.transport).sort()).toEqual(["discord", "teams"]);
      });
    });
  });

  it("skips the notify sink when the host has no notifier", async () => {
    const h = host();
    await expect(h.deliverDigest(routine([], { sinks: { notify: true } }), { digest: "x", results: [], record: {} as never })).resolves.toBeUndefined();
  });
});
