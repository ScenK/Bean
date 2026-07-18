import { describe, expect, it, test } from "vitest";
import { converse, type ActionTool, type ConverseDeps, type ConverseInput, type ConvoMsg, type ToolSpec } from "../src/converse.js";
import { composePersonaPrompt, DEFAULT_PERSONA, type Persona } from "../src/persona.js";
import { availableModels } from "../src/models.js";
import type { Project, Skill } from "../src/types.js";

const skills: Skill[] = [
  { name: "review-code", description: "review a diff", body: "REVIEW BODY" },
  { name: "write-tests", description: "write tests", body: "TESTS BODY" },
];
const projects: Project[] = [
  { name: "api", path: "/work/api", defaultSkill: "review-code" },
  { name: "bean", path: "/dev/bean" },
];

function depsReturning(content: string, toolCalls: { name: string; args: unknown }[] = []): ConverseDeps {
  return { model: "m", chat: async () => ({ content, toolCalls }) };
}

// Shared-fixture wrapper: each test states only the fields it cares about.
const conv = (input: Partial<ConverseInput> & Pick<ConverseInput, "latestUserText" | "deps">) =>
  converse({ history: [], skills, projects, persona: DEFAULT_PERSONA, memories: [], ...input });

test("plain reply with no tool call yields no proposal", async () => {
  const res = await conv({ latestUserText: "hi there", deps: depsReturning("Hello!") });
  expect(res.reply).toBe("Hello!");
  expect(res.proposedRun).toBeUndefined();
});

test("valid propose_run tool call composes a run from the local skill body", async () => {
  const deps = depsReturning("On it.", [
    { name: "propose_run", args: { skill: "review-code", project: "/work/api", instruction: "review the 3 PRs" } },
  ]);
  const res = await conv({ latestUserText: "review the PRs in api", deps, droppedUrl: "https://linear/BEAN-42" });
  expect(res.reply).toBe("On it.");
  expect(res.proposedRun?.skillName).toBe("review-code");
  expect(res.proposedRun?.projectPath).toBe("/work/api");
  expect(res.proposedRun?.composedPrompt).toContain("REVIEW BODY");
  expect(res.proposedRun?.composedPrompt).toContain("review the 3 PRs");
  expect(res.proposedRun?.composedPrompt).toContain("https://linear/BEAN-42");
});

test("tool call naming an unknown skill or project drops the proposal but keeps the reply", async () => {
  const deps = depsReturning("Hmm.", [
    { name: "propose_run", args: { skill: "nope", project: "/nowhere", instruction: "x" } },
  ]);
  const res = await conv({ latestUserText: "do a thing", deps });
  expect(res.reply).toBe("Hmm.");
  expect(res.proposedRun).toBeUndefined();
});

test("propose_run tool is enum-constrained to known skill names and project paths", async () => {
  let captured: ToolSpec[] = [];
  const deps: ConverseDeps = {
    model: "m",
    chat: async ({ tools }) => { captured = tools; return { content: "ok", toolCalls: [] }; },
  };
  await conv({ latestUserText: "hi", deps });
  expect(captured.map((t) => t.name)).toEqual(["propose_run", "propose_note", "propose_skill"]);
  const props = (captured[0]!.parameters as { properties: Record<string, { enum?: string[] }> }).properties;
  expect(props.skill?.enum).toEqual(["review-code", "write-tests"]);
  expect(props.project?.enum).toEqual(["/work/api", "/dev/bean"]);
});

test("no propose_run tool is offered when there are no skills", async () => {
  let captured: ToolSpec[] = [{ name: "sentinel", description: "", parameters: {} }];
  const deps: ConverseDeps = {
    model: "m",
    chat: async ({ tools }) => { captured = tools; return { content: "hi", toolCalls: [] }; },
  };
  await conv({ latestUserText: "hi", skills: [], deps });
  expect(captured.map((t) => t.name)).toEqual(["propose_note", "propose_skill"]);
});

test("runAvailable=false (chatops) offers propose_run only for chat-target skills", async () => {
  const mixed = [
    { name: "review-code", description: "review a diff", body: "REVIEW BODY", target: "terminal" as const },
    { name: "summarize", description: "summarize content", body: "SUM BODY", target: "chat" as const },
  ];
  let captured: ToolSpec[] = [];
  const deps: ConverseDeps = {
    model: "m",
    chat: async ({ tools }) => { captured = tools; return { content: "hi", toolCalls: [] }; },
  };
  await conv({ latestUserText: "summarize this", skills: mixed, deps, delegateAvailable: true, runAvailable: false });
  expect(captured.map((t) => t.name)).toEqual(["propose_run", "propose_delegate", "propose_note", "propose_skill"]);
  const props = (captured[0]!.parameters as { properties: Record<string, { enum?: string[] }> }).properties;
  expect(props.skill?.enum).toEqual(["summarize"]);
  expect(captured[0]!.description).toContain("right here in this chat");
});

test("runAvailable=false with no chat-target skills drops propose_run and rejects stray calls", async () => {
  let captured: ToolSpec[] = [];
  const deps: ConverseDeps = {
    model: "m",
    chat: async ({ tools }) => {
      captured = tools;
      // Stray call for a terminal skill anyway — must not become a proposedRun.
      return { content: "hi", toolCalls: [{ name: "propose_run", args: { skill: "review-code", instruction: "x" } }] };
    },
  };
  const res = await conv({ latestUserText: "run review-code on api", deps, delegateAvailable: true, runAvailable: false });
  expect(captured.map((t) => t.name)).toEqual(["propose_delegate", "propose_note", "propose_skill"]);
  expect(res.proposedRun).toBeUndefined();
});

test("propose_run is still offered with no configured projects — project is optional", async () => {
  let captured: ToolSpec[] = [];
  const deps: ConverseDeps = {
    model: "m",
    chat: async ({ tools }) => { captured = tools; return { content: "hi", toolCalls: [] }; },
  };
  await conv({ latestUserText: "hi", projects: [], deps });
  expect(captured.map((t) => t.name)).toEqual(["propose_run", "propose_note", "propose_skill"]);
});

test("omitting project in propose_run proposes a no-project (scratch workspace) run", async () => {
  const deps = depsReturning("On it.", [
    { name: "propose_run", args: { skill: "review-code", instruction: "summarize this page" } },
  ]);
  const res = await conv({ latestUserText: "summarize this", deps });
  expect(res.proposedRun?.skillName).toBe("review-code");
  expect(res.proposedRun?.projectPath).toBeUndefined();
});

test("valid propose_delegate returns a free-form delegated task", async () => {
  const deps = depsReturning("On it.", [
    { name: "propose_delegate", args: { project: "/work/api", instruction: "fix the flaky test" } },
  ]);
  const res = await conv({ latestUserText: "delegate this", deps, delegateAvailable: true });
  expect(res.proposedDelegate).toEqual({
    projectPath: "/work/api",
    instruction: "fix the flaky test",
    skillName: undefined,
    composedPrompt: "fix the flaky test",
  });
});

test("propose_delegate composes a known optional skill into the prompt", async () => {
  const deps = depsReturning("On it.", [
    { name: "propose_delegate", args: { project: "/work/api", instruction: "do it", skill: "review-code" } },
  ]);
  const res = await conv({ latestUserText: "delegate this", deps, delegateAvailable: true });
  expect(res.proposedDelegate?.skillName).toBe("review-code");
  expect(res.proposedDelegate?.composedPrompt).toContain("REVIEW BODY");
  expect(res.proposedDelegate?.composedPrompt).toContain("## Task");
  expect(res.proposedDelegate?.composedPrompt).toContain("do it");
});

test("propose_delegate treats unknown skill as no skill", async () => {
  const deps = depsReturning("On it.", [
    { name: "propose_delegate", args: { project: "/work/api", instruction: "do it", skill: "nope" } },
  ]);
  const res = await conv({ latestUserText: "delegate this", deps, delegateAvailable: true });
  expect(res.proposedDelegate?.skillName).toBeUndefined();
  expect(res.proposedDelegate?.composedPrompt).toBe("do it");
});

test("propose_delegate drops unknown project or missing instruction", async () => {
  for (const args of [{ project: "/nope", instruction: "x" }, { project: "/work/api" }]) {
    const deps = depsReturning("on it", [{ name: "propose_delegate", args }]);
    const res = await conv({ latestUserText: "delegate this", deps, delegateAvailable: true });
    expect(res.proposedDelegate).toBeUndefined();
    expect(res.reply).toBe("on it");
  }
});

test("propose_delegate tool is offered only when delegation is available", async () => {
  let captured: ToolSpec[] = [];
  const deps: ConverseDeps = {
    model: "m",
    chat: async ({ tools }) => { captured = tools; return { content: "ok", toolCalls: [] }; },
  };
  await conv({ latestUserText: "hi", deps, delegateAvailable: false });
  expect(captured.map((t) => t.name)).not.toContain("propose_delegate");
  await conv({ latestUserText: "hi", deps, delegateAvailable: true });
  expect(captured.map((t) => t.name)).toContain("propose_delegate");
});

test("delegate instructions tell the model to inspect linked projects instead of refusing", async () => {
  let systemContent = "";
  let delegateDescription = "";
  const deps: ConverseDeps = {
    model: "m",
    chat: async ({ messages, tools }) => {
      systemContent = messages[0]!.content;
      delegateDescription = tools.find((t) => t.name === "propose_delegate")?.description ?? "";
      return { content: "ok", toolCalls: [] };
    },
  };

  await conv({ latestUserText: "what does the bean project do?", deps, delegateAvailable: true });

  expect(systemContent).toContain("inspect, explore, summarize, or explain a linked project");
  expect(systemContent).toContain("do not say you cannot access the repository");
  expect(delegateDescription).toContain("inspect, summarize, explain");
});

test("delegate guidance tells the model to propose directly, not ask permission in chat first", async () => {
  let systemContent = "";
  let delegateDescription = "";
  const deps: ConverseDeps = {
    model: "m",
    chat: async ({ messages, tools }) => {
      systemContent = messages[0]!.content;
      delegateDescription = tools.find((t) => t.name === "propose_delegate")?.description ?? "";
      return { content: "ok", toolCalls: [] };
    },
  };

  await conv({ latestUserText: "hi", deps, delegateAvailable: true });

  expect(systemContent).toContain("don't ask the user in chat text whether you should delegate first");
  expect(delegateDescription).toContain("don't ask the user for permission in chat text first");
});

test("recalled memories ride a trailing system message, labeled global vs project", async () => {
  let captured: ConvoMsg[] = [];
  const deps: ConverseDeps = {
    model: "m",
    chat: async ({ messages }) => { captured = messages; return { content: "ok", toolCalls: [] }; },
  };
  const memories = [
    { id: "1", text: "prefers pnpm", createdAt: "2026-07-03T00:00:00.000Z" },
    { id: "2", text: "preload must stay CJS", projectPath: "/dev/bean", createdAt: "2026-07-03T00:00:00.000Z" },
  ];
  await conv({ history: [{ role: "user", content: "earlier" }], latestUserText: "hi", memories, deps });
  // Leading system message stays memory-free (stable prompt-cache prefix); the recall block
  // sits in a second system message between history and the latest user message.
  expect(captured[0]!.content).not.toContain("What you remember:");
  const context = captured[captured.length - 2]!;
  expect(context.role).toBe("system");
  expect(context.content).toContain("What you remember:");
  expect(context.content).toContain("- (about the user) prefers pnpm");
  expect(context.content).toContain("- (project bean) preload must stay CJS");
  expect(captured[captured.length - 1]).toEqual({ role: "user", content: "hi" });
});

test("no memory block is added when memories is empty", async () => {
  let captured: ConvoMsg[] = [];
  const deps: ConverseDeps = {
    model: "m",
    chat: async ({ messages }) => { captured = messages; return { content: "ok", toolCalls: [] }; },
  };
  await conv({ latestUserText: "hi", deps });
  expect(captured.some((m) => m.content.includes("What you remember:"))).toBe(false);
});

test("leading system message is byte-stable across turns (prompt-cache prefix)", async () => {
  const systems: string[] = [];
  const deps: ConverseDeps = {
    model: "m",
    chat: async ({ messages }) => { systems.push(messages[0]!.content); return { content: "ok", toolCalls: [] }; },
  };
  const memories = [{ id: "1", text: "prefers pnpm", createdAt: "2026-07-03T00:00:00.000Z" }];
  const action = { spec: { name: "noop", description: "d", parameters: {} }, run: async () => "ok" };
  await conv({ latestUserText: "first message", memories, deps, actions: [action], now: () => new Date("2026-07-03T10:00:00.000Z") });
  await conv({
    history: [{ role: "user", content: "first message" }, { role: "assistant", content: "ok" }],
    latestUserText: "totally different follow-up",
    memories, deps, actions: [action], now: () => new Date("2026-07-04T22:31:07.000Z"),
  });
  expect(systems[1]).toBe(systems[0]);
});

test("history turns are accepted and the function never throws on chat failure", async () => {
  const deps: ConverseDeps = { model: "m", chat: async () => { throw new Error("network"); } };
  const res = await conv({
    history: [{ role: "user", content: "earlier" }, { role: "assistant", content: "reply" }],
    latestUserText: "again",
    deps,
  });
  expect(res.proposedRun).toBeUndefined();
  expect(res.reply.length).toBeGreaterThan(0);
});

test("system prompt composes persona intro, behavior instructions, and catalog in order", async () => {
  let systemContent = "";
  const deps: ConverseDeps = {
    model: "m",
    chat: async ({ messages }) => {
      systemContent = messages[0]!.content;
      return { content: "ok", toolCalls: [] };
    },
  };
  const persona: Persona = { name: "Ponyta", tags: ["Playful", "Formal"] };
  await conv({ latestUserText: "hi", persona, deps });
  const personaIdx = systemContent.indexOf(composePersonaPrompt(persona));
  const behaviorIdx = systemContent.indexOf("You cannot do project work yourself");
  const catalogIdx = systemContent.indexOf("Skills:");
  expect(personaIdx).toBe(0);
  expect(behaviorIdx).toBeGreaterThan(personaIdx);
  expect(catalogIdx).toBeGreaterThan(behaviorIdx);
});

test("behavior instructions tell the model not to recite the skill/project catalog unprompted", async () => {
  let systemContent = "";
  const deps: ConverseDeps = {
    model: "m",
    chat: async ({ messages }) => {
      systemContent = messages[0]!.content;
      return { content: "ok", toolCalls: [] };
    },
  };
  await conv({ latestUserText: "hi", deps });
  expect(systemContent).toContain("don't recite or summarize it unprompted");
});

test("delegate guidance lives in behavior instructions", async () => {
  let systemContent = "";
  const deps: ConverseDeps = {
    model: "m",
    chat: async ({ messages }) => {
      systemContent = messages[0]!.content;
      return { content: "ok", toolCalls: [] };
    },
  };
  await conv({ latestUserText: "hi", deps, delegateAvailable: true });
  const delegateIdx = systemContent.indexOf("a background agent does the work while the chat stays open");
  const noteIdx = systemContent.indexOf("Don't propose a note for small talk");
  const catalogIdx = systemContent.indexOf("Skills:");
  expect(delegateIdx).toBeGreaterThan(noteIdx);
  expect(delegateIdx).toBeLessThan(catalogIdx);
  expect(systemContent).toContain("its result returns to this conversation");
});

test("proposedRun carries the skill's chat target", async () => {
  const chatSkills: Skill[] = [{ name: "summarize", description: "s", body: "B", target: "chat" }];
  const deps = depsReturning("On it.", [
    { name: "propose_run", args: { skill: "summarize", project: "/work/api", instruction: "go" } },
  ]);
  const res = await conv({ latestUserText: "summarize this", skills: chatSkills, deps });
  expect(res.proposedRun?.target).toBe("chat");
});

const reminderAction = (ran: unknown[]): ActionTool => ({
  spec: { name: "set_reminder", description: "set a reminder", parameters: { type: "object", properties: {} } },
  run: async (args) => { ran.push(args); return "reminder saved"; },
});

test("action tool call executes the tool and feeds the result back to the model", async () => {
  const ran: unknown[] = [];
  const rounds: ConvoMsg[][] = [];
  const deps: ConverseDeps = {
    model: "m",
    chat: async ({ messages }) => {
      rounds.push(messages.map((m) => ({ ...m })));
      return rounds.length === 1
        ? { content: "", toolCalls: [{ id: "call_1", name: "set_reminder", args: { text: "stretch", at: "soon" } }] }
        : { content: "Done — reminder set.", toolCalls: [] };
    },
  };
  const res = await conv({ latestUserText: "remind me", deps, actions: [reminderAction(ran)] });
  expect(ran).toEqual([{ text: "stretch", at: "soon" }]);
  expect(res.reply).toBe("Done — reminder set.");
  expect(res.proposedRun).toBeUndefined();
  expect(rounds[1]!.slice(-2)).toEqual([
    { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "set_reminder", args: { text: "stretch", at: "soon" } }] },
    { role: "tool", content: "reminder saved", toolCallId: "call_1" },
  ]);
});

test("action tool loop terminates even if the model keeps calling tools", async () => {
  const ran: unknown[] = [];
  const deps = depsReturning("looping", [{ name: "set_reminder", args: {} }]);
  const res = await conv({ latestUserText: "remind me", deps, actions: [reminderAction(ran)] });
  expect(ran).toHaveLength(3);
  expect(res.reply).toBe("looping");
});

test("a throwing action feeds an error string back instead of crashing", async () => {
  const action: ActionTool = {
    spec: { name: "boom", description: "boom", parameters: { type: "object", properties: {} } },
    run: async () => { throw new Error("disk full"); },
  };
  let toolResult = "";
  const deps: ConverseDeps = {
    model: "m",
    chat: async ({ messages }) => {
      const last = messages.at(-1)!;
      if (last.role === "tool") { toolResult = last.content; return { content: "sorry", toolCalls: [] }; }
      return { content: "", toolCalls: [{ id: "call_boom", name: "boom", args: {} }] };
    },
  };
  const res = await conv({ latestUserText: "go", deps, actions: [action] });
  expect(toolResult).toBe("error: disk full");
  expect(res.reply).toBe("sorry");
});

test("action tool specs are offered alongside propose_run and current time is in the prompt", async () => {
  let captured: ToolSpec[] = [];
  let messagesSeen: ConvoMsg[] = [];
  const deps: ConverseDeps = {
    model: "m",
    chat: async ({ tools, messages }) => {
      captured = tools; messagesSeen = messages;
      return { content: "ok", toolCalls: [] };
    },
  };
  const now = new Date("2026-07-03T10:00:00.000Z");
  await conv({ latestUserText: "hi", deps, actions: [reminderAction([])], now: () => now });
  expect(captured.map((t) => t.name)).toEqual(["propose_run", "propose_note", "propose_skill", "set_reminder"]);
  // The clock lives in the trailing context message, not the cached leading system prefix.
  expect(messagesSeen[0]!.content).not.toContain("Current date and time:");
  const context = messagesSeen[messagesSeen.length - 2]!;
  expect(context.role).toBe("system");
  expect(context.content).toContain(`Current date and time: ${now.toString()}`);
});

test("propose_note yields a confirmed-later draft; project validated against known paths", async () => {
  const deps = depsReturning("Draft ready.", [
    { name: "propose_note", args: { title: " Flaky tests ", body: "## Summary\ns", project: "/work/api" } },
  ]);
  const res = await conv({ latestUserText: "save this as a note", deps });
  expect(res.reply).toBe("Draft ready.");
  expect(res.proposedNote).toEqual({ title: "Flaky tests", body: "## Summary\ns", project: "/work/api", slug: undefined });
});

test("propose_note with an unknown project keeps the note but drops the project", async () => {
  const deps = depsReturning("ok", [
    { name: "propose_note", args: { title: "T", body: "B", project: "/nowhere" } },
  ]);
  const res = await conv({ latestUserText: "note it", deps });
  expect(res.proposedNote?.project).toBeUndefined();
  expect(res.proposedNote?.title).toBe("T");
});

test("propose_note with a missing or blank title is dropped, keeping the reply", async () => {
  const deps = depsReturning("hm", [{ name: "propose_note", args: { title: "  ", body: "B" } }]);
  const res = await conv({ latestUserText: "note it", deps });
  expect(res.proposedNote).toBeUndefined();
  expect(res.reply).toBe("hm");
});

test("linked note goes into the system prompt and its slug rides on the proposal", async () => {
  let systemContent = "";
  const deps: ConverseDeps = {
    model: "m",
    chat: async ({ messages }) => {
      systemContent = messages[0]!.content;
      return { content: "ok", toolCalls: [{ name: "propose_note", args: { title: "T2", body: "B2" } }] };
    },
  };
  const linked = { slug: "flaky", title: "Flaky tests", version: 3, body: "old body" };
  const res = await conv({ latestUserText: "continue", deps, linkedNote: linked });
  expect(systemContent).toContain('continues from the note "Flaky tests" (v3)');
  expect(systemContent).toContain("old body");
  expect(res.proposedNote?.slug).toBe("flaky");
});

test("composePersonaPrompt reflects the default persona's name and tags", () => {
  expect(composePersonaPrompt(DEFAULT_PERSONA)).toBe(
    "You are Bean, a warm, concise, direct desktop coding companion. Reply in a way that reflects that.",
  );
});

test("composePersonaPrompt reflects a custom persona's name and tags", () => {
  expect(composePersonaPrompt({ name: "Ponyta", tags: ["Playful", "Formal"] })).toBe(
    "You are Ponyta, a playful, formal desktop coding companion. Reply in a way that reflects that.",
  );
});

const TEST_CLI_MODELS = [
  { provider: "claude" as const, models: ["sonnet", "opus", "haiku"] },
  { provider: "opencode" as const, models: ["github-copilot/gpt-5.5"] },
];

test("propose_delegate carries a stated cli and model into the proposal", async () => {
  const deps = depsReturning("On it.", [
    { name: "propose_delegate", args: { project: "/work/api", instruction: "do it", cli: "opencode", model: "github-copilot/gpt-5.5" } },
  ]);
  const res = await conv({
    latestUserText: "delegate this", deps, delegateAvailable: true, availableClis: ["claude", "opencode"],
    models: availableModels(TEST_CLI_MODELS, ["opencode"]),
  });
  expect(res.proposedDelegate?.cli).toBe("opencode");
  expect(res.proposedDelegate?.model).toBe("github-copilot/gpt-5.5");
});

test("propose_delegate drops a cli not in availableClis and an unknown model", async () => {
  const deps = depsReturning("On it.", [
    { name: "propose_delegate", args: { project: "/work/api", instruction: "do it", cli: "opencode", model: "not-a-model" } },
  ]);
  const res = await conv({
    latestUserText: "delegate this", deps, delegateAvailable: true, availableClis: ["claude"],
    models: availableModels(TEST_CLI_MODELS, ["opencode"]),
  });
  expect(res.proposedDelegate?.cli).toBeUndefined();
  expect(res.proposedDelegate?.model).toBeUndefined();
  expect(res.proposedDelegate?.projectPath).toBe("/work/api");
});

test("propose_delegate tool schema includes cli/model enums when clis are available", async () => {
  let seenTools: ToolSpec[] = [];
  const deps: ConverseDeps = {
    model: "m",
    chat: async ({ tools }) => { seenTools = tools; return { content: "ok", toolCalls: [] }; },
  };
  await conv({
    latestUserText: "hi", deps, delegateAvailable: true, availableClis: ["claude"],
    models: availableModels(TEST_CLI_MODELS, ["claude"]),
  });
  const tool = seenTools.find((t) => t.name === "propose_delegate");
  const props = (tool?.parameters as { properties: Record<string, { enum?: string[] }> }).properties;
  expect(props.cli?.enum).toEqual(["claude"]);
  expect(props.model?.enum).toContain("sonnet");
  expect(props.model?.enum).not.toContain("github-copilot/gpt-5.5"); // opencode-only model, claude-only session
});

test("propose_remember tool is only offered when rememberAvailable is true", async () => {
  let captured: ToolSpec[] = [];
  const deps: ConverseDeps = {
    model: "m",
    chat: async ({ tools }) => { captured = tools; return { content: "ok", toolCalls: [] }; },
  };
  await conv({ latestUserText: "hi", deps, rememberAvailable: true });
  expect(captured.map((t) => t.name)).toContain("propose_remember");
  const remember = captured.find((t) => t.name === "propose_remember")!;
  expect((remember.parameters as { properties: object }).properties).toEqual({});
});

test("propose_remember is absent by default (desktop path)", async () => {
  let captured: ToolSpec[] = [];
  const deps: ConverseDeps = {
    model: "m",
    chat: async ({ tools }) => { captured = tools; return { content: "ok", toolCalls: [] }; },
  };
  await conv({ latestUserText: "hi", deps });
  expect(captured.map((t) => t.name)).not.toContain("propose_remember");
});

test("a propose_remember tool call short-circuits to proposedRemember", async () => {
  const deps = depsReturning("Sure — which of these should I keep?", [
    { name: "propose_remember", args: {} },
  ]);
  const res = await conv({ latestUserText: "remember what we discussed", deps, rememberAvailable: true });
  expect(res.reply).toBe("Sure — which of these should I keep?");
  expect(res.proposedRemember).toBe(true);
});

test("valid propose_skill call yields a proposedSkill with updating=false for a new name", async () => {
  const deps = depsReturning("Drafted it.", [
    { name: "propose_skill", args: { name: "changelog", body: "---\ndescription: Write a changelog\n---\n\n# Changelog\n\nDo the thing." } },
  ]);
  const res = await conv({ latestUserText: "make me a changelog skill", deps });
  expect(res.reply).toBe("Drafted it.");
  expect(res.proposedSkill).toEqual({
    name: "changelog",
    body: "---\ndescription: Write a changelog\n---\n\n# Changelog\n\nDo the thing.",
    updating: false,
  });
});

test("propose_skill naming an existing skill sets updating=true", async () => {
  const deps = depsReturning("Updating.", [
    { name: "propose_skill", args: { name: "review-code", body: "# Review\n\nNew body." } },
  ]);
  const res = await conv({ latestUserText: "improve the review skill", deps });
  expect(res.proposedSkill?.updating).toBe(true);
});

test("propose_skill with a traversal or empty name drops the proposal but keeps the reply", async () => {
  for (const name of ["../evil", "a/b", "a\\b", "", "  "]) {
    const deps = depsReturning("Hmm.", [{ name: "propose_skill", args: { name, body: "# X" } }]);
    const res = await conv({ latestUserText: "make a skill", deps });
    expect(res.proposedSkill, name).toBeUndefined();
    expect(res.reply).toBe("Hmm.");
  }
});

test("propose_skill with a missing or empty body drops the proposal", async () => {
  const deps = depsReturning("Hmm.", [{ name: "propose_skill", args: { name: "ok" } }]);
  const res = await conv({ latestUserText: "make a skill", deps });
  expect(res.proposedSkill).toBeUndefined();
});

describe("propose_todo", () => {
  it("is not offered when no todo-driven routines exist", async () => {
    let offered: string[] = [];
    await conv({
      latestUserText: "queue this",
      skills: [],
      projects: [],
      deps: {
        model: "m",
        chat: async ({ tools }) => { offered = tools.map((t) => t.name); return { content: "ok", toolCalls: [] }; },
      },
    });
    expect(offered).not.toContain("propose_todo");
  });

  it("returns proposedTodo on a valid call", async () => {
    const res = await conv({
      latestUserText: "queue this",
      skills: [],
      projects: [],
      deps: {
        model: "m",
        chat: async () => ({
          content: "queued a draft",
          toolCalls: [{ name: "propose_todo", args: { routine: "nightly", text: "Fix the flaky spec" } }],
        }),
      },
      todoRoutines: ["nightly"],
    });
    expect(res.proposedTodo).toEqual({ routine: "nightly", text: "Fix the flaky spec" });
    expect(res.reply).toBe("queued a draft");
  });

  it("drops the proposal on an unknown routine or empty text", async () => {
    const res = await conv({
      latestUserText: "queue this",
      skills: [],
      projects: [],
      deps: {
        model: "m",
        chat: async () => ({
          content: "hm",
          toolCalls: [{ name: "propose_todo", args: { routine: "nope", text: "x" } }],
        }),
      },
      todoRoutines: ["nightly"],
    });
    expect(res.proposedTodo).toBeUndefined();
  });
});
