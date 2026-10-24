import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { recordRun, releaseRun, updateRunPid, interruptedRunNotice, clearReservations, sweepDeadRuns } from "../src/run-queue.js";
import { runsDir } from "../src/config.js";

const tmp = () => mkdtempSync(join(tmpdir(), "bean-runqueue-"));
const DEAD = 999_999; // a pid that (almost certainly) doesn't exist
const read = (dir: string, f: string) => JSON.parse(readFileSync(join(runsDir(dir), f), "utf8"));

describe("run-queue", () => {
  it("records overlapping runs on one project, one file per run id (never refuses)", () => {
    const dir = tmp(); // no runs/ yet — created on demand
    recordRun(dir, "a", "/p", process.pid);
    recordRun(dir, "b", "/p", process.pid);
    expect(readdirSync(runsDir(dir)).sort()).toEqual(["a.json", "b.json"]);
    expect(read(dir, "a.json")).toMatchObject({ id: "a", projectPath: "/p", pid: process.pid });
    expect(typeof read(dir, "a.json").createdAt).toBe("string");
  });

  it("release removes only that run; releasing an unknown run is a no-op", () => {
    const dir = tmp();
    recordRun(dir, "a", "/p", process.pid);
    recordRun(dir, "b", "/p", process.pid);
    releaseRun(dir, "a");
    expect(readdirSync(runsDir(dir))).toEqual(["b.json"]);
    expect(() => releaseRun(dir, "nope")).not.toThrow();
  });

  it("updateRunPid rewrites the tracked pid; a no-op once the record is gone", () => {
    const dir = tmp();
    recordRun(dir, "a", "/p", process.pid);
    updateRunPid(dir, "a", 4242);
    expect(read(dir, "a.json")).toMatchObject({ id: "a", projectPath: "/p", pid: 4242 });
    releaseRun(dir, "a");
    updateRunPid(dir, "a", 1);
    expect(readdirSync(runsDir(dir))).toEqual([]);
    expect(() => updateRunPid(tmp(), "never", 1)).not.toThrow(); // no runs/ at all
  });

  it("sweepDeadRuns deletes dead-pid and malformed records (legacy hash files too), keeps live ones, never kills", () => {
    const dir = tmp();
    expect(sweepDeadRuns(dir)).toBe(0); // no runs/ yet
    recordRun(dir, "live", "/p", process.pid);
    recordRun(dir, "dead", "/p", DEAD);
    writeFileSync(join(runsDir(dir), "broken.json"), "{broken", "utf8");
    // A pre-#385 per-project reservation: same shape, hash filename.
    writeFileSync(join(runsDir(dir), "0123456789abcdef0123456789abcdef.json"),
      JSON.stringify({ id: "old", projectPath: "/p", pid: DEAD, createdAt: "2026-01-01T00:00:00Z" }), "utf8");
    expect(sweepDeadRuns(dir)).toBe(3);
    expect(readdirSync(runsDir(dir))).toEqual(["live.json"]);
  });

  it("clearReservations kills each recorded group (never this process) and empties runs/, legacy files included", () => {
    const dir = tmp();
    expect(clearReservations(dir)).toEqual([]); // no runs/ yet
    recordRun(dir, "a", "/stale", 424242);
    recordRun(dir, "b", "/self", process.pid);
    writeFileSync(join(runsDir(dir), "0123456789abcdef0123456789abcdef.json"),
      JSON.stringify({ id: "old", projectPath: "/legacy", pid: 434343, createdAt: "2026-01-01T00:00:00Z" }), "utf8");
    const killed: number[] = [];
    expect(clearReservations(dir, (pid) => { killed.push(pid); }).sort()).toEqual(["/legacy", "/self", "/stale"]);
    expect(killed.sort()).toEqual([424242, 434343]);
    expect(readdirSync(runsDir(dir))).toEqual([]);
  });
});

describe("interruptedRunNotice", () => {
  it("full keeps the complete instruction; display uses the project's basename and quotes it verbatim when short", () => {
    const { full, display } = interruptedRunNotice("/Users/scenk/Develop/Bean", "fix the bug");
    expect(full).toBe('Run on /Users/scenk/Develop/Bean ("fix the bug") was interrupted when Bean closed. Ask me again to retry.');
    expect(display).toBe('⚠️ A run on **Bean** ("fix the bug") was interrupted when Bean closed. Say "retry" and I\'ll pick it back up.');
  });

  it("display truncates a long instruction; full is unaffected", () => {
    const longInstruction = "Review GitHub PR #45: ".padEnd(200, "x");
    const { full, display } = interruptedRunNotice("/p/bean", longInstruction);
    expect(full).toContain(longInstruction); // nothing trimmed from the model-facing text
    expect(display.length).toBeLessThan(full.length);
    expect(display).toContain("…");
    expect(display).not.toContain(longInstruction);
  });

  it("a bare project name with no path separators is used as-is", () => {
    const { display } = interruptedRunNotice("bean", "do it");
    expect(display).toContain("**bean**");
  });
});
