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
