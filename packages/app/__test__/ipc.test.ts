import { describe, expect, it, test, vi } from "vitest";
import {
  buildThemeHandlers, buildChatHandler, buildLaunchHandler, buildPlanStore,
  buildDroppedUrlStore, buildChatPromptStore, buildModelsHandler, buildModelMemoryHandlers,
  buildPendingUpdateStore, buildUpdateHandlers,
  parseDashboardTarget, openComponentPayload, notificationOpens, type ChatHandlerDeps,
} from "../src/ipc.js";
import { buildMemoryHandlers } from "@bean/host";
import type { Project, RouteSuggestion, Skill, Persona, Memory } from "@bean/core";
import type { LaunchSpawnFn } from "@bean/core";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";

test("theme handlers read and write through the injected deps", async () => {
  let current: "hearth" | "graphite" = "hearth";
  const setCurrentTheme = vi.fn(async (t: "hearth" | "graphite") => { current = t; });
  const handlers = buildThemeHandlers({ getCurrentTheme: () => current, setCurrentTheme });

  expect(handlers.get()).toBe("hearth");
  await handlers.set("graphite");
  expect(setCurrentTheme).toHaveBeenCalledWith("graphite");
  expect(handlers.get()).toBe("graphite");
});

test("chat handler wires skills/projects/persona into converse", async () => {
  const skills: Skill[] = [{ name: "review-code", description: "r", body: "BODY" }];
  const projects: Project[] = [{ name: "api", path: "/work/api" }];
  const handler = buildChatHandler({
    loadSkills: async () => skills,
    loadProjects: async () => projects,
    loadPersona: async () => ({ name: "Ponyta", tags: ["Playful"] }),
    converse: async ({ messages }) => {
      expect(messages[0]!.content).toContain("You are Ponyta");
      return {
        content: "on it",
        toolCalls: [{ name: "propose_run", args: { skill: "review-code", project: "/work/api", instruction: "go" } }],
      };
    },
    getModel: () => "m",
    projectSkillsDir: "/b/project-skills",
    skillsDir: "/b/skills",
    projectsFile: "/b/projects.json",
    personaFile: "/b/persona.json",
    projectPersonaFile: "/b/project-persona.json",
    loadMemories: async () => [],
    dbFile: "/b/memory.json",
  });
  const out = await handler({ history: [], message: "review api", droppedUrl: undefined });
  expect(out.reply).toBe("on it");
  expect(out.model).toBe("m");
  expect(out.proposedRun?.projectPath).toBe("/work/api");
  expect(out.proposedRun?.composedPrompt).toContain("BODY");
});

test("chat handler offers the desktop hand-off only to a chat that can open a live session", async () => {
  let toolNames: string[] = [];
  let description = "";
  const handler = buildChatHandler({
    loadSkills: async () => [],
    loadProjects: async () => [{ name: "api", path: "/work/api" }],
    loadPersona: async () => ({ name: "Ponyta", tags: [] }),
    converse: async ({ tools }) => {
      toolNames = tools.map((t) => t.name);
      description = tools.find((t) => t.name === "propose_live_session")?.description ?? "";
      return { content: "ok", toolCalls: [] };
    },
    getModel: () => "m",
    projectSkillsDir: "/b/project-skills",
    skillsDir: "/b/skills",
    projectsFile: "/b/projects.json",
    personaFile: "/b/persona.json",
    projectPersonaFile: "/b/project-persona.json",
    loadMemories: async () => [],
    dbFile: "/b/memory.json",
    liveSessionAvailable: (clientId, mountId) => clientId === 7 && mountId === "m1",
  });
  await handler({ history: [], message: "build it" }, 7, "m1");
  expect(toolNames).toContain("propose_live_session");
  expect(description).toContain("hand this chat over");
  await handler({ history: [], message: "build it" }, 7, "m2");
  expect(toolNames).not.toContain("propose_live_session");
  await handler({ history: [], message: "build it" }, 8, "m1");
  expect(toolNames).not.toContain("propose_live_session");
  await handler({ history: [], message: "build it" }, 7);
  expect(toolNames).not.toContain("propose_live_session");
  await handler({ history: [], message: "build it" });
  expect(toolNames).not.toContain("propose_live_session");
});

test("chat handler rejects bad images in main before converse runs (#733)", async () => {
  let called = false;
  const handler = buildChatHandler({
    loadSkills: async () => [],
    loadProjects: async () => [],
    loadPersona: async () => ({ name: "Bean", tags: [] }) as Persona,
    converse: async () => { called = true; return { content: "x", toolCalls: [] }; },
    getModel: () => "m",
    projectSkillsDir: "/b/project-skills",
    skillsDir: "/b/skills",
    projectsFile: "/b/projects.json",
    personaFile: "/b/persona.json",
    projectPersonaFile: "/b/project-persona.json",
    loadMemories: async () => [],
    dbFile: "/b/memory.json",
  });
  const png = { data: "AAAA", mimeType: "image/png" };
  await expect(handler({ history: [], message: "hi", images: [{ ...png, mimeType: "image/svg+xml" }] })).rejects.toThrow(/PNG, JPEG and WebP/);
  await expect(handler({ history: [], message: "hi", images: [png, png, png, png, png] })).rejects.toThrow(/at most 4/);
  await expect(handler({ history: [], message: "hi", images: [{ ...png, data: "A".repeat(14 * 1024 * 1024) }] })).rejects.toThrow(/10 MB/);
  expect(called).toBe(false);
});

test("chat handler forwards req.images to converse and runs generate_image into generatedImages", async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const imagesTmp = await mkdtemp(join(tmpdir(), "bean-imgs-"));
  let calls = 0;
  let sawImageParts = false;
  const progress: (string | undefined)[] = [];
  const b64 = Buffer.from("png!").toString("base64");
  const handler = buildChatHandler({
    loadSkills: async () => [],
    loadProjects: async () => [],
    loadPersona: async () => ({ name: "Bean", tags: [] }) as Persona,
    converse: async ({ messages, tools }) => {
      calls += 1;
      const last = messages[messages.length - 1]!;
      if (Array.isArray(last.content)) sawImageParts = last.content.some((p) => p.type === "image");
      if (calls === 1) {
        expect(tools.some((t) => t.name === "generate_image")).toBe(true);
        return { content: "", toolCalls: [{ id: "1", name: "generate_image", args: { prompt: "a cat" } }] };
      }
      return { content: "done", toolCalls: [] };
    },
    getModel: () => "m",
    projectSkillsDir: "/b/project-skills",
    skillsDir: "/b/skills",
    projectsFile: "/b/projects.json",
    personaFile: "/b/persona.json",
    projectPersonaFile: "/b/project-persona.json",
    loadMemories: async () => [],
    dbFile: "/b/memory.json",
    imageGen: {
      generate: async () => ({ b64 }),
      getModel: () => "gpt-image-2",
      imagesDir: imagesTmp,
      onStart: (mountId) => { progress.push(mountId); },
    },
  });
  const out = await handler({ history: [], message: "draw a cat", images: [{ data: "AAAA", mimeType: "image/png" }] }, undefined, "mount-1");
  expect(progress).toEqual(["mount-1"]); // image progress is tagged with the asking chat
  expect(sawImageParts).toBe(true);
  expect(out.reply).toBe("done");
  expect(out.generatedImages).toHaveLength(1);
  expect(out.generatedImages![0]!.dataUrl).toBe(`data:image/png;base64,${b64}`);
  expect(out.generatedImages![0]!.path).toMatch(/a-cat\.png$/);
});

test("chat handler offers both memory tools on every typed turn only, and reports the rows forget actually deleted", async () => {
  const seen: Record<string, string[]> = {};
  const intentPrompts: string[] = [];
  let key = "";
  const deleted: string[][] = [];
  const handler = buildChatHandler({
    loadSkills: async () => [],
    loadProjects: async () => [],
    loadPersona: async () => ({ name: "Bean", tags: [] }) as Persona,
    converse: async ({ messages, tools }) => {
      if (tools.length === 0) { // the memory tools' intent check: fixed prompt + typed text only
        intentPrompts.push(String(messages[1]?.content));
        return { content: '{"remember": false, "forget": true}', toolCalls: [] };
      }
      seen[key] ??= tools.map((t) => t.name).filter((n) => n === "remember" || n === "forget_memory");
      if (key === "forget" && !messages.some((m) => m.role === "tool")) {
        return { content: "", toolCalls: [{ id: "1", name: "forget_memory", args: { ids: ["d", "k"] } }] };
      }
      return { content: "ok", toolCalls: [] };
    },
    getModel: () => "m",
    projectSkillsDir: "/b/project-skills",
    skillsDir: "/b/skills",
    projectsFile: "/b/projects.json",
    personaFile: "/b/persona.json",
    projectPersonaFile: "/b/project-persona.json",
    loadMemories: async () => [
      { id: "d", text: "dentist on Friday", createdAt: "2026-07-03T00:00:00.000Z" },
      { id: "k", text: "uses zed", createdAt: "2026-07-03T00:00:00.000Z" },
    ],
    appendMemories: async () => {},
    deleteMemories: async (_f, ids) => { deleted.push(ids); return ["d"]; }, // "k" already gone
    dbFile: "/b/bean.db",
  });
  for (const [k, req] of Object.entries({
    typed: { message: "hi", source: "typed" as const },
    loopback: { message: "delegate result", source: "loopback" as const },
    skill: { message: "## Skill", source: "skill" as const },
    incognito: { message: "hi", source: "typed" as const, incognito: true },
  })) {
    key = k;
    await handler({ history: [], ...req });
  }
  expect(seen).toEqual({ typed: ["remember", "forget_memory"], loopback: [], skill: [], incognito: [] });
  key = "forget";
  const out = await handler({ history: [], message: "forget the dentist thing", source: "typed" });
  expect(intentPrompts).toEqual(["forget the dentist thing"]);
  expect(deleted).toEqual([["d", "k"]]);
  expect(out.forgotten).toEqual([{ id: "d", text: "dentist on Friday", createdAt: "2026-07-03T00:00:00.000Z" }]);
});

test("chat handler drops disabled skills and injects recalled memories", async () => {
  const skills: Skill[] = [
    { name: "review-code", description: "r", body: "BODY", enabled: true },
    { name: "hidden", description: "h", body: "H", enabled: false },
  ];
  const projects: Project[] = [{ name: "api", path: "/work/api" }];
  let systemContent = "";
  let userContent = "";
  const handler = buildChatHandler({
    loadSkills: async () => skills,
    loadProjects: async () => projects,
    loadPersona: async () => ({ name: "Bean", tags: ["Warm"] }) as Persona,
    converse: async ({ messages, tools }) => {
      systemContent = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
      userContent = messages.filter((m) => m.role === "user").map((m) => String(m.content)).join("\n\n");
      const props = (tools[0]!.parameters as { properties: Record<string, { enum?: string[] }> }).properties;
      expect(props.skill?.enum).toEqual(["review-code"]); // "hidden" excluded
      return { content: "ok", toolCalls: [] };
    },
    getModel: () => "m",
    projectSkillsDir: "/b/project-skills",
    skillsDir: "/b/skills",
    projectsFile: "/b/projects.json",
    personaFile: "/b/persona.json",
    projectPersonaFile: "/b/project-persona.json",
    loadMemories: async () => [
      { id: "1", text: "prefers pnpm", createdAt: "2026-07-03T00:00:00.000Z" },
      { id: "2", text: "drinks rooibos", createdAt: "2026-07-03T00:00:00.000Z", subjectId: "29:owner" },
      { id: "3", text: "drinks espresso", createdAt: "2026-07-03T00:00:00.000Z", subjectId: "mia" },
    ],
    ownerSubjectIds: async () => ["disc-owner", "29:owner"],
    dbFile: "/b/memory.json",
  });
  await handler({ history: [], message: "hi" });
  // Recalled memories are user-role data, never system authority.
  expect(userContent).toContain("What you remember (saved preferences and facts");
  expect(userContent).toContain("prefers pnpm");
  // Owner-DM rows read as about the user; other members' private rows as a member (#647).
  expect(userContent).toContain("[2] (about the user) drinks rooibos");
  expect(userContent).toContain("[3] (about a member) drinks espresso");
  expect(systemContent).not.toContain("prefers pnpm");
});

test("chat handler pins the owner's You rows into every recall, whatever the memory size (#650)", async () => {
  let userContent = "";
  const handler = buildChatHandler({
    loadSkills: async () => [],
    loadProjects: async () => [],
    loadPersona: async () => ({ name: "Bean", tags: [] }) as Persona,
    converse: async ({ messages }) => {
      userContent = messages.filter((m) => m.role === "user").map((m) => String(m.content)).join("\n\n");
      return { content: "ok", toolCalls: [] };
    },
    getModel: () => "m",
    projectSkillsDir: "/b/project-skills",
    skillsDir: "/b/skills",
    projectsFile: "/b/projects.json",
    personaFile: "/b/persona.json",
    projectPersonaFile: "/b/project-persona.json",
    loadMemories: async () => [
      { id: "you", text: "goes by Scen", category: "You", createdAt: "2026-07-01T00:00:00.000Z" },
      ...Array.from({ length: 30 }, (_, i) => ({ id: `f-${i}`, text: `unrelated filler ${i}`, createdAt: "2026-07-03T00:00:00.000Z" })),
    ],
    dbFile: "/b/memory.json",
  });
  await handler({ history: [], message: "what's the weather" });
  expect(userContent).toContain("[you] (about the user) goes by Scen");
});

test("chat handler passes the linked note through to converse (framed user message + proposal slug)", async () => {
  let systemContent = "";
  let noteContent = "";
  const handler = buildChatHandler({
    loadSkills: async () => [{ name: "review-code", description: "r", body: "BODY" }] as Skill[],
    loadProjects: async () => [{ name: "api", path: "/work/api" }] as Project[],
    loadPersona: async () => ({ name: "Bean", tags: ["Warm"] }) as Persona,
    converse: async ({ messages }) => {
      systemContent = messages[0]!.content;
      noteContent = String(messages[1]!.content);
      return { content: "ok", toolCalls: [{ name: "propose_note", args: { title: "T2", body: "B2" } }] };
    },
    getModel: () => "m",
    projectSkillsDir: "/b/project-skills",
    skillsDir: "/b/skills",
    projectsFile: "/b/projects.json",
    personaFile: "/b/persona.json",
    projectPersonaFile: "/b/project-persona.json",
    loadMemories: async () => [],
    dbFile: "/b/memory.json",
  });
  const out = await handler({
    history: [], message: "continue",
    linkedNote: { slug: "flaky", title: "Flaky tests", version: 3, body: "old note body" },
  });
  expect(systemContent).toContain("continues from a linked note");
  expect(systemContent).not.toContain("Flaky tests");
  expect(noteContent).toContain('[The linked note "Flaky tests" (v3) is the subject of this chat');
  expect(noteContent).toContain("old note body");
  expect(out.proposedNote?.slug).toBe("flaky");
});

test("chat handler passes delegate availability and web search through to converse", async () => {
  let seenTools: string[] = [];
  let seenWebSearch: boolean | undefined;
  const handler = buildChatHandler({
    loadSkills: async () => [{ name: "review-code", description: "r", body: "BODY" }] as Skill[],
    loadProjects: async () => [{ name: "api", path: "/work/api" }] as Project[],
    loadPersona: async () => ({ name: "Bean", tags: ["Warm"] }) as Persona,
    converse: async ({ tools, webSearch }) => {
      seenWebSearch = webSearch;
      seenTools = tools.map((t) => t.name);
      return { content: "ok", toolCalls: [] };
    },
    getModel: () => "m",
    projectSkillsDir: "/b/project-skills",
    skillsDir: "/b/skills",
    projectsFile: "/b/projects.json",
    personaFile: "/b/persona.json",
    projectPersonaFile: "/b/project-persona.json",
    loadMemories: async () => [],
    dbFile: "/b/memory.json",
    delegateAvailable: () => true,
    webSearch: () => true,
  });
  await handler({ history: [], message: "delegate this" });
  expect(seenTools).toContain("propose_delegate");
  expect(seenWebSearch).toBe(true);
});

test("chat handler offers propose_send only with proposeSend and turns the call into a send card", async () => {
  const base = {
    loadSkills: async () => [] as Skill[],
    loadProjects: async () => [] as Project[],
    loadPersona: async () => ({ name: "Bean", tags: ["Warm"] }) as Persona,
    getModel: () => "m",
    projectSkillsDir: "/b/project-skills", skillsDir: "/b/skills", projectsFile: "/b/projects.json",
    personaFile: "/b/persona.json", projectPersonaFile: "/b/project-persona.json",
    loadMemories: async () => [], dbFile: "/b/memory.json",
  };
  const offered: string[][] = [];
  const converse: ChatHandlerDeps["converse"] = async ({ tools }) => {
    offered.push(tools.map((t) => t.name));
    return tools.some((t) => t.name === "propose_send")
      ? { content: "", toolCalls: [{ name: "propose_send", args: { destination: "ops", text: "hi" } }] }
      : { content: "ok", toolCalls: [] };
  };
  await buildChatHandler({ ...base, converse } as ChatHandlerDeps)({ history: [], message: "post hi in ops" });
  expect(offered[0]).not.toContain("propose_send");
  const seen: string[] = [];
  const out = await buildChatHandler({
    ...base, converse,
    proposeSend: (destination, body) => { seen.push(destination, body); return { id: "p1", destination, body, options: [] }; },
  } as ChatHandlerDeps)({ history: [], message: "post hi in ops" });
  expect(offered[1]).toContain("propose_send");
  expect(seen).toEqual(["ops", "hi"]);
  expect(out.sendCard).toEqual({ id: "p1", destination: "ops", body: "hi", options: [] });
  expect(out.proposedSend).toBeUndefined();
});

test("buildChatHandler passes todo-driven routine names into converse", async () => {
  const nightlyTodoDriven: Routine = {
    name: "nightly", enabled: true, cron: "0 2 * * *", todoDriven: true,
    steps: [{ kind: "chat", instruction: "x" }], sinks: {},
  };
  const plainRoutine: Routine = {
    name: "plain", enabled: true, cron: "0 8 * * *",
    steps: [{ kind: "chat", instruction: "x" }], sinks: {},
  };
  let seenTools: string[] = [];
  const handler = buildChatHandler({
    loadSkills: async () => [{ name: "review-code", description: "r", body: "BODY" }] as Skill[],
    loadProjects: async () => [{ name: "api", path: "/work/api" }] as Project[],
    loadPersona: async () => ({ name: "Bean", tags: ["Warm"] }) as Persona,
    converse: async ({ tools }) => {
      seenTools = tools.map((t) => t.name);
      return { content: "ok", toolCalls: [] };
    },
    getModel: () => "m",
    projectSkillsDir: "/b/project-skills",
    skillsDir: "/b/skills",
    projectsFile: "/b/projects.json",
    personaFile: "/b/persona.json",
    projectPersonaFile: "/b/project-persona.json",
    loadMemories: async () => [],
    dbFile: "/b/memory.json",
    loadRoutines: async () => [nightlyTodoDriven, plainRoutine],
  });
  await handler({ history: [], message: "queue a task" });
  expect(seenTools).toContain("propose_todo");
});

describe("chat handler sprout runs", () => {
  const watch: Routine = {
    name: "feed-watch", enabled: true, watch: { kind: "command", command: "x" }, todoDriven: true,
    steps: [{ kind: "chat", instruction: "x" }], sinks: { note: true },
  };
  const daily: Routine = { name: "daily", description: "Morning brief", enabled: false, cron: "0 8 * * *", steps: [{ kind: "chat", instruction: "x" }], sinks: {} };
  const handlerFor = (routines: Routine[], name: string, facts = { pending: 0, seeded: true }) => {
    let seenTools: string[] = [];
    const handler = buildChatHandler({
      loadSkills: async () => [] as Skill[],
      loadProjects: async () => [] as Project[],
      loadPersona: async () => ({ name: "Bean", tags: [] }) as unknown as Persona,
      converse: async ({ tools }) => {
        seenTools = tools.map((t) => t.name);
        return { content: "Here you go", toolCalls: tools.some((t) => t.name === "propose_sprout_run") ? [{ name: "propose_sprout_run", args: { routine: name } }] : [] };
      },
      getModel: () => "m",
      projectSkillsDir: "/b/ps", skillsDir: "/b/s", projectsFile: "/b/p.json", personaFile: "/b/pe.json", projectPersonaFile: "/b/pp.json",
      loadMemories: async () => [], dbFile: "/b/bean.db",
      loadRoutines: async () => routines,
      sproutFacts: async () => facts,
    });
    return { run: () => handler({ history: [], message: "run it" }), tools: () => seenTools };
  };

  it("freezes the action onto a card", async () => {
    const res = await handlerFor([daily, watch], "daily").run();
    expect(res.proposedSproutRun).toBeUndefined();
    expect(res.sproutRun).toMatchObject({ routine: "daily", action: "run", paused: true });
    expect(res.reply).toBe("Here you go");
    const check = await handlerFor([daily, watch], "feed-watch").run();
    expect(check.sproutRun).toMatchObject({ action: "check", resultsTo: "a note" });
  });

  it("answers a paused or never-reviewed watch with text, not a card", async () => {
    const off = await handlerFor([{ ...watch, enabled: false }], "feed-watch").run();
    expect(off.sproutRun).toBeUndefined();
    expect(off.reply).toBe("feed-watch is off — turn it on in Sprouts.");
    const review = await handlerFor([{ ...watch, enabled: false }], "feed-watch", { pending: 0, seeded: false }).run();
    expect(review.reply).toBe("feed-watch needs its first review in Bean's Sprouts panel.");
  });

  it("isn't offered without sproutFacts", async () => {
    let seen: string[] = [];
    const handler = buildChatHandler({
      loadSkills: async () => [] as Skill[], loadProjects: async () => [] as Project[],
      loadPersona: async () => ({ name: "Bean", tags: [] }) as unknown as Persona,
      converse: async ({ tools }) => { seen = tools.map((t) => t.name); return { content: "ok", toolCalls: [] }; },
      getModel: () => "m",
      projectSkillsDir: "/b/ps", skillsDir: "/b/s", projectsFile: "/b/p.json", personaFile: "/b/pe.json", projectPersonaFile: "/b/pp.json",
      loadMemories: async () => [], dbFile: "/b/bean.db", loadRoutines: async () => [daily],
    });
    await handler({ history: [], message: "run it" });
    expect(seen).not.toContain("propose_sprout_run");
  });
});

test("chat handler passes action tools through to converse and executes them", async () => {
  const ran: unknown[] = [];
  const handler = buildChatHandler({
    loadSkills: async () => [{ name: "review-code", description: "r", body: "BODY" }] as Skill[],
    loadProjects: async () => [{ name: "api", path: "/work/api" }] as Project[],
    loadPersona: async () => ({ name: "Bean", tags: ["Warm"] }) as Persona,
    converse: async ({ tools, messages }) => {
      if (messages.at(-1)!.role === "tool") return { content: "done", toolCalls: [] };
      expect(tools.map((t) => t.name)).toContain("set_reminder");
      return { content: "", toolCalls: [{ id: "call_1", name: "set_reminder", args: { text: "t", at: "now" } }] };
    },
    getModel: () => "m",
    projectSkillsDir: "/b/project-skills",
    skillsDir: "/b/skills",
    projectsFile: "/b/projects.json",
    personaFile: "/b/persona.json",
    projectPersonaFile: "/b/project-persona.json",
    loadMemories: async () => [],
    dbFile: "/b/memory.json",
    actions: [{
      spec: { name: "set_reminder", description: "d", parameters: { type: "object", properties: {} } },
      run: async (args) => { ran.push(args); return "saved"; },
    }],
  });
  const out = await handler({ history: [], message: "remind me" });
  expect(ran).toEqual([{ text: "t", at: "now" }]);
  expect(out.reply).toBe("done");
});

function fakeChild() {
  return new EventEmitter() as EventEmitter & { kill: () => void };
}

test("launch handler opens the configured editor via `open -a` (open mode, no script)", () => {
  const child = fakeChild();
  const spawnLaunch = vi.fn<LaunchSpawnFn>(() => child as never);
  const handler = buildLaunchHandler({ spawnLaunch, getEditorApp: () => "/Applications/Zed.app" });

  handler({ mode: "open", projectPath: "/p" });

  expect(spawnLaunch).toHaveBeenCalledWith("open", ["-a", "/Applications/Zed.app", "/p"]);
});

test("launch handler reports an error and never spawns when no editor is configured", () => {
  const spawnLaunch = vi.fn<LaunchSpawnFn>();
  const onLaunchError = vi.fn();
  const handler = buildLaunchHandler({ spawnLaunch, onLaunchError });

  handler({ mode: "open", projectPath: "/p" });

  expect(spawnLaunch).not.toHaveBeenCalled();
  expect(onLaunchError).toHaveBeenCalledWith(
    { mode: "open", projectPath: "/p" },
    expect.objectContaining({ message: expect.stringContaining("No editor configured") }),
  );
});

test("launch handler forwards getTerminalApp() into launchInTerminal's terminalApp arg", () => {
  const child = fakeChild();
  const spawnLaunch = vi.fn<LaunchSpawnFn>(() => child as never);
  const handler = buildLaunchHandler({ spawnLaunch, getTerminalApp: () => "/Applications/Warp.app" });

  handler({ mode: "opencode", projectPath: "/p", prompt: "go" });

  // "open" is called with the -a flag naming the configured app.
  expect(spawnLaunch).toHaveBeenCalledWith("open", expect.arrayContaining(["-a", "/Applications/Warp.app"]));
});

test("a forget receipt's Undo: memory.append of result.forgotten restores the identical row; a second restore fails loud", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const core = await import("@bean/core");
  const dir = await mkdtemp(join(tmpdir(), "bean-forgot-"));
  try {
    const file = join(dir, "bean.db");
    const row: Memory = { id: "d", text: "dentist on Friday", projectPath: "/work/api", createdAt: "2026-07-03T00:00:00.000Z", subjectId: "u1" };
    await core.appendMemories(file, [row]);
    const handler = buildChatHandler({
      loadSkills: async () => [], loadProjects: async () => [], loadPersona: async () => ({ name: "Bean", tags: [] }) as Persona,
      converse: async ({ messages, tools }) => {
        if (tools.length === 0) return { content: '{"remember": false, "forget": true}', toolCalls: [] };
        return messages.some((m) => m.role === "tool")
          ? { content: "Forgotten.", toolCalls: [] }
          : { content: "", toolCalls: [{ id: "1", name: "forget_memory", args: { ids: ["d"] } }] };
      },
      getModel: () => "m", projectSkillsDir: "/b/ps", skillsDir: "/b/s", projectsFile: "/b/p.json",
      personaFile: "/b/persona.json", projectPersonaFile: "/b/pp.json",
      loadMemories: core.loadMemories, appendMemories: core.appendMemories, deleteMemories: core.deleteMemories,
      dbFile: file,
    });
    const out = await handler({ history: [], message: "forget the dentist", source: "typed" });
    expect(out.forgotten).toEqual([row]);
    expect(await core.loadMemories(file)).toEqual([]);
    const handlers = buildMemoryHandlers({
      loadMemories: core.loadMemories, appendMemories: core.appendMemories, dbFile: file,
    } as Parameters<typeof buildMemoryHandlers>[0]);
    await handlers.append(out.forgotten!);
    expect(await core.loadMemories(file)).toEqual([row]);
    await expect(handlers.append(out.forgotten!)).rejects.toThrow(/UNIQUE/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("plan store lets a late subscriber pull the pending plan (drop race fix)", () => {
  const store = buildPlanStore();
  const run: RouteSuggestion = { skillName: "review-code", projectPath: "/work/api", composedPrompt: "go", confidence: 0 };

  // No plan proposed yet: a window that opens first sees nothing.
  expect(store.get()).toBeUndefined();

  // main stores the plan the instant it's computed, before the fresh window's
  // renderer has even loaded — the exact timing that used to drop the push message.
  store.set(run);

  // The renderer mounts later and pulls it: no race, it's there.
  expect(store.get()).toBe(run);
  // Consumed once so a reopened plan window can't replay a stale proposal.
  expect(store.get()).toBeUndefined();
});

test("dropped-url store lets a late subscriber pull the pending drop (same drop-race fix as the plan store)", () => {
  const store = buildDroppedUrlStore();

  // No drop yet: a window that opens first sees nothing.
  expect(store.get()).toBeUndefined();

  // main stores the url the instant a drop lands, before a fresh chat window's renderer has
  // mounted and subscribed — the exact timing that silently dropped the push message.
  store.set("/Users/x/photo.png");

  // The renderer mounts later and pulls it: no race, it's there.
  expect(store.get()).toBe("/Users/x/photo.png");
  // Consumed once so a later reopen can't replay a stale drop.
  expect(store.get()).toBeUndefined();
});

test("chat-prompt store lets a late-mounting chat window pull the pending prompt (same race fix)", () => {
  const store = buildChatPromptStore();
  expect(store.get()).toBeUndefined();
  store.set({ prompt: "## Skill\nsummarize…", label: "summarize" });
  expect(store.get()).toEqual({ prompt: "## Skill\nsummarize…", label: "summarize" });
  // Consumed once so a reopened chat can't replay a stale run.
  expect(store.get()).toBeUndefined();
});

test("models handler returns only models the enabled CLIs offer", () => {
  const handler = buildModelsHandler({
    getAvailableClis: () => ["claude"],
    getCliModels: () => [
      { provider: "claude", models: ["sonnet", "opus", "haiku"] },
      { provider: "opencode", models: ["gpt-5-5"] },
    ],
  });
  const models = handler();
  expect(models.find((m) => m.id === "sonnet")?.availableOn).toEqual(["claude"]);
  expect(models.find((m) => m.id === "gpt-5-5")).toBeUndefined();
});

test("model memory handlers get/set through the injected store fns against the configured file", async () => {
  const store: Record<string, string> = {};
  const handlers = buildModelMemoryHandlers({
    loadModelMemory: async (file) => { expect(file).toBe("/b/model-memory.json"); return { ...store }; },
    saveModelMemory: async (file, next) => { expect(file).toBe("/b/model-memory.json"); Object.assign(store, next); },
    modelMemoryFile: "/b/model-memory.json",
  });
  expect(await handlers.get("summarize")).toBeUndefined();
  await handlers.set("summarize", "sonnet-4-5");
  expect(await handlers.get("summarize")).toBe("sonnet-4-5");
});

test("concurrent model memory sets on different keys both persist", async () => {
  let disk: Record<string, string> = { keep: "x" };
  const handlers = buildModelMemoryHandlers({
    // Async load/save with a gap between them: unserialized, the second set reads before the first saves.
    loadModelMemory: async () => { await new Promise((r) => setTimeout(r, 5)); return { ...disk }; },
    saveModelMemory: async (_f, next) => { await new Promise((r) => setTimeout(r, 5)); disk = { ...next }; },
    modelMemoryFile: "/b/model-memory.json",
  });
  await Promise.all([handlers.set("live:model:claude", "opus"), handlers.set("desktop:live:project:claude", "/p")]);
  expect(disk).toEqual({ keep: "x", "live:model:claude": "opus", "desktop:live:project:claude": "/p" });
});

test("a failed model memory set doesn't block the next one", async () => {
  let disk: Record<string, string> = {};
  let fail = true;
  const handlers = buildModelMemoryHandlers({
    loadModelMemory: async () => ({ ...disk }),
    saveModelMemory: async (_f, next) => { if (fail) { fail = false; throw new Error("disk full"); } disk = { ...next }; },
    modelMemoryFile: "/b/model-memory.json",
  });
  await expect(handlers.set("a", "1")).rejects.toThrow("disk full");
  await handlers.set("b", "2");
  expect(disk).toEqual({ b: "2" });
});

test("launch handler with a real projectPath fires synchronously (no scratch-workspace detour)", () => {
  const child = fakeChild();
  const spawnLaunch = vi.fn<LaunchSpawnFn>(() => child as never);
  const handler = buildLaunchHandler({ spawnLaunch });

  handler({ mode: "opencode", projectPath: "/dev/acme", prompt: "go" });

  // Synchronous: no awaited microtask needed before the spawn happens.
  expect(spawnLaunch).toHaveBeenCalledWith("open", expect.anything());
});

test("launch handler rejects a stale request for a disabled CLI", () => {
  const child = fakeChild();
  const spawnLaunch = vi.fn<LaunchSpawnFn>(() => child as never);
  const onLaunchError = vi.fn();
  const handler = buildLaunchHandler({
    spawnLaunch,
    onLaunchError,
    getAvailableClis: () => ["claude"],
    getCliModels: () => [
      { provider: "claude", models: ["sonnet"] },
      { provider: "codex", models: ["gpt-5.6-sol"] },
    ],
  });

  handler({ mode: "codex", projectPath: "/dev/acme", prompt: "go", model: "gpt-5.6-sol" });

  expect(spawnLaunch).not.toHaveBeenCalled();
  expect(onLaunchError).toHaveBeenCalledWith(
    expect.objectContaining({ mode: "codex" }),
    expect.objectContaining({ message: expect.stringContaining("disabled") }),
  );
});

test("launch handler normalizes an unsupported model to one supported by the valid CLI", () => {
  const child = fakeChild();
  const spawnLaunch = vi.fn<LaunchSpawnFn>(() => child as never);
  const handler = buildLaunchHandler({
    spawnLaunch,
    getAvailableClis: () => ["claude"],
    getCliModels: () => [
      { provider: "claude", models: ["sonnet"] },
      { provider: "codex", models: ["gpt-5.6-sol"] },
    ],
  });

  handler({ mode: "claude", projectPath: "/dev/acme", prompt: "go", model: "gpt-5.6-sol" });

  const scriptPath = spawnLaunch.mock.calls[0]?.[1][0];
  expect(scriptPath).toEqual(expect.stringMatching(/bean-run-.*\.command$/));
  const script = readFileSync(scriptPath!, "utf8");
  expect(script).toContain("'--model' 'sonnet'");
  expect(script).not.toContain("gpt-5.6-sol");
});

test("launch handler keeps open mode available when every terminal CLI is disabled", () => {
  const child = fakeChild();
  const spawnLaunch = vi.fn<LaunchSpawnFn>(() => child as never);
  const handler = buildLaunchHandler({
    spawnLaunch,
    getEditorApp: () => "/Applications/Zed.app",
    getAvailableClis: () => [],
    getCliModels: () => [],
  });

  handler({ mode: "open", projectPath: "/p" });

  expect(spawnLaunch).toHaveBeenCalledWith("open", ["-a", "/Applications/Zed.app", "/p"]);
});

test("launch handler with no project resolves via a bare scratch dir before launching", async () => {
  const child = fakeChild();
  const spawnLaunch = vi.fn<LaunchSpawnFn>(() => child as never);
  const ensureDir = vi.fn(async () => {});
  const handler = buildLaunchHandler({ spawnLaunch, beanDirPath: "/b", ensureDir });

  handler({ mode: "opencode", projectPath: "", prompt: "go" });
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(ensureDir).toHaveBeenCalledWith("/b/workspace");
  // launchInTerminal writes a real .command script and opens it via `open` — same shape
  // launcher.test.ts already covers; here we're only proving the async resolution ran first.
  expect(spawnLaunch).toHaveBeenCalledWith("open", [expect.stringMatching(/bean-run-.*\.command$/)]);
});

test("buildPendingUpdateStore returns undefined until set, then the same value on repeated get (not consumed)", () => {
  const store = buildPendingUpdateStore();
  expect(store.get()).toBeUndefined();
  store.set("/tmp/bean-update-xyz/Bean.app");
  expect(store.get()).toBe("/tmp/bean-update-xyz/Bean.app");
  expect(store.get()).toBe("/tmp/bean-update-xyz/Bean.app");
});

test("buildUpdateHandlers.check strips extractedAppPath/URLs before returning to the renderer, and stores the path for install", async () => {
  const store = buildPendingUpdateStore();
  const handlers = buildUpdateHandlers({
    currentVersion: "0.8.12",
    isPackaged: true,
    checkAndDownloadUpdate: async () => ({
      result: { status: "available", version: "0.8.13", notes: "notes", zipUrl: "https://x/zip", sigUrl: "https://x/sig" },
      extractedAppPath: "/tmp/bean-update-xyz/Bean.app",
    }),
    installUpdate: async () => {},
    pendingUpdateStore: store,
    openReleasesPage: () => {},
    cleanupExtractedBundle: async () => {},
  });
  const status = await handlers.check();
  expect(status).toEqual({ status: "available", version: "0.8.13", notes: "notes" });
  expect(store.get()).toBe("/tmp/bean-update-xyz/Bean.app");
});

test("buildUpdateHandlers.check passes up-to-date/error results through unchanged", async () => {
  const handlers = buildUpdateHandlers({
    currentVersion: "0.8.12",
    isPackaged: true,
    checkAndDownloadUpdate: async () => ({ result: { status: "up-to-date" } }),
    installUpdate: async () => {},
    pendingUpdateStore: buildPendingUpdateStore(),
    openReleasesPage: () => {},
    cleanupExtractedBundle: async () => {},
  });
  expect(await handlers.check()).toEqual({ status: "up-to-date" });
});

test("buildUpdateHandlers.install errors when nothing has been checked/downloaded yet", async () => {
  const installed: string[] = [];
  const handlers = buildUpdateHandlers({
    currentVersion: "0.8.12",
    isPackaged: true,
    checkAndDownloadUpdate: async () => ({ result: { status: "up-to-date" } }),
    installUpdate: async (path: string) => { installed.push(path); },
    pendingUpdateStore: buildPendingUpdateStore(),
    openReleasesPage: () => {},
    cleanupExtractedBundle: async () => {},
  });
  expect(await handlers.install()).toEqual({
    status: "error",
    message: "No update is ready to install — check for updates again.",
  });
  expect(installed).toEqual([]);
});

test("buildUpdateHandlers.install calls installUpdate with the stored path", async () => {
  const installed: string[] = [];
  const store = buildPendingUpdateStore();
  const handlers = buildUpdateHandlers({
    currentVersion: "0.8.12",
    isPackaged: true,
    checkAndDownloadUpdate: async () => ({
      result: { status: "available", version: "0.8.13", notes: "notes", zipUrl: "https://x/zip", sigUrl: "https://x/sig" },
      extractedAppPath: "/tmp/bean-update-xyz/Bean.app",
    }),
    installUpdate: async (path: string) => { installed.push(path); },
    pendingUpdateStore: store,
    openReleasesPage: () => {},
    cleanupExtractedBundle: async () => {},
  });
  await handlers.check();
  const outcome = await handlers.install();
  expect(installed).toEqual(["/tmp/bean-update-xyz/Bean.app"]);
  expect(outcome).toBeUndefined();
});

test("buildUpdateHandlers.install surfaces an error from installUpdate instead of throwing", async () => {
  const store = buildPendingUpdateStore();
  store.set("/tmp/bean-update-xyz/Bean.app");
  const handlers = buildUpdateHandlers({
    currentVersion: "0.8.12",
    isPackaged: true,
    checkAndDownloadUpdate: async () => ({ result: { status: "up-to-date" } }),
    installUpdate: async () => { throw new Error("EACCES"); },
    pendingUpdateStore: store,
    openReleasesPage: () => {},
    cleanupExtractedBundle: async () => {},
  });
  expect(await handlers.install()).toEqual({ status: "error", message: "EACCES" });
});

test("buildUpdateHandlers.openReleasesPage delegates to the injected opener", () => {
  const opened: boolean[] = [];
  const handlers = buildUpdateHandlers({
    currentVersion: "0.8.12",
    isPackaged: true,
    checkAndDownloadUpdate: async () => ({ result: { status: "up-to-date" } }),
    installUpdate: async () => {},
    pendingUpdateStore: buildPendingUpdateStore(),
    openReleasesPage: () => { opened.push(true); },
    cleanupExtractedBundle: async () => {},
  });
  handlers.openReleasesPage();
  expect(opened).toEqual([true]);
});

test("buildUpdateHandlers.check refuses in a dev build without calling checkAndDownloadUpdate", async () => {
  const checked: string[] = [];
  const handlers = buildUpdateHandlers({
    currentVersion: "0.8.12",
    isPackaged: false,
    checkAndDownloadUpdate: async (v: string) => { checked.push(v); return { result: { status: "up-to-date" } }; },
    installUpdate: async () => {},
    pendingUpdateStore: buildPendingUpdateStore(),
    openReleasesPage: () => {},
    cleanupExtractedBundle: async () => {},
  });
  expect(await handlers.check()).toEqual({ status: "error", message: "Updates aren't available in a dev build." });
  expect(checked).toEqual([]);
});

test("buildUpdateHandlers.install refuses in a dev build without calling installUpdate, even with a pending path", async () => {
  const installed: string[] = [];
  const store = buildPendingUpdateStore();
  store.set("/tmp/bean-update-xyz/Bean.app");
  const handlers = buildUpdateHandlers({
    currentVersion: "0.8.12",
    isPackaged: false,
    checkAndDownloadUpdate: async () => ({ result: { status: "up-to-date" } }),
    installUpdate: async (path: string) => { installed.push(path); },
    pendingUpdateStore: store,
    openReleasesPage: () => {},
    cleanupExtractedBundle: async () => {},
  });
  expect(await handlers.install()).toEqual({ status: "error", message: "Updates aren't available in a dev build." });
  expect(installed).toEqual([]);
});

test("buildUpdateHandlers.check cleans up the previous extracted bundle when a second check supersedes it", async () => {
  const store = buildPendingUpdateStore();
  const cleanedUp: string[] = [];
  let call = 0;
  const handlers = buildUpdateHandlers({
    currentVersion: "0.8.12",
    isPackaged: true,
    checkAndDownloadUpdate: async () => {
      call += 1;
      return {
        result: { status: "available", version: `0.8.1${call + 2}`, notes: "notes", zipUrl: "https://x/zip", sigUrl: "https://x/sig" },
        extractedAppPath: `/tmp/bean-update-${call}/Bean.app`,
      };
    },
    installUpdate: async () => {},
    pendingUpdateStore: store,
    openReleasesPage: () => {},
    cleanupExtractedBundle: async (path: string) => { cleanedUp.push(path); },
  });

  await handlers.check();
  expect(cleanedUp).toEqual([]);

  await handlers.check();
  expect(cleanedUp).toEqual(["/tmp/bean-update-1/Bean.app"]);
  expect(store.get()).toBe("/tmp/bean-update-2/Bean.app");
});

test("buildUpdateHandlers.check does not clean up when the new result has no extracted bundle (up-to-date/error)", async () => {
  const store = buildPendingUpdateStore();
  store.set("/tmp/bean-update-1/Bean.app");
  const cleanedUp: string[] = [];
  const handlers = buildUpdateHandlers({
    currentVersion: "0.8.12",
    isPackaged: true,
    checkAndDownloadUpdate: async () => ({ result: { status: "up-to-date" } }),
    installUpdate: async () => {},
    pendingUpdateStore: store,
    openReleasesPage: () => {},
    cleanupExtractedBundle: async (path: string) => { cleanedUp.push(path); },
  });

  await handlers.check();
  expect(cleanedUp).toEqual([]);
  expect(store.get()).toBe("/tmp/bean-update-1/Bean.app");
});

// Dashboard deep links cross renderer → main (bubble click) and ride notification `meta`: both are
// validated before main acts on them.
describe("dashboard targets", () => {
  const at = "2026-10-23T06:00:00.000Z";
  test("keeps only a non-empty routine and an ISO startedAt; an invalid date rejects the target", () => {
    expect(parseDashboardTarget({ routine: "nightly", startedAt: at, extra: "x" })).toEqual({ routine: "nightly", startedAt: at });
    expect(parseDashboardTarget({ routine: "nightly" })).toEqual({ routine: "nightly" });
    expect(parseDashboardTarget({ routine: "nightly", startedAt: "yesterday" })).toBeUndefined();
    expect(parseDashboardTarget({ routine: "nightly", startedAt: "2026-13-45T99:99" })).toBeUndefined();
    expect(parseDashboardTarget({ routine: "nightly", startedAt: 0 })).toBeUndefined();
    expect(parseDashboardTarget({ routine: "" })).toBeUndefined();
    expect(parseDashboardTarget("nightly")).toBeUndefined();
    expect(parseDashboardTarget(null)).toBeUndefined();
  });

  test("openComponent payload pairs by kind: URL for chat, target for dashboard, else dropped", () => {
    expect(openComponentPayload("chat", "https://x.test")).toBe("https://x.test");
    expect(openComponentPayload("chat", { routine: "r" })).toBeUndefined();
    expect(openComponentPayload("dashboard", { routine: "r", startedAt: at })).toEqual({ routine: "r", startedAt: at });
    expect(openComponentPayload("dashboard", "https://x.test")).toBeUndefined();
    expect(openComponentPayload("routines", { routine: "r" })).toBeUndefined();
  });

  test("openComponent chat payload accepts avatar-dropped images, rejects malformed ones", () => {
    const img = { path: "/tmp/a.png", mimeType: "image/png", size: 3, data: "AAAA" };
    // data must be exactly `size` bytes of base64, so a lied-about size can't dodge the 10 MB guard.
    expect(openComponentPayload("chat", [{ ...img, size: 0 }])).toBeUndefined();
    expect(openComponentPayload("chat", [{ ...img, data: "AAAAAAAA" }])).toBeUndefined();
    expect(openComponentPayload("chat", [{ ...img, size: -1, data: undefined }])).toBeUndefined();
    const unread = { path: "/tmp/b.gif", mimeType: "image/gif", size: 3 };
    expect(openComponentPayload("chat", [img, unread])).toEqual([img, unread]);
    expect(openComponentPayload("chat", [])).toBeUndefined();
    expect(openComponentPayload("chat", [{ ...img, size: "3" }])).toBeUndefined();
    expect(openComponentPayload("chat", [{ ...img, data: 1 }])).toBeUndefined();
    expect(openComponentPayload("dashboard", [img])).toBeUndefined();
  });

  test("a notification click opens the run, the Routines panel, or Chat", () => {
    expect(notificationOpens({ open: "dashboard", target: { routine: "r", startedAt: at } })).toEqual({ kind: "dashboard", target: { routine: "r", startedAt: at } });
    expect(notificationOpens({ open: "dashboard", target: { routine: 1 } })).toEqual({ kind: "dashboard" });
    expect(notificationOpens({ open: "routines" })).toEqual({ kind: "routines" });
    expect(notificationOpens(undefined)).toEqual({ kind: "chat" });
  });
});

test("chat handler validates documents before converse: a real PDF reaches it, a spoofed or oversize one is refused", async () => {
  let sawFile: string | undefined;
  let calls = 0;
  const handler = buildChatHandler({
    loadSkills: async () => [],
    loadProjects: async () => [],
    loadPersona: async () => ({ name: "Bean", tags: [] }) as Persona,
    converse: async ({ messages }) => {
      calls += 1;
      for (const m of messages) {
        if (m.role === "user" && Array.isArray(m.content)) {
          for (const p of m.content) if (p.type === "file") sawFile = p.file.filename;
        }
      }
      return { content: "ok", toolCalls: [] };
    },
    getModel: () => "m",
    projectSkillsDir: "/b/project-skills",
    skillsDir: "/b/skills",
    projectsFile: "/b/projects.json",
    personaFile: "/b/persona.json",
    projectPersonaFile: "/b/project-persona.json",
    loadMemories: async () => [],
    dbFile: "/b/memory.json",
  });
  const pdf = Buffer.from("%PDF-1.4\n%%EOF").toString("base64");
  await handler({ history: [], message: "summarise", documents: [{ data: pdf, filename: "a.pdf" }] });
  expect(sawFile).toBe("a.pdf");
  const spoofed = Buffer.from("not a pdf at all").toString("base64");
  await expect(handler({ history: [], message: "x", documents: [{ data: spoofed, filename: "b.pdf" }] })).rejects.toThrow(/not a PDF/);
  await expect(handler({ history: [], message: "x", documents: [{ data: "A".repeat(14_000_000), filename: "c.pdf" }] })).rejects.toThrow(/10 MB/);
  expect(calls).toBe(1);
});
