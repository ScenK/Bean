import { describe, expect, it, test, vi } from "vitest";
import {
  buildConfigHandlers, buildDeleteSkillHandler, buildListProjectsHandler, buildListSkillsHandler, buildPersonaHandlers,
  buildSaveProjectsHandler, buildSaveSkillHandler, buildTodoHandlers, type ConfigUpdate, type ConfigView,
} from "../src/index.js";
import type { Persona, Project, Skill } from "@bean/core";

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

test("config get handler returns the injected view", () => {
  const view: ConfigView = {
    openaiApiKey: "sk-x", model: "m", terminalApp: "", editorApp: "", delegateCli: "",
    systemControls: false, disabledClis: [],
    paths: { config: "/b/config.json", skills: "/b/skills", projects: "/b/projects.json", persona: "/b/persona.json" },
  };
  const handlers = buildConfigHandlers({ getConfig: () => view, applyConfig: async () => {} });
  expect(handlers.get()).toBe(view);
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
