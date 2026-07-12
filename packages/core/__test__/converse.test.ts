import { expect, test } from "vitest";
import { converse, type ActionTool, type ConverseDeps, type ConvoMsg, type ToolSpec } from "../src/converse.js";
import { composePersonaPrompt, DEFAULT_PERSONA, type Persona } from "../src/persona.js";
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

test("plain reply with no tool call yields no proposal", async () => {
  const res = await converse([], "hi there", skills, projects, DEFAULT_PERSONA, [], depsReturning("Hello!"));
  expect(res.reply).toBe("Hello!");
  expect(res.proposedRun).toBeUndefined();
});

test("valid propose_run tool call composes a run from the local skill body", async () => {
  const deps = depsReturning("On it.", [
    { name: "propose_run", args: { skill: "review-code", project: "/work/api", instruction: "review the 3 PRs" } },
  ]);
  const res = await converse([], "review the PRs in api", skills, projects, DEFAULT_PERSONA, [], deps, "https://linear/BEAN-42");
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
  const res = await converse([], "do a thing", skills, projects, DEFAULT_PERSONA, [], deps);
  expect(res.reply).toBe("Hmm.");
  expect(res.proposedRun).toBeUndefined();
});

test("propose_run tool is enum-constrained to known skill names and project paths", async () => {
  let captured: ToolSpec[] = [];
  const deps: ConverseDeps = {
    model: "m",
    chat: async ({ tools }) => { captured = tools; return { content: "ok", toolCalls: [] }; },
  };
  await converse([], "hi", skills, projects, DEFAULT_PERSONA, [], deps);
  expect(captured.map((t) => t.name)).toEqual(["propose_run", "propose_note"]);
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
  await converse([], "hi", [], projects, DEFAULT_PERSONA, [], deps);
  expect(captured.map((t) => t.name)).toEqual(["propose_note"]);
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
  await converse(
    [], "summarize this", mixed, projects, DEFAULT_PERSONA, [], deps,
    undefined, [], undefined, undefined, true, [], false, false,
  );
  expect(captured.map((t) => t.name)).toEqual(["propose_run", "propose_delegate", "propose_note"]);
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
  const res = await converse(
    [], "run review-code on api", skills, projects, DEFAULT_PERSONA, [], deps,
    undefined, [], undefined, undefined, true, [], false, false,
  );
  expect(captured.map((t) => t.name)).toEqual(["propose_delegate", "propose_note"]);
  expect(res.proposedRun).toBeUndefined();
});

test("propose_run is still offered with no configured projects — project is optional", async () => {
  let captured: ToolSpec[] = [];
  const deps: ConverseDeps = {
    model: "m",
    chat: async ({ tools }) => { captured = tools; return { content: "hi", toolCalls: [] }; },
  };
  await converse([], "hi", skills, [], DEFAULT_PERSONA, [], deps);
  expect(captured.map((t) => t.name)).toEqual(["propose_run", "propose_note"]);
});

test("omitting project in propose_run proposes a no-project (scratch workspace) run", async () => {
  const deps = depsReturning("On it.", [
    { name: "propose_run", args: { skill: "review-code", instruction: "summarize this page" } },
  ]);
  const res = await converse([], "summarize this", skills, projects, DEFAULT_PERSONA, [], deps);
  expect(res.proposedRun?.skillName).toBe("review-code");
  expect(res.proposedRun?.projectPath).toBeUndefined();
});

test("valid propose_delegate returns a free-form delegated task", async () => {
  const deps = depsReturning("On it.", [
    { name: "propose_delegate", args: { project: "/work/api", instruction: "fix the flaky test" } },
  ]);
  const res = await converse([], "delegate this", skills, projects, DEFAULT_PERSONA, [], deps, undefined, [], undefined, undefined, true);
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
  const res = await converse([], "delegate this", skills, projects, DEFAULT_PERSONA, [], deps, undefined, [], undefined, undefined, true);
  expect(res.proposedDelegate?.skillName).toBe("review-code");
  expect(res.proposedDelegate?.composedPrompt).toContain("REVIEW BODY");
  expect(res.proposedDelegate?.composedPrompt).toContain("## Task");
  expect(res.proposedDelegate?.composedPrompt).toContain("do it");
});

test("propose_delegate treats unknown skill as no skill", async () => {
  const deps = depsReturning("On it.", [
    { name: "propose_delegate", args: { project: "/work/api", instruction: "do it", skill: "nope" } },
  ]);
  const res = await converse([], "delegate this", skills, projects, DEFAULT_PERSONA, [], deps, undefined, [], undefined, undefined, true);
  expect(res.proposedDelegate?.skillName).toBeUndefined();
  expect(res.proposedDelegate?.composedPrompt).toBe("do it");
});

test("propose_delegate drops unknown project or missing instruction", async () => {
  for (const args of [{ project: "/nope", instruction: "x" }, { project: "/work/api" }]) {
    const deps = depsReturning("on it", [{ name: "propose_delegate", args }]);
    const res = await converse([], "delegate this", skills, projects, DEFAULT_PERSONA, [], deps, undefined, [], undefined, undefined, true);
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
  await converse([], "hi", skills, projects, DEFAULT_PERSONA, [], deps, undefined, [], undefined, undefined, false);
  expect(captured.map((t) => t.name)).not.toContain("propose_delegate");
  await converse([], "hi", skills, projects, DEFAULT_PERSONA, [], deps, undefined, [], undefined, undefined, true);
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

  await converse([], "what does the bean project do?", skills, projects, DEFAULT_PERSONA, [], deps, undefined, [], undefined, undefined, true);

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

  await converse([], "hi", skills, projects, DEFAULT_PERSONA, [], deps, undefined, [], undefined, undefined, true);

  expect(systemContent).toContain("don't ask the user in chat text whether you should delegate first");
  expect(delegateDescription).toContain("don't ask the user for permission in chat text first");
});

test("recalled memories are injected after the catalog, labeled global vs project", async () => {
  let systemContent = "";
  const deps: ConverseDeps = {
    model: "m",
    chat: async ({ messages }) => { systemContent = messages[0]!.content; return { content: "ok", toolCalls: [] }; },
  };
  const memories = [
    { id: "1", text: "prefers pnpm", createdAt: "2026-07-03T00:00:00.000Z" },
    { id: "2", text: "preload must stay CJS", projectPath: "/dev/bean", createdAt: "2026-07-03T00:00:00.000Z" },
  ];
  await converse([], "hi", skills, projects, DEFAULT_PERSONA, memories, deps);
  const catalogIdx = systemContent.indexOf("Skills:");
  const memIdx = systemContent.indexOf("What you remember:");
  expect(memIdx).toBeGreaterThan(catalogIdx);
  expect(systemContent).toContain("- (about the user) prefers pnpm");
  expect(systemContent).toContain("- (project bean) preload must stay CJS");
});

test("no memory block is added when memories is empty", async () => {
  let systemContent = "";
  const deps: ConverseDeps = {
    model: "m",
    chat: async ({ messages }) => { systemContent = messages[0]!.content; return { content: "ok", toolCalls: [] }; },
  };
  await converse([], "hi", skills, projects, DEFAULT_PERSONA, [], deps);
  expect(systemContent).not.toContain("What you remember:");
});

test("history turns are accepted and the function never throws on chat failure", async () => {
  const deps: ConverseDeps = { model: "m", chat: async () => { throw new Error("network"); } };
  const res = await converse(
    [{ role: "user", content: "earlier" }, { role: "assistant", content: "reply" }],
    "again", skills, projects, DEFAULT_PERSONA, [], deps,
  );
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
  await converse([], "hi", skills, projects, persona, [], deps);
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
  await converse([], "hi", skills, projects, DEFAULT_PERSONA, [], deps);
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
  await converse([], "hi", skills, projects, DEFAULT_PERSONA, [], deps, undefined, [], undefined, undefined, true);
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
  const res = await converse([], "summarize this", chatSkills, projects, DEFAULT_PERSONA, [], deps);
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
  const res = await converse([], "remind me", skills, projects, DEFAULT_PERSONA, [], deps, undefined, [reminderAction(ran)]);
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
  const res = await converse([], "remind me", skills, projects, DEFAULT_PERSONA, [], deps, undefined, [reminderAction(ran)]);
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
  const res = await converse([], "go", skills, projects, DEFAULT_PERSONA, [], deps, undefined, [action]);
  expect(toolResult).toBe("error: disk full");
  expect(res.reply).toBe("sorry");
});

test("action tool specs are offered alongside propose_run and current time is in the prompt", async () => {
  let captured: ToolSpec[] = [];
  let systemContent = "";
  const deps: ConverseDeps = {
    model: "m",
    chat: async ({ tools, messages }) => {
      captured = tools; systemContent = messages[0]!.content;
      return { content: "ok", toolCalls: [] };
    },
  };
  const now = new Date("2026-07-03T10:00:00.000Z");
  await converse([], "hi", skills, projects, DEFAULT_PERSONA, [], deps, undefined, [reminderAction([])], () => now);
  expect(captured.map((t) => t.name)).toEqual(["propose_run", "propose_note", "set_reminder"]);
  expect(systemContent).toContain(`Current date and time: ${now.toString()}`);
});

test("propose_note yields a confirmed-later draft; project validated against known paths", async () => {
  const deps = depsReturning("Draft ready.", [
    { name: "propose_note", args: { title: " Flaky tests ", body: "## Summary\ns", project: "/work/api" } },
  ]);
  const res = await converse([], "save this as a note", skills, projects, DEFAULT_PERSONA, [], deps);
  expect(res.reply).toBe("Draft ready.");
  expect(res.proposedNote).toEqual({ title: "Flaky tests", body: "## Summary\ns", project: "/work/api", slug: undefined });
});

test("propose_note with an unknown project keeps the note but drops the project", async () => {
  const deps = depsReturning("ok", [
    { name: "propose_note", args: { title: "T", body: "B", project: "/nowhere" } },
  ]);
  const res = await converse([], "note it", skills, projects, DEFAULT_PERSONA, [], deps);
  expect(res.proposedNote?.project).toBeUndefined();
  expect(res.proposedNote?.title).toBe("T");
});

test("propose_note with a missing or blank title is dropped, keeping the reply", async () => {
  const deps = depsReturning("hm", [{ name: "propose_note", args: { title: "  ", body: "B" } }]);
  const res = await converse([], "note it", skills, projects, DEFAULT_PERSONA, [], deps);
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
  const res = await converse([], "continue", skills, projects, DEFAULT_PERSONA, [], deps, undefined, [], undefined, linked);
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

test("propose_delegate carries a stated cli and model into the proposal", async () => {
  const deps = depsReturning("On it.", [
    { name: "propose_delegate", args: { project: "/work/api", instruction: "do it", cli: "opencode", model: "gpt-5-5" } },
  ]);
  const res = await converse([], "delegate this", skills, projects, DEFAULT_PERSONA, [], deps, undefined, [], undefined, undefined, true, ["claude", "opencode"]);
  expect(res.proposedDelegate?.cli).toBe("opencode");
  expect(res.proposedDelegate?.model).toBe("gpt-5-5");
});

test("propose_delegate drops a cli not in availableClis and an unknown model", async () => {
  const deps = depsReturning("On it.", [
    { name: "propose_delegate", args: { project: "/work/api", instruction: "do it", cli: "opencode", model: "not-a-model" } },
  ]);
  const res = await converse([], "delegate this", skills, projects, DEFAULT_PERSONA, [], deps, undefined, [], undefined, undefined, true, ["claude"]);
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
  await converse([], "hi", skills, projects, DEFAULT_PERSONA, [], deps, undefined, [], undefined, undefined, true, ["claude"]);
  const tool = seenTools.find((t) => t.name === "propose_delegate");
  const props = (tool?.parameters as { properties: Record<string, { enum?: string[] }> }).properties;
  expect(props.cli?.enum).toEqual(["claude"]);
  expect(props.model?.enum).toContain("sonnet");
  expect(props.model?.enum).not.toContain("gpt-5-5"); // opencode-only model, claude-only session
});

test("propose_remember tool is only offered when rememberAvailable is true", async () => {
  let captured: ToolSpec[] = [];
  const deps: ConverseDeps = {
    model: "m",
    chat: async ({ tools }) => { captured = tools; return { content: "ok", toolCalls: [] }; },
  };
  await converse([], "hi", skills, projects, DEFAULT_PERSONA, [], deps,
    undefined, [], undefined, undefined, false, [], true);
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
  await converse([], "hi", skills, projects, DEFAULT_PERSONA, [], deps);
  expect(captured.map((t) => t.name)).not.toContain("propose_remember");
});

test("a propose_remember tool call short-circuits to proposedRemember", async () => {
  const deps = depsReturning("Sure — which of these should I keep?", [
    { name: "propose_remember", args: {} },
  ]);
  const res = await converse([], "remember what we discussed", skills, projects, DEFAULT_PERSONA, [], deps,
    undefined, [], undefined, undefined, false, [], true);
  expect(res.reply).toBe("Sure — which of these should I keep?");
  expect(res.proposedRemember).toBe(true);
});
