import { EventEmitter } from "node:events";
import { expect, test } from "vitest";
import { createDevProcessManager } from "../scripts/dev-processes.mjs";

function child(pid: number) {
  const proc = new EventEmitter() as EventEmitter & { pid: number; killed: boolean; exitCode: number | null; kill: () => void };
  proc.pid = pid;
  proc.killed = false;
  proc.exitCode = null;
  proc.kill = () => { proc.killed = true; };
  return proc;
}

test("dev process manager SIGTERMs tracked children", () => {
  const manager = createDevProcessManager();
  const proc = child(123);

  manager.track(proc);
  manager.killAll();

  expect(proc.killed).toBe(true);
});

test("dev process manager forgets exited children", () => {
  const manager = createDevProcessManager();
  const proc = child(456);

  manager.track(proc);
  proc.emit("exit");
  manager.killAll();

  expect(proc.killed).toBe(false);
});

test("dev process manager skips already-killed children", () => {
  const manager = createDevProcessManager();
  const proc = child(789);
  proc.killed = true;
  let calls = 0;
  proc.kill = () => { calls++; };

  manager.track(proc);
  manager.killAll();

  expect(calls).toBe(0);
});
