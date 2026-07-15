import { expect, test } from "vitest";
import { discordCards } from "../src/components.js";

const models = [
  { id: "sonnet", label: "Sonnet", aliases: { claude: "sonnet" }, availableOn: ["claude" as const] },
  { id: "gpt-5-5", label: "GPT-5.5", aliases: { opencode: "github-copilot/gpt-5.5" }, availableOn: ["opencode" as const] },
];

const proposalInput = {
  proposalId: "prop-1", projectName: "bean", skillName: "fix-bug",
  instruction: "fix the <flaky> test & report", clis: ["claude" as const, "opencode" as const],
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

test("memory proposal message has a multi-select of facts and remember/cancel buttons", () => {
  const card = discordCards.memoryProposalCard({
    proposalId: "mem-1",
    facts: [{ text: "prefers tabs" }, { text: "uses vitest", projectName: "bean" }],
  }) as { components: { components: { type: number; custom_id?: string; max_values?: number; options?: unknown[] }[] }[] };
  const s = JSON.stringify(card);
  expect(s).toContain("prefers tabs");
  expect(s).toContain("bean:pick-memories:mem-1");
  expect(s).toContain("bean:save-memories:mem-1");
  expect(s).toContain("bean:cancel-memories:mem-1");
  const select = card.components[0]!.components[0]!;
  expect(select.type).toBe(3); // string select
  expect(select.max_values).toBe(2);
  expect(select.options).toHaveLength(2);
});

test("memory result message has no components and states the outcome", () => {
  const card = discordCards.memoryResultCard({ count: 2, savedBy: "scen", outcome: "saved" }) as { components: unknown[] };
  expect(card.components).toEqual([]);
  expect(JSON.stringify(card)).toContain("saved");
});

test("memory proposal clamps a long fact label to Discord's 100-char option limit", () => {
  const card = discordCards.memoryProposalCard({
    proposalId: "mem-1", facts: [{ text: "x".repeat(200) }],
  }) as { components: { components: { options?: { label: string }[] }[] }[] };
  const label = card.components[0]!.components[0]!.options![0]!.label;
  expect(label.length).toBeLessThanOrEqual(100);
});
