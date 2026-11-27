import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { dbFile } from "../src/config.js";
import { closeDb, openDb } from "../src/db.js";
import {
  markAuditInterrupted, queryRunAudit, reconcileAuditRuns, recordAuditEnd, recordAuditRefused, recordAuditSession, recordAuditStart, type AuditStart,
} from "../src/run-audit.js";
import { RunRegistry } from "../src/chatops/runs.js";
import { recordRun, sweepDeadRuns } from "../src/run-queue.js";
import { LiveSessionRegistry } from "../src/chatops/live-sessions.js";
import { recordDelegateSession } from "../src/delegate-runs.js";
import type { DelegateCallbacks, DelegateRequest } from "../src/delegate.js";
import type { LiveSessionCallbacks } from "../src/live-session.js";

const file = (): string => dbFile(mkdtempSync(join(tmpdir(), "bean-audit-")));
const row = (over: Partial<AuditStart> = {}): AuditStart => ({
  runId: "r1", surface: "discord", conversationId: "c1", trigger: "card", projectPath: "/p/bean", cli: "claude",
  instruction: "fix it", askedBy: { id: "u1", name: "alice" }, confirmedBy: { id: "u2", name: "bob" }, ...over,
});

test("start → session → end: one row, settled once with its duration", () => {
  const f = file();
  recordAuditStart(f, row(), new Date("2026-11-26T10:00:00.000Z"));
  recordAuditSession(f, "r1", "sess-1");
  recordAuditEnd(f, "r1", "done", undefined, new Date("2026-11-26T10:00:02.500Z"));
  recordAuditEnd(f, "r1", "failed", undefined, new Date("2026-11-26T10:00:09.000Z")); // late settle: no-op
  expect(queryRunAudit(f)).toEqual([expect.objectContaining({
    run_id: "r1", outcome: "done", session_id: "sess-1", duration_ms: 2500, ended_at: "2026-11-26T10:00:02.500Z",
    asked_by_id: "u1", asked_by_name: "alice", confirmed_by_id: "u2", confirmed_by_name: "bob", authority_id: null,
  })]);
  closeDb(f);
});

test("refused rows end at once; interrupted flips only running rows; cancel records its actor", () => {
  const f = file();
  recordAuditRefused(f, row({ runId: "ref" }));
  recordAuditStart(f, row({ runId: "run" }));
  recordAuditStart(f, row({ runId: "can" }));
  recordAuditEnd(f, "can", "cancelled", { id: "u3", name: "carol" });
  markAuditInterrupted(f, ["ref", "run", "can"]);
  const by = Object.fromEntries(queryRunAudit(f).map((r) => [r.run_id, r]));
  expect(by.ref).toMatchObject({ outcome: "refused", duration_ms: 0 });
  expect(by.run).toMatchObject({ outcome: "interrupted" });
  expect(by.can).toMatchObject({ outcome: "cancelled", cancelled_by_id: "u3", cancelled_by_name: "carol" });
  closeDb(f);
});

test("query filters by since, project, actor and limit", () => {
  const f = file();
  recordAuditStart(f, row({ runId: "a", projectPath: "/p/web" }), new Date("2026-11-20T00:00:00Z"));
  recordAuditStart(f, row({ runId: "b", askedBy: { id: "u9" }, confirmedBy: undefined }), new Date("2026-11-25T00:00:00Z"));
  recordAuditStart(f, row({ runId: "c", trigger: "continuation", confirmedBy: undefined, authorityId: "u7" }), new Date("2026-11-26T00:00:00Z"));
  expect(queryRunAudit(f).map((r) => r.run_id)).toEqual(["c", "b", "a"]);
  expect(queryRunAudit(f, { since: "2026-11-24T00:00:00Z" }).map((r) => r.run_id)).toEqual(["c", "b"]);
  expect(queryRunAudit(f, { project: "web" }).map((r) => r.run_id)).toEqual(["a"]);
  expect(queryRunAudit(f, { actor: "u7" }).map((r) => r.run_id)).toEqual(["c"]);
  expect(queryRunAudit(f, { actor: "u9" }).map((r) => r.run_id)).toEqual(["b"]);
  expect(queryRunAudit(f, { limit: 1 }).map((r) => r.run_id)).toEqual(["c"]);
  closeDb(f);
});

test("an unwritable bean.db never throws", () => {
  const dir = mkdtempSync(join(tmpdir(), "bean-audit-"));
  writeFileSync(join(dir, "blocker"), "");
  const bad = join(dir, "blocker", "bean.db"); // its parent is a file
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(() => {
    recordAuditStart(bad, row());
    recordAuditRefused(bad, row());
    recordAuditSession(bad, "r1", "s");
    recordAuditEnd(bad, "r1", "done");
    markAuditInterrupted(bad, ["r1"]);
  }).not.toThrow();
  expect(queryRunAudit(bad)).toEqual([]);
  expect(warn.mock.calls.flat().join(" ")).not.toContain("fix it");
  warn.mockRestore();
});

test("the table opens cleanly on an existing bean.db", () => {
  const f = file();
  openDb(f).exec("DROP TABLE run_audit");
  closeDb(f);
  recordAuditStart(f, row());
  expect(queryRunAudit(f)).toHaveLength(1);
  closeDb(f);
});

function fakeRun() {
  const calls: { req: DelegateRequest; cb: DelegateCallbacks }[] = [];
  const fn = (r: DelegateRequest, cb: DelegateCallbacks) => {
    calls.push({ req: r, cb });
    return { cancel: (done?: () => void) => done?.() };
  };
  return { fn, calls };
}
const events = () => ({ onTail: vi.fn(), onDone: vi.fn(), onError: vi.fn(), onCancelled: vi.fn() });
const meta = { instruction: "fix it", conversationId: "c1", audit: { trigger: "card" as const, confirmedBy: { id: "u2", name: "bob" } } };

test("RunRegistry: a run's row follows its lifecycle; a cancel records who; interruptAll flips the rest", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bean-audit-"));
  const f = dbFile(dir);
  const { fn, calls } = fakeRun();
  const reg = new RunRegistry(fn, { dir, botKind: "teams" });
  const req: DelegateRequest = { cli: "claude", projectPath: "/p/bean", prompt: "SKILL BODY\n## Task\nfix it", model: "sonnet" };
  const a = await reg.start(req, events(), meta);
  expect(queryRunAudit(f)[0]).toMatchObject({ run_id: a, outcome: "running", surface: "teams", model: "sonnet", instruction: "fix it" });
  calls[0]!.cb.onSessionStart?.(1, "sess-1");
  calls[0]!.cb.onError(new Error("SECRET-STDERR"), "partial");
  expect(queryRunAudit(f)[0]).toMatchObject({ run_id: a, outcome: "failed", session_id: "sess-1" });
  const b = await reg.start(req, events(), meta);
  reg.cancel(b, undefined, { id: "u3", name: "carol" });
  const c = await reg.start(req, events(), meta);
  reg.interruptAll();
  const by = Object.fromEntries(queryRunAudit(f).map((r) => [r.run_id, r]));
  expect(by[b]).toMatchObject({ outcome: "cancelled", cancelled_by_id: "u3", cancelled_by_name: "carol" });
  expect(by[c]).toMatchObject({ outcome: "interrupted" });
  const all = JSON.stringify(queryRunAudit(f));
  expect(all).not.toContain("SKILL BODY");
  expect(all).not.toContain("SECRET-STDERR");
  expect(all).not.toContain("partial");
  closeDb(f);
});

test("RunRegistry: a strict-resume refusal records `refused` and spawns nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bean-audit-"));
  const f = dbFile(dir);
  recordDelegateSession(f, { surface: "discord", cli: "claude", sessionId: "sess-1", projectPath: "/p/web", instruction: "x" });
  const { fn, calls } = fakeRun();
  const reg = new RunRegistry(fn, { dir, botKind: "discord" });
  const ev = events();
  const id = await reg.start({ cli: "claude", projectPath: "/p/bean", prompt: "go", resume: "sess-1", strictResume: true }, ev,
    { ...meta, audit: { trigger: "continuation", authorityId: "u2" } });
  expect(calls).toHaveLength(0);
  expect(ev.onError).toHaveBeenCalled();
  expect(queryRunAudit(f)).toEqual([expect.objectContaining({ run_id: id, outcome: "refused", trigger: "continuation", authority_id: "u2", confirmed_by_id: null })]);
  closeDb(f);
});

test("LiveSessionRegistry: one `live` row per session, its session id and end", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bean-audit-"));
  const f = dbFile(dir);
  let cbs!: LiveSessionCallbacks;
  const reg = new LiveSessionRegistry((_req, c) => {
    cbs = c;
    return { pid: 1, send: () => true, interrupt: () => false, stop: () => cbs.onExit(undefined) };
  }, { dir, surface: "discord", newId: () => "live-1" });
  const sink = { post: async () => "m", edit: async () => {} };
  reg.start({
    channelId: "c1", projectPath: "/p/bean", instruction: "SKILL BODY\n## Task\nlook", ask: "look", cli: "claude",
    starterId: "u2", sink, audit: { starterName: "bob", askedBy: { name: "alice" }, skill: "fix-bug" },
  });
  expect(queryRunAudit(f)).toEqual([expect.objectContaining({
    run_id: "live-1", trigger: "live", outcome: "running", conversation_id: "c1", instruction: "look",
    confirmed_by_id: "u2", confirmed_by_name: "bob", asked_by_name: "alice", skill: "fix-bug",
  })]);
  cbs.onSessionId?.("0b0e1c4e-1111-4222-8333-944455556666");
  reg.stop("c1");
  expect(queryRunAudit(f)[0]).toMatchObject({ outcome: "done", session_id: "0b0e1c4e-1111-4222-8333-944455556666" });
  expect(JSON.stringify(queryRunAudit(f))).not.toContain("SKILL BODY");
  closeDb(f);
});

test("boot reconcile flips only running rows whose run record is missing or dead", () => {
  const dir = mkdtempSync(join(tmpdir(), "bean-audit-"));
  const f = dbFile(dir);
  for (const id of ["live", "dead", "gone", "done"]) recordAuditStart(f, row({ runId: id }));
  recordAuditEnd(f, "done", "done");
  recordRun(dir, "live", "/p", process.pid);
  recordRun(dir, "dead", "/p", 2 ** 22 + 7); // no such pid
  sweepDeadRuns(dir); // boot order: records first, then the audit rows
  reconcileAuditRuns(dir);
  const by = Object.fromEntries(queryRunAudit(f).map((r) => [r.run_id, r.outcome]));
  expect(by).toEqual({ live: "running", dead: "interrupted", gone: "interrupted", done: "done" });
  closeDb(f);
});
