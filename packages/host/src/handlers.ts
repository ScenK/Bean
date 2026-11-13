import {
  listSkillProposals, approveSkillProposal, rejectSkillProposal, undoSkillProposal, skillHash, resolveTodoRoutine,
  type SkillProposal, type ProposalOutcome, type Project, type Skill, type Persona, type Routine, type TodoItem,
} from "@bean/core";

// The stateless handler builders: each one closes over its file paths and calls core. No Electron.

export interface ListSkillsHandlerDeps {
  loadSkills: (projectDir: string, userDir: string) => Promise<Skill[]>;
  projectSkillsDir: string;
  skillsDir: string;
}

export function buildListSkillsHandler(deps: ListSkillsHandlerDeps) {
  // `hidden: true` skills (e.g. the built-in self-intro skill) stay in converse()'s routing
  // catalog (buildChatHandler loads skills separately) but never reach any UI surface — every
  // renderer skill list/picker/quick-launch goes through this one IPC call.
  return async (): Promise<Skill[]> => (await deps.loadSkills(deps.projectSkillsDir, deps.skillsDir)).filter((s) => !s.hidden);
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
  projectsFile: string;
}

export function buildSaveProjectsHandler(deps: SaveProjectsHandlerDeps) {
  return (projects: Project[]): Promise<void> => deps.saveProjects(deps.projectsFile, projects);
}

export interface SaveSkillHandlerDeps {
  saveSkill: (dir: string, name: string, body: string) => Promise<void>;
  skillsDir: string;
}

export function buildSaveSkillHandler(deps: SaveSkillHandlerDeps) {
  return (name: string, body: string): Promise<void> => deps.saveSkill(deps.skillsDir, name, body);
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
    retry: (id: string): Promise<void> => deps.retryTodo(deps.dbFile, id),
  };
}
