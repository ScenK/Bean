import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { MAIN_LOG_LINE_MAX, MAIN_LOG_MAX_BYTES, createMainLog, teeConsole } from "../src/main-log.js";

const dirs: string[] = [];
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), "main-log-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

test("writes timestamp, level and the full text (stack included) into a 0600 file in a 0700 dir", () => {
  const file = join(tmp(), "Logs", "main.log");
  const log = createMainLog(file, () => new Date("2026-11-24T00:00:00Z"));
  const err = new Error("model call failed");
  expect(log("warn", ["bean: memory capture failed", err])).toBe(true);
  const text = readFileSync(file, "utf8");
  expect(text.startsWith("2026-11-24T00:00:00.000Z warn bean: memory capture failed Error: model call failed\n    at ")).toBe(true);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(statSync(join(file, "..")).mode & 0o777).toBe(0o700);
});

test("caps an entry at about 4 KB with a marker", () => {
  const file = join(tmp(), "main.log");
  createMainLog(file)("error", ["x".repeat(MAIN_LOG_LINE_MAX * 2)]);
  const line = readFileSync(file, "utf8");
  expect(line).toMatch(/ error x+ …\[truncated\]\n$/);
  expect(line.length).toBeLessThan(MAIN_LOG_LINE_MAX + 100);
});

test("rotates to one .1 generation above the cap", () => {
  const file = join(tmp(), "main.log");
  writeFileSync(file, "x".repeat(MAIN_LOG_MAX_BYTES + 1));
  writeFileSync(`${file}.1`, "older");
  createMainLog(file)("error", ["fresh"]);
  expect(statSync(`${file}.1`).size).toBe(MAIN_LOG_MAX_BYTES + 1);
  expect(readFileSync(file, "utf8")).toMatch(/ error fresh\n$/);
});

test("an unwritable path reports false instead of throwing", () => {
  const blocker = join(tmp(), "file");
  writeFileSync(blocker, "");
  expect(createMainLog(join(blocker, "Logs", "main.log"))("error", ["boom"])).toBe(false);
  expect(existsSync(join(blocker, "Logs"))).toBe(false);
});

test("teeConsole still prints, then logs each error/warn call", () => {
  const printed: unknown[][] = [];
  const logged: [string, unknown[]][] = [];
  const target = { error: (...a: unknown[]) => { printed.push(a); }, warn: (...a: unknown[]) => { printed.push(a); } };
  teeConsole((level, args) => { logged.push([level, args]); return false; }, target);
  target.error("a", 1);
  target.warn("b");
  expect(printed).toEqual([["a", 1], ["b"]]);
  expect(logged).toEqual([["error", ["a", 1]], ["warn", ["b"]]]);
});
