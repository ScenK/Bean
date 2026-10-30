import { describe, expect, it, test, vi } from "vitest";
import {
  buildRouteHandler, buildThemeHandlers, buildChatHandler,
  buildListSkillsHandler, buildListProjectsHandler, buildSaveProjectsHandler, buildSaveSkillHandler,
  buildDeleteSkillHandler,
  buildPersonaHandlers, buildLaunchHandler, buildConfigHandlers, buildPlanStore, buildMemoryHandlers,
  buildDroppedUrlStore, buildChatPromptStore, buildNotesHandlers,
  buildModelsHandler, buildModelMemoryHandlers, buildRoutineHandlers,
  buildPendingUpdateStore, buildUpdateHandlers, buildTodoHandlers,
  parseDashboardTarget, openComponentPayload, notificationOpens,
} from "../src/ipc.js";
import type { ConfigView, ConfigUpdate } from "../src/channels.js";
import type { Project, RouteSuggestion, Skill, Persona, Memory, MemoryCandidate, Routine, ChatTurn } from "@bean/core";
import type { LaunchSpawnFn } from "@bean/core";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";

test("route handler wires core pieces together", async () => {
  const skills: Skill[] = [{ name: "review-code", description: "r", body: "BODY" }];
  const projects: Project[] = [{ name: "acme", path: "/dev/acme" }];
  const handler = buildRouteHandler({
    loadSkills: async () => skills,
    loadProjects: async () => projects,
    chat: async () => JSON.stringify({ skillName: "review-code", projectPath: "/dev/acme", confidence: 0.7 }),
    getModel: () => "m",
    projectSkillsDir: "/b/project-skills",
    skillsDir: "/b/skills",
    projectsFile: "/b/projects.json",
  });
  const out: RouteSuggestion = await handler({ userText: "go", droppedUrl: "u" });
  expect(out.skillName).toBe("review-code");
  expect(out.projectPath).toBe("/dev/acme");
  expect(out.composedPrompt).toContain("BODY");
});

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

test("chat handler offers the desktop hand-off only to a sender without a live session", async () => {
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
    liveSessionAvailable: (senderId) => senderId === 7,
  });
  await handler({ history: [], message: "build it" }, 7);
  expect(toolNames).toContain("propose_live_session");
  expect(description).toContain("hand this chat over");
  await handler({ history: [], message: "build it" }, 8);
  expect(toolNames).not.toContain("propose_live_session");
  await handler({ history: [], message: "build it" });
  expect(toolNames).not.toContain("propose_live_session");
});

test("chat handler forwards req.images to converse and runs generate_image into generatedImages", async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const imagesTmp = await mkdtemp(join(tmpdir(), "bean-imgs-"));
  let calls = 0;
  let sawImageParts = false;
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
    },
  });
  const out = await handler({ history: [], message: "draw a cat", images: [{ data: "AAAA", mimeType: "image/png" }] });
  expect(sawImageParts).toBe(true);
  expect(out.reply).toBe("done");
  expect(out.generatedImages).toHaveLength(1);
  expect(out.generatedImages![0]!.dataUrl).toBe(`data:image/png;base64,${b64}`);
  expect(out.generatedImages![0]!.path).toMatch(/a-cat\.png$/);
});

test("chat handler drops disabled skills and injects recalled memories", async () => {
  const skills: Skill[] = [
    { name: "review-code", description: "r", body: "BODY", enabled: true },
    { name: "hidden", description: "h", body: "H", enabled: false },
  ];
  const projects: Project[] = [{ name: "api", path: "/work/api" }];
  let systemContent = "";
  const handler = buildChatHandler({
    loadSkills: async () => skills,
    loadProjects: async () => projects,
    loadPersona: async () => ({ name: "Bean", tags: ["Warm"] }) as Persona,
    converse: async ({ messages, tools }) => {
      systemContent = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
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
    loadMemories: async () => [{ id: "1", text: "prefers pnpm", createdAt: "2026-07-03T00:00:00.000Z" }],
    dbFile: "/b/memory.json",
  });
  await handler({ history: [], message: "hi" });
  expect(systemContent).toContain("What you remember (saved facts");
  expect(systemContent).toContain("prefers pnpm");
});

test("chat handler passes the linked note through to converse (system prompt + proposal slug)", async () => {
  let systemContent = "";
  const handler = buildChatHandler({
    loadSkills: async () => [{ name: "review-code", description: "r", body: "BODY" }] as Skill[],
    loadProjects: async () => [{ name: "api", path: "/work/api" }] as Project[],
    loadPersona: async () => ({ name: "Bean", tags: ["Warm"] }) as Persona,
    converse: async ({ messages }) => {
      systemContent = messages[0]!.content;
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
  expect(systemContent).toContain('continues from the note "Flaky tests" (v3)');
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

test("note image handlers accept raw bytes only and serve stored rows as data: URLs", async () => {
  const stored: Uint8Array[] = [];
  const saves: { body: string }[] = [];
  const handlers = buildNotesHandlers({
    loadNotes: async () => [],
    saveNote: async (_f, draft) => { saves.push({ body: draft.body }); return "s"; },
    archiveNote: async () => true, restoreNote: async () => true, purgeNote: async () => true,
    starNote: async () => {},
    loadNoteHistory: async () => [],
    saveNoteImage: async (_f, bytes) => { stored.push(bytes); return "abcdef12-2222-4333-8444-555555555555"; },
    loadNoteImage: async (_f, id) => (id === "known" ? { mime: "image/png", bytes: Uint8Array.from([1, 2]) } : undefined),
    dbFile: "/b/bean.db",
  });
  await expect(handlers.saveImage("/Users/me/secret.png")).rejects.toThrow(/raw bytes/);
  await expect(handlers.saveImage({ path: "/etc/passwd" })).rejects.toThrow(/raw bytes/);
  await expect(handlers.saveImage(new Uint8Array(10 * 1024 * 1024 + 1))).rejects.toThrow(/10 MB/);
  expect(stored).toHaveLength(0);
  expect(await handlers.saveImage(Uint8Array.from([9]))).toMatch(/^abcdef12/);
  expect(await handlers.image("known")).toBe("data:image/png;base64,AQI=");
  expect(await handlers.image("missing")).toBeUndefined();
  expect(await handlers.image(42)).toBeUndefined();
  await handlers.save({ title: "T", body: "B" }, [{ data: "AQI=", mimeType: "image/png" }]);
  expect(saves[0]!.body).toBe("B\n\n![image](bean-image:abcdef12-2222-4333-8444-555555555555)\n");
});

test("notes save copies only known draft fields", async () => {
  const drafts: unknown[] = [];
  const handlers = buildNotesHandlers({
    loadNotes: async () => [], saveNote: async (_f, draft) => { drafts.push(draft); return "s"; },
    archiveNote: async () => true, restoreNote: async () => true, purgeNote: async () => true,
    starNote: async () => {}, loadNoteHistory: async () => [],
    saveNoteImage: async () => "x", loadNoteImage: async () => undefined, dbFile: "/b/bean.db",
  });
  await handlers.save({ title: "T", body: "B", slug: "s1", project: "/p", source: "manual", archivedAt: "x", upsert: true } as never);
  expect(drafts).toEqual([{ title: "T", body: "B", slug: "s1", project: "/p", source: "manual" }]);
});

test("notes handlers pass the configured dir through to the injected store fns", async () => {
  const calls: unknown[][] = [];
  let purged = true;
  const handlers = buildNotesHandlers({
    loadNotes: async (dir, opts) => { calls.push(["list", dir, opts]); return []; },
    saveNote: async (dir, draft) => { calls.push(["save", dir, draft.title]); return "slug"; },
    archiveNote: async (dir, slug) => { calls.push(["archive", dir, slug]); return true; },
    restoreNote: async (dir, slug) => { calls.push(["restore", dir, slug]); return true; },
    purgeNote: async (dir, slug) => { calls.push(["purge", dir, slug]); return purged; },
    loadNoteHistory: async (dir, slug) => { calls.push(["history", dir, slug]); return []; },
    dbFile: "/b/notes",
  });
  await handlers.list();
  await handlers.list({ includeArchived: "yes" });
  await handlers.list({ includeArchived: true });
  expect(await handlers.save({ title: "T", body: "B" })).toBe("slug");
  await handlers.archive("t");
  await handlers.restore("t");
  await handlers.purge("t");
  await handlers.history("t");
  expect(calls).toEqual([
    ["list", "/b/notes", { includeArchived: false }], ["list", "/b/notes", { includeArchived: false }],
    ["list", "/b/notes", { includeArchived: true }], ["save", "/b/notes", "T"], ["archive", "/b/notes", "t"],
    ["restore", "/b/notes", "t"], ["purge", "/b/notes", "t"], ["history", "/b/notes", "t"],
  ]);
  // Slugs cross IPC untyped: non-strings never reach core, and a refused purge surfaces.
  await expect(handlers.restore(42)).rejects.toThrow(/invalid note slug/);
  await expect(handlers.purge(undefined)).rejects.toThrow(/invalid note slug/);
  purged = false;
  await expect(handlers.purge("live")).rejects.toThrow(/archived/);
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

test("listSkills handler loads skills from both the project and user skills dirs", async () => {
  const skills: Skill[] = [{ name: "review-code", description: "r", body: "BODY" }];
  const handler = buildListSkillsHandler({
    loadSkills: async (projectDir, userDir) => {
      expect(projectDir).toBe("/b/project-skills");
      expect(userDir).toBe("/b/skills");
      return skills;
    },
    projectSkillsDir: "/b/project-skills",
    skillsDir: "/b/skills",
  });
  expect(await handler()).toEqual(skills);
});

test("listSkills handler filters out hidden skills", async () => {
  const visible: Skill = { name: "review-code", description: "r", body: "BODY" };
  const hidden: Skill = { name: "bean", description: "intro", body: "BODY", hidden: true };
  const handler = buildListSkillsHandler({
    loadSkills: async () => [visible, hidden],
    projectSkillsDir: "/b/project-skills",
    skillsDir: "/b/skills",
  });
  expect(await handler()).toEqual([visible]);
});

test("listProjects handler loads projects from the configured projects file", async () => {
  const projects: Project[] = [{ name: "api", path: "/work/api" }];
  const handler = buildListProjectsHandler({
    loadProjects: async (file) => { expect(file).toBe("/b/projects.json"); return projects; },
    projectsFile: "/b/projects.json",
  });
  expect(await handler()).toBe(projects);
});

test("saveProjects handler writes through the injected deps with the configured projects file", async () => {
  const projects: Project[] = [{ name: "api", path: "/work/api" }];
  const saveProjects = vi.fn(async () => {});
  const handler = buildSaveProjectsHandler({ saveProjects, projectsFile: "/b/projects.json" });
  await handler(projects);
  expect(saveProjects).toHaveBeenCalledWith("/b/projects.json", projects);
});

test("saveSkill handler writes through the injected deps with the configured skills dir", async () => {
  const saveSkill = vi.fn(async () => {});
  const handler = buildSaveSkillHandler({ saveSkill, skillsDir: "/b/skills" });
  await handler("review-code", "new body");
  expect(saveSkill).toHaveBeenCalledWith("/b/skills", "review-code", "new body");
});

test("deleteSkill handler deletes through the injected deps with the configured skills dir", async () => {
  const deleteSkill = vi.fn(async () => {});
  const handler = buildDeleteSkillHandler({ deleteSkill, skillsDir: "/b/skills" });
  await handler("review-code");
  expect(deleteSkill).toHaveBeenCalledWith("/b/skills", "review-code");
});

test("getPersona handler loads persona from the user file, falling back to the project file", async () => {
  const persona: Persona = { name: "Bean", tags: ["Warm"] };
  const handlers = buildPersonaHandlers({
    loadPersona: async (userFile, projectFile) => {
      expect(userFile).toBe("/b/persona.json");
      expect(projectFile).toBe("/b/project-persona.json");
      return persona;
    },
    savePersona: async () => {},
    personaFile: "/b/persona.json",
    projectPersonaFile: "/b/project-persona.json",
  });
  expect(await handlers.get()).toBe(persona);
});

test("savePersona handler writes through the injected deps with the configured persona file", async () => {
  const persona: Persona = { name: "Bean", tags: ["Warm"] };
  const savePersona = vi.fn(async () => {});
  const handlers = buildPersonaHandlers({
    loadPersona: async () => persona,
    savePersona,
    personaFile: "/b/persona.json",
    projectPersonaFile: "/b/project-persona.json",
  });
  await handlers.save(persona);
  expect(savePersona).toHaveBeenCalledWith("/b/persona.json", persona);
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

test("config get handler returns the injected view", () => {
  const view: ConfigView = {
    openaiApiKey: "sk-x", model: "m", terminalApp: "", editorApp: "", delegateCli: "",
    systemControls: false, disabledClis: [],
    paths: { config: "/b/config.json", skills: "/b/skills", projects: "/b/projects.json", persona: "/b/persona.json" },
  };
  const handlers = buildConfigHandlers({ getConfig: () => view, applyConfig: async () => {} });
  expect(handlers.get()).toBe(view);
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

function memoryHandlersFor(over: Partial<Parameters<typeof buildMemoryHandlers>[0]> = {}) {
  const appended: Memory[][] = [];
  const deleted: string[][] = [];
  const batches: Memory[][] = [];
  let failures = 0;
  const existing: Memory[] = [{ id: "1", text: "prefers pnpm", createdAt: "2026-07-03T00:00:00.000Z" }];
  const handlers = buildMemoryHandlers({
    loadMemories: async () => existing,
    appendMemories: async (_file, additions) => { appended.push(additions); },
    updateMemory: async () => {},
    deleteMemories: async (_file, ids) => { deleted.push(ids); return ids.length; },
    extractMemories: async (transcript, ex, projects) => {
      expect(ex).toEqual(existing);
      expect(projects).toEqual([{ name: "api", path: "/work/api" }]);
      return { candidates: transcript.length ? [{ text: "new fact", projectPath: undefined }] : [], rejected: 0, failed: false };
    },
    loadProjects: async () => [{ name: "api", path: "/work/api" }],
    converse: async () => ({ content: "", toolCalls: [] }),
    getModel: () => "m",
    autoMemory: () => true,
    onMemoryBatch: (b) => { batches.push(b); },
    onMemoryFailure: () => { failures++; },
    getLastDream: async () => undefined,
    restoreDreamRun: async () => ({ restored: 0, skipped: 0 }),
    dreamDetails: async () => [],
    dbFile: "/b/bean.db",
    projectsFile: "/b/projects.json",
    ...over,
  });
  return { handlers, appended, deleted, batches, existing, failures: () => failures };
}

const typed: ChatTurn[] = [{ role: "user", content: "I prefer pnpm", source: "typed" }];

test("rememberOnClose extracts and appends in the background, then Undo deletes exactly that batch", async () => {
  const { handlers, appended, deleted, batches } = memoryHandlersFor();
  const batch = await handlers.rememberOnClose(typed, {});
  expect(batch.map((m) => m.text)).toEqual(["new fact"]);
  expect(appended).toEqual([batch]);
  expect(batches).toEqual([batch]);
  expect(handlers.batch()?.ids).toEqual(batch.map((m) => m.id));
  expect(await handlers.undoBatch()).toBe(1);
  expect(deleted).toEqual([batch.map((m) => m.id)]);
  expect(handlers.batch()).toBeUndefined();
  expect(await handlers.undoBatch()).toBe(0);
});

test("an incognito chat writes nothing and never calls extraction", async () => {
  let extracted = false;
  const { handlers, appended, batches, failures } = memoryHandlersFor({ extractMemories: async () => { extracted = true; return { candidates: [], rejected: 0, failed: true }; } });
  expect(await handlers.rememberOnClose(typed, { incognito: true })).toEqual([]);
  expect(extracted).toBe(false);
  expect(appended).toEqual([]);
  expect(batches).toEqual([]);
  expect(failures()).toBe(0);
});

test("autoMemory off means no background extraction", async () => {
  let extracted = false;
  const { handlers, appended, batches, failures } = memoryHandlersFor({ autoMemory: () => false, extractMemories: async () => { extracted = true; return { candidates: [], rejected: 0, failed: true }; } });
  expect(await handlers.rememberOnClose(typed, {})).toEqual([]);
  expect(extracted).toBe(false);
  expect(appended).toEqual([]);
  expect(batches).toEqual([]);
  expect(failures()).toBe(0);
});

test("Undo last dream restores the recorded run once; an undone or absent run is a no-op", async () => {
  const restored: string[] = [];
  let digest: { runId: string; at: string; merged: number; rewritten: number; removed: number; undone?: boolean } | undefined =
    { runId: "r1", at: "2026-09-01T00:00:00.000Z", merged: 1, rewritten: 0, removed: 2 };
  const { handlers } = memoryHandlersFor({
    getLastDream: async () => digest,
    restoreDreamRun: async (_f, runId) => { restored.push(runId); return { restored: 2, skipped: 1 }; },
  });
  expect(await handlers.undoLastDream()).toEqual({ restored: 2, skipped: 1 });
  digest = { ...digest!, undone: true };
  expect(await handlers.undoLastDream()).toEqual({ restored: 0, skipped: 0 });
  digest = undefined;
  expect(await handlers.undoLastDream()).toEqual({ restored: 0, skipped: 0 });
  expect(restored).toEqual(["r1"]);
});

test("no candidates means no batch and no bubble", async () => {
  const { handlers, batches, failures } = memoryHandlersFor({ extractMemories: async () => ({ candidates: [], rejected: 2, failed: false }) });
  expect(await handlers.rememberOnClose(typed, {})).toEqual([]);
  expect(batches).toEqual([]);
  expect(failures()).toBe(0);
  expect(handlers.batch()).toBeUndefined();
});

test("a failed extraction model call raises exactly one failure bubble", async () => {
  const { handlers, appended, batches, failures } = memoryHandlersFor({ extractMemories: async () => ({ candidates: [], rejected: 0, failed: true }) });
  await expect(handlers.rememberOnClose(typed, {})).rejects.toThrow(/extraction/);
  expect(failures()).toBe(1);
  expect(appended).toEqual([]);
  expect(batches).toEqual([]);
});

test("a store failure raises exactly one failure bubble and leaves no Undo batch", async () => {
  const { handlers, batches, failures } = memoryHandlersFor({ appendMemories: async () => { throw new Error("SQLITE_BUSY"); } });
  await expect(handlers.rememberOnClose(typed, {})).rejects.toThrow("SQLITE_BUSY");
  expect(failures()).toBe(1);
  expect(batches).toEqual([]);
  expect(handlers.batch()).toBeUndefined();
});

const turnReq = { history: [], message: "I live in Seattle", source: "typed" as const, turnId: "item-1" };
const reply = { reply: "Nice!" };

test("captureTurn saves only the latest typed turn, after the reply, and close catch-up skips it", async () => {
  const calls: { transcript: ChatTurn[]; opts?: { latestTurn?: boolean } }[] = [];
  const turnBatches: string[][] = [];
  const { handlers, appended, batches } = memoryHandlersFor({
    extractMemories: async (transcript, _ex, _p, _d, opts) => {
      calls.push({ transcript, opts });
      return { candidates: transcript.some((t) => t.source === "typed") ? [{ text: "Lives in Seattle" }] : [], rejected: 0, failed: false };
    },
    onTurnBatch: (pendingIds) => { turnBatches.push(pendingIds()); },
  });
  const saved = await handlers.captureTurn(7, turnReq, reply);
  expect(saved.map((m) => m.text)).toEqual(["Lives in Seattle"]);
  expect(calls[0]).toEqual({ transcript: [{ role: "user", content: "I live in Seattle", source: "typed" }], opts: { latestTurn: true } });
  expect(appended).toEqual([saved]);
  // Dream sees the still-undoable per-turn ids as pending.
  expect(turnBatches).toEqual([saved.map((m) => m.id)]);
  expect(batches).toEqual([]); // no avatar bubble — the chat row is the receipt

  // Close: the captured turn is context only, so nothing is citable and nothing is re-saved.
  expect(await handlers.rememberOnClose([{ role: "user", content: "I live in Seattle", source: "typed", id: "item-1" }], { windowId: 7 })).toEqual([]);
  expect(calls[1]?.transcript).toEqual([{ role: "user", content: "I live in Seattle", source: undefined }]);
  // An uncaptured turn (another id) is still caught up.
  expect(await handlers.rememberOnClose([{ role: "user", content: "I use vim", source: "typed", id: "item-9" }], { windowId: 7 })).toHaveLength(1);
});

test("captureTurn skips incognito, autoMemory off, non-typed, errored, and explicit-remember turns", async () => {
  let extracted = 0;
  const count = { extractMemories: async () => { extracted++; return { candidates: [], rejected: 0, failed: false }; } };
  const { handlers } = memoryHandlersFor(count);
  expect(await handlers.captureTurn(1, { ...turnReq, incognito: true }, reply)).toEqual([]);
  expect(await handlers.captureTurn(1, { ...turnReq, source: "loopback" }, reply)).toEqual([]);
  expect(await handlers.captureTurn(1, turnReq, { reply: "", error: "boom" })).toEqual([]);
  expect(await handlers.captureTurn(1, turnReq, { reply: "ok", remembered: [{ id: "x", text: "Lives in Seattle", createdAt: "" }] })).toEqual([]);
  const off = memoryHandlersFor({ ...count, autoMemory: () => false });
  expect(await off.handlers.captureTurn(1, turnReq, reply)).toEqual([]);
  expect(extracted).toBe(0);
});

test("a failed per-turn capture is retried by close catch-up and raises no bubble itself", async () => {
  let fail = true;
  const { handlers, failures } = memoryHandlersFor({
    extractMemories: async (transcript) => (fail
      ? { candidates: [], rejected: 0, failed: true }
      : { candidates: transcript.some((t) => t.source === "typed") ? [{ text: "Lives in Seattle" }] : [], rejected: 0, failed: false }),
  });
  await expect(handlers.captureTurn(3, turnReq, reply)).rejects.toThrow(/extraction/);
  expect(failures()).toBe(0);
  fail = false;
  expect(await handlers.rememberOnClose([{ role: "user", content: "I live in Seattle", source: "typed", id: "item-1" }], { windowId: 3 })).toHaveLength(1);
});

function deferredExtract() {
  const pending: Array<{ text: string; resolve: () => void }> = [];
  const extractMemories = (_t: ChatTurn[]) => new Promise<{ candidates: { text: string }[]; rejected: number; failed: boolean }>((resolve) => {
    const text = _t[_t.length - 1]!.content;
    pending.push({ text, resolve: () => resolve({ candidates: [{ text }], rejected: 0, failed: false }) });
  });
  return { pending, extractMemories };
}

test("switching the chip on while a capture is in flight saves nothing", async () => {
  const d = deferredExtract();
  const { handlers, appended } = memoryHandlersFor({ extractMemories: d.extractMemories });
  const capture = handlers.captureTurn(4, turnReq, reply);
  await new Promise((r) => setTimeout(r, 0));
  handlers.setIncognito(4, true);
  d.pending[0]!.resolve();
  expect(await capture).toEqual([]);
  expect(appended).toEqual([]);
  // And later turns in that window are never sent to the model.
  expect(await handlers.captureTurn(4, { ...turnReq, turnId: "item-3" }, reply)).toEqual([]);
  expect(d.pending).toHaveLength(1);
});

test("isIncognito reports each window's live chip (delegate starts read it)", () => {
  const { handlers } = memoryHandlersFor({});
  expect(handlers.isIncognito(5)).toBe(false);
  handlers.setIncognito(5, true);
  expect(handlers.isIncognito(5)).toBe(true);
  expect(handlers.isIncognito(6)).toBe(false);
  handlers.setIncognito(5, false);
  expect(handlers.isIncognito(5)).toBe(false);
});

test("a reply that settles after its window closed is never captured (close already covered it)", async () => {
  let extracted = 0;
  const { handlers, appended } = memoryHandlersFor({
    extractMemories: async () => { extracted++; return { candidates: [], rejected: 0, failed: false }; },
  });
  handlers.setIncognito(8, true);
  // Closed incognito: catch-up writes nothing...
  expect(await handlers.rememberOnClose([{ role: "user", content: "I live in Seattle", source: "typed", id: "item-1" }], { windowId: 8, incognito: true })).toEqual([]);
  // ...and the late capture (request flag snapshotted before the chip) doesn't revive the window.
  expect(await handlers.captureTurn(8, turnReq, reply)).toEqual([]);
  expect(extracted).toBe(0);
  expect(appended).toEqual([]);
});

test("closing incognito stops a capture already in flight, even if the chip IPC never arrived", async () => {
  const d = deferredExtract();
  const { handlers, appended } = memoryHandlersFor({ extractMemories: d.extractMemories });
  const capture = handlers.captureTurn(9, turnReq, reply);
  await new Promise((r) => setTimeout(r, 0));
  expect(await handlers.rememberOnClose([{ role: "user", content: "I live in Seattle", source: "typed", id: "item-1" }], { windowId: 9, incognito: true })).toEqual([]);
  d.pending[0]!.resolve();
  expect(await capture).toEqual([]);
  expect(appended).toEqual([]);
});

test("captures in one window run in turn order, so a later fact is saved later", async () => {
  const d = deferredExtract();
  const { handlers, appended } = memoryHandlersFor({ extractMemories: d.extractMemories });
  const first = handlers.captureTurn(5, turnReq, reply);
  const second = handlers.captureTurn(5, { ...turnReq, message: "I live in Portland now", turnId: "item-3" }, reply);
  await new Promise((r) => setTimeout(r, 0));
  expect(d.pending.map((p) => p.text)).toEqual(["I live in Seattle"]); // second waits its turn
  d.pending[0]!.resolve();
  await first;
  await new Promise((r) => setTimeout(r, 0));
  d.pending[1]!.resolve();
  await second;
  expect(appended.map((b) => b[0]!.text)).toEqual(["I live in Seattle", "I live in Portland now"]);
});

test("a capture that fails after its window closed raises the failure bubble (catch-up skipped it)", async () => {
  let fail!: () => void;
  const { handlers, failures } = memoryHandlersFor({
    extractMemories: (transcript) => (transcript.some((t) => t.source === "typed") && transcript.length === 1
      ? new Promise((resolve) => { fail = () => resolve({ candidates: [], rejected: 0, failed: true }); })
      : Promise.resolve({ candidates: [], rejected: 0, failed: false })),
  });
  const capture = handlers.captureTurn(6, turnReq, reply);
  await new Promise((r) => setTimeout(r, 0));
  await handlers.rememberOnClose([{ role: "user", content: "I live in Seattle", source: "typed", id: "item-1" }, { role: "assistant", content: "Nice!" }], { windowId: 6 });
  fail();
  await expect(capture).rejects.toThrow(/extraction/);
  expect(failures()).toBe(1);
});

test("facts undone in the window reach close catch-up as already remembered", async () => {
  let seen: Memory[] = [];
  const { handlers, existing } = memoryHandlersFor({
    extractMemories: async (_t, ex) => { seen = ex; return { candidates: [], rejected: 0, failed: false }; },
  });
  await handlers.rememberOnClose(typed, { rejected: ["Lives in Seattle"] });
  expect(seen.map((m) => m.text)).toEqual([...existing.map((m) => m.text), "Lives in Seattle"]);
});

test("config save handler forwards the update to applyConfig", async () => {
  const applied: ConfigUpdate[] = [];
  const notifications: string[] = [];
  const handlers = buildConfigHandlers({
    getConfig: () => ({ openaiApiKey: "", model: "", terminalApp: "", editorApp: "", delegateCli: "", systemControls: false, disabledClis: [], paths: { config: "", skills: "", projects: "", persona: "" } }),
    applyConfig: async (u) => { applied.push(u); },
    onApplied: () => { notifications.push("cli-availability-changed"); },
  });
  await handlers.save({ openaiApiKey: "sk-new", model: "gpt-5", terminalApp: "/Applications/iTerm.app", editorApp: "/Applications/Zed.app", delegateCli: "claude", systemControls: false, disabledClis: ["codex"] });
  expect(applied).toEqual([{ openaiApiKey: "sk-new", model: "gpt-5", terminalApp: "/Applications/iTerm.app", editorApp: "/Applications/Zed.app", delegateCli: "claude", systemControls: false, disabledClis: ["codex"] }]);
  expect(notifications).toEqual(["cli-availability-changed"]);
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

const routine: Routine = {
  name: "r", enabled: true, cron: "0 6 * * *",
  steps: [{ kind: "chat", instruction: "x" }], sinks: {},
};

test("routine handlers merge in-memory running state into the state view", async () => {
  const h = buildRoutineHandlers({
    loadRoutines: async () => [routine],
    saveRoutine: vi.fn(async () => {}),
    deleteRoutine: vi.fn(async () => {}),
    loadStates: async () => ({ r: { lastRun: "2026-07-12T06:30:00.000Z", history: [] } }),
    isRunning: (name) => name === "r",
    runningCount: () => 1,
    runNow: async () => ({ started: true }),
  });
  const state = await h.state();
  expect(state.r).toMatchObject({ lastRun: "2026-07-12T06:30:00.000Z", running: true, runningCount: 1 });
  expect(state.r?.queue).toBeUndefined(); // not todo-driven
});

test("routine state fills the queue for every todo-driven sprout, cron included", async () => {
  const queueCounts = vi.fn(async () => ({ pending: 2, running: 3 }));
  const h = buildRoutineHandlers({
    loadRoutines: async () => [{ ...routine, todoDriven: true, maxParallel: 3 }],
    saveRoutine: vi.fn(async () => {}), deleteRoutine: vi.fn(async () => {}),
    loadStates: async () => ({}), isRunning: () => true, runningCount: () => 3, queueCounts,
    runNow: async () => ({ started: true }),
  });
  const state = await h.state();
  expect(state.r).toMatchObject({ running: true, runningCount: 3, queue: { pending: 2, running: 3 } });
  expect(queueCounts).toHaveBeenCalledWith("r");
});

test("routine handlers save delegates (validation is core saveRoutine's job); delete and runNow pass through", async () => {
  const saveRoutine = vi.fn(async () => {});
  const runNow = vi.fn(async () => ({ started: true }) as const);
  const h = buildRoutineHandlers({
    loadRoutines: async () => [], saveRoutine, deleteRoutine: vi.fn(async () => {}),
    loadStates: async () => ({}), isRunning: () => false, runningCount: () => 0, runNow,
  });
  await h.save(routine);
  expect(saveRoutine).toHaveBeenCalledWith(routine);
  // A rejection from the real (core) saveRoutine — e.g. an invalid-cron error — propagates
  // unchanged, so the renderer sees the specific reason rather than a generic message.
  saveRoutine.mockRejectedValueOnce(new Error(`cron schedule "bad" is not a valid 5-field cron expression`));
  await expect(h.save({ ...routine, cron: "bad" })).rejects.toThrow("is not a valid 5-field cron expression");
  await h.runNow("r");
  expect(runNow).toHaveBeenCalledWith("r");
});

it("buildRoutineHandlers.remove cascades to onRoutineDeleted", async () => {
  const deleted: string[] = [];
  const h = buildRoutineHandlers({
    loadRoutines: async () => [],
    saveRoutine: async () => {},
    deleteRoutine: async () => {},
    loadStates: async () => ({}),
    isRunning: () => false,
    runningCount: () => 0,
    runNow: async () => ({ started: true }),
    onRoutineDeleted: async (name) => { deleted.push(name); },
  });
  await h.remove("nightly");
  expect(deleted).toEqual(["nightly"]);
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

describe("buildTodoHandlers", () => {
  const routines = [
    { name: "nightly", enabled: true, cron: "0 2 * * *", todoDriven: true, steps: [{ kind: "chat" as const, instruction: "x" }], sinks: {} },
    { name: "plain", enabled: true, cron: "0 8 * * *", steps: [{ kind: "chat" as const, instruction: "x" }], sinks: {} },
  ];
  const makeDeps = () => {
    const added: { routine: string; text: string }[] = [];
    return {
      added,
      deps: {
        dbFile: "/tmp/unused.db",
        loadRoutines: async () => routines,
        addTodo: async (_f: string, routine: string, text: string) => {
          added.push({ routine, text });
          return { id: "1", routine, text, status: "pending" as const, createdAt: "", order: 1 };
        },
        listTodos: async () => [], listAllTodos: async () => [],
        editTodoText: async () => {}, deleteTodo: async () => {}, reorderTodo: async () => {},
        clearFinishedTodos: async () => {}, retryTodo: async () => {},
      },
    };
  };

  it("add inserts into a todo-driven routine's queue", async () => {
    const { deps, added } = makeDeps();
    const h = buildTodoHandlers(deps);
    await h.add("nightly", "do the thing");
    expect(added).toEqual([{ routine: "nightly", text: "do the thing" }]);
  });

  it("add rejects unknown and non-todo-driven routines", async () => {
    const { deps } = makeDeps();
    const h = buildTodoHandlers(deps);
    await expect(h.add("ghost", "x")).rejects.toThrow();
    await expect(h.add("plain", "x")).rejects.toThrow();
  });
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

  test("a notification click opens the run, the Routines panel, or Chat", () => {
    expect(notificationOpens({ open: "dashboard", target: { routine: "r", startedAt: at } })).toEqual({ kind: "dashboard", target: { routine: "r", startedAt: at } });
    expect(notificationOpens({ open: "dashboard", target: { routine: 1 } })).toEqual({ kind: "dashboard" });
    expect(notificationOpens({ open: "routines" })).toEqual({ kind: "routines" });
    expect(notificationOpens(undefined)).toEqual({ kind: "chat" });
  });
});
