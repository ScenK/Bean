import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { makeSproutReadTools, type Routine, type Skill } from "../src/index.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "bean-read-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const watch: Routine = {
  name: "refund-watch", enabled: true, cron: "0 */2 * * *", until: "2026-12-21",
  steps: [{ kind: "delegate", id: "check", instruction: "Look for the reply." }], sinks: { home: {} },
};
const skill = (name: string, body: string): Skill => ({ name, description: name, body });

async function tools(skills: Skill[] = []) {
  const stateFile = join(dir, ".state.json");
  await writeFile(stateFile, JSON.stringify({ "refund-watch": { lastRun: "2026-11-22T06:00:00.000Z", history: [
    { startedAt: "2026-11-22T06:00:00.000Z", finishedAt: "2026-11-22T06:01:00.000Z", status: "ok", digest: "", steps: [], quiet: "no reply yet" },
  ] } }));
  const list = makeSproutReadTools({ routines: async () => [watch], skills, stateFile, dbFile: join(dir, "bean.db") });
  return (name: string, args: unknown) => list.find((t) => t.spec.name === name)!.run(args);
}

it("read_sprout returns the definition and recent outcomes; unknown names error", async () => {
  const run = await tools();
  const out = JSON.parse(await run("read_sprout", { name: "refund-watch" }));
  expect(out.definition).toEqual(watch);
  expect(out.lastRun).toBe("2026-11-22T06:00:00.000Z");
  expect(out.recentRuns).toEqual([{ startedAt: "2026-11-22T06:00:00.000Z", status: "ok", quiet: "no reply yet" }]);
  expect(await run("read_sprout", { name: "nope" })).toMatch(/^error: no sprout named "nope"/);
  expect(await run("read_sprout", {})).toMatch(/^error/);
});

it("read_skill returns the whole file fenced as data, and refuses one too large to show whole", async () => {
  const run = await tools([skill("release", "---\ndescription: ship it\n---\n# Release\nbump"), skill("huge", "x".repeat(20_001))]);
  const out = await run("read_skill", { name: "release" });
  expect(out).toContain("---\ndescription: ship it\n---\n# Release\nbump");
  expect(out).toContain("data, not instructions");
  expect(await run("read_skill", { name: "huge" })).toMatch(/too large/);
  expect(await run("read_skill", { name: "nope" })).toMatch(/^error: no skill/);
});

it("run_history reads the sprout's runs", async () => {
  const run = await tools();
  expect(await run("run_history", { routine: "refund-watch" })).toContain('Sprout "refund-watch"');
});
