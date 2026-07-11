import { expect, test } from "vitest";
import { finishedCard, noteProposalCard, noteResultCard, proposalCard, runningCard } from "../src/cards.js";

const models = [
  { id: "sonnet", label: "Sonnet", aliases: { claude: "sonnet" }, availableOn: ["claude" as const] },
  { id: "gpt-5-5", label: "GPT-5.5", aliases: { opencode: "github-copilot/gpt-5.5" }, availableOn: ["opencode" as const] },
];

function flatten(card: object): string {
  return JSON.stringify(card);
}

test("proposal card shows the verbatim instruction and wires confirm/cancel data", () => {
  const card = proposalCard({
    proposalId: "prop-1", projectName: "bean", skillName: "fix-bug",
    instruction: "fix the <flaky> test & report", clis: ["claude", "opencode"],
    models, defaultCli: "claude", defaultModel: "sonnet",
  });
  const s = flatten(card);
  expect(s).toContain("fix the <flaky> test & report");
  expect(s).toContain('"beanAction":"confirm"');
  expect(s).toContain('"beanAction":"cancel-proposal"');
  expect(s).toContain('"proposalId":"prop-1"');
});

test("proposal card pre-selects the resolved cli and model in ChoiceSets", () => {
  const card = proposalCard({
    proposalId: "p", projectName: "bean", instruction: "x",
    clis: ["claude"], models, defaultCli: "claude", defaultModel: "sonnet",
  }) as { body: { type: string; id?: string; value?: string }[] };
  const cliInput = card.body.find((el) => el.id === "cli");
  const modelInput = card.body.find((el) => el.id === "model");
  expect(cliInput?.value).toBe("claude");
  expect(modelInput?.value).toBe("sonnet");
});

test("running card carries a cancel-run action with the project path", () => {
  const s = flatten(runningCard({
    projectName: "bean", instruction: "x", startedBy: "bob", tail: "▸ Bash", projectPath: "/p/bean",
  }));
  expect(s).toContain('"beanAction":"cancel-run"');
  expect(s).toContain('"projectPath":"/p/bean"');
  expect(s).toContain("▸ Bash");
  expect(s).toContain("bob");
});

test("finished card states the outcome and has no actions", () => {
  const card = finishedCard({ projectName: "bean", instruction: "x", startedBy: "bob", outcome: "done" }) as {
    actions?: unknown[];
  };
  expect(card.actions ?? []).toHaveLength(0);
  expect(flatten(card)).toContain("done");
});

test("note proposal card shows the title/body and wires save/cancel data", () => {
  const s = flatten(noteProposalCard({
    proposalId: "note-1", title: "Our chat", body: "## Summary\n\nwe talked", projectName: "bean", updating: false,
  }));
  expect(s).toContain("Our chat");
  expect(s).toContain("we talked");
  expect(s).toContain('"beanAction":"save-note"');
  expect(s).toContain('"beanAction":"cancel-note"');
  expect(s).toContain('"proposalId":"note-1"');
});

test("note result card states the outcome and has no actions", () => {
  const card = noteResultCard({ title: "Our chat", savedBy: "bob", outcome: "saved" }) as { actions?: unknown[] };
  expect(card.actions ?? []).toHaveLength(0);
  expect(flatten(card)).toContain("saved");
});
