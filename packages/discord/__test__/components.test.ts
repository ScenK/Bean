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

test("note proposal clamps a long body to Discord's 4096-char embed description limit", () => {
  const card = discordCards.noteProposalCard({
    proposalId: "note-1", title: "T", body: "x".repeat(5000), updating: false,
  }) as { embeds: { description: string }[] };
  const desc = card.embeds[0]?.description ?? "";
  expect(desc.length).toBeLessThanOrEqual(4096);
  expect(desc).toContain("the full note is saved");
});
