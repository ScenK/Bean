import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test, vi } from "vitest";
import { closeDb, openDb } from "../src/db.js";
import { findDelegateRun, isValidSessionId, recordDelegateSession, resumeCommand, type DelegateRunRow } from "../src/delegate-runs.js";

const row: DelegateRunRow = { surface: "desktop", cli: "claude", sessionId: "3f2a-uuid", projectPath: "/p", instruction: "fix it" };

test("isValidSessionId accepts CLI ids and rejects option-like, control-char and over-long values", () => {
  for (const ok of ["3f2a9c1e-0b7d-4e8a-9c6f-1d2e3f4a5b6c", "ses_abc123", "t:1.2"]) expect(isValidSessionId(ok)).toBe(true);
  for (const bad of ["--help", "-x", "", "a b", "a\nb", "a\u0007", "a".repeat(129), "a;rm -rf ~"]) expect(isValidSessionId(bad)).toBe(false);
});

test("resumeCommand uses each CLI's interactive resume form", () => {
  expect(resumeCommand("claude", "id1")).toBe("claude --resume id1");
  expect(resumeCommand("codex", "id1")).toBe("codex resume id1");
  expect(resumeCommand("opencode", "id1")).toBe("opencode -s id1");
});

test("records rows (repeated ids are distinct rows) and skips invalid ids", () => {
  const file = join(mkdtempSync(join(tmpdir(), "bean-dr-")), "bean.db");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(recordDelegateSession(file, row, () => new Date("2026-09-30T00:00:00Z"))).toBe(true);
  expect(recordDelegateSession(file, row)).toBe(true);
  expect(recordDelegateSession(file, { ...row, sessionId: "--help" })).toBe(false);
  const rows = openDb(file).prepare("SELECT started_at, surface, session_id FROM delegate_runs ORDER BY id").all();
  expect(rows).toHaveLength(2);
  expect({ ...rows[0] }).toEqual({ started_at: "2026-09-30T00:00:00.000Z", surface: "desktop", session_id: "3f2a-uuid" });
  expect(JSON.stringify(warn.mock.calls)).not.toContain("--help");
  warn.mockRestore();
  closeDb(file);
});

test("a DB failure is swallowed and logged without the row's values", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  // A directory where the db file should be: openDb throws.
  const dir = mkdtempSync(join(tmpdir(), "bean-dr-"));
  expect(recordDelegateSession(dir, row)).toBe(false);
  expect(JSON.stringify(warn.mock.calls)).not.toMatch(/3f2a|fix it|"\/p"/);
  warn.mockRestore();
});

test("an existing bean.db without the table gains it on open", () => {
  const file = join(mkdtempSync(join(tmpdir(), "bean-dr-")), "bean.db");
  const old = new DatabaseSync(file);
  old.exec("CREATE TABLE notes (slug TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, project TEXT, updated TEXT NOT NULL, version INTEGER NOT NULL, source TEXT NOT NULL)");
  old.close();
  expect(recordDelegateSession(file, row)).toBe(true);
  closeDb(file);
});

test("findDelegateRun returns the newest row and refuses ids that can't continue live", () => {
  const file = join(mkdtempSync(join(tmpdir(), "bean-dr-")), "bean.db");
  const exists = (p: string): boolean => p !== "/gone";
  recordDelegateSession(file, { ...row, surface: "discord", projectPath: "/old", instruction: "first" });
  recordDelegateSession(file, { ...row, surface: "discord", instruction: "follow-up" });
  recordDelegateSession(file, { ...row, sessionId: "cx", cli: "codex", surface: "teams" });
  const uuid = "019a6b1e-7c3d-7f00-9a1b-2c3d4e5f6a7b";
  recordDelegateSession(file, { ...row, sessionId: uuid, cli: "codex", surface: "routine" });
  recordDelegateSession(file, { ...row, sessionId: "oc", cli: "opencode", surface: "teams" });
  recordDelegateSession(file, { ...row, sessionId: "desk" });
  recordDelegateSession(file, { ...row, sessionId: "gone", surface: "routine", projectPath: "/gone" });
  expect(findDelegateRun(file, "3f2a-uuid", exists)).toEqual({ run: { ...row, surface: "discord", instruction: "follow-up" } });
  expect(findDelegateRun(file, "--help", exists)).toEqual({ refusal: "Copy the session id from the resume line on the finished card." });
  expect(findDelegateRun(file, "nope", exists)).toEqual({ refusal: "I have no record of that run." });
  // codex needs a UUID: a non-UUID id would start a new thread instead of resuming.
  expect(findDelegateRun(file, "cx", exists)).toEqual({ refusal: "Copy the session id from the resume line on the finished card." });
  expect(findDelegateRun(file, uuid, exists)).toEqual({ run: { ...row, sessionId: uuid, cli: "codex", surface: "routine" } });
  expect(findDelegateRun(file, "oc", exists)).toEqual({ refusal: "Only Claude and Codex sessions continue live for now — resume it from a terminal." });
  expect(findDelegateRun(file, "desk", exists)).toEqual({ refusal: "That run started in Bean's desktop chat — continue it there." });
  expect(findDelegateRun(file, "gone", exists)).toEqual({ refusal: "That project folder no longer exists on this Mac." });
  closeDb(file);
});
