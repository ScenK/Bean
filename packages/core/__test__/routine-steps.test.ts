import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runsDir } from "../src/config.js";
import { makeRoutineSteps } from "../src/routine-steps.js";

const tmp = (p: string): string => mkdtempSync(join(tmpdir(), p));
const records = (dir: string): { pid: number; projectPath: string }[] => {
  try {
    return readdirSync(runsDir(dir)).map((f) => JSON.parse(readFileSync(join(runsDir(dir), f), "utf8")));
  } catch { return []; }
};

describe("makeRoutineSteps delegate adapter", () => {
  it("records every step's run against its spawned child's pid (cron, no todo), then releases it", async () => {
    const dir = tmp("bean-steps-");
    const project = tmp("bean-proj-");
    let childPid: number | undefined;
    let recorded: number | undefined;
    const { delegateStep } = makeRoutineSteps({
      dir, path: process.env.PATH ?? "",
      selectCli: () => ({ cli: "claude" }),
      spawnFn: (_cmd, _args, cwd) => {
        const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 300)"], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
        childPid = child.pid;
        setTimeout(() => { recorded = records(dir)[0]?.pid; }, 100);
        return child;
      },
    });
    await delegateStep({ projectPath: project, instruction: "x", priorOutputs: "" }).catch(() => {});
    expect(recorded).toBe(childPid);
    expect(records(dir)).toEqual([]);
  });

  it("two steps on one project run at once, each with its own record", async () => {
    const dir = tmp("bean-steps-");
    const project = tmp("bean-proj-");
    let midRun: string[] = [];
    const { delegateStep } = makeRoutineSteps({
      dir, path: process.env.PATH ?? "",
      selectCli: () => ({ cli: "claude" }),
      spawnFn: (_cmd, _args, cwd) => {
        setTimeout(() => { midRun = records(dir).map((r) => r.projectPath); }, 100);
        return spawn(process.execPath, ["-e", "setTimeout(() => {}, 300)"], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      },
    });
    await Promise.all([
      delegateStep({ projectPath: project, instruction: "a", priorOutputs: "", todoId: "t1" }).catch(() => {}),
      delegateStep({ projectPath: project, instruction: "b", priorOutputs: "", todoId: "t2" }).catch(() => {}),
    ]);
    expect(midRun).toEqual([project, project]);
    expect(records(dir)).toEqual([]);
  });

  it("a gated hold keeps the per-todo scratch dir past the step; the run record still goes", async () => {
    const dir = tmp("bean-steps-");
    const { delegateStep } = makeRoutineSteps({
      dir, path: process.env.PATH ?? "",
      selectCli: () => ({ cli: "claude" }),
      spawnFn: (_cmd, _args, cwd) => spawn(process.execPath, ["-e", ""], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] }),
    });
    const hold = { scratch: new Set<string>() };
    await delegateStep({ instruction: "x", priorOutputs: "", todoId: "t1" }, undefined, hold).catch(() => {});
    const [scratch] = [...hold.scratch];
    expect(scratch && existsSync(scratch)).toBe(true);
    expect(records(dir)).toEqual([]);
  });
});
