import { randomUUID } from "node:crypto";
import {
  configFile, dbFile, imagesDir, loadConfig, modelMemoryFile, outboxDir, personaFile, projectsFile, remindersFile,
  routinesDir, routineStateFile, skillsDir,
} from "../config.js";
import { setBeanGitIdentity } from "../agent-rules.js";
import { conversationDispatches } from "../dispatch-store.js";
import { listDestinations } from "../destinations.js";
import { appendMemories, deleteMemories, loadMemories, shareMemory } from "../memory/store.js";
import { loadModelMemory, saveModelMemory } from "../model-memory.js";
import { saveNoteImage } from "../note-images.js";
import { archiveNote, restoreNoteOutcome, saveNote, searchNotes } from "../note-store.js";
import { makeOpenAIImageGen } from "../openai-chat.js";
import { enqueueOutbox } from "../outbox.js";
import { loadPersona } from "../persona-store.js";
import { loadProjects } from "../project-registry.js";
import { createRoutine, isArchived, loadRoutines, memberTodoEligible, resolveTodoRoutine, saveRoutine } from "../routine-store.js";
import { loadLayeredSkills, saveSkill } from "../skill-library.js";
import { addTodo, cancelPendingTodo, listOpenTodos, pendingTodoCount, queueTodoDispatch } from "../todo-store.js";
import type { BeanConfig } from "../types.js";
import { parentActivitySink } from "./activity.js";
import type { TeamsBotDeps } from "./bot.js";
import { ConversationCatalog, ownerSubjectIds } from "./catalog.js";
import { makeChatter } from "./chatter.js";
import { makeAway } from "./away.js";
import { NoteArchiveProposalStore } from "./note-archive-proposals.js";
import { NoteProposalStore } from "./note-proposals.js";
import { RoutineProposalStore } from "./routine-proposals.js";
import { SendProposalStore } from "./send-proposals.js";
import { SkillProposalStore } from "./skill-proposals.js";
import { TodoProposalStore } from "./todo-proposals.js";

/** The `buildTeamsBot` deps that are identical on every chatops surface but for the surface tag.
 * Platform-specific keys (roles, cards, chat, runs, conversations, live sessions, the delegate
 * lookups, routine recipients and sprout triggers) stay with each server — never add them here:
 * roles has no default (.memory/safety-chatops-roles.md) and desk-continue / member recipients /
 * headless sprouts are per-surface decisions. */
export type SharedBotDeps = Pick<TeamsBotDeps,
  | "onActivity" | "model"
  | "loadSkills" | "loadProjects" | "loadPersona" | "loadMemories" | "ownerSubjectIds" | "loadModelMemory" | "saveModelMemory"
  | "noteProposals" | "saveNote" | "saveNoteImage" | "searchNotes" | "noteArchiveProposals" | "archiveNote" | "restoreNote"
  | "todoProposals" | "queueTodo" | "queueTodoDispatch" | "pendingTodos" | "listTodoRoutines" | "listOpenTodos" | "cancelTodo" | "backgroundWork"
  | "skillProposals" | "saveSkill"
  | "appendMemories" | "deleteMemories" | "shareMemory" | "autoMemoryEnabled"
  | "systemControlsEnabled" | "webSearchEnabled" | "imageGen"
  | "catalog" | "chatter" | "away" | "reminders" | "send"
> & {
  routines: Omit<NonNullable<TeamsBotDeps["routines"]>, "recipients" | "sprouts">;
};

export function sharedBotDeps(opts: {
  dir: string;
  builtinDir: string;
  surface: "discord" | "teams";
  config: BeanConfig;
}): SharedBotDeps {
  const { dir, builtinDir, surface: transport, config } = opts;
  // A bot is its own process: its delegates and live sessions commit as Settings' identity too.
  // ponytail: read at bot start like webSearch; restart the bot after changing it
  setBeanGitIdentity(config.gitName, config.gitEmail);
  const db = dbFile(dir);
  const enqueue = (msg: Parameters<typeof enqueueOutbox>[1]) => enqueueOutbox(outboxDir(dir), msg, () => randomUUID());
  return {
    onActivity: parentActivitySink,
    model: config.model,
    loadSkills: () => loadLayeredSkills(skillsDir(builtinDir), skillsDir(dir)),
    loadProjects: () => loadProjects(projectsFile(dir)),
    loadPersona: () => loadPersona(personaFile(dir), personaFile(builtinDir)),
    loadMemories: (subject, scope) => loadMemories(db, subject, scope),
    ownerSubjectIds: () => ownerSubjectIds(db, dir),
    loadModelMemory: () => loadModelMemory(modelMemoryFile(dir)),
    saveModelMemory: (m) => saveModelMemory(modelMemoryFile(dir), m),
    noteProposals: new NoteProposalStore(),
    saveNote: (draft) => saveNote(db, draft),
    saveNoteImage: (bytes) => saveNoteImage(db, bytes),
    searchNotes: (query) => searchNotes(db, query),
    noteArchiveProposals: new NoteArchiveProposalStore(),
    archiveNote: (slug) => archiveNote(db, slug),
    restoreNote: (slug) => restoreNoteOutcome(db, slug),
    todoProposals: new TodoProposalStore(),
    queueTodo: async (routine, text, createdBy) => {
      const target = resolveTodoRoutine(await loadRoutines(routinesDir(dir)), routine, createdBy !== undefined);
      await addTodo(db, routine, text, undefined, undefined, createdBy);
      return target;
    },
    queueTodoDispatch: async (t, report) => {
      const routine = resolveTodoRoutine(await loadRoutines(routinesDir(dir)), t.routine, t.createdBy !== undefined);
      const q = queueTodoDispatch(db, t, { surface: transport, ...(report.channel ? { conversation: report.channel } : {}), ...(report.actor ? { actor: report.actor } : {}) });
      return { ...(routine ? { routine } : {}), jobId: q.jobId, ahead: q.ahead };
    },
    pendingTodos: async (routine) => pendingTodoCount(db, routine),
    listTodoRoutines: async (member) => (await loadRoutines(routinesDir(dir)))
      .filter((r) => !isArchived(r, new Date()) && (member ? memberTodoEligible(r) : r.todoDriven)).map((r) => r.name),
    listOpenTodos: (createdBy) => listOpenTodos(db, createdBy),
    cancelTodo: (id, createdBy) => cancelPendingTodo(db, id, createdBy),
    backgroundWork: { file: db, stateFile: routineStateFile(dir), dispatches: (conversation) => conversationDispatches(db, transport, conversation) },
    skillProposals: new SkillProposalStore(),
    saveSkill: (name, body) => saveSkill(skillsDir(dir), name, body, skillsDir(builtinDir)),
    appendMemories: (m) => appendMemories(db, m),
    deleteMemories: (ids, subject) => deleteMemories(db, ids, subject),
    shareMemory: (id, actor) => shareMemory(db, id, actor),
    // Re-read per DM so a Settings toggle applies without a restart; unreadable config = off.
    autoMemoryEnabled: () => loadConfig(configFile(dir), dir).then((c) => c.autoMemory, () => false),
    systemControlsEnabled: () => config.systemControls,
    webSearchEnabled: () => config.webSearch,
    imageGen: { generate: makeOpenAIImageGen(config.openaiApiKey), model: config.imageModel, imagesDir: imagesDir(dir) },
    catalog: new ConversationCatalog(db, transport),
    chatter: makeChatter({ dbPath: db, surface: transport }),
    away: makeAway({ dbPath: db, surface: transport }),
    // Fired by the desktop app's reminder loop into the outbox; each bot's drain delivers them.
    reminders: { file: remindersFile(dir), transport },
    // Owner-DM sends by name (#689): this surface's destinations, delivered by its own outbox drain.
    send: {
      transport,
      destinations: () => listDestinations(db, transport),
      enqueue,
      proposals: new SendProposalStore(),
    },
    routines: {
      transport,
      load: () => loadRoutines(routinesDir(dir)),
      save: (r) => saveRoutine(routinesDir(dir), r),
      create: (r) => createRoutine(routinesDir(dir), r),
      // No channel = the owner's DM.
      notifyOwner: async (body) => { await enqueue({ transport, body }); },
      destinations: () => listDestinations(db, transport),
      proposals: new RoutineProposalStore(),
    },
  };
}
