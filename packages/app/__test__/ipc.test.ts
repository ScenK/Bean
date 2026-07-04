import { expect, test, vi } from "vitest";
import {
  buildRouteHandler, buildThemeHandlers, buildChatHandler,
  buildListSkillsHandler, buildListProjectsHandler, buildSaveProjectsHandler, buildSaveSkillHandler,
  buildDeleteSkillHandler,
  buildPersonaHandlers, buildLaunchHandler, buildConfigHandlers, buildPlanStore, buildMemoryHandlers,
  buildDroppedUrlStore, buildChatPromptStore, buildNotesHandlers,
} from "../src/ipc.js";
import type { ConfigView, ConfigUpdate } from "../src/channels.js";
import type { Project, RouteSuggestion, Skill, Persona, Memory, MemoryCandidate } from "@bean/core";
import type { LaunchSpawnFn } from "@bean/core";
import { EventEmitter } from "node:events";

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
    memoryFile: "/b/memory.json",
  });
  const out = await handler({ history: [], message: "review api", droppedUrl: undefined });
  expect(out.reply).toBe("on it");
  expect(out.model).toBe("m");
  expect(out.proposedRun?.projectPath).toBe("/work/api");
  expect(out.proposedRun?.composedPrompt).toContain("BODY");
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
      systemContent = messages[0]!.content;
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
    memoryFile: "/b/memory.json",
  });
  await handler({ history: [], message: "hi" });
  expect(systemContent).toContain("What you remember:");
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
    memoryFile: "/b/memory.json",
  });
  const out = await handler({
    history: [], message: "continue",
    linkedNote: { slug: "flaky", title: "Flaky tests", version: 3, body: "old note body" },
  });
  expect(systemContent).toContain('continues from the note "Flaky tests" (v3)');
  expect(out.proposedNote?.slug).toBe("flaky");
});

test("notes handlers pass the configured dir through to the injected store fns", async () => {
  const calls: unknown[][] = [];
  const handlers = buildNotesHandlers({
    loadNotes: async (dir) => { calls.push(["list", dir]); return []; },
    saveNote: async (dir, draft) => { calls.push(["save", dir, draft.title]); return "slug"; },
    deleteNote: async (dir, slug) => { calls.push(["delete", dir, slug]); },
    notesDir: "/b/notes",
  });
  await handlers.list();
  expect(await handlers.save({ title: "T", body: "B" })).toBe("slug");
  await handlers.delete("t");
  expect(calls).toEqual([["list", "/b/notes"], ["save", "/b/notes", "T"], ["delete", "/b/notes", "t"]]);
});

test("chat handler passes action tools through to converse and executes them", async () => {
  const ran: unknown[] = [];
  const handler = buildChatHandler({
    loadSkills: async () => [{ name: "review-code", description: "r", body: "BODY" }] as Skill[],
    loadProjects: async () => [{ name: "api", path: "/work/api" }] as Project[],
    loadPersona: async () => ({ name: "Bean", tags: ["Warm"] }) as Persona,
    converse: async ({ tools, messages }) => {
      if (messages.at(-1)!.content.startsWith("[tool result")) return { content: "done", toolCalls: [] };
      expect(tools.map((t) => t.name)).toContain("set_reminder");
      return { content: "", toolCalls: [{ name: "set_reminder", args: { text: "t", at: "now" } }] };
    },
    getModel: () => "m",
    projectSkillsDir: "/b/project-skills",
    skillsDir: "/b/skills",
    projectsFile: "/b/projects.json",
    personaFile: "/b/persona.json",
    projectPersonaFile: "/b/project-persona.json",
    loadMemories: async () => [],
    memoryFile: "/b/memory.json",
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
  expect(await handler()).toBe(skills);
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
    openaiApiKey: "sk-x", model: "m", terminalApp: "", editorApp: "",
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

test("memory handlers list, save, and extract through injected deps", async () => {
  let saved: unknown[] = [];
  const existing = [{ id: "1", text: "prefers pnpm", createdAt: "2026-07-03T00:00:00.000Z" }];
  const handlers = buildMemoryHandlers({
    loadMemories: async () => existing,
    saveMemories: async (_file, memories) => { saved = memories; },
    extractMemories: async (transcript, ex, projects) => {
      expect(ex).toEqual(existing);
      expect(projects).toEqual([{ name: "api", path: "/work/api" }]);
      return transcript.length ? [{ text: "new fact", projectPath: undefined }] : [];
    },
    loadProjects: async () => [{ name: "api", path: "/work/api" }],
    converse: async () => ({ content: "", toolCalls: [] }),
    getModel: () => "m",
    memoryFile: "/b/memory.json",
    projectsFile: "/b/projects.json",
  });

  expect(await handlers.list()).toEqual(existing);
  await handlers.save([{ id: "2", text: "x", createdAt: "2026-07-03T00:00:00.000Z" }]);
  expect(saved).toHaveLength(1);
  expect(await handlers.extract([{ role: "user", content: "hi" }])).toEqual([{ text: "new fact", projectPath: undefined }]);
});

test("config save handler forwards the update to applyConfig", async () => {
  const applied: ConfigUpdate[] = [];
  const handlers = buildConfigHandlers({
    getConfig: () => ({ openaiApiKey: "", model: "", terminalApp: "", editorApp: "", paths: { config: "", skills: "", projects: "", persona: "" } }),
    applyConfig: async (u) => { applied.push(u); },
  });
  await handlers.save({ openaiApiKey: "sk-new", model: "gpt-5", terminalApp: "/Applications/iTerm.app", editorApp: "/Applications/Zed.app" });
  expect(applied).toEqual([{ openaiApiKey: "sk-new", model: "gpt-5", terminalApp: "/Applications/iTerm.app", editorApp: "/Applications/Zed.app" }]);
});

test("chat-prompt store lets a late-mounting chat window pull the pending prompt (same race fix)", () => {
  const store = buildChatPromptStore();
  expect(store.get()).toBeUndefined();
  store.set({ prompt: "## Skill\nsummarize…", label: "summarize" });
  expect(store.get()).toEqual({ prompt: "## Skill\nsummarize…", label: "summarize" });
  // Consumed once so a reopened chat can't replay a stale run.
  expect(store.get()).toBeUndefined();
});
