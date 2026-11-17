import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addTodo, backgroundWork, claimTodo, closeDispatch, conversationDispatches, makeBackgroundWorkTool, openDispatch,
  parentSproutRunning, parseRoutineRunningResult, queueTodoDispatch, updateTodoStatus, type ParentPort,
} from "../src/index.js";
import { closeDb } from "../src/db.js";

let dir: string;
let file: string;
let stateFile: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bean-work-"));
  file = join(dir, "bean.db");
  stateFile = join(dir, ".state.json");
});
afterEach(async () => {
  closeDb(file);
  await rm(dir, { recursive: true, force: true });
});

let n = 0;
const ids = (): string => `id-${++n}`;
let t = 0;
const tick = (): Date => new Date(Date.UTC(2026, 10, 16, 12, 0, t++));

/** Two people's work on one sprout in channel c1, plus an owner DM job. */
async function seed(): Promise<{ ownerRun: string; memberJob: string; ownerJob: string; dmJob: string }> {
  // Mia (a member) queued first, then the owner queued behind her.
  const member = queueTodoDispatch(file, { routine: "triage", text: "mia's secret task", createdBy: "mia" },
    { surface: "teams", conversation: "c1", actor: "mia" }, ids, tick);
  const owner = queueTodoDispatch(file, { routine: "triage", text: "owner task" }, { surface: "teams", conversation: "c1", actor: "u1" }, ids, tick);
  // A finished run-linked job with a brief.
  const ownerRun = openDispatch(file, { surface: "teams", conversation: "c1", actor: "u1", routine: "digest" }, ids, tick);
  closeDispatch(file, ownerRun, { status: "ok", brief: "3 PRs merged" }, tick);
  const dmJob = openDispatch(file, { surface: "teams", actor: "u1", routine: "digest" }, ids, tick);
  return { ownerRun, memberJob: member.jobId, ownerJob: owner.jobId, dmJob };
}

describe("background_work", () => {
  it("owner: live runs, queue counts, this conversation's jobs with outcome and position, last results", async () => {
    const s = await seed();
    await writeFile(stateFile, JSON.stringify({
      digest: { history: [{ startedAt: "a", finishedAt: "2026-11-16T11:00:00.000Z", status: "ok", digest: "all good", steps: [] }] },
    }));
    const r = await backgroundWork({
      file, stateFile, running: async () => [{ name: "triage", runs: 1 }, { name: "idle", runs: 0 }],
      dispatches: () => conversationDispatches(file, "teams", "c1"),
    });
    expect(r.running).toEqual([{ sprout: "triage", runs: 1 }]);
    expect(r.queues).toEqual([{ sprout: "triage", pending: 2, running: 0 }]);
    expect(r.dispatched.map((d) => [d.job, d.state, d.position, d.task, d.result])).toEqual([
      [s.ownerRun, "ok", undefined, undefined, "3 PRs merged"],
      [s.ownerJob, "queued", 2, "owner task", undefined],
      [s.memberJob, "queued", 1, "mia's secret task", undefined],
    ]);
    expect(r.lastResults).toEqual([{ sprout: "digest", status: "ok", finishedAt: "2026-11-16T11:00:00.000Z", summary: "all good" }]);
  });

  it("a taken todo reads running, then its own result once it finishes", async () => {
    const s = await seed();
    const taken = await claimTodo(file, "triage");
    const view = () => backgroundWork({ file, stateFile, dispatches: () => conversationDispatches(file, "teams", "c1") });
    expect((await view()).dispatched.find((d) => d.job === s.memberJob)).toMatchObject({ state: "running" });
    await updateTodoStatus(file, taken!.id, "done", "fixed it");
    expect((await view()).dispatched.find((d) => d.job === s.memberJob)).toMatchObject({ state: "ok", result: "fixed it", task: "mia's secret task" });
  });

  it("no scheduler reachable: running is unknown", async () => {
    await seed();
    for (const running of [undefined, async () => undefined, async () => { throw new Error("gone"); }]) {
      const r = await backgroundWork({ file, stateFile, dispatches: () => [], ...(running ? { running } : {}) });
      expect(r.running).toBe("unknown");
    }
  });

  it("a non-owner gets only their own todos and jobs — no other person's task text", async () => {
    const s = await seed();
    await addTodo(file, "triage", "gus's task", undefined, undefined, "gus");
    await writeFile(stateFile, JSON.stringify({ triage: { history: [{ startedAt: "a", finishedAt: "b", status: "ok", digest: "owner task done", steps: [] }] } }));
    const tool = makeBackgroundWorkTool({
      file, stateFile, viewer: "mia", running: async () => [{ name: "triage", runs: 1 }],
      dispatches: () => conversationDispatches(file, "teams", "c1"),
    });
    const out = await tool.run({});
    expect(out).not.toContain("owner task");
    expect(out).not.toContain("gus's task");
    expect(out).not.toContain("3 PRs merged");
    const r = JSON.parse(out) as Awaited<ReturnType<typeof backgroundWork>>;
    expect(r.running).toBeUndefined();
    expect(r.lastResults).toBeUndefined();
    expect(r.myTodos).toEqual([{ id: expect.any(String), sprout: "triage", text: "mia's secret task", status: "pending", position: 1 }]);
    expect(r.dispatched.map((d) => d.job)).toEqual([s.memberJob]);
  });

  it("the owner DM's jobs are the surface's unset conversation only", async () => {
    const s = await seed();
    expect(conversationDispatches(file, "teams").map((d) => d.id)).toEqual([s.dmJob]);
    expect(conversationDispatches(file, "discord")).toEqual([]);
  });
});

describe("routine-running bridge", () => {
  const fakePort = () => {
    let onMsg: (raw: unknown) => void = () => {};
    const sent: unknown[] = [];
    const port: ParentPort = {
      connected: () => true,
      send: (m, cb) => { sent.push(m); cb(null); },
      onMessage: (cb) => { onMsg = cb; },
      onDisconnect: () => {},
    };
    return { port, sent, reply: (m: unknown) => onMsg(m) };
  };

  it("asks with only a request id and resolves the app's counts", async () => {
    const p = fakePort();
    const ask = parentSproutRunning(p.port, 1000, () => "r1");
    const answer = ask();
    expect(p.sent).toEqual([{ type: "routine-running", requestId: "r1" }]);
    p.reply({ type: "routine-running-result", requestId: "r1", running: [{ name: "triage", runs: 2 }] });
    await expect(answer).resolves.toEqual([{ name: "triage", runs: 2 }]);
  });

  it("a standby app, a malformed answer or no answer reads unknown", async () => {
    const p = fakePort();
    const ask = parentSproutRunning(p.port, 20, () => `r${p.sent.length}`);
    const standby = ask();
    p.reply({ type: "routine-running-result", requestId: "r0" });
    await expect(standby).resolves.toBeUndefined();
    expect(parseRoutineRunningResult({ type: "routine-running-result", requestId: "x", running: [{ name: "a", runs: -1 }] })).toBeUndefined();
    await expect(ask()).resolves.toBeUndefined(); // timed out
  });
});
