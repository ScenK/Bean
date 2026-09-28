import { describe, expect, it, vi } from "vitest";
import { createRoutineBuilder, type RoutineBuilderDeps } from "../src/routine-builder.js";
import type { Routine, RoutineBrief, Skill } from "@bean/core";

const skill: Skill = { name: "build-routine", description: "", body: "# Build", hidden: true } as Skill;
const brief = (over: Partial<RoutineBrief> = {}): RoutineBrief => ({
  name: "review-queue", trigger: "watch", source: "PRs for me", sourceKind: "command", via: "gh", everyMinutes: 5,
  notifyOnly: false, steps: [{ kind: "delegate", skill: "code-review", instruction: "Review" }],
  sinks: { chatops: [{ transport: "discord" }] }, missing: [], ...over,
});
const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(agentOutput: string | Error, over: Partial<RoutineBuilderDeps> = {}) {
  const saved: Routine[] = [];
  const deps: RoutineBuilderDeps = {
    loadRoutines: async () => saved,
    saveRoutine: vi.fn(async (r: Routine) => { saved.push(r); }),
    loadSkills: async () => [skill],
    saveSkill: vi.fn(async () => {}),
    pollWatch: vi.fn(async () => [{ id: "1", text: "PR 1" }]),
    fetchText: async () => "",
    tools: () => ["gh"],
    startAgent: vi.fn((_prompt, _brief, onLine) => {
      onLine("BEAN-STEP: command");
      return { done: agentOutput instanceof Error ? Promise.reject(agentOutput) : Promise.resolve(agentOutput), cancel: vi.fn() };
    }),
    ...over,
  };
  return { deps, builder: createRoutineBuilder(deps), saved };
}

const ok = '```json\n{"routine":{"watch":{"kind":"command","command":"gh search prs"},"steps":[{"kind":"delegate","skill":"code-review","instruction":"Review the PR"}]}}\n```';

describe("routine builder", () => {
  it("builds a command watch, re-runs the command itself, and saves it disabled", async () => {
    const t = setup(ok);
    await t.builder.start(brief());
    expect(t.builder.list()[0]).toMatchObject({ status: "building" });
    await flush();
    expect(t.deps.pollWatch).toHaveBeenCalledWith({ kind: "command", command: "gh search prs", everyMinutes: 5 });
    expect(t.saved[0]).toMatchObject({ name: "review-queue", enabled: false, todoDriven: true });
    expect(t.builder.list()).toEqual([]); // the routine itself is now the "needs review" row
  });

  it("a failed test saves nothing and keeps the failure (with exit code) in the list", async () => {
    const t = setup('```json\n{"routine":{},"testError":{"message":"gh auth login","exitCode":4}}\n```');
    await t.builder.start(brief());
    await flush();
    expect(t.saved).toEqual([]);
    expect(t.builder.list()[0]).toMatchObject({ status: "failed", error: "gh auth login", exitCode: 4 });
    t.builder.dismiss("review-queue");
    expect(t.builder.list()).toEqual([]);
  });

  it("fails when Bean's own re-run of the command fails", async () => {
    const t = setup(ok, { pollWatch: vi.fn(async () => { throw new Error("exit 1"); }) });
    await t.builder.start(brief());
    await flush();
    expect(t.saved).toEqual([]);
    expect(t.builder.list()[0]?.error).toMatch(/Bean re-ran the command.*exit 1/);
  });

  it("feed briefs skip the agent: find the feed on the page, check it, save", async () => {
    const t = setup(ok, {
      fetchText: async () => '<link rel="canonical" href="https://www.youtube.com/channel/UCabc">',
    });
    await t.builder.start(brief({ name: "yt", sourceKind: "feed", source: "https://www.youtube.com/@x", notifyOnly: true, steps: [] }));
    await flush();
    expect(t.deps.startAgent).not.toHaveBeenCalled();
    expect(t.saved[0]).toMatchObject({
      name: "yt", enabled: false, steps: [],
      watch: { kind: "feed", url: "https://www.youtube.com/feeds/videos.xml?channel_id=UCabc" },
    });
  });

  it("refuses a name that already exists, and never overwrites an existing skill", async () => {
    const t = setup(ok.replace('"steps"', '"skills":[{"name":"build-routine","markdown":"x"},{"name":"fresh","markdown":"# y"}],"steps"').replace('}}\n```', '}}\n```'));
    await t.builder.start(brief());
    await flush();
    await expect(t.builder.start(brief())).rejects.toThrow(/already exists/);
    expect(t.deps.saveSkill).not.toHaveBeenCalledWith("build-routine", expect.anything());
  });

  it("cancel drops the build and stops the agent", async () => {
    const cancel = vi.fn();
    const t = setup(ok, { startAgent: vi.fn(() => ({ done: new Promise<string>(() => {}), cancel })) });
    await t.builder.start(brief());
    await flush();
    t.builder.cancel("review-queue");
    expect(cancel).toHaveBeenCalled();
    expect(t.builder.list()).toEqual([]);
  });

  it("refuses a name that could escape the scratch dir", async () => {
    const t = setup(ok);
    await expect(t.builder.start(brief({ name: "x/../.." }))).rejects.toThrow(/lowercase/);
    expect(t.deps.startAgent).not.toHaveBeenCalled();
  });
});
