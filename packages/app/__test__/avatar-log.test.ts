import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { AVATAR_LOG_MAX_BYTES, createAvatarLog } from "../src/avatar-log.js";

const dirs: string[] = [];
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), "avatar-log-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

test("writes allowlisted fields only, creating the logs dir", () => {
  const file = join(tmp(), "logs", "avatar.log");
  const log = createAvatarLog(file, () => new Date("2026-11-09T00:00:00Z"));
  expect(log("did-fail-load", { errorCode: -6, errorDescription: "ERR_FILE_NOT_FOUND", validatedURL: "file:///Users/me/x", line: "task text" })).toBe(true);
  expect(readFileSync(file, "utf8")).toBe('2026-11-09T00:00:00.000Z did-fail-load {"errorCode":-6,"errorDescription":"ERR_FILE_NOT_FOUND"}\n');
  expect(statSync(file).mode & 0o777).toBe(0o600);
});

test("rotates to one .1 generation above 1 MB", () => {
  const file = join(tmp(), "avatar.log");
  writeFileSync(file, "x".repeat(AVATAR_LOG_MAX_BYTES + 1));
  writeFileSync(`${file}.1`, "older");
  const log = createAvatarLog(file);
  log("resume");
  expect(statSync(`${file}.1`).size).toBe(AVATAR_LOG_MAX_BYTES + 1);
  expect(readFileSync(file, "utf8")).toMatch(/ resume \{\}\n$/);
});

test("an unwritable path reports false instead of throwing", () => {
  const blocker = join(tmp(), "file");
  writeFileSync(blocker, "");
  const log = createAvatarLog(join(blocker, "logs", "avatar.log"));
  expect(log("suspend")).toBe(false);
  expect(existsSync(join(blocker, "logs"))).toBe(false);
});
