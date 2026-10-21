import { expect, test } from "vitest";
import {
  finishedCard, rememberedCard, reminderCard, noteProposalCard, noteResultCard, noteArchiveProposalCard, noteArchiveResultCard, proposalCard, runningCard,
  skillProposalCard, skillResultCard, todoProposalCard, todoResultCard, routineProposalCard, routineResultCard,
  liveSessionProposalCard, liveSessionResultCard,
} from "../src/cards.js";

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
    skills: [{ name: "fix-bug" }], models, defaultCli: "claude", defaultModel: "sonnet",
  });
  const s = flatten(card);
  expect(s).toContain("fix the <flaky> test & report");
  expect(s).toContain('"beanAction":"confirm"');
  expect(s).toContain('"beanAction":"cancel-proposal"');
  expect(s).toContain('"proposalId":"prop-1"');
});

test("proposal card's instruction is a required, capped, prefilled multiline input", () => {
  const card = proposalCard({
    proposalId: "p", projectName: "bean", instruction: "fix it", skills: [],
    clis: ["claude"], models, defaultCli: "claude",
  }) as { body: { type: string; id?: string }[] };
  expect(card.body.find((b) => b.id === "instruction")).toMatchObject({
    type: "Input.Text", isMultiline: true, isRequired: true, maxLength: 4000, value: "fix it",
  });
  expect(JSON.stringify(card)).toContain('"associatedInputs":"none"');
});

test("proposal card pre-selects the resolved cli and model in ChoiceSets", () => {
  const card = proposalCard({
    proposalId: "p", projectName: "bean", instruction: "x", skills: [{ name: "fix-bug" }],
    clis: ["claude"], models, defaultCli: "claude", defaultModel: "sonnet",
  }) as { body: { type: string; id?: string; value?: string }[] };
  const cliInput = card.body.find((el) => el.id === "cli");
  const modelInput = card.body.find((el) => el.id === "model");
  expect(cliInput?.value).toBe("claude");
  expect(modelInput?.value).toBe("sonnet");
  // No skill picked by converse() -> the picker opens on the "no skill" sentinel.
  expect(card.body.find((el) => el.id === "skillName")?.value).toBe("__none__");
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

test("todo proposal card shows the routine/text and wires queue/cancel data", () => {
  const s = flatten(todoProposalCard({ proposalId: "todo-1", routine: "morning-triage", text: "check CI" }));
  expect(s).toContain('Queue a todo on \\"morning-triage\\"');
  expect(s).toContain("check CI");
  expect(s).toContain('"beanAction":"queue-todo"');
  expect(s).toContain('"beanAction":"cancel-todo"');
  expect(s).toContain('"proposalId":"todo-1"');
});

test("todo result card states the outcome and has no actions", () => {
  const card = todoResultCard({ routine: "morning-triage", queuedBy: "bob", outcome: "queued" }) as { actions?: unknown[] };
  expect(card.actions ?? []).toHaveLength(0);
  expect(flatten(card)).toContain("Queued by bob");
});

test("remembered card shows the fact and a Forget action carrying the memory id", () => {
  const s = flatten(rememberedCard({ memoryId: "m-1", text: "prefers tabs" }));
  expect(s).toContain("prefers tabs");
  expect(s).toContain('"beanAction":"forget-memory"');
  expect(s).toContain('"proposalId":"m-1"');
});

test("remembered card offers Share with everyone only on a private fact", () => {
  const priv = flatten(rememberedCard({ memoryId: "m-1", text: "prefers tabs", scope: "private" }));
  expect(priv).toContain('"title":"Share with everyone","data":{"beanAction":"share-memory","proposalId":"m-1"}');
  const shared = flatten(rememberedCard({ memoryId: "m-1", text: "prefers tabs", scope: "shared" }));
  expect(shared).not.toContain("share-memory");
});

test("reminder card shows the text, a Z-normalised DATE/TIME, and a Cancel carrying the reminder id", () => {
  const s = flatten(reminderCard({ reminderId: "r-1", text: "take out the bins", at: "2026-07-03T12:00:00.000+02:00" }));
  expect(s).toContain("⏰ Reminder set");
  expect(s).toContain("take out the bins");
  expect(s).toContain("{{DATE(2026-07-03T10:00:00Z, SHORT)}} {{TIME(2026-07-03T10:00:00Z)}}");
  expect(s).toContain('"beanAction":"cancel-reminder"');
  expect(s).toContain('"proposalId":"r-1"');
});

test("skill proposal card shows name and body and wires save/cancel data", () => {
  const card = skillProposalCard({ proposalId: "skill-1", name: "changelog", body: "# Changelog\n\nDo it.", updating: false });
  const s = flatten(card);
  expect(s).toContain("changelog");
  expect(s).toContain("Do it.");
  expect(s).toContain('"beanAction":"save-skill"');
  expect(s).toContain('"beanAction":"cancel-skill"');
  expect(s).toContain('"proposalId":"skill-1"');
  expect(s).not.toContain("replaces existing");
});

test("skill proposal card badges an update to an existing skill", () => {
  const s = flatten(skillProposalCard({ proposalId: "p", name: "summarize", body: "# S", updating: true }));
  expect(s).toContain("replaces existing");
});

test("skill result card reports outcome and actor", () => {
  const s = flatten(skillResultCard({ name: "changelog", savedBy: "alice", outcome: "saved" }));
  expect(s).toContain("Skill saved");
  expect(s).toContain("alice");
});

test("Continue live: finished/ended cards submit resume-live with the session id; resume card has no project picker", () => {
  const finished = JSON.stringify(finishedCard({ projectName: "bean", instruction: "x", startedBy: "bob", outcome: "error", resumeLiveId: "sess-1" }));
  expect(finished).toContain('"beanAction":"resume-live","proposalId":"sess-1"');
  expect(JSON.stringify(liveSessionResultCard({ projectName: "bean", startedBy: "bob", outcome: "ended", resumeLiveId: "sess-1" })))
    .toContain("resume-live");
  expect(JSON.stringify(liveSessionResultCard({ projectName: "bean", startedBy: "bob", outcome: "started", resumeLiveId: "sess-1" })))
    .not.toContain("resume-live");

  const card = JSON.stringify(liveSessionProposalCard({
    proposalId: "live-1", projectName: "other", instruction: "Continue where you left off",
    projects: [{ name: "bean", path: "/p/bean" }], models: [], skills: [], cli: "codex", clis: [], agent: "codex", continues: "fix the flaky test",
  }));
  // A resume's engine is frozen: an Agent fact, no CLI picker.
  expect(card).toContain("Agent");
  expect(card).not.toContain('"id":"cli"');
  expect(card).toContain("fix the flaky test");
  expect(card).not.toContain('"id":"projectPath"');
  expect(card).not.toContain("/p/bean");
});

test("fresh live card: CLI picker defaults to the selected CLI; combined models tagged by CLI", () => {
  const card = JSON.stringify(liveSessionProposalCard({
    proposalId: "live-2", projectName: "bean", instruction: "go", projects: [{ name: "bean", path: "/p/bean" }], skills: [],
    models: [{ id: "opus", label: "opus", availableOn: ["claude"] }, { id: "gpt-5.5", label: "gpt-5.5", availableOn: ["codex"] }],
    cli: "codex", clis: ["claude", "codex"],
  }));
  expect(card).toContain('"id":"cli","label":"CLI","value":"codex"');
  expect(card).toContain("opus (claude)");
  expect(card).toContain("gpt-5.5 (codex)");
});

test("note archive cards wire archive/cancel data and a Restore carrying the note id", () => {
  const p = flatten(noteArchiveProposalCard({ proposalId: "archive-1", title: "Groceries", updated: "2026-10-01T12:00:00.000Z", snippet: "milk" }));
  expect(p).toContain("archive-note");
  expect(p).toContain("cancel-archive-note");
  expect(p).toContain("2026-10-01");
  expect(flatten(noteArchiveResultCard({ title: "Groceries", by: "mia", outcome: "archived", noteId: "n-1" }))).toContain("restore-note");
  const cancelled = noteArchiveResultCard({ title: "Groceries", by: "mia", outcome: "cancelled" }) as { actions: unknown[] };
  expect(cancelled.actions).toHaveLength(0);
});

test("routine proposal card: FactSet, warnings, toggle/save/cancel", () => {
  const card = routineProposalCard({
    proposalId: "routine-1", name: "standup", updating: false, enabled: true,
    schedule: "Weekdays at 9:00 AM (UTC)", steps: ["1. chat: post standup"], sinks: ["This chat"],
    warnings: ["restarts monthly"],
  }) as { body: { type: string; facts?: { title: string; value: string }[] }[]; actions: { title: string; data: { beanAction: string } }[] };
  const facts = card.body.find((b) => b.type === "FactSet")?.facts ?? [];
  expect(facts.map((f) => f.title)).toEqual(["When", "Steps", "Sends to"]);
  expect(flatten(card)).toContain("Heads up: restarts monthly");
  expect(card.actions.map((a) => a.data.beanAction)).toEqual(["toggle-routine", "save-routine", "cancel-routine"]);
  expect(card.actions[0]?.title).toBe("Enabled: on");
});

test("a non-owner's routine draft: Save draft + Cancel, no toggle, starts off", () => {
  const card = routineProposalCard({
    proposalId: "routine-3", name: "standup", updating: false, enabled: false,
    schedule: "Weekdays at 9:00 AM (UTC)", steps: [], sinks: ["This chat"], ownerEnables: "Scen",
  }) as { actions: { title: string; data: { beanAction: string } }[] };
  expect(card.actions.map((a) => [a.title, a.data.beanAction])).toEqual([["Save draft", "save-routine"], ["Cancel", "cancel-routine"]]);
  expect(flatten(card)).toContain("Starts off — Scen turns it on.");
});

test("invalid routine draft shows the reason and Cancel only", () => {
  const card = routineProposalCard({
    proposalId: "routine-2", name: "bad", updating: false, enabled: true,
    schedule: "", steps: [], sinks: [], problem: "command steps can't be set up from chat",
  }) as { actions: { data: { beanAction: string } }[] };
  expect(flatten(card)).toContain("Can't save: command steps");
  expect(flatten(card)).not.toContain("FactSet");
  expect(card.actions.map((a) => a.data.beanAction)).toEqual(["cancel-routine"]);
});

test("routine result card is a one-line receipt", () => {
  expect(flatten(routineResultCard({ name: "standup", by: "Scen", outcome: "saved", enabled: false }))).toContain("Routine saved (by Scen) — off");
  expect(flatten(routineResultCard({ name: "standup", by: "Scen", outcome: "failed", problem: "nope" }))).toContain("standup: nope");
});
