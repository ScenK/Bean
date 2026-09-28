import { describe, expect, it } from "vitest";
import { briefMessages, buildStageFromLine, parseBrief, parseBuildResult, type BriefContext, type RoutineBrief } from "../src/index.js";

const ctx: BriefContext = {
  tools: ["gh"],
  projects: [{ name: "bean", path: "/code/bean" }],
  skills: [{ name: "code-review", description: "review a PR" }],
  clis: ["claude"],
};

describe("parseBrief", () => {
  it("keeps known skills/projects and drops invented ones", () => {
    const brief = parseBrief(JSON.stringify({
      name: "review-queue", trigger: "watch", source: "PRs where my review is requested", sourceKind: "command", via: "gh",
      steps: [
        { kind: "delegate", skill: "code-review", project: "/nope", instruction: "Review it" },
        { kind: "chat", skill: "made-up", instruction: "Summarise" },
      ],
      sinks: { chatops: [{ transport: "discord", channel: " 123 " }, { transport: "teams", channel: "" }, { transport: "slack" }], note: true },
      missing: [{ field: "steps.0.project", question: "Which repo?" }, { field: "x" }],
    }), ctx);
    expect(brief.steps).toEqual([
      { kind: "delegate", skill: "code-review", instruction: "Review it" },
      { kind: "chat", instruction: "Summarise" },
    ]);
    expect(brief.sinks).toEqual({ chatops: [{ transport: "discord", channel: "123" }, { transport: "teams" }], note: true });
    expect(brief.missing).toEqual([{ field: "steps.0.project", question: "Which repo?" }]);
    expect(brief.everyMinutes).toBe(5);
    expect(brief.notifyOnly).toBe(false);
  });

  it("treats a URL source as a feed, a watch without steps as notify-only, and slugs a bad name", () => {
    const brief = parseBrief('```json\n{"name":"Ping Me!","trigger":"watch","source":"https://www.youtube.com/@veritasium","steps":[]}\n```', ctx);
    expect(brief).toMatchObject({ name: "ping-me", sourceKind: "feed", notifyOnly: true, everyMinutes: 15, steps: [] });
  });

  it("throws when the reply has no JSON", () => {
    expect(() => parseBrief("sorry, no", ctx)).toThrow(/didn't return a brief/);
  });

  it("tells the model what's installed and which skills exist", () => {
    const system = briefMessages("ping me", ctx)[0]!.content;
    expect(system).toContain("gh");
    expect(system).toContain("code-review");
  });
});

const brief: RoutineBrief = {
  name: "review-queue", trigger: "watch", source: "PRs", sourceKind: "command", everyMinutes: 5, notifyOnly: false,
  steps: [{ kind: "delegate", skill: "code-review", instruction: "Review" }],
  sinks: { chatops: [{ transport: "discord" }] }, missing: [],
};

describe("parseBuildResult", () => {
  it("reads the LAST json fence and keeps the brief's name, interval and sinks", () => {
    const text = [
      "draft:", "```json", '{"routine":{"watch":{"kind":"command","command":"old"}}}', "```",
      "final:", "```json",
      JSON.stringify({
        routine: { name: "evil", sinks: { chatops: [{ transport: "teams", channel: "x" }] },
          watch: { kind: "command", command: "gh search prs --review-requested=@me" },
          steps: [{ kind: "delegate", skill: "code-review", instruction: "Review the PR" }] },
        skills: [{ name: "pr-notes", markdown: "# Notes" }, { name: "../bad", markdown: "x" }],
      }),
      "```",
    ].join("\n");
    const r = parseBuildResult(text, brief);
    expect(r.routine).toMatchObject({
      name: "review-queue", enabled: false, todoDriven: true,
      watch: { kind: "command", command: "gh search prs --review-requested=@me", everyMinutes: 5 },
      sinks: { chatops: [{ transport: "discord" }] },
    });
    expect(r.skills.map((s) => s.name)).toEqual(["pr-notes"]);
  });

  it("survives a drafted skill whose markdown contains its own ```json fence, and trailing prose", () => {
    const skills = [{ name: "notes", markdown: "Output:\n```json\n{}\n```" }];
    const text = "done\n```json\n" + JSON.stringify({ routine: { watch: { kind: "command", command: "c" } }, skills }) + "\n```\nAll set {ok}.";
    const r = parseBuildResult(text, brief);
    expect(r.routine?.watch).toMatchObject({ command: "c" });
    expect(r.skills[0]?.markdown).toContain("```json");
  });

  it("parses a huge adversarial input in linear time", () => {
    const t = Date.now();
    expect(() => parseBuildResult("```json\n".repeat(20_000), brief)).toThrow();
    expect(Date.now() - t).toBeLessThan(2000);
  });

  it("returns the test error instead of a routine", () => {
    const r = parseBuildResult('```json\n{"routine":{},"testError":{"message":"gh auth login","exitCode":4}}\n```', brief);
    expect(r).toEqual({ skills: [], testError: { message: "gh auth login", exitCode: 4 } });
  });

  it("rejects output without a watch command", () => {
    expect(() => parseBuildResult("no json here", brief)).toThrow(/didn't return/);
    expect(() => parseBuildResult('```json\n{"routine":{"steps":[]}}\n```', brief)).toThrow(/no watch command/);
  });
});

it("reads BEAN-STEP progress markers", () => {
  expect(buildStageFromLine("ok BEAN-STEP: tested exit=0 items=3")).toEqual({ stage: "tested", detail: "exit=0 items=3" });
  expect(buildStageFromLine("BEAN-STEP: command")).toEqual({ stage: "command" });
  expect(buildStageFromLine("nothing")).toBeUndefined();
});
