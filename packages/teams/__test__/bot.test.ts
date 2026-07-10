import { expect, test, vi } from "vitest";
import type { ConverseResult } from "@bean/core";
import { buildTeamsBot, type BotEffects, type TeamsBotDeps } from "../src/bot.js";
import { ConversationStore } from "../src/conversation.js";
import { ProposalStore } from "../src/proposals.js";
import { RunRegistry } from "../src/runs.js";
import type { DelegateCallbacks, DelegateRequest } from "@bean/core";

function fx(): BotEffects & { posted: string[]; cards: object[]; updates: { id: string; card: object }[] } {
  const posted: string[] = [];
  const cards: object[] = [];
  const updates: { id: string; card: object }[] = [];
  return {
    posted, cards, updates,
    reply: async (t) => { posted.push(t); },
    post: async (t) => { posted.push(t); },
    postCard: async (c) => { cards.push(c); return `act-${cards.length}`; },
    updateCard: async (id, card) => { updates.push({ id, card }); },
  };
}

function makeDeps(overrides: Partial<TeamsBotDeps> & { converseResult?: ConverseResult } = {}) {
  const delegateCalls: { req: DelegateRequest; cb: DelegateCallbacks }[] = [];
  const runs = new RunRegistry((req, cb) => {
    delegateCalls.push({ req, cb });
    return { cancel: (done?: () => void) => done?.() };
  });
  const saved: Record<string, string>[] = [];
  const result = overrides.converseResult ?? { reply: "hello there" };
  const deps: TeamsBotDeps = {
    // bot.ts calls converse() internally; we exercise it through a chat fn that
    // triggers the delegate tool path only when the test wants a proposal.
    chat: async () =>
      result.proposedDelegate
        ? { content: result.reply, toolCalls: [{ name: "propose_delegate", args: {
            project: result.proposedDelegate.projectPath,
            instruction: result.proposedDelegate.instruction,
          } }] }
        : { content: result.reply, toolCalls: [] },
    model: "m",
    loadSkills: async () => [{ name: "fix-bug", description: "d", body: "b", enabled: true }],
    loadProjects: async () => [{ name: "bean", path: "/p/bean" }],
    loadPersona: async () => ({ name: "Bean", tags: ["helpful"] }),
    loadMemories: async () => [],
    loadModelMemory: async () => ({}),
    saveModelMemory: async (m) => { saved.push(m); },
    detectClis: () => ["claude"],
    runs,
    proposals: new ProposalStore(),
    conversations: new ConversationStore(),
    ...overrides,
  };
  return { deps, delegateCalls, saved };
}

const msg = { conversationId: "c1", text: "hi bean", fromId: "u1", fromName: "alice" };

test("plain message: replies with converse text and records history", async () => {
  const { deps } = makeDeps();
  const bot = buildTeamsBot(deps);
  const effects = fx();
  await bot.onMessage(msg, effects);
  expect(effects.posted).toContain("hello there");
  expect(deps.conversations.history("c1")).toEqual([
    { role: "user", content: "hi bean" },
    { role: "assistant", content: "hello there" },
  ]);
});

test("proposedDelegate posts a proposal card", async () => {
  const { deps } = makeDeps({
    converseResult: {
      reply: "I can delegate that",
      proposedDelegate: { projectPath: "/p/bean", instruction: "fix it", composedPrompt: "fix it" },
    },
  });
  const bot = buildTeamsBot(deps);
  const effects = fx();
  await bot.onMessage(msg, effects);
  expect(effects.cards).toHaveLength(1);
  expect(JSON.stringify(effects.cards[0])).toContain("fix it");
});

async function proposeThenGetId(deps: TeamsBotDeps, effects: ReturnType<typeof fx>): Promise<string> {
  const bot = buildTeamsBot(deps);
  await bot.onMessage(msg, effects);
  const card = JSON.stringify(effects.cards[0]);
  const match = /"proposalId":"(prop-\d+)"/.exec(card);
  if (!match?.[1]) throw new Error("no proposal id in card");
  return match[1];
}

const delegateResult: ConverseResult = {
  reply: "delegating",
  proposedDelegate: { projectPath: "/p/bean", instruction: "fix it", composedPrompt: "fix it" },
};

test("confirm starts the run, updates the card, and persists model memory", async () => {
  const { deps, delegateCalls, saved } = makeDeps({ converseResult: delegateResult });
  const effects = fx();
  const id = await proposeThenGetId(deps, effects);
  const bot = buildTeamsBot(deps);
  await bot.onCardAction(
    { conversationId: "c1", fromName: "bob", value: { beanAction: "confirm", proposalId: id, cli: "claude", model: "sonnet" } },
    effects,
  );
  expect(delegateCalls).toHaveLength(1);
  expect(delegateCalls[0]?.req).toEqual({ cli: "claude", projectPath: "/p/bean", prompt: "fix it", model: "sonnet" });
  expect(effects.updates).toHaveLength(1);
  expect(JSON.stringify(effects.updates[0]?.card)).toContain("bob");
  expect(saved[0]).toMatchObject({ "teams:cli": "claude", "teams:model:claude": "sonnet" });
  // run finishes → result posted and fed into history
  delegateCalls[0]?.cb.onDone("all fixed");
  await vi.waitFor(() => expect(effects.posted).toContain("all fixed"));
  expect(deps.conversations.history("c1").at(-1)).toEqual({ role: "assistant", content: "[delegate result] all fixed" });
});

test("confirm on an expired proposal posts an expiry message", async () => {
  const { deps } = makeDeps({ converseResult: delegateResult });
  const effects = fx();
  const bot = buildTeamsBot(deps);
  await bot.onCardAction(
    { conversationId: "c1", fromName: "bob", value: { beanAction: "confirm", proposalId: "prop-999" } },
    effects,
  );
  expect(effects.posted.some((p) => p.includes("expired"))).toBe(true);
});

test("confirm while the project is busy refuses politely", async () => {
  const { deps } = makeDeps({ converseResult: delegateResult });
  const effects = fx();
  const id1 = await proposeThenGetId(deps, effects);
  const bot = buildTeamsBot(deps);
  await bot.onCardAction({ conversationId: "c1", fromName: "a", value: { beanAction: "confirm", proposalId: id1 } }, effects);
  // second proposal on the same project
  await bot.onMessage(msg, effects);
  const card2 = JSON.stringify(effects.cards[1]);
  const id2 = /"proposalId":"(prop-\d+)"/.exec(card2)?.[1] ?? "";
  await bot.onCardAction({ conversationId: "c1", fromName: "b", value: { beanAction: "confirm", proposalId: id2 } }, effects);
  expect(effects.posted.some((p) => p.includes("already going"))).toBe(true);
});

test("cancel-proposal updates the card to cancelled", async () => {
  const { deps } = makeDeps({ converseResult: delegateResult });
  const effects = fx();
  const id = await proposeThenGetId(deps, effects);
  const bot = buildTeamsBot(deps);
  await bot.onCardAction({ conversationId: "c1", fromName: "a", value: { beanAction: "cancel-proposal", proposalId: id } }, effects);
  expect(JSON.stringify(effects.updates[0]?.card)).toContain("cancelled");
});

test("proposedRun / proposedNote redirect to the desktop app", async () => {
  const { deps } = makeDeps({
    chat: async () => ({
      content: "sure",
      toolCalls: [{ name: "propose_run", args: { skill: "fix-bug", project: "/p/bean", instruction: "fix it" } }],
    }),
  });
  const bot = buildTeamsBot(deps);
  const effects = fx();
  await bot.onMessage(msg, effects);
  expect(effects.posted).toContain(
    "That needs the Bean desktop app — I can only chat and run delegate tasks from Teams.",
  );
});

test("proposedDelegate with no CLI detected posts an error and no card", async () => {
  const { deps } = makeDeps({ converseResult: delegateResult, detectClis: () => [] });
  const bot = buildTeamsBot(deps);
  const effects = fx();
  await bot.onMessage(msg, effects);
  expect(effects.cards).toHaveLength(0);
  expect(effects.posted.some((p) => p.includes("PATH"))).toBe(true);
});

test("run onError posts the failure message and updates the card", async () => {
  const { deps, delegateCalls } = makeDeps({ converseResult: delegateResult });
  const effects = fx();
  const id = await proposeThenGetId(deps, effects);
  const bot = buildTeamsBot(deps);
  await bot.onCardAction({ conversationId: "c1", fromName: "bob", value: { beanAction: "confirm", proposalId: id } }, effects);
  delegateCalls[0]?.cb.onError(new Error("boom"));
  await vi.waitFor(() => expect(effects.posted.some((p) => p.includes("Delegate run failed: boom"))).toBe(true));
  const last = effects.updates.at(-1);
  expect(JSON.stringify(last?.card)).toContain("error");
});

test("cancel-run on an idle project posts a message and does nothing else", async () => {
  const { deps } = makeDeps();
  const bot = buildTeamsBot(deps);
  const effects = fx();
  await bot.onCardAction(
    { conversationId: "c1", fromName: "a", value: { beanAction: "cancel-run", projectPath: "/p/bean" } },
    effects,
  );
  expect(effects.posted).toContain("Nothing is running in that project.");
});

test("loader throwing is caught and reported via reply", async () => {
  const { deps } = makeDeps({
    loadSkills: async () => {
      throw new Error("disk on fire");
    },
  });
  const bot = buildTeamsBot(deps);
  const effects = fx();
  await bot.onMessage(msg, effects);
  expect(effects.posted).toContain("Something went wrong: disk on fire");
});

test("'Cancel' message cancels active runs without calling converse", async () => {
  const { deps, delegateCalls } = makeDeps({ converseResult: delegateResult });
  const chatSpy = vi.fn(deps.chat);
  const deps2 = { ...deps, chat: chatSpy };
  const effects = fx();
  const id = await proposeThenGetId(deps2, effects);
  const bot = buildTeamsBot(deps2);
  await bot.onCardAction({ conversationId: "c1", fromName: "bob", value: { beanAction: "confirm", proposalId: id } }, effects);
  expect(delegateCalls).toHaveLength(1);
  chatSpy.mockClear();
  await bot.onMessage({ ...msg, text: "Cancel" }, effects);
  expect(effects.posted).toContain("Cancelled 1 run(s).");
  expect(chatSpy).not.toHaveBeenCalled();
});
