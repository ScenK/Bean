import { expect, test } from "vitest";
import { discordCards } from "../src/components.js";

const models = [
  { id: "sonnet", label: "Sonnet", aliases: { claude: "sonnet" }, availableOn: ["claude" as const] },
  { id: "gpt-5-5", label: "GPT-5.5", aliases: { opencode: "github-copilot/gpt-5.5" }, availableOn: ["opencode" as const] },
];

const proposalInput = {
  proposalId: "prop-1", projectName: "bean", skillName: "fix-bug",
  instruction: "fix the <flaky> test & report", clis: ["claude" as const, "opencode" as const],
  skills: [{ name: "fix-bug" }, { name: "review-code" }],
  models, defaultCli: "claude" as const, defaultModel: "sonnet",
};

test("proposal message shows the verbatim instruction and carries the customId contract", () => {
  const s = JSON.stringify(discordCards.proposalCard(proposalInput));
  expect(s).toContain("fix the <flaky> test & report");
  expect(s).toContain("bean:confirm:prop-1");
  expect(s).toContain("bean:cancel-proposal:prop-1");
  expect(s).toContain("bean:cli:prop-1");
  expect(s).toContain("bean:model:prop-1");
});

test("proposal selects pre-select the resolved cli and model", () => {
  const card = discordCards.proposalCard(proposalInput) as {
    components: { components: { custom_id: string; options?: { value: string; default?: boolean }[] }[] }[];
  };
  const selects = card.components.flatMap((row) => row.components).filter((c) => c.options);
  const cli = selects.find((c) => c.custom_id === "bean:cli:prop-1");
  const model = selects.find((c) => c.custom_id === "bean:model:prop-1");
  expect(cli?.options?.find((o) => o.default)?.value).toBe("claude");
  expect(model?.options?.find((o) => o.default)?.value).toBe("sonnet");
  const skill = selects.find((c) => c.custom_id === "bean:skill:prop-1");
  expect(skill?.options?.find((o) => o.default)?.value).toBe("fix-bug");
});

test("proposal skill select defaults to the no-skill sentinel when no skill was picked", () => {
  const card = discordCards.proposalCard({ ...proposalInput, skillName: undefined }) as {
    components: { components: { custom_id: string; options?: { value: string; default?: boolean }[] }[] }[];
  };
  const skill = card.components.flatMap((r) => r.components).find((c) => c.custom_id === "bean:skill:prop-1");
  expect(skill?.options?.find((o) => o.default)?.value).toBe("__none__");
});

test("proposal skill select keeps the picked skill visible past the 24-option cap", () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ name: `skill-${i}` }));
  const card = discordCards.proposalCard({ ...proposalInput, skillName: "skill-39", skills: many }) as {
    components: { components: { custom_id: string; options?: { value: string; default?: boolean }[] }[] }[];
  };
  const skill = card.components.flatMap((r) => r.components).find((c) => c.custom_id === "bean:skill:prop-1");
  expect(skill?.options).toHaveLength(25); // sentinel + 24
  expect(skill?.options?.find((o) => o.default)?.value).toBe("skill-39");
});

test("proposal skill select drops names past Discord's 100-char option-value cap", () => {
  const card = discordCards.proposalCard({ ...proposalInput, skills: [{ name: "x".repeat(101) }, { name: "ok" }] }) as {
    components: { components: { custom_id: string; options?: { value: string }[] }[] }[];
  };
  const skill = card.components.flatMap((r) => r.components).find((c) => c.custom_id === "bean:skill:prop-1");
  expect(skill?.options?.map((o) => o.value)).toEqual(["__none__", "ok"]);
});

test("running message carries cancel-run and the tail in a code block", () => {
  const s = JSON.stringify(discordCards.runningCard({
    projectName: "bean", instruction: "x", startedBy: "scen", tail: "▸ Bash", projectPath: "/p/bean",
  }));
  expect(s).toContain("bean:cancel-run:");
  expect(s).toContain("▸ Bash");
  expect(s).toContain("scen");
});

test("finished message has no components", () => {
  const card = discordCards.finishedCard({
    projectName: "bean", instruction: "x", startedBy: "scen", outcome: "done",
  }) as { components: unknown[] };
  expect(card.components).toEqual([]);
  expect(JSON.stringify(card)).toContain("done");
});

test("delegate cards clamp a long instruction to Discord's 4096-char embed description limit", () => {
  const instruction = "y".repeat(5000);
  const base = { projectName: "bean", instruction, startedBy: "scen" };
  const cards = [
    discordCards.proposalCard({ ...proposalInput, instruction }),
    discordCards.runningCard({ ...base, tail: "", projectPath: "/p/bean" }),
    discordCards.finishedCard({ ...base, outcome: "done" }),
  ] as { embeds: { description: string }[] }[];
  for (const card of cards) {
    const desc = card.embeds[0]?.description ?? "";
    expect(desc.length).toBe(4096);
    expect(desc.endsWith("…")).toBe(true);
  }
});

test("note proposal message shows the title/body and wires save/cancel customIds", () => {
  const s = JSON.stringify(discordCards.noteProposalCard({
    proposalId: "note-1", title: "Our chat", body: "## Summary\n\nwe talked", projectName: "bean", updating: false,
  }));
  expect(s).toContain("Our chat");
  expect(s).toContain("bean:save-note:note-1");
  expect(s).toContain("bean:cancel-note:note-1");
});

test("note result message has no components and states the outcome", () => {
  const card = discordCards.noteResultCard({ title: "Our chat", savedBy: "scen", outcome: "saved" }) as {
    components: unknown[];
  };
  expect(card.components).toEqual([]);
  expect(JSON.stringify(card)).toContain("saved");
});

test("todo proposal message shows the routine/text and wires queue/cancel customIds", () => {
  const s = JSON.stringify(discordCards.todoProposalCard({ proposalId: "todo-1", routine: "morning-triage", text: "check CI" }));
  expect(s).toContain('Queue a todo on \\"morning-triage\\"');
  expect(s).toContain("check CI");
  expect(s).toContain("bean:queue-todo:todo-1");
  expect(s).toContain("bean:cancel-todo:todo-1");
});

test("todo result message has no components and states the outcome", () => {
  const card = discordCards.todoResultCard({ routine: "morning-triage", queuedBy: "scen", outcome: "queued" }) as {
    components: unknown[];
  };
  expect(card.components).toEqual([]);
  expect(JSON.stringify(card)).toContain("Queued by scen");
});

test("note proposal clamps a long body to Discord's 4096-char embed description limit", () => {
  const card = discordCards.noteProposalCard({
    proposalId: "note-1", title: "T", body: "x".repeat(5000), updating: false,
  }) as { embeds: { description: string }[] };
  const desc = card.embeds[0]?.description ?? "";
  expect(desc.length).toBeLessThanOrEqual(4096);
  expect(desc).toContain("the full note is saved");
});

test("remembered card shows the fact and a Forget button carrying the memory id within Discord's 100-char custom_id", () => {
  const id = "0f8c2a4e-6b1d-4c3e-9a7f-2d5b8e1c4a90";
  const card = discordCards.rememberedCard({ memoryId: id, text: "uses vitest", projectName: "bean" }) as {
    components: { components: { custom_id: string; label: string }[] }[];
  };
  const s = JSON.stringify(card);
  expect(s).toContain("(bean) uses vitest");
  const button = card.components[0]!.components[0]!;
  expect(button.label).toBe("Forget");
  expect(button.custom_id).toBe(`bean:forget-memory:${id}`);
  expect(button.custom_id.length).toBeLessThanOrEqual(100);
});

test("live-session card renders project/skill/cli/model dropdowns, edit+start+cancel, defaults selected", () => {
  const card = discordCards.liveSessionProposalCard({
    proposalId: "live-1", projectName: "bean", instruction: "investigate the auth bug",
    model: "opus", skillName: "review",
    projects: [{ name: "bean", path: "/p/bean" }, { name: "web", path: "/p/web" }],
    models: [{ id: "sonnet", label: "sonnet" }, { id: "opus", label: "opus" }],
    skills: [{ name: "review" }, { name: "fix-bug" }], clis: ["claude"],
  }) as { components: { components: { custom_id: string; options?: { value: string; default?: boolean }[] }[] }[] };
  const s = JSON.stringify(card);
  expect(s).toContain("investigate the auth bug");
  expect(s).toContain("bean:live-project:live-1");
  expect(s).toContain("bean:live-skill:live-1");
  expect(s).toContain("bean:live-cli:live-1");
  expect(s).toContain("bean:live-model:live-1");
  expect(s).toContain("bean:live-edit:live-1");
  expect(s).toContain("bean:start-live:live-1");
  expect(s).toContain("bean:cancel-live:live-1");
  const selects = card.components.flatMap((r) => r.components).filter((c) => c.options);
  expect(selects.find((c) => c.custom_id === "bean:live-project:live-1")?.options?.find((o) => o.default)?.value).toBe("/p/bean");
  expect(selects.find((c) => c.custom_id === "bean:live-model:live-1")?.options?.find((o) => o.default)?.value).toBe("opus");
  expect(selects.find((c) => c.custom_id === "bean:live-skill:live-1")?.options?.find((o) => o.default)?.value).toBe("review");
  // 5-row cap: project, skill, cli, model, buttons.
  expect(card.components).toHaveLength(5);
});

test("live-session skill picker defaults to the no-skill sentinel when none is chosen", () => {
  const card = discordCards.liveSessionProposalCard({
    proposalId: "live-3", projectName: "bean", instruction: "go",
    projects: [{ name: "bean", path: "/p/bean" }], models: [], skills: [{ name: "review" }], clis: ["claude"],
  }) as { components: { components: { custom_id: string; options?: { value: string; default?: boolean }[] }[] }[] };
  const skill = card.components.flatMap((r) => r.components).find((c) => c.custom_id === "bean:live-skill:live-3");
  expect(skill?.options?.find((o) => o.default)?.value).toBe("__none__");
});

test("live-session card omits model/skill/cli dropdowns when none are configured", () => {
  const card = discordCards.liveSessionProposalCard({
    proposalId: "live-2", projectName: "bean", instruction: "go",
    projects: [{ name: "bean", path: "/p/bean" }], models: [], skills: [], clis: [],
  });
  const s = JSON.stringify(card);
  expect(s).not.toContain("bean:live-model:");
  expect(s).not.toContain("bean:live-skill:");
  expect(s).not.toContain("bean:live-cli:");
});

test("running card clamps a long tail to Discord's 1024-char field limit, keeping the newest end", () => {
  const tail = "a".repeat(2000) + "END";
  const card = discordCards.runningCard({
    projectName: "bean", instruction: "search", startedBy: "scen", tail, projectPath: "/p",
  }) as { embeds: { fields: { value: string }[] }[] };
  const value = card.embeds[0]!.fields[0]!.value;
  expect(value.length).toBeLessThanOrEqual(1024);
  expect(value).toContain("END\n```");
});

test("delegate proposal has Edit prompt / Run / Cancel buttons, in that order", () => {
  const card = discordCards.proposalCard(proposalInput) as {
    components: { components: { type: number; label?: string; custom_id: string }[] }[];
  };
  const buttons = card.components.flatMap((r) => r.components).filter((c) => c.type === 2);
  expect(buttons.map((b) => b.label)).toEqual(["Edit prompt", "Run", "Cancel"]);
  expect(buttons[0]?.custom_id).toBe("bean:delegate-edit:prop-1");
});

test("a re-rendered delegate proposal uses the supplied select defaults", () => {
  const card = discordCards.proposalCard({ ...proposalInput, skillName: "review-code", defaultCli: "opencode", defaultModel: "gpt-5-5" }) as {
    components: { components: { custom_id: string; options?: { value: string; default?: boolean }[] }[] }[];
  };
  const selects = card.components.flatMap((r) => r.components).filter((c) => c.options);
  const pick = (id: string): string | undefined => selects.find((c) => c.custom_id === id)?.options?.find((o) => o.default)?.value;
  expect(pick("bean:skill:prop-1")).toBe("review-code");
  expect(pick("bean:cli:prop-1")).toBe("opencode");
  expect(pick("bean:model:prop-1")).toBe("gpt-5-5");
});
