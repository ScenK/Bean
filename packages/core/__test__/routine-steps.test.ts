import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runsDir } from "../src/config.js";
import { makeRoutineSteps } from "../src/routine-steps.js";

describe("makeRoutineSteps delegate adapter", () => {
  it("a todo's project reservation tracks the spawned child's pid, then is released", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bean-steps-"));
    const project = mkdtempSync(join(tmpdir(), "bean-proj-"));
    let childPid: number | undefined;
    let reservedPid: number | undefined;
    const { delegateStep } = makeRoutineSteps({
      dir, path: process.env.PATH ?? "",
      selectCli: () => ({ cli: "claude" }),
      spawnFn: (_cmd, _args, cwd) => {
        const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 300)"], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
        childPid = child.pid;
        setTimeout(() => {
          const [f] = readdirSync(runsDir(dir));
          reservedPid = (JSON.parse(readFileSync(join(runsDir(dir), f!), "utf8")) as { pid: number }).pid;
        }, 100);
        return child;
      },
    });
    await delegateStep({ projectPath: project, instruction: "x", priorOutputs: "", todoId: "t1" }).catch(() => {});
    expect(reservedPid).toBe(childPid);
    expect(readdirSync(runsDir(dir))).toEqual([]);
  });

  it("a gated hold hands the reservation back to the live host once the child exits", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bean-steps-"));
    const project = mkdtempSync(join(tmpdir(), "bean-proj-"));
    const { delegateStep } = makeRoutineSteps({
      dir, path: process.env.PATH ?? "",
      selectCli: () => ({ cli: "claude" }),
      spawnFn: (_cmd, _args, cwd) => spawn(process.execPath, ["-e", ""], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] }),
    });
    const hold = { reserved: new Set<string>(), scratch: new Set<string>() };
    await delegateStep({ projectPath: project, instruction: "x", priorOutputs: "", todoId: "t1" }, undefined, hold).catch(() => {});
    const [f] = readdirSync(runsDir(dir));
    expect((JSON.parse(readFileSync(join(runsDir(dir), f!), "utf8")) as { pid: number }).pid).toBe(process.pid);
  });
});
