import {
  getMindItem, listMindItems, resolveMindItem, undoMindItem, updatePulseState, type DismissReason, type MindItem,
  foldDefaultSkills, listSkillProposals, approveSkillProposal, rejectSkillProposal, undoSkillProposal, skillHash, resolveTodoRoutine, isArchived, skillUsage,
  type SkillProposal, type ProposalOutcome, type Project, type LegacyProject, type Skill, type Persona, type Routine, type TodoItem,
} from "@bean/core";

// The stateless handler builders: each one closes over its file paths and calls core. No Electron.

export interface ListSkillsHandlerDeps {
  loadSkills: (projectDir: string, userDir: string) => Promise<Skill[]>;
  projectSkillsDir: string;
  skillsDir: string;
  /** Saved sprouts, for each skill's `usedBy`; must throw when they can't be read (not `[]`). */
  loadRoutines?: () => Promise<Routine[]>;
}

export function buildListSkillsHandler(deps: ListSkillsHandlerDeps) {
  // `hidden: true` skills (e.g. the built-in self-intro skill) stay in converse()'s routing
  // catalog (buildChatHandler loads skills separately) but never reach any UI surface — every
  // renderer skill list/picker/quick-launch goes through this one IPC call.
  return async (): Promise<Skill[]> => {
    const skills = (await deps.loadSkills(deps.projectSkillsDir, deps.skillsDir)).filter((s) => !s.hidden);
    // Unreadable sprouts → no `usedBy` at all (unknown), never `[]` (would read as "unused").
    const routines = deps.loadRoutines ? await deps.loadRoutines().catch(() => undefined) : undefined;
    if (!routines) return skills;
    const usage = skillUsage(routines);
    const off = skillUsage(routines, true);
    return skills.map((s) => ({ ...s, usedBy: usage.get(s.name) ?? [], usedByOff: off.get(s.name) ?? [] }));
  };
}

export interface ListProjectsHandlerDeps {
  loadProjects: (file: string) => Promise<Project[]>;
  projectsFile: string;
}

export function buildListProjectsHandler(deps: ListProjectsHandlerDeps) {
  return (): Promise<Project[]> => deps.loadProjects(deps.projectsFile);
}

export interface SaveProjectsHandlerDeps {
  saveProjects: (file: string, projects: Project[]) => Promise<void>;
  loadSkills: (projectDir: string, userDir: string) => Promise<Skill[]>;
  projectsFile: string;
  projectSkillsDir: string;
  skillsDir: string;
}

export function buildSaveProjectsHandler(deps: SaveProjectsHandlerDeps) {
  // An older shell may still send the retired `defaultSkill`: fold it like a load does. Skill names
  // without a file (hidden and disabled count as files) are dropped — unless the catalog read came
  // back empty, which may be a failed read rather than no skills.
  return async (projects: LegacyProject[]): Promise<void> => {
    const known = new Set((await deps.loadSkills(deps.projectSkillsDir, deps.skillsDir)).map((s) => s.name));
    const next = foldDefaultSkills(projects).map((p) =>
      known.size > 0 && p.skills ? { ...p, skills: p.skills.filter((n) => known.has(n)) } : p);
    await deps.saveProjects(deps.projectsFile, next);
  };
}

export interface SaveSkillHandlerDeps {
  saveSkill: (dir: string, name: string, body: string, builtinDir?: string) => Promise<void>;
  skillsDir: string;
  projectSkillsDir: string;
}

export function buildSaveSkillHandler(deps: SaveSkillHandlerDeps) {
  // The built-in dir lets a toggle-only save (Skills panel enable/quick-launch) store just the flags.
  return (name: string, body: string): Promise<void> => deps.saveSkill(deps.skillsDir, name, body, deps.projectSkillsDir);
}

export interface DeleteSkillHandlerDeps {
  deleteSkill: (dir: string, name: string) => Promise<void>;
  skillsDir: string;
}

export function buildDeleteSkillHandler(deps: DeleteSkillHandlerDeps) {
  return (name: string): Promise<void> => deps.deleteSkill(deps.skillsDir, name);
}

/** A retro proposal as the Skills inbox shows it: the skill's current effective body to diff
 * against, and whether that body already moved past the one the proposal was drafted on. */
export interface SkillProposalView extends SkillProposal {
  current?: string;
  stale: boolean;
}

export interface SkillProposalHandlerDeps {
  loadSkills: (projectDir: string, userDir: string) => Promise<Skill[]>;
  projectSkillsDir: string;
  skillsDir: string;
  dbFile: string;
}

export function buildSkillProposalHandlers(deps: SkillProposalHandlerDeps) {
  const dirs = { projectDir: deps.projectSkillsDir, userDir: deps.skillsDir };
  return {
    list: async (): Promise<{ pending: SkillProposalView[]; applied: SkillProposalView[] }> => {
      const skills = await deps.loadSkills(deps.projectSkillsDir, deps.skillsDir);
      const view = (p: SkillProposal): SkillProposalView => {
        const current = skills.find((s) => s.name === p.skill)?.body;
        return { ...p, ...(current !== undefined ? { current } : {}), stale: current === undefined || skillHash(current) !== p.baseHash };
      };
      return { pending: listSkillProposals(deps.dbFile).map(view), applied: listSkillProposals(deps.dbFile, "applied").map(view) };
    },
    approve: (id: string): Promise<ProposalOutcome> => approveSkillProposal(deps.dbFile, dirs, id),
    reject: (id: string): Promise<ProposalOutcome> => rejectSkillProposal(deps.dbFile, id),
    undo: (id: string): Promise<ProposalOutcome> => undoSkillProposal(deps.dbFile, deps.skillsDir, id),
  };
}

export interface PersonaHandlerDeps {
  loadPersona: (userFile: string, projectFile: string) => Promise<Persona>;
  savePersona: (file: string, persona: Persona) => Promise<void>;
  personaFile: string;
  projectPersonaFile: string;
}

export function buildPersonaHandlers(deps: PersonaHandlerDeps) {
  return {
    get: (): Promise<Persona> => deps.loadPersona(deps.personaFile, deps.projectPersonaFile),
    save: (persona: Persona): Promise<void> => deps.savePersona(deps.personaFile, persona),
  };
}

export interface TodoHandlerDeps {
  dbFile: string;
  loadRoutines: () => Promise<Routine[]>;
  addTodo: (file: string, routine: string, text: string) => Promise<TodoItem>;
  listTodos: (file: string, routine: string) => Promise<TodoItem[]>;
  listAllTodos: (file: string) => Promise<TodoItem[]>;
  editTodoText: (file: string, id: string, text: string) => Promise<void>;
  deleteTodo: (file: string, id: string) => Promise<void>;
  reorderTodo: (file: string, id: string, newOrder: number) => Promise<void>;
  clearFinishedTodos: (file: string, routine: string) => Promise<void>;
  retryTodo: (file: string, id: string) => Promise<void>;
  /** The scheduler's per-sprout lane (#980): a retry is admitted against the current definition. */
  withSprout?: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
}

export function buildTodoHandlers(deps: TodoHandlerDeps) {
  return {
    list: (routine: string): Promise<TodoItem[]> => deps.listTodos(deps.dbFile, routine),
    listAll: (): Promise<TodoItem[]> => deps.listAllTodos(deps.dbFile),
    // Routine existence/type is enforced here, not in the store (store stays dumb, per spec).
    add: async (routine: string, text: string): Promise<TodoItem> => {
      resolveTodoRoutine(await deps.loadRoutines(), routine);
      return deps.addTodo(deps.dbFile, routine, text);
    },
    edit: (id: string, text: string): Promise<void> => deps.editTodoText(deps.dbFile, id, text),
    remove: (id: string): Promise<void> => deps.deleteTodo(deps.dbFile, id),
    reorder: (id: string, newOrder: number): Promise<void> => deps.reorderTodo(deps.dbFile, id, newOrder),
    clearFinished: (routine: string): Promise<void> => deps.clearFinishedTodos(deps.dbFile, routine),
    retry: async (id: string): Promise<void> => {
      const todo = (await deps.listAllTodos(deps.dbFile)).find((t) => t.id === id);
      if (!todo) return deps.retryTodo(deps.dbFile, id);
      const lane = deps.withSprout ?? ((_: string, fn: () => Promise<void>) => fn());
      // Same admission rule as add, in the sprout's lane: an archived sprout's queue stays closed (#980).
      return lane(todo.routine, async () => {
        const routine = (await deps.loadRoutines()).find((r) => r.name === todo.routine);
        if (routine && isArchived(routine, new Date())) throw new Error(`sprout "${routine.name}" is archived — restore it first`);
        return deps.retryTodo(deps.dbFile, id);
      });
    },
  };
}

/** Seeds (#1157): the owner's list, Done / Let it go, and Undo. The renderer is untrusted, so every
 * argument is checked. A write carries the version the owner saw: a seed that changed since (the
 * pulse reworded or closed it) throws, so the owner never acts on text they didn't read. */
export function buildSeedHandlers(deps: { dbFile: string; now?: () => Date }) {
  const now = (): Date => deps.now?.() ?? new Date();
  const seen = (id: unknown, version: unknown): MindItem | undefined => {
    if (typeof id !== "string" || id === "" || !Number.isSafeInteger(version)) throw new Error("malformed seed request");
    const cur = getMindItem(deps.dbFile, id);
    if (cur && cur.version !== version) throw new Error("That seed just changed — have another look.");
    return cur;
  };
  return {
    /** Active seeds, plus the ones closed in the last week (the "Crossed off" line and its Undo). */
    list: (): MindItem[] => listMindItems(deps.dbFile, { recentDays: 7, now: now() }),
    /** Undefined = it wasn't active (already closed). Answers a check-in: resets the backoff streak. */
    resolve: (id: unknown, status: unknown, version: unknown, reason?: unknown): MindItem | undefined => {
      if (status !== "done" && status !== "dismissed") throw new Error("malformed seed request");
      if (reason !== undefined && (status !== "dismissed" || (reason !== "not-interested" && reason !== "wrong"))) throw new Error("malformed seed request");
      if (seen(id, version)?.status !== "active") return undefined;
      const item = resolveMindItem(deps.dbFile, id as string, status, reason as DismissReason | undefined, now());
      if (item) updatePulseState(deps.dbFile, (s) => ({ ...s, unanswered: 0 }));
      return item;
    },
    /** Back to active; undefined = it wasn't closed. */
    undo: (id: unknown, version: unknown): MindItem | undefined => {
      const cur = seen(id, version);
      return cur && cur.status !== "active" ? undoMindItem(deps.dbFile, cur.id, now()) : undefined;
    },
  };
}
