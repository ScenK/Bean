import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import type { ConverseResult } from "../src/index.js";
import { buildTeamsBot, type BotEffects, type TeamsBotDeps } from "../src/chatops/bot.js";
import { ConversationStore } from "../src/chatops/conversation.js";
import { dbFile } from "../src/config.js";
import { ProposalStore } from "../src/chatops/proposals.js";
import { NoteProposalStore } from "../src/chatops/note-proposals.js";
import { TodoProposalStore } from "../src/chatops/todo-proposals.js";
import { MemoryProposalStore } from "../src/chatops/memory-proposals.js";
import { ConsolidationProposalStore } from "../src/chatops/consolidation-proposals.js";
import { RunRegistry } from "../src/chatops/runs.js";
import type { CardBuilders } from "../src/chatops/cards-api.js";
import type { DelegateCallbacks, DelegateRequest, NoteDraft } from "../src/index.js";
import { SkillProposalStore } from "../src/chatops/skill-proposals.js";
import { LiveSessionRegistry, type LiveSessionSink } from "../src/chatops/live-sessions.js";
import { LiveSessionProposalStore } from "../src/chatops/live-session-proposals.js";
import type { LiveSessionCallbacks, LiveSessionHandle, LiveSessionRequest } from "../src/live-session.js";

const fakeCards = {
  proposalCard: (i: object) => ({ kind: "proposal", ...i }),
  runningCard: (i: object) => ({ kind: "running", ...i }),
  finishedCard: (i: object) => ({ kind: "finished", ...i }),
  noteProposalCard: (i: object) => ({ kind: "note-proposal", ...i }),
  noteResultCard: (i: object) => ({ kind: "note-result", ...i }),
  todoProposalCard: (i: object) => ({ kind: "todo-proposal", ...i }),
  todoResultCard: (i: object) => ({ kind: "todo-result", ...i }),
  memoryProposalCard: (i: object) => ({ kind: "memory-proposal", ...i }),
  memoryResultCard: (i: object) => ({ kind: "memory-result", ...i }),
  consolidationProposalCard: (i: object) => ({ kind: "consolidation-proposal", ...i }),
  consolidationResultCard: (i: object) => ({ kind: "consolidation-result", ...i }),
  skillProposalCard: (i: object) => ({ kind: "skill-proposal", ...i }),
  skillResultCard: (i: object) => ({ kind: "skill-result", ...i }),
  // Mirrors the real discord/teams builders: a "start-live"/"cancel-live" beanAction lives
  // in each card's actions, not just a flat field, so tests can assert on it the same way
  // a real Start-session button's custom_id/data would surface it.
  liveSessionProposalCard: (i: object) => ({
    kind: "live-session-proposal",
    ...i,
    actions: [
      { beanAction: "start-live", proposalId: (i as { proposalId: string }).proposalId },
      { beanAction: "cancel-live", proposalId: (i as { proposalId: string }).proposalId },
    ],
  }),
  liveSessionResultCard: (i: object) => ({ kind: "live-session-result", ...i }),
};

/** Controllable fake for LiveSessionRegistry's StartFn — stop() fires onExit synchronously
 * so registry teardown (and the has() flip to false) is observable without awaiting a tick,
 * matching the synchronous-looking flow bot.ts's onMessage capture path expects. */
function fakeLiveStartFn(): { startFn: (req: LiveSessionRequest, cbs: LiveSessionCallbacks) => LiveSessionHandle; sent: string[] } {
  const sent: string[] = [];
  const startFn = (_req: LiveSessionRequest, cbs: LiveSessionCallbacks): LiveSessionHandle => ({
    pid: 1,
    send: (t: string) => { sent.push(t); },
    stop: () => cbs.onExit(undefined),
  });
  return { startFn, sent };
}

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
  // Fresh tmp dir per makeDeps() call: reserveRun's pid-liveness check would otherwise see a
  // stale reservation from an earlier test as "still alive" (same vitest worker pid) and
  // wrongly refuse to start.
  const runsBeanDir = mkdtempSync(join(tmpdir(), "bean-bot-"));
  const runs = new RunRegistry((req, cb) => {
    delegateCalls.push({ req, cb });
    return { cancel: (done?: () => void) => done?.() };
  }, { dir: runsBeanDir, botKind: "discord" });
  const saved: Record<string, string>[] = [];
  const savedNotes: NoteDraft[] = [];
  const savedMemories: import("../src/memory/memory.js").Memory[][] = [];
  const savedSkills: { name: string; body: string }[] = [];
  const queuedTodos: { routine: string; text: string }[] = [];
  const result = overrides.converseResult ?? { reply: "hello there" };
  const deps: TeamsBotDeps = {
    // bot.ts calls converse() internally; we exercise it through a chat fn that
    // triggers the delegate tool path only when the test wants a proposal.
    chat: async () => {
      if (result.proposedSkill) {
        return { content: result.reply, toolCalls: [{ name: "propose_skill", args: {
          name: result.proposedSkill.name, body: result.proposedSkill.body,
        } }] };
      }
      return result.proposedDelegate
        ? { content: result.reply, toolCalls: [{ name: "propose_delegate", args: {
            project: result.proposedDelegate.projectPath,
            instruction: result.proposedDelegate.instruction,
          } }] }
        : { content: result.reply, toolCalls: [] };
    },
    model: "m",
    loadSkills: async () => [{ name: "fix-bug", description: "d", body: "b", enabled: true }],
    loadProjects: async () => [{ name: "bean", path: "/p/bean" }],
    loadPersona: async () => ({ name: "Bean", tags: ["helpful"] }),
    loadMemories: async () => [],
    loadModelMemory: async () => ({}),
    saveModelMemory: async (m) => { saved.push(m); },
    detectClis: () => ["claude"],
    cliModels: [
      { provider: "claude", models: ["sonnet", "opus", "haiku"] },
      { provider: "opencode", models: ["github-copilot/gpt-5.5"] },
    ],
    runs,
    proposals: new ProposalStore(),
    noteProposals: new NoteProposalStore(),
    saveNote: async (draft) => { savedNotes.push(draft); return "our-chat"; },
    searchNotes: async () => [],
    todoProposals: new TodoProposalStore(),
    queueTodo: async (routine, text) => { queuedTodos.push({ routine, text }); },
    listTodoRoutines: async () => [],
    memoryProposals: new MemoryProposalStore(),
    appendMemories: async (additions) => { savedMemories.push(additions); },
    saveMemories: async (mems) => { savedMemories.push(mems); },
    consolidationProposals: new ConsolidationProposalStore(),
    conversations: new ConversationStore(dbFile(runsBeanDir)),
    cards: fakeCards as CardBuilders,
    skillProposals: new SkillProposalStore(),
    saveSkill: async (name, body) => { savedSkills.push({ name, body }); },
    systemControlsEnabled: () => false,
    liveSessions: new LiveSessionRegistry(fakeLiveStartFn().startFn as never, { dir: runsBeanDir }),
    liveSessionProposals: new LiveSessionProposalStore(),
    liveSessionsEnabled: () => false,
    ...overrides,
  };
  return { deps, delegateCalls, saved, savedNotes, savedMemories, savedSkills, queuedTodos };
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

test("fetchRecent messages are injected after stored history and persisted into it", async () => {
  const seen: { role: string; content: string }[][] = [];
  const { deps } = makeDeps({
    chat: async ({ messages }) => {
      seen.push(messages.map((m) => ({ role: m.role, content: String(m.content) })));
      return { content: "summary", toolCalls: [] };
    },
  });
  deps.conversations.append("c1", { role: "user", content: "earlier question" });
  deps.conversations.append("c1", { role: "assistant", content: "earlier answer" });
  const bot = buildTeamsBot(deps);
  const effects = { ...fx(), fetchRecent: async () => [{ fromName: "alice", text: "ship it", at: Date.now() }] };
  await bot.onMessage(msg, effects);
  const contents = seen[0]!.map((m) => m.content);
  const blockIdx = contents.findIndex((c) => c.includes("not addressed to you"));
  // system, earlier question, earlier answer, ambient block, latest message —
  // the ambient messages are newer than stored history, so the block comes after it.
  expect(blockIdx).toBe(3);
  expect(seen[0]![blockIdx]!.role).toBe("user");
  expect(contents[blockIdx]).toContain("alice: ship it");
  // the block Bean acted on is persisted so follow-up mentions stay coherent
  const history = deps.conversations.history("c1").map((t) => t.content);
  expect(history.findIndex((c) => c.includes("alice: ship it"))).toBe(2);
  // block sits right before the mention that triggered it, then Bean's reply
  expect(history.at(-2)).toBe("hi bean");
});

test("a second mention does not re-inject ambient messages already seen", async () => {
  const sinceSeen: number[] = [];
  const ambientAt = Date.now() - 60_000;
  const { deps } = makeDeps();
  const effects = {
    ...fx(),
    fetchRecent: async (sinceMs: number) => {
      sinceSeen.push(sinceMs);
      return [{ fromName: "alice", text: "ship it", at: ambientAt }].filter((m) => m.at >= sinceMs);
    },
  };
  const bot = buildTeamsBot(deps);
  await bot.onMessage(msg, effects);
  await bot.onMessage(msg, effects);
  expect(sinceSeen[1]).toBeGreaterThan(ambientAt);
  const blocks = deps.conversations.history("c1").filter((t) => t.content.includes("alice: ship it"));
  expect(blocks).toHaveLength(1);
});

// The cutoff must live in the db, not in buildTeamsBot's memory: Discord's fetchRecent
// re-reads live channel history, so a bot restart would otherwise re-inject (and re-persist)
// ambient chatter that is already in the conversation.
test("a restarted bot does not re-inject ambient chatter already persisted to the db", async () => {
  const ambientAt = Date.now() - 60_000;
  const { deps } = makeDeps();
  const fetchRecent = async (sinceMs: number) =>
    [{ fromName: "alice", text: "ship it", at: ambientAt }].filter((m) => m.at >= sinceMs);
  await buildTeamsBot(deps).onMessage(msg, { ...fx(), fetchRecent });
  // fresh bot instance, same deps/db — simulates a bot process restart
  await buildTeamsBot(deps).onMessage(msg, { ...fx(), fetchRecent });
  const blocks = deps.conversations.history("c1").filter((t) => t.content.includes("alice: ship it"));
  expect(blocks).toHaveLength(1);
});

test("'/new' clears the conversation history without calling converse", async () => {
  const { deps } = makeDeps();
  const chatSpy = vi.fn(deps.chat);
  const bot = buildTeamsBot({ ...deps, chat: chatSpy });
  const effects = fx();
  await bot.onMessage(msg, effects);
  expect(deps.conversations.history("c1")).not.toEqual([]);
  chatSpy.mockClear();
  await bot.onMessage({ ...msg, text: "/new" }, effects);
  expect(deps.conversations.history("c1")).toEqual([]);
  expect(chatSpy).not.toHaveBeenCalled();
  expect(effects.posted.some((p) => p.toLowerCase().includes("fresh"))).toBe(true);
});

test("after '/new', ambient messages from before the reset are not re-injected", async () => {
  const seen: string[][] = [];
  const { deps } = makeDeps({
    chat: async ({ messages }) => {
      seen.push(messages.map((m) => String(m.content)));
      return { content: "ok", toolCalls: [] };
    },
  });
  const staleAt = Date.now() - 1000; // recent enough for the 15-min window
  const effects = {
    ...fx(),
    fetchRecent: async (sinceMs: number) =>
      [{ fromName: "alice", text: "old chatter", at: staleAt }].filter((m) => m.at >= sinceMs),
  };
  const bot = buildTeamsBot(deps);
  await bot.onMessage({ ...msg, text: "/new" }, effects);
  await bot.onMessage(msg, effects);
  expect(seen[0]!.some((c) => c.includes("old chatter"))).toBe(false);
});


test("empty or absent fetchRecent injects nothing", async () => {
  const seen: string[][] = [];
  const { deps } = makeDeps({
    chat: async ({ messages }) => {
      seen.push(messages.map((m) => String(m.content)));
      return { content: "ok", toolCalls: [] };
    },
  });
  const bot = buildTeamsBot(deps);
  await bot.onMessage(msg, { ...fx(), fetchRecent: async () => [] });
  await bot.onMessage(msg, fx());
  for (const messages of seen) {
    expect(messages.some((c) => c.includes("not addressed to you"))).toBe(false);
  }
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

test("unrecognized beanAction with a valid proposalId does not consume the proposal", async () => {
  const { deps, delegateCalls } = makeDeps({ converseResult: delegateResult });
  const effects = fx();
  const id = await proposeThenGetId(deps, effects);
  const bot = buildTeamsBot(deps);
  await bot.onCardAction(
    { conversationId: "c1", fromName: "bob", value: { beanAction: "some-unknown-action", proposalId: id } },
    effects,
  );
  expect(delegateCalls).toHaveLength(0);
  await bot.onCardAction(
    { conversationId: "c1", fromName: "bob", value: { beanAction: "confirm", proposalId: id } },
    effects,
  );
  expect(effects.posted.some((p) => p.includes("expired"))).toBe(false);
  expect(delegateCalls).toHaveLength(1);
});

test("terminal-target skills never get propose_run offered from chatops — only propose_delegate", async () => {
  let captured: string[] = [];
  const { deps } = makeDeps({
    chat: async ({ tools }) => {
      captured = tools.map((t) => t.name);
      return { content: "hi", toolCalls: [] };
    },
  });
  await buildTeamsBot(deps).onMessage({ ...msg, text: "run fix-bug on bean" }, fx());
  expect(captured).not.toContain("propose_run");
  expect(captured).toContain("propose_delegate");
});

test("chat-target propose_run runs on Bean's own model and replies in the same chat", async () => {
  let calls = 0;
  let secondUserContent = "";
  const { deps } = makeDeps({
    loadSkills: async () => [{ name: "summarize", description: "d", body: "SUM BODY", target: "chat", enabled: true }],
    chat: async ({ messages }) => {
      calls++;
      if (calls === 1) {
        return { content: "sure", toolCalls: [{ name: "propose_run", args: { skill: "summarize", instruction: "summarize the thread" } }] };
      }
      secondUserContent = messages[messages.length - 1]!.content;
      return { content: "Here's the summary.", toolCalls: [] };
    },
  });
  const effects = fx();
  await buildTeamsBot(deps).onMessage(msg, effects);
  expect(effects.posted).toContain("Here's the summary.");
  expect(secondUserContent).toContain("SUM BODY");
  expect(effects.posted.some((t) => t.includes("Bean desktop app"))).toBe(false);
  expect(effects.cards).toHaveLength(0);
});

// Second hop goes pure tool-use with no text (nested proposals are one-hop-ignored):
// the user must still get a message, never silence.
test("chat-target run whose second hop returns no text posts a fallback, not silence", async () => {
  let calls = 0;
  const { deps } = makeDeps({
    loadSkills: async () => [{ name: "summarize", description: "d", body: "SUM BODY", target: "chat", enabled: true }],
    chat: async () => {
      calls++;
      if (calls === 1) {
        return { content: "", toolCalls: [{ name: "propose_run", args: { skill: "summarize", instruction: "summarize" } }] };
      }
      return { content: "", toolCalls: [{ name: "propose_note", args: { title: "t", body: "b" } }] };
    },
  });
  const effects = fx();
  await buildTeamsBot(deps).onMessage(msg, effects);
  expect(effects.posted).toHaveLength(1);
  expect(effects.posted[0]).toContain("summarize skill didn't produce a reply");
  expect(effects.cards).toHaveLength(0);
});

// A stray propose_run for a terminal-target skill is dropped by converse()'s validation
// (it checks against the chat-target subset in chatops), so the reply lands but nothing
// runs and nothing redirects — no dead-end message, no card.
test("a stray terminal-skill propose_run from chatops is dropped, keeping the reply", async () => {
  const { deps } = makeDeps({
    chat: async () => ({
      content: "sure",
      toolCalls: [{ name: "propose_run", args: { skill: "fix-bug", project: "/p/bean", instruction: "fix it" } }],
    }),
  });
  const bot = buildTeamsBot(deps);
  const effects = fx();
  await bot.onMessage(msg, effects);
  expect(effects.posted).toEqual(["sure"]);
  expect(effects.cards).toHaveLength(0);
});

// propose_note fires when the model calls the tool with a title + body.
const noteChat: TeamsBotDeps["chat"] = async () => ({
  content: "Want me to save that?",
  toolCalls: [{ name: "propose_note", args: { title: "Our chat", body: "## Summary\n\nwe talked" } }],
});

async function proposeNoteThenId(deps: TeamsBotDeps, effects: ReturnType<typeof fx>): Promise<string> {
  const bot = buildTeamsBot(deps);
  await bot.onMessage(msg, effects);
  const card = JSON.stringify(effects.cards[0]);
  const match = /"proposalId":"(note-\d+)"/.exec(card);
  if (!match?.[1]) throw new Error("no note proposal id in card");
  return match[1];
}

test("proposedNote posts a confirm-first note card instead of redirecting", async () => {
  const { deps } = makeDeps({ chat: noteChat });
  const effects = fx();
  await buildTeamsBot(deps).onMessage(msg, effects);
  expect(effects.posted.some((t) => t.includes("Bean desktop app"))).toBe(false);
  expect(effects.cards).toHaveLength(1);
  const s = JSON.stringify(effects.cards[0]);
  expect(s).toContain("note-proposal");
  expect(s).toContain("Our chat");
});

test("save-note saves the draft, updates the card, and confirms", async () => {
  const { deps, savedNotes } = makeDeps({ chat: noteChat });
  const effects = fx();
  const id = await proposeNoteThenId(deps, effects);
  const bot = buildTeamsBot(deps);
  await bot.onCardAction(
    { conversationId: "c1", fromName: "bob", value: { beanAction: "save-note", proposalId: id } },
    effects,
  );
  expect(savedNotes).toHaveLength(1);
  expect(savedNotes[0]).toMatchObject({ title: "Our chat", source: "chat" });
  expect(JSON.stringify(effects.updates.at(-1)?.card)).toContain("saved");
  expect(effects.posted.some((p) => p.includes('Saved note "Our chat"'))).toBe(true);
});

test("cancel-note updates the card to cancelled without saving", async () => {
  const { deps, savedNotes } = makeDeps({ chat: noteChat });
  const effects = fx();
  const id = await proposeNoteThenId(deps, effects);
  const bot = buildTeamsBot(deps);
  await bot.onCardAction(
    { conversationId: "c1", fromName: "bob", value: { beanAction: "cancel-note", proposalId: id } },
    effects,
  );
  expect(savedNotes).toHaveLength(0);
  expect(JSON.stringify(effects.updates.at(-1)?.card)).toContain("cancelled");
});

test("save-note on an expired draft posts a message and saves nothing", async () => {
  const { deps, savedNotes } = makeDeps({ chat: noteChat });
  const effects = fx();
  const bot = buildTeamsBot(deps);
  await bot.onCardAction(
    { conversationId: "c1", fromName: "bob", value: { beanAction: "save-note", proposalId: "note-999" } },
    effects,
  );
  expect(savedNotes).toHaveLength(0);
  expect(effects.posted.some((p) => p.includes("expired"))).toBe(true);
});

// propose_todo fires when the model calls the tool with a routine + text; requires
// deps.listTodoRoutines to include that routine name for converse() to accept it.
const todoChat: TeamsBotDeps["chat"] = async () => ({
  content: "",
  toolCalls: [{ name: "propose_todo", args: { routine: "nightly", text: "fix it" } }],
});

async function proposeTodoThenId(deps: TeamsBotDeps, effects: ReturnType<typeof fx>): Promise<string> {
  const bot = buildTeamsBot(deps);
  await bot.onMessage(msg, effects);
  const card = JSON.stringify(effects.cards[0]);
  const match = /"proposalId":"(todo-\d+)"/.exec(card);
  if (!match?.[1]) throw new Error("no todo proposal id in card");
  return match[1];
}

test("posts a todo proposal card when converse proposes a todo", async () => {
  const { deps } = makeDeps({ chat: todoChat, listTodoRoutines: async () => ["nightly"] });
  const effects = fx();
  await buildTeamsBot(deps).onMessage(msg, effects);
  expect(effects.cards).toHaveLength(1);
  const s = JSON.stringify(effects.cards[0]);
  expect(s).toContain("todo-proposal");
  expect(s).toContain("nightly");
  expect(s).toContain("fix it");
});

test("queue-todo card action queues via deps.queueTodo; cancel-todo does not", async () => {
  const { deps, queuedTodos } = makeDeps({ chat: todoChat, listTodoRoutines: async () => ["nightly"] });
  const effects = fx();
  const id = await proposeTodoThenId(deps, effects);
  const bot = buildTeamsBot(deps);
  await bot.onCardAction(
    { conversationId: "c1", fromName: "bob", value: { beanAction: "queue-todo", proposalId: id } },
    effects,
  );
  expect(queuedTodos).toEqual([{ routine: "nightly", text: "fix it" }]);
  expect(JSON.stringify(effects.updates.at(-1)?.card)).toContain("todo-result");

  const { deps: deps2, queuedTodos: queuedTodos2 } = makeDeps({ chat: todoChat, listTodoRoutines: async () => ["nightly"] });
  const effects2 = fx();
  const id2 = await proposeTodoThenId(deps2, effects2);
  const bot2 = buildTeamsBot(deps2);
  await bot2.onCardAction(
    { conversationId: "c1", fromName: "bob", value: { beanAction: "cancel-todo", proposalId: id2 } },
    effects2,
  );
  expect(queuedTodos2).toHaveLength(0);
  expect(JSON.stringify(effects2.updates.at(-1)?.card)).toContain("cancelled");
});


function rememberDeps() {
  let call = 0;
  const chat: TeamsBotDeps["chat"] = async () => {
    call++;
    if (call === 1) return { content: "Which should I keep?", toolCalls: [{ name: "propose_remember", args: {} }] };
    return {
      content: "",
      toolCalls: [
        { name: "remember", args: { text: "prefers tabs" } },
        { name: "remember", args: { text: "uses vitest", projectPath: "/p/bean" } },
      ],
    };
  };
  return makeDeps({ chat });
}

async function proposeMemoryThenId(deps: TeamsBotDeps, effects: ReturnType<typeof fx>): Promise<string> {
  await buildTeamsBot(deps).onMessage(msg, effects);
  const card = JSON.stringify(effects.cards[0]);
  const match = /"proposalId":"(mem-\d+)"/.exec(card);
  if (!match?.[1]) throw new Error("no memory proposal id in card");
  return match[1];
}

test("proposedRemember runs extraction and posts a selectable memory card", async () => {
  const { deps } = rememberDeps();
  const effects = fx();
  await buildTeamsBot(deps).onMessage(msg, effects);
  expect(effects.cards).toHaveLength(1);
  const s = JSON.stringify(effects.cards[0]);
  expect(s).toContain("memory-proposal");
  expect(s).toContain("prefers tabs");
  expect(s).toContain("uses vitest");
});

test("save-memories with undefined memoryPicks saves every candidate", async () => {
  const { deps, savedMemories } = rememberDeps();
  const effects = fx();
  const id = await proposeMemoryThenId(deps, effects);
  await buildTeamsBot(deps).onCardAction(
    { conversationId: "c1", fromName: "bob", value: { beanAction: "save-memories", proposalId: id } },
    effects,
  );
  expect(savedMemories).toHaveLength(1);
  expect(savedMemories[0]).toHaveLength(2);
  expect(savedMemories[0]!.map((m) => m.text)).toEqual(["prefers tabs", "uses vitest"]);
  expect(savedMemories[0]![1]!.projectPath).toBe("/p/bean");
  expect(effects.posted.some((p) => p.includes("Remembered 2"))).toBe(true);
});

test("save-memories honors memoryPicks and saves only the selected subset", async () => {
  const { deps, savedMemories } = rememberDeps();
  const effects = fx();
  const id = await proposeMemoryThenId(deps, effects);
  await buildTeamsBot(deps).onCardAction(
    { conversationId: "c1", fromName: "bob", value: { beanAction: "save-memories", proposalId: id, memoryPicks: ["1"] } },
    effects,
  );
  expect(savedMemories[0]).toHaveLength(1);
  expect(savedMemories[0]![0]!.text).toBe("uses vitest");
});

test("save-memories with an empty pick set saves nothing", async () => {
  const { deps, savedMemories } = rememberDeps();
  const effects = fx();
  const id = await proposeMemoryThenId(deps, effects);
  await buildTeamsBot(deps).onCardAction(
    { conversationId: "c1", fromName: "bob", value: { beanAction: "save-memories", proposalId: id, memoryPicks: [] } },
    effects,
  );
  expect(savedMemories).toHaveLength(0);
});

test("cancel-memories updates the card and saves nothing", async () => {
  const { deps, savedMemories } = rememberDeps();
  const effects = fx();
  const id = await proposeMemoryThenId(deps, effects);
  await buildTeamsBot(deps).onCardAction(
    { conversationId: "c1", fromName: "bob", value: { beanAction: "cancel-memories", proposalId: id } },
    effects,
  );
  expect(savedMemories).toHaveLength(0);
  expect(JSON.stringify(effects.updates.at(-1)?.card)).toContain("cancelled");
});

test("save-memories on an expired proposal posts a message and saves nothing", async () => {
  const { deps, savedMemories } = rememberDeps();
  const effects = fx();
  await buildTeamsBot(deps).onCardAction(
    { conversationId: "c1", fromName: "bob", value: { beanAction: "save-memories", proposalId: "mem-999" } },
    effects,
  );
  expect(savedMemories).toHaveLength(0);
  expect(effects.posted.some((p) => p.includes("expired"))).toBe(true);
});

// A stateful fake store (not the plain array makeDeps() defaults to): appendMemories/saveMemories
// mutate the same underlying list that loadMemories reads back, so maybeProposeConsolidation's
// post-append threshold check sees the real accumulated count — a static array would never
// cross the threshold no matter how many facts get "added".
function rememberDepsOverThreshold(consolidateToolCalls: { name: string; args: object }[]) {
  let current = Array.from({ length: 30 }, (_, i) => ({
    id: `e${i}`, text: `fact ${i}`, createdAt: "2026-01-01T00:00:00.000Z",
  }));
  let call = 0;
  const chat: TeamsBotDeps["chat"] = async () => {
    call++;
    if (call === 1) return { content: "ok", toolCalls: [{ name: "propose_remember", args: {} }] };
    if (call === 2) return { content: "", toolCalls: [{ name: "remember", args: { text: "new fact" } }] };
    return { content: "", toolCalls: consolidateToolCalls };
  };
  const { deps } = makeDeps({
    chat,
    loadMemories: async () => current,
    appendMemories: async (additions) => { current = [...current, ...additions]; },
    saveMemories: async (mems) => { current = mems; },
  });
  return { deps, getCurrent: () => current };
}

test("save-memories past the consolidation threshold posts a follow-up tidy-up card", async () => {
  const { deps } = rememberDepsOverThreshold([{ name: "drop_memory", args: { id: "e0" } }]);
  const effects = fx();
  const id = await proposeMemoryThenId(deps, effects);
  await buildTeamsBot(deps).onCardAction(
    { conversationId: "c1", fromName: "bob", value: { beanAction: "save-memories", proposalId: id } },
    effects,
  );
  expect(effects.cards).toHaveLength(2);
  expect(JSON.stringify(effects.cards[1])).toContain("consolidation-proposal");
});

test("save-memories under the threshold or with an empty consolidation result posts no follow-up card", async () => {
  const { deps } = rememberDepsOverThreshold([]); // model finds nothing to tidy
  const effects = fx();
  const id = await proposeMemoryThenId(deps, effects);
  await buildTeamsBot(deps).onCardAction(
    { conversationId: "c1", fromName: "bob", value: { beanAction: "save-memories", proposalId: id } },
    effects,
  );
  expect(effects.cards).toHaveLength(1);
});

test("confirm-consolidation applies drops and merges, then saves the reduced list", async () => {
  const { deps, getCurrent } = rememberDepsOverThreshold([
    { name: "merge_memories", args: { ids: ["e1", "e2"], mergedText: "facts 1 and 2 combined" } },
    { name: "drop_memory", args: { id: "e3" } },
  ]);
  const effects = fx();
  const memId = await proposeMemoryThenId(deps, effects);
  await buildTeamsBot(deps).onCardAction(
    { conversationId: "c1", fromName: "bob", value: { beanAction: "save-memories", proposalId: memId } },
    effects,
  );
  const card = JSON.stringify(effects.cards[1]);
  const consId = /"proposalId":"(cons-\d+)"/.exec(card)?.[1];
  expect(consId).toBeDefined();
  await buildTeamsBot(deps).onCardAction(
    { conversationId: "c1", fromName: "bob", value: { beanAction: "confirm-consolidation", proposalId: consId } },
    effects,
  );
  const finalSave = getCurrent();
  expect(finalSave.some((m) => m.text === "facts 1 and 2 combined")).toBe(true);
  expect(finalSave.some((m) => m.id === "e1" || m.id === "e2")).toBe(false);
  expect(finalSave.some((m) => m.id === "e3")).toBe(false);
  expect(effects.posted.some((p) => p.includes("tidied up"))).toBe(true);
});

test("cancel-consolidation updates the card and saves nothing further", async () => {
  const { deps, getCurrent } = rememberDepsOverThreshold([{ name: "drop_memory", args: { id: "e0" } }]);
  const effects = fx();
  const memId = await proposeMemoryThenId(deps, effects);
  await buildTeamsBot(deps).onCardAction(
    { conversationId: "c1", fromName: "bob", value: { beanAction: "save-memories", proposalId: memId } },
    effects,
  );
  const countBefore = getCurrent().length;
  const card = JSON.stringify(effects.cards[1]);
  const consId = /"proposalId":"(cons-\d+)"/.exec(card)?.[1];
  await buildTeamsBot(deps).onCardAction(
    { conversationId: "c1", fromName: "bob", value: { beanAction: "cancel-consolidation", proposalId: consId } },
    effects,
  );
  expect(getCurrent()).toHaveLength(countBefore);
  expect(JSON.stringify(effects.updates.at(-1)?.card)).toContain("cancelled");
});

test("proposedRemember with no extracted facts posts a message and no card", async () => {
  let call = 0;
  const chat: TeamsBotDeps["chat"] = async () => {
    call++;
    if (call === 1) return { content: "ok", toolCalls: [{ name: "propose_remember", args: {} }] };
    return { content: "", toolCalls: [] };
  };
  const { deps } = makeDeps({ chat });
  const effects = fx();
  await buildTeamsBot(deps).onMessage(msg, effects);
  expect(effects.cards).toHaveLength(0);
  expect(effects.posted.some((p) => p.toLowerCase().includes("nothing"))).toBe(true);
});

test("proposedDelegate with no CLI detected posts an error and no card", async () => {
  const { deps } = makeDeps({ converseResult: delegateResult, detectClis: () => [] });
  const bot = buildTeamsBot(deps);
  const effects = fx();
  await bot.onMessage(msg, effects);
  expect(effects.cards).toHaveLength(0);
  expect(effects.posted.some((p) => p.includes("`claude`, `opencode`, or `codex`"))).toBe(true);
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

test("'/cancel' works too — Teams has no slash-command infra, so the slash arrives as plain text", async () => {
  const { deps, delegateCalls } = makeDeps({ converseResult: delegateResult });
  const chatSpy = vi.fn(deps.chat);
  const deps2 = { ...deps, chat: chatSpy };
  const effects = fx();
  const id = await proposeThenGetId(deps2, effects);
  const bot = buildTeamsBot(deps2);
  await bot.onCardAction({ conversationId: "c1", fromName: "bob", value: { beanAction: "confirm", proposalId: id } }, effects);
  expect(delegateCalls).toHaveLength(1);
  chatSpy.mockClear();
  await bot.onMessage({ ...msg, text: "/cancel" }, effects);
  expect(effects.posted).toContain("Cancelled 1 run(s).");
  expect(chatSpy).not.toHaveBeenCalled();
});

test("proposedSkill posts a skill proposal card and stores the pending draft", async () => {
  const { deps } = makeDeps({
    converseResult: { reply: "Drafted.", proposedSkill: { name: "changelog", body: "# C", updating: false } },
  });
  const bot = buildTeamsBot(deps);
  const effects = fx();
  await bot.onMessage(msg, effects);
  const card = effects.cards[0] as { kind: string; name: string; updating: boolean; proposalId: string };
  expect(card.kind).toBe("skill-proposal");
  expect(card.name).toBe("changelog");
  expect(card.updating).toBe(false);
  expect(card.proposalId).toBeTruthy();
});

test("save-skill action persists the skill and updates the card to saved", async () => {
  const { deps, savedSkills } = makeDeps();
  const bot = buildTeamsBot(deps);
  const pending = deps.skillProposals.add({
    skill: { name: "changelog", body: "# C", updating: false }, conversationId: "c1", proposedBy: "alice",
  });
  deps.skillProposals.setCardActivityId(pending.id, "act-1");
  const effects = fx();
  await bot.onCardAction({ conversationId: "c1", fromName: "bob", value: { beanAction: "save-skill", proposalId: pending.id } }, effects);
  expect(savedSkills).toEqual([{ name: "changelog", body: "# C" }]);
  expect(effects.updates[0]?.card).toMatchObject({ kind: "skill-result", outcome: "saved", savedBy: "bob" });
  expect(effects.posted[0]).toContain("changelog");
});

test("cancel-skill action updates the card to cancelled without saving", async () => {
  const { deps, savedSkills } = makeDeps();
  const bot = buildTeamsBot(deps);
  const pending = deps.skillProposals.add({
    skill: { name: "changelog", body: "# C", updating: false }, conversationId: "c1", proposedBy: "alice",
  });
  deps.skillProposals.setCardActivityId(pending.id, "act-1");
  const effects = fx();
  await bot.onCardAction({ conversationId: "c1", fromName: "bob", value: { beanAction: "cancel-skill", proposalId: pending.id } }, effects);
  expect(savedSkills).toEqual([]);
  expect(effects.updates[0]?.card).toMatchObject({ kind: "skill-result", outcome: "cancelled" });
});

test("save-skill on an expired/unknown proposal posts an expiry message", async () => {
  const { deps, savedSkills } = makeDeps();
  const bot = buildTeamsBot(deps);
  const effects = fx();
  await bot.onCardAction({ conversationId: "c1", fromName: "bob", value: { beanAction: "save-skill", proposalId: "nope" } }, effects);
  expect(savedSkills).toEqual([]);
  expect(effects.posted[0]).toContain("expired");
});

// propose_live_session fires when the model calls the tool with a project + instruction;
// converse() validates project against the enum and returns proposedLiveSession regardless
// of whether the tool was actually offered (same as the other propose_* fakes above), so the
// fake chat fn can return the toolCall unconditionally.
function makeBotWithLiveSessionProposal() {
  const { deps } = makeDeps({
    liveSessionsEnabled: () => true,
    chat: async () => ({
      content: "Let's start a live session.",
      toolCalls: [{ name: "propose_live_session", args: { project: "/p/bean", instruction: "look at the auth module" } }],
    }),
  });
  const bot = buildTeamsBot(deps);
  const effects = fx();
  return { bot, fx: effects, deps };
}

function latestLiveProposalId(cards: object[]): string {
  const card = JSON.stringify(cards.at(-1));
  const match = /"proposalId":"(live-\d+)"/.exec(card);
  if (!match?.[1]) throw new Error("no live-session proposal id in card");
  return match[1];
}

test("posts a live-session proposal card when converse proposes one", async () => {
  const { bot, fx: effects } = makeBotWithLiveSessionProposal();
  await bot.onMessage({ conversationId: "c1", text: "start live session", fromId: "u", fromName: "sam" }, effects);
  expect(effects.cards.some((c) => JSON.stringify(c).includes("start-live"))).toBe(true);
});

test("start-live card action starts the session and binds the channel", async () => {
  const { bot, fx: effects, deps } = makeBotWithLiveSessionProposal();
  await bot.onMessage({ conversationId: "c1", text: "start live session", fromId: "u", fromName: "sam" }, effects);
  const proposalId = latestLiveProposalId(effects.cards);
  await bot.onCardAction({ conversationId: "c1", fromName: "sam", value: { beanAction: "start-live", proposalId } }, effects);
  expect(deps.liveSessions.has("c1")).toBe(true);
});

test("cancel-live card action updates the card to cancelled without starting a session", async () => {
  const { bot, fx: effects, deps } = makeBotWithLiveSessionProposal();
  await bot.onMessage({ conversationId: "c1", text: "start live session", fromId: "u", fromName: "sam" }, effects);
  const proposalId = latestLiveProposalId(effects.cards);
  await bot.onCardAction({ conversationId: "c1", fromName: "sam", value: { beanAction: "cancel-live", proposalId } }, effects);
  expect(deps.liveSessions.has("c1")).toBe(false);
  expect(JSON.stringify(effects.updates.at(-1)?.card)).toContain("cancelled");
});

test("proposeLiveSession posts the confirm card, defaulting to the first project", async () => {
  const { deps } = makeDeps({ liveSessionsEnabled: () => true });
  const bot = buildTeamsBot(deps);
  const effects = fx();
  const reply = await bot.proposeLiveSession(
    { conversationId: "c1", instruction: "look at auth", proposedBy: "sam" }, effects,
  );
  expect(reply).toContain("Start");
  const card = JSON.stringify(effects.cards.at(-1));
  expect(card).toContain("start-live");
  expect(card).toContain("look at auth");
});

test("proposeLiveSession refuses when disabled, with no card", async () => {
  const off = makeDeps({ liveSessionsEnabled: () => false });
  const botOff = buildTeamsBot(off.deps);
  const fxOff = fx();
  expect(await botOff.proposeLiveSession({ conversationId: "c1", instruction: "x", proposedBy: "s" }, fxOff))
    .toContain("disabled");
  expect(fxOff.cards).toHaveLength(0);
});

test("a disabled Claude CLI keeps the Claude-only live-session tool unavailable", async () => {
  let toolNames: string[] = [];
  const { deps } = makeDeps({
    detectClis: () => ["codex"],
    liveSessionsEnabled: () => true,
    chat: async ({ tools }) => {
      toolNames = tools.map((tool) => tool.name);
      return { content: "no live session", toolCalls: [] };
    },
  });

  await buildTeamsBot(deps).onMessage(msg, fx());

  expect(toolNames).not.toContain("propose_live_session");
});

test("start-live composes the picked skill's body into the opening prompt", async () => {
  const prompts: string[] = [];
  const startFn = (req: LiveSessionRequest, cbs: LiveSessionCallbacks): LiveSessionHandle => {
    prompts.push(req.prompt);
    return { pid: 1, send: () => {}, stop: () => cbs.onExit(undefined) };
  };
  const { deps } = makeDeps({
    liveSessionsEnabled: () => true,
    loadSkills: async () => [{ name: "review", description: "d", body: "REVIEW SKILL BODY", enabled: true }],
    liveSessions: new LiveSessionRegistry(startFn as never, { dir: mkdtempSync(join(tmpdir(), "bean-bot-")) }),
  });
  const bot = buildTeamsBot(deps);
  const effects = fx();
  await bot.proposeLiveSession({ conversationId: "c1", instruction: "check the login flow", proposedBy: "sam" }, effects);
  const proposalId = latestLiveProposalId(effects.cards);
  deps.liveSessionProposals.update(proposalId, { skillName: "review" }); // simulates the skill dropdown pick
  await bot.onCardAction({ conversationId: "c1", fromName: "sam", value: { beanAction: "start-live", proposalId } }, effects);
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain("REVIEW SKILL BODY");
  expect(prompts[0]).toContain("check the login flow");
});

test("start-live applies on-card selections carried in the submit value (Teams path)", async () => {
  const reqs: LiveSessionRequest[] = [];
  const startFn = (req: LiveSessionRequest, cbs: LiveSessionCallbacks): LiveSessionHandle => {
    reqs.push(req);
    return { pid: 1, send: () => {}, stop: () => cbs.onExit(undefined) };
  };
  const { deps } = makeDeps({
    liveSessionsEnabled: () => true,
    loadSkills: async () => [{ name: "review", description: "d", body: "REVIEW SKILL BODY", enabled: true }],
    liveSessions: new LiveSessionRegistry(startFn as never, { dir: mkdtempSync(join(tmpdir(), "bean-bot-")) }),
  });
  const bot = buildTeamsBot(deps);
  const effects = fx();
  await bot.proposeLiveSession({ conversationId: "c1", instruction: "original", proposedBy: "sam" }, effects);
  const proposalId = latestLiveProposalId(effects.cards);
  await bot.onCardAction({
    conversationId: "c1", fromName: "sam",
    value: { beanAction: "start-live", proposalId, instruction: "edited prompt", model: "opus", skillName: "review", steering: "open" },
  }, effects);
  expect(reqs).toHaveLength(1);
  expect(reqs[0]?.model).toBe("opus");
  expect(reqs[0]?.prompt).toContain("REVIEW SKILL BODY");
  expect(reqs[0]?.prompt).toContain("edited prompt");
});

test("literal /live-session message routes verbatim, never touching converse", async () => {
  const chatSpy = vi.fn(async () => ({ content: "SHOULD NOT BE CALLED", toolCalls: [] }));
  const { deps } = makeDeps({ chat: chatSpy, liveSessionsEnabled: () => true });
  const bot = buildTeamsBot(deps);
  const effects = fx();
  await bot.onMessage(
    { conversationId: "c1", text: "/live-session for bean project, do we have codex support?", fromId: "u", fromName: "sam" },
    effects,
  );
  expect(chatSpy).not.toHaveBeenCalled();
  const card = JSON.stringify(effects.cards.at(-1));
  expect(card).toContain("start-live");
  expect(card).toContain("for bean project, do we have codex support?"); // verbatim, not an LLM rewrite
});

test("start-live on an expired/unknown proposal posts an expiry message", async () => {
  const { deps } = makeDeps({ liveSessionsEnabled: () => true });
  const bot = buildTeamsBot(deps);
  const effects = fx();
  await bot.onCardAction({ conversationId: "c1", fromName: "sam", value: { beanAction: "start-live", proposalId: "live-999" } }, effects);
  expect(deps.liveSessions.has("c1")).toBe(false);
  expect(effects.posted.some((p) => p.includes("expired"))).toBe(true);
});

// The registry is pre-bound to the channel directly (bypassing the propose/start card flow) —
// this test is only about the capture contract in onMessage, not about how a session starts.
function makeBotWithActiveLiveSession(channelId: string) {
  const chatSpy = vi.fn(async () => ({ content: "should not be called", toolCalls: [] }));
  const { startFn } = fakeLiveStartFn();
  const { deps } = makeDeps({
    chat: chatSpy,
    liveSessionsEnabled: () => true,
    liveSessions: new LiveSessionRegistry(startFn as never, { dir: mkdtempSync(join(tmpdir(), "bean-bot-")) }),
  });
  const sink: LiveSessionSink = { post: async () => "m1", edit: async () => {} };
  deps.liveSessions.start({ channelId, projectPath: "/p/bean", instruction: "go", sink });
  const bot = buildTeamsBot(deps);
  const effects = fx();
  return { bot, fx: effects, deps, chatCalls: () => chatSpy.mock.calls.length };
}

test("channel messages route to an active session instead of converse, and stop ends it", async () => {
  const { bot, fx: effects, deps, chatCalls } = makeBotWithActiveLiveSession("c1");
  await bot.onMessage({ conversationId: "c1", text: "look at the auth module", fromId: "u", fromName: "sam" }, effects);
  expect(chatCalls()).toBe(0); // converse never invoked
  await bot.onMessage({ conversationId: "c1", text: "stop", fromId: "u", fromName: "sam" }, effects);
  expect(deps.liveSessions.has("c1")).toBe(false);
});

test("/stop ends a live session too (Teams has no slash-command infra, so it arrives as plain text)", async () => {
  const { bot, fx: effects, deps, chatCalls } = makeBotWithActiveLiveSession("c1");
  await bot.onMessage({ conversationId: "c1", text: "/stop", fromId: "u", fromName: "sam" }, effects);
  expect(deps.liveSessions.has("c1")).toBe(false);
  expect(chatCalls()).toBe(0); // "/stop" ended it — never sent to the agent as a turn
});

test("capturing a live-session message advances the ambient cutoff, so it isn't replayed after the session ends", async () => {
  const { bot, fx: effects, deps } = makeBotWithActiveLiveSession("c1");
  const before = deps.conversations.ambientCutoff("c1");
  await bot.onMessage({ conversationId: "c1", text: "look at the auth module", fromId: "u", fromName: "sam" }, effects);
  // Without this, a later addressed message's fetchRecent(sinceMs) would re-fetch this same
  // channel history and hand it to converse() a second time as ambient chatter.
  expect(deps.conversations.ambientCutoff("c1")).toBeGreaterThan(before);
});

// Locks in the contract packages/discord/src/server.ts's messageCreate gate relies on: onMessage
// itself has no addressed/unaddressed concept — it captures ANY text for a channel with an
// active session, whether or not it looks like it was aimed at Bean. The bug this guarded
// against (unaddressed channel chatter silently dropped instead of steering the live session)
// was entirely in the Discord adapter's own "if (!addressed) return" gate, not in this capture
// logic — a full adapter-level test isn't practical here since server.ts performs real config
// loading and a live discord.js client login as top-level side effects on import, with no
// existing harness in packages/discord/__test__/ to fake a Client/Message for it.
test("onMessage captures plain, unaddressed-looking text for an active session — no @mention needed", async () => {
  const { bot, fx: effects, deps, chatCalls } = makeBotWithActiveLiveSession("c1");
  await bot.onMessage(
    { conversationId: "c1", text: "just some plain hint, no mention of bean at all", fromId: "u", fromName: "sam" },
    effects,
  );
  expect(chatCalls()).toBe(0); // captured by the live session, converse() never invoked
  expect(deps.liveSessions.has("c1")).toBe(true);
});

test("start-live re-checks liveSessionsEnabled at claim time and refuses if the feature was disabled meanwhile", async () => {
  // The proposal is offered while enabled, but a flag flip (or claude CLI going undetected)
  // can land before the operator taps the card — the gate must be re-checked where the
  // permissions-bypassed process actually launches, not just when the proposal was made.
  const { bot, fx: effects, deps } = makeBotWithLiveSessionProposal();
  await bot.onMessage({ conversationId: "c1", text: "start live session", fromId: "u", fromName: "sam" }, effects);
  const proposalId = latestLiveProposalId(effects.cards);
  deps.liveSessionsEnabled = () => false; // flag flips off after the card was posted
  await bot.onCardAction({ conversationId: "c1", fromName: "sam", value: { beanAction: "start-live", proposalId } }, effects);
  expect(deps.liveSessions.has("c1")).toBe(false);
  expect(JSON.stringify(effects.updates.at(-1)?.card)).toContain("cancelled");
  expect(effects.posted.some((p) => p.toLowerCase().includes("disabled"))).toBe(true);
});
