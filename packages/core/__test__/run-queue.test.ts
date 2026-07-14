import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { reserveRun, releaseRun } from "../src/run-queue.js";
import { runsDir } from "../src/config.js";

const tmp = () => mkdtempSync(join(tmpdir(), "bean-runqueue-"));
let n = 0;
const newId = () => `run-${++n}`;

describe("run-queue", () => {
  it("reserves a free project path and refuses a second reservation for the same path while alive", async () => {
    const dir = tmp();
    const first = await reserveRun(dir, "/p", process.pid, newId);
    expect(first?.projectPath).toBe("/p");
    expect(await reserveRun(dir, "/p", process.pid, newId)).toBeUndefined();
    // A different project path is unaffected.
    expect((await reserveRun(dir, "/q", process.pid, newId))?.projectPath).toBe("/q");
  });

  it("release frees the path for a new reservation", async () => {
    const dir = tmp();
    const first = await reserveRun(dir, "/p", process.pid, newId);
    expect(first).toBeDefined();
    await releaseRun(dir, first!.id);
    expect(readdirSync(runsDir(dir))).toEqual([]);
    expect(await reserveRun(dir, "/p", process.pid, newId)).toBeDefined();
  });

  it("reclaims a reservation left by a dead pid (crash recovery)", async () => {
    const dir = tmp();
    // A pid that (almost certainly) doesn't exist — simulates a crashed/force-quit process
    // that never ran its own cleanup.
    const deadPid = 999_999;
    const stale = await reserveRun(dir, "/p", deadPid, newId);
    expect(stale).toBeDefined();
    const reclaimed = await reserveRun(dir, "/p", process.pid, newId);
    expect(reclaimed).toBeDefined();
    expect(reclaimed?.pid).toBe(process.pid);
    // The stale file was swept, only the reclaiming reservation remains.
    expect(readdirSync(runsDir(dir))).toHaveLength(1);
  });

  it("missing runs dir → reserve succeeds (mkdir on demand)", async () => {
    const dir = tmp();
    expect(await reserveRun(dir, "/p", process.pid, newId)).toBeDefined();
  });

  it("malformed reservation files are swept and don't block a new reservation", async () => {
    const dir = tmp();
    // Prime the dir via a throwaway reservation on another path so runs/ exists, then drop junk in.
    await reserveRun(dir, "/other", process.pid, newId);
    writeFileSync(join(runsDir(dir), "junk.json"), "{broken", "utf8");
    const r = await reserveRun(dir, "/p", process.pid, newId);
    expect(r).toBeDefined();
    expect(readdirSync(runsDir(dir))).not.toContain("junk.json");
  });

  it("release of an unknown id is a no-op", async () => {
    const dir = tmp();
    await expect(releaseRun(dir, "nope")).resolves.toBeUndefined();
  });

  it("reservation file content round-trips (id, projectPath, pid, createdAt)", async () => {
    const dir = tmp();
    const r = await reserveRun(dir, "/p", process.pid, newId);
    const onDisk = JSON.parse(readFileSync(join(runsDir(dir), `${r!.id}.json`), "utf8"));
    expect(onDisk).toMatchObject({ id: r!.id, projectPath: "/p", pid: process.pid });
    expect(typeof onDisk.createdAt).toBe("string");
  });
});
