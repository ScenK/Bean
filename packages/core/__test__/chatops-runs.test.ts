import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { DelegateCallbacks, DelegateRequest } from "../src/index.js";
import { RunRegistry } from "../src/chatops/runs.js";
import { dbFile } from "../src/config.js";
import { closeDb, openDb } from "../src/db.js";
import { recordDelegateSession } from "../src/delegate-runs.js";
import { sweepDeadRuns } from "../src/run-queue.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const req: DelegateRequest = { cli: "claude", projectPath: "/p", prompt: "do" };
const meta = { instruction: "do the thing", conversationId: "c1" };

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "bean-runs-"));
}

function fakeRun() {
  const calls: { req: DelegateRequest; cb: DelegateCallbacks }[] = [];
  const cancelled: boolean[] = [];
  const fn = (r: DelegateRequest, cb: DelegateCallbacks) => {
    calls.push({ req: r, cb });
    return { cancel: (done?: () => void) => { cancelled.push(true); done?.(); } };
  };
  return { fn, calls, cancelled };
}

/** A thread session resumes only where it last ran: record that row. */
function seed(dir: string, sessionId: string, projectPath: string, cli: DelegateRequest["cli"] = "claude"): void {
  recordDelegateSession(dbFile(dir), { surface: "discord", cli, sessionId, projectPath, instruction: "earlier" });
}

const runFiles = (dir: string): string[] => { try { return readdirSync(join(dir, "runs")); } catch { return []; } };

function events() {
  return { onTail: vi.fn(), onDone: vi.fn(), onError: vi.fn(), onCancelled: vi.fn() };
}

test("two runs on one project overlap, each recorded and settled on its own", async () => {
  const { fn, calls } = fakeRun();
  const dir = tmp();
  const reg = new RunRegistry(fn, { dir, botKind: "discord" });
  const evA = events();
  const evB = events();
  const a = await reg.start(req, evA, meta);
  const b = await reg.start(req, evB, meta);
  expect(a).not.toBe(b);
  expect(calls).toHaveLength(2);
  expect(runFiles(dir).sort()).toEqual([`${a}.json`, `${b}.json`].sort());
  calls[0]?.cb.onSessionStart?.(123, "sess-1");
  calls[0]?.cb.onDone("result", "sess-1");
  expect(evA.onDone).toHaveBeenCalledWith("result", "sess-1");
  expect(evB.onDone).not.toHaveBeenCalled();
  expect(runFiles(dir)).toEqual([`${b}.json`]);
  closeDb(dbFile(dir));
});

test("tail lines are throttled: only the latest line flushes per interval", async () => {
  const { fn, calls } = fakeRun();
  const reg = new RunRegistry(fn, { dir: tmp(), botKind: "discord", throttleMs: 5000 });
  const ev = events();
  await reg.start(req, ev, meta);
  calls[0]?.cb.onOutput("line 1");
  calls[0]?.cb.onOutput("line 2");
  expect(ev.onTail).not.toHaveBeenCalled();
  vi.advanceTimersByTime(5000);
  expect(ev.onTail).toHaveBeenCalledTimes(1);
  expect(ev.onTail).toHaveBeenCalledWith("line 2");
  vi.advanceTimersByTime(5000); // no new output → no extra flush
  expect(ev.onTail).toHaveBeenCalledTimes(1);
});

test("error releases the run's record and reports the message", async () => {
  const { fn, calls } = fakeRun();
  const dir = tmp();
  const reg = new RunRegistry(fn, { dir, botKind: "discord" });
  const ev = events();
  await reg.start(req, ev, meta);
  calls[0]?.cb.onError(new Error("boom"));
  expect(ev.onError).toHaveBeenCalledWith("boom", undefined);
  expect(runFiles(dir)).toEqual([]);
});

test("cancelAll cancels every active run and returns the count", async () => {
  const { fn, cancelled } = fakeRun();
  const reg = new RunRegistry(fn, { dir: tmp(), botKind: "discord" });
  await reg.start(req, events(), meta);
  await reg.start({ ...req, projectPath: "/q" }, events(), meta);
  expect(reg.cancelAll()).toBe(2);
  expect(cancelled).toHaveLength(2);
  expect(reg.cancelAll()).toBe(0);
});

test("a run that settles synchronously (spawn failure) leaves no record behind", async () => {
  const dir = tmp();
  const reg = new RunRegistry((_r, cb) => {
    cb.onError(new Error("spawn failed"));
    return { cancel: () => {} };
  }, { dir, botKind: "discord" });
  const ev = events();
  const id = await reg.start(req, ev, meta);
  expect(ev.onError).toHaveBeenCalledWith("spawn failed", undefined);
  expect(runFiles(dir)).toEqual([]);
  expect(reg.cancel(id)).toBe(false); // never registered
});

test("stale callbacks from a cancelled run cannot corrupt a newer run", async () => {
  const { fn, calls } = fakeRun();
  const dir = tmp();
  const reg = new RunRegistry(fn, { dir, botKind: "discord", throttleMs: 5000 });
  const evA = events();
  const id = await reg.start(req, evA, meta);
  reg.cancel(id);
  const evB = events();
  const b = await reg.start(req, evB, meta);
  // Run A's delegate misbehaves and fires onDone after cancel.
  calls[0]?.cb.onDone("late");
  expect(evA.onDone).not.toHaveBeenCalled();
  expect(runFiles(dir)).toEqual([`${b}.json`]); // B's record untouched
  // B's throttle timer must still be alive.
  calls[1]?.cb.onOutput("b line");
  vi.advanceTimersByTime(5000);
  expect(evB.onTail).toHaveBeenCalledWith("b line");
});

test("cancel cancels the underlying handle and fires onCancelled", async () => {
  const { fn, cancelled } = fakeRun();
  const dir = tmp();
  const reg = new RunRegistry(fn, { dir, botKind: "discord" });
  const ev = events();
  const id = await reg.start(req, ev, meta);
  expect(reg.cancel(id)).toBe(true);
  expect(cancelled).toHaveLength(1);
  expect(ev.onCancelled).toHaveBeenCalled();
  expect(runFiles(dir)).toEqual([]);
  expect(reg.cancel(id)).toBe(false);
});

test("cancel does not release the run record until the handle confirms the child actually stopped", async () => {
  const dir = tmp();
  let confirm: (() => void) | undefined;
  const fn = () => ({ cancel: (done?: () => void) => { confirm = done; } });
  const reg = new RunRegistry(fn, { dir, botKind: "discord" });
  const ev = events();
  const id = (await reg.start(req, ev, meta))!;
  expect(reg.cancel(id)).toBe(true);
  // SIGTERM sent, but the child hasn't confirmed it stopped yet — crash cleanup must still see it.
  expect(readdirSync(join(dir, "runs"))).toHaveLength(1);
  expect(ev.onCancelled).not.toHaveBeenCalled();
  confirm?.();
  expect(ev.onCancelled).toHaveBeenCalled();
  expect(readdirSync(join(dir, "runs"))).toEqual([]); // released only now
});

test("two registries sharing a dir (Discord + Teams) both run on one project", async () => {
  const dir = tmp();
  const { fn: fnA, calls: a } = fakeRun();
  const { fn: fnB, calls: b } = fakeRun();
  const regA = new RunRegistry(fnA, { dir, botKind: "discord" });
  const regB = new RunRegistry(fnB, { dir, botKind: "teams" });
  await regA.start(req, events(), meta);
  await regB.start(req, events(), meta);
  expect([a.length, b.length]).toEqual([1, 1]);
  expect(runFiles(dir)).toHaveLength(2);
});

test("interruptAll leaves the run record in place and leaves an outbox notice per run", async () => {
  const dir = tmp();
  const { fn, cancelled } = fakeRun();
  const reg = new RunRegistry(fn, { dir, botKind: "discord" });
  await reg.start(req, events(), meta);
  const n = reg.interruptAll();
  expect(n).toBe(1);
  expect(cancelled).toHaveLength(1);
  // The record is NOT released: this process is exiting with no confirmation the delegate child
  // actually stopped, so boot cleanup must still find it.
  expect(runFiles(dir)).toHaveLength(1);
  const outboxFiles = readdirSync(join(dir, "outbox"));
  expect(outboxFiles).toHaveLength(1);
  expect(outboxFiles[0]).toMatch(/^discord-/);
});

test("start() records the delegate child's own pid, so the boot sweep drops it once that child is dead", async () => {
  const dir = tmp();
  // If the record stayed keyed to the *calling* process's pid (always alive here), the sweep
  // would keep it forever after interruptAll().
  const fn = () => ({ cancel: () => {}, pid: 999_999 });
  const reg = new RunRegistry(fn, { dir, botKind: "discord" });
  await reg.start(req, events(), meta);
  reg.interruptAll();
  expect(sweepDeadRuns(dir)).toBe(1);
  expect(runFiles(dir)).toEqual([]);
});

test("onActivity reports the run lifecycle under one id, named after the project, without output", async () => {
  const { fn, calls } = fakeRun();
  const seen: unknown[] = [];
  const reg = new RunRegistry(fn, { dir: tmp(), botKind: "discord", throttleMs: 5000, newId: () => "r1", onActivity: (e) => seen.push(e) });
  const ev = events();
  await reg.start({ ...req, projectPath: "/work/api" }, ev, meta);
  calls[0]?.cb.onOutput("building");
  vi.advanceTimersByTime(5000);
  calls[0]?.cb.onDone("ok");
  expect(seen).toEqual([
    { type: "run", phase: "start", id: "r1", name: "api" },
    { type: "run", phase: "done", id: "r1", name: "api" },
  ]); // no tail: delegate output never leaves the channel
  expect(ev.onTail).toHaveBeenCalledWith("building");
  expect(ev.onDone).toHaveBeenCalledWith("ok", undefined); // caller's events still fire
});

test("onActivity reports a cancel as cancelled", async () => {
  const { fn } = fakeRun();
  const seen: { phase: string }[] = [];
  const reg = new RunRegistry(fn, { dir: tmp(), botKind: "discord", onActivity: (e) => seen.push(e) });
  const id = (await reg.start(req, events(), meta))!;
  reg.cancel(id);
  expect(seen.map((e) => e.phase)).toEqual(["start", "cancelled"]);
});

test("a resumed run keeps the record on this live process until the session starts", async () => {
  const dir = tmp();
  const { fn, calls } = fakeRun();
  const pids = [111];
  const reg = new RunRegistry((r, cb) => ({ ...fn(r, cb), pid: pids[0] }), { dir, botKind: "discord" });
  seed(dir, "s-1", "/p");
  await reg.start({ ...req, resume: "s-1" }, events(), meta);
  const file = join(dir, "runs", readdirSync(join(dir, "runs"))[0]!);
  // Not the first child's pid: it may die on a rejected resume and get swept mid-run.
  expect(JSON.parse(readFileSync(file, "utf8")).pid).toBe(process.pid);
  calls[0]!.cb.onSessionStart?.(4242, "s-1");
  expect(JSON.parse(readFileSync(file, "utf8")).pid).toBe(4242);
  closeDb(dbFile(dir));
});

test("every started run (not just resumes) is recorded, and error/cancel carry the session id", async () => {
  const { fn, calls } = fakeRun();
  const dir = tmp();
  const reg = new RunRegistry(fn, { dir, botKind: "teams" });
  const ev = events();
  await reg.start(req, ev, meta);
  calls[0]?.cb.onSessionStart?.(123, "s-err");
  calls[0]?.cb.onError(new Error("boom"));
  expect(ev.onError).toHaveBeenCalledWith("boom", "s-err");
  const id = (await reg.start(req, ev, meta))!;
  calls[1]?.cb.onSessionStart?.(124, "s-cancel");
  reg.cancel(id);
  expect(ev.onCancelled).toHaveBeenCalledWith("s-cancel");
  await reg.start(req, ev, meta);
  calls[2]?.cb.onSessionStart?.(125, "--help"); // option-like: no row, no receipt
  calls[2]?.cb.onDone("ok", "--help");
  expect(ev.onDone).toHaveBeenCalledWith("ok", undefined);
  const rows = openDb(dbFile(dir)).prepare("SELECT surface, cli, session_id, project_path, instruction FROM delegate_runs ORDER BY id").all();
  expect(rows.map((r) => ({ ...r }))).toEqual([
    { surface: "teams", cli: "claude", session_id: "s-err", project_path: "/p", instruction: "do the thing" },
    { surface: "teams", cli: "claude", session_id: "s-cancel", project_path: "/p", instruction: "do the thing" },
  ]);
  closeDb(dbFile(dir));
});

test.each(["claude", "codex", "opencode"] as const)("a %s resume recorded for another project starts fresh and says so; the same project resumes", async (cli) => {
  const { fn, calls } = fakeRun();
  const dir = tmp();
  const reg = new RunRegistry(fn, { dir, botKind: "discord" });
  const base: DelegateRequest = { cli, projectPath: "/x", prompt: "do" };
  await reg.start(base, events(), meta);
  calls[0]?.cb.onSessionStart?.(1, "ses_x");
  calls[0]?.cb.onDone("ok");
  const moved = events();
  await reg.start({ ...base, projectPath: "/y", resume: "ses_x" }, moved, meta);
  expect(calls[1]?.req.resume).toBeUndefined();
  calls[1]?.cb.onDone("ok");
  expect(moved.onDone).toHaveBeenCalledWith(`${RunRegistry.projectSwitchNotice(cli)}ok`, undefined);
  expect(RunRegistry.projectSwitchNotice(cli)).toContain(`earlier ${cli} session`);
  const same = events();
  await reg.start({ ...base, resume: "ses_x" }, same, meta);
  expect(calls[2]?.req.resume).toBe("ses_x");
  calls[2]?.cb.onDone("ok");
  expect(same.onDone).toHaveBeenCalledWith("ok", undefined);
  // No recorded project for the session: fresh too.
  await reg.start({ ...base, resume: "ses_unknown" }, events(), meta);
  expect(calls[3]?.req.resume).toBeUndefined();
  closeDb(dbFile(dir));
});

test("cancel resolves by run id; a conversation scope cancels only that conversation's run", async () => {
  const { fn, cancelled } = fakeRun();
  const reg = new RunRegistry(fn, { dir: tmp(), botKind: "discord" });
  const a = (await reg.start(req, events(), meta))!;
  const b = (await reg.start({ ...req, projectPath: "/q" }, events(), { ...meta, conversationId: "c2" }))!;
  expect(a).not.toBe(b);
  expect(reg.cancel("/p")).toBe(false); // a path is not a run id
  expect(reg.cancel(b, "c1")).toBe(false); // c2's run, c1's scope
  expect(reg.cancel(b, "c2")).toBe(true);
  expect(reg.cancel(a)).toBe(true); // unscoped (owner)
  expect(cancelled).toHaveLength(2);
});

test("a resume in a thread already running that CLI starts fresh and says so", async () => {
  const { fn, calls } = fakeRun();
  const dir = tmp();
  seed(dir, "s-1", "/p");
  seed(dir, "s-2", "/r", "codex");
  seed(dir, "s-3", "/s");
  const reg = new RunRegistry(fn, { dir, botKind: "discord" });
  await reg.start({ ...req, resume: "s-1" }, events(), meta);
  expect(calls[0]?.req.resume).toBe("s-1");
  const ev = events();
  await reg.start({ ...req, resume: "s-1" }, ev, meta);
  expect(calls[1]?.req.resume).toBeUndefined();
  calls[1]?.cb.onDone("ok");
  expect(ev.onDone).toHaveBeenCalledWith(`${RunRegistry.BUSY_THREAD_NOTICE}ok`, undefined);
  // Another CLI, or another thread, keeps its resume.
  await reg.start({ ...req, cli: "codex", projectPath: "/r", resume: "s-2" }, events(), meta);
  await reg.start({ ...req, projectPath: "/s", resume: "s-3" }, events(), { ...meta, conversationId: "c2" });
  expect(calls[2]?.req.resume).toBe("s-2");
  expect(calls[3]?.req.resume).toBe("s-3");
  closeDb(dbFile(dir));
});

test("a cancelled run still keeps its thread's CLI busy until its child confirms it stopped", async () => {
  const calls: DelegateRequest[] = [];
  let confirm: (() => void) | undefined;
  const dir = tmp();
  seed(dir, "s-1", "/p");
  const reg = new RunRegistry((r) => { calls.push(r); return { cancel: (done?: () => void) => { confirm = done; } }; }, { dir, botKind: "discord" });
  const id = (await reg.start({ ...req, resume: "s-1" }, events(), meta))!;
  reg.cancel(id);
  const q = (await reg.start({ ...req, resume: "s-1" }, events(), meta))!;
  expect(calls[1]?.resume).toBeUndefined();
  confirm?.(); // the first child is gone…
  reg.cancel(q);
  confirm?.(); // …and so is the second's: the thread is free again
  await reg.start({ ...req, resume: "s-1" }, events(), meta);
  expect(calls[2]?.resume).toBe("s-1");
  closeDb(dbFile(dir));
});
