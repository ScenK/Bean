import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { reserveRun, releaseRun, updateReservationPid, interruptedRunNotice } from "../src/run-queue.js";
import { runsDir } from "../src/config.js";

const tmp = () => mkdtempSync(join(tmpdir(), "bean-runqueue-"));
let n = 0;
const newId = () => `run-${++n}`;

describe("run-queue", () => {
  it("reserves a free project path and refuses a second reservation for the same path while alive", () => {
    const dir = tmp();
    const first = reserveRun(dir, "/p", process.pid, newId);
    expect(first?.projectPath).toBe("/p");
    expect(reserveRun(dir, "/p", process.pid, newId)).toBeUndefined();
    // A different project path is unaffected.
    expect(reserveRun(dir, "/q", process.pid, newId)?.projectPath).toBe("/q");
  });

  it("reservation is keyed by project path atomically (O_EXCL create) — no scan-then-write window", () => {
    // Can't truly simulate two racing OS processes in a single-threaded synchronous test; what
    // this does verify is that a second reserveRun call for the same (alive) project never
    // creates a second file — the write itself is exclusive (O_EXCL), not a separate
    // check-then-write that a directory-scan-then-write-a-new-file scheme would have raced.
    const dir = tmp();
    const a = reserveRun(dir, "/p", process.pid, newId);
    const b = reserveRun(dir, "/p", process.pid, newId);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(readdirSync(runsDir(dir))).toHaveLength(1);
  });

  it("release frees the path for a new reservation", () => {
    const dir = tmp();
    const first = reserveRun(dir, "/p", process.pid, newId);
    expect(first).toBeDefined();
    releaseRun(dir, "/p");
    expect(readdirSync(runsDir(dir))).toEqual([]);
    expect(reserveRun(dir, "/p", process.pid, newId)).toBeDefined();
  });

  it("reclaims a reservation left by a dead pid (crash recovery)", () => {
    const dir = tmp();
    // A pid that (almost certainly) doesn't exist — simulates a crashed/force-quit process
    // that never ran its own cleanup.
    const deadPid = 999_999;
    const stale = reserveRun(dir, "/p", deadPid, newId);
    expect(stale).toBeDefined();
    const reclaimed = reserveRun(dir, "/p", process.pid, newId);
    expect(reclaimed).toBeDefined();
    expect(reclaimed?.pid).toBe(process.pid);
    // The stale file was swept, only the reclaiming reservation remains.
    expect(readdirSync(runsDir(dir))).toHaveLength(1);
  });

  it("missing runs dir → reserve succeeds (mkdir on demand)", () => {
    const dir = tmp();
    expect(reserveRun(dir, "/p", process.pid, newId)).toBeDefined();
  });

  it("a malformed reservation file is reclaimed rather than blocking forever", () => {
    const dir = tmp();
    reserveRun(dir, "/p", process.pid, newId);
    const [file] = readdirSync(runsDir(dir));
    writeFileSync(join(runsDir(dir), file!), "{broken", "utf8"); // corrupt the live reservation in place
    const r = reserveRun(dir, "/p", process.pid, newId);
    expect(r).toBeDefined();
    expect(readdirSync(runsDir(dir))).toHaveLength(1);
  });

  it("release of a project with no reservation is a no-op", () => {
    const dir = tmp();
    expect(() => releaseRun(dir, "/nope")).not.toThrow();
  });

  it("reservation file content round-trips (id, projectPath, pid, createdAt)", () => {
    const dir = tmp();
    const r = reserveRun(dir, "/p", process.pid, newId);
    const [file] = readdirSync(runsDir(dir));
    const onDisk = JSON.parse(readFileSync(join(runsDir(dir), file!), "utf8"));
    expect(onDisk).toMatchObject({ id: r!.id, projectPath: "/p", pid: process.pid });
    expect(typeof onDisk.createdAt).toBe("string");
  });

  it("updateReservationPid rewrites the tracked pid, and the busy-check follows the new pid not the old one", () => {
    const dir = tmp();
    // Reserve under a pid that's (almost certainly) dead — simulates the owning-process pid
    // used before a delegate child exists — then switch it to a genuinely live one.
    const deadPid = 999_999;
    const r = reserveRun(dir, "/p", deadPid, newId)!;
    updateReservationPid(dir, "/p", process.pid);
    // Busy now under the NEW (live) pid — if the update hadn't taken effect, this would instead
    // reclaim the still-dead-pid'd reservation and succeed.
    expect(reserveRun(dir, "/p", 1, newId)).toBeUndefined();
    const [file] = readdirSync(runsDir(dir));
    const onDisk = JSON.parse(readFileSync(join(runsDir(dir), file!), "utf8"));
    expect(onDisk).toMatchObject({ id: r.id, projectPath: "/p", pid: process.pid });
  });

  it("updateReservationPid is a no-op if the reservation is already gone", () => {
    const dir = tmp();
    // No runs/ dir exists yet at all — updateReservationPid must not try to create one.
    expect(() => updateReservationPid(dir, "/never-reserved", 1)).not.toThrow();
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
