// packages/core/__test__/routine-store.test.ts
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendRunRecord, deleteRoutine, isValidRoutine, loadRoutines, loadRoutineStates,
  saveRoutine, saveRoutineStates, type Routine, type RunRecord,
} from "../src/routine-store.js";

const routine = (over: Partial<Routine> = {}): Routine => ({
  name: "morning-triage", enabled: true, cron: "30 6 * * 1-5",
  steps: [{ kind: "chat", instruction: "sweep mentions" }], sinks: {}, ...over,
});
const record = (over: Partial<RunRecord> = {}): RunRecord => ({
  startedAt: "2026-07-12T06:30:00.000Z", finishedAt: "2026-07-12T06:31:00.000Z",
  status: "ok", digest: "all clear", steps: [{ kind: "chat", ok: true, summary: "swept" }], ...over,
});
const tmp = () => mkdtemp(join(tmpdir(), "bean-routines-"));

describe("save/load/delete routines", () => {
  it("round-trips a routine as <name>.json", async () => {
    const dir = await tmp();
    await saveRoutine(dir, routine());
    const loaded = await loadRoutines(dir);
    expect(loaded).toEqual([routine()]);
    await deleteRoutine(dir, "morning-triage");
    expect(await loadRoutines(dir)).toEqual([]);
  });
  it("skips invalid files and non-json entries, missing dir → []", async () => {
    expect(await loadRoutines("/nonexistent/nowhere")).toEqual([]);
    const dir = await tmp();
    await writeFile(join(dir, "broken.json"), "{nope", "utf8");
    await writeFile(join(dir, "wrong.json"), JSON.stringify({ name: "wrong" }), "utf8");
    await saveRoutine(dir, routine());
    expect((await loadRoutines(dir)).map((r) => r.name)).toEqual(["morning-triage"]);
  });
  it("rejects bad names (traversal) and bad cron at save time", async () => {
    const dir = await tmp();
    await expect(saveRoutine(dir, routine({ name: "../evil" }))).rejects.toThrow();
    await expect(saveRoutine(dir, routine({ cron: "not cron" }))).rejects.toThrow();
    await expect(deleteRoutine(dir, "../evil")).rejects.toThrow();
  });
});

describe("isValidRoutine", () => {
  it("accepts both step kinds and rejects unknown kinds / empty steps", () => {
    expect(isValidRoutine(routine({ steps: [
      { kind: "delegate", skill: "ci-triage", project: "/p", instruction: "check CI" },
      { kind: "chat", instruction: "sweep" },
    ] }))).toBe(true);
    expect(isValidRoutine(routine({ steps: [] }))).toBe(false);
    expect(isValidRoutine({ ...routine(), steps: [{ kind: "launch", instruction: "x" }] })).toBe(false);
    expect(isValidRoutine({ ...routine(), cron: 5 })).toBe(false);
  });
});

describe("routine state", () => {
  it("round-trips states; missing/invalid file → {}", async () => {
    const dir = await tmp();
    const file = join(dir, ".state.json");
    expect(await loadRoutineStates(file)).toEqual({});
    await saveRoutineStates(file, { "morning-triage": { lastRun: "2026-07-12T06:30:00.000Z", history: [record()] } });
    const states = await loadRoutineStates(file);
    expect(states["morning-triage"]?.history).toHaveLength(1);
  });
  it("appendRunRecord caps history at 20 and clears missed", () => {
    let state = appendRunRecord(undefined, record());
    expect(state.history).toHaveLength(1);
    state.missed = true;
    for (let i = 0; i < 25; i++) state = appendRunRecord(state, record({ digest: `run ${i}` }));
    expect(state.history).toHaveLength(20);
    expect(state.history[0]!.digest).toBe("run 24"); // newest first
    expect(state.missed).toBe(false);
  });
});
