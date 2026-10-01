import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test, vi } from "vitest";
import { closeDb, openDb } from "../src/db.js";
import { isValidSessionId, recordDelegateSession, resumeCommand, type DelegateRunRow } from "../src/delegate-runs.js";

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
