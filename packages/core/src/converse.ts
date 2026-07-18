import { composePrompt } from "./prompt.js";
import { composePersonaPrompt, type Persona } from "./persona.js";
import type { Project, RouteSuggestion, Skill } from "./types.js";
import type { Memory } from "./memory/memory.js";
import { selectRelevantMemories } from "./memory/store.js";
import type { CliName } from "./launcher.js";
import type { AvailableModel } from "./models.js";

export type ConvoMsg =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; content: string; toolCallId: string };
// "system" backs chatops/compact.ts's rolling summary turn — ConvoMsg already accepts it, so
// converse()'s history mapping needs no change, just this wider type.
export interface ChatTurn { role: "user" | "assistant" | "system"; content: string; }
export interface ToolSpec { name: string; description: string; parameters: object; }
export interface ToolCall { id?: string; name: string; args: unknown; }
// A tool Bean executes itself (in the Electron main process), unlike propose_run
// which is confirm-first. run() returns a plain-text result fed back to the model.
export interface ActionTool { spec: ToolSpec; run: (args: unknown) => Promise<string>; }
export interface ConverseDeps {
  chat: (a: { model: string; messages: ConvoMsg[]; tools: ToolSpec[] }) => Promise<{
    content: string;
    toolCalls: ToolCall[];
  }>;
  model: string;
}

export type ProposedRun = RouteSuggestion;
/** A note draft awaiting user confirmation in the chat — notes are never saved silently.
 * `slug` present = update that existing note in place (chat linked to a note). */
export interface ProposedNote { title: string; body: string; project?: string; slug?: string; }
/** A skill draft awaiting user confirmation — skills are never written silently.
 * `updating` = a skill with this name already exists (user or built-in; confirming
 * writes/overrides the user copy in ~/.bean/skills). */
export interface ProposedSkill { name: string; body: string; updating: boolean; }
/** A queue item draft awaiting user confirmation — todos are never queued silently. */
export interface ProposedTodo { routine: string; text: string; }
// A confirm-first background coding task that reports its final result back to this chat.
export interface ProposedDelegate {
  projectPath: string;
  instruction: string;
  skillName?: string;
  composedPrompt: string;
  /** CLI the user explicitly asked for in chat, validated against the caller's detected CLIs. */
  cli?: CliName;
  /** Literal --model value (clis.json) the user explicitly asked for. */
  model?: string;
}
/** The note this chat was continued from: its body goes into the system prompt and a
 * propose_note from this chat targets it (update in place) by default. */
export interface LinkedNote { slug: string; title: string; version: number; body: string; }
export interface ConverseResult { reply: string; model?: string; proposedRun?: ProposedRun; proposedNote?: ProposedNote; proposedDelegate?: ProposedDelegate; proposedRemember?: boolean; proposedSkill?: ProposedSkill; proposedTodo?: ProposedTodo; }
export interface ChatRequest { history: ChatTurn[]; message: string; droppedUrl?: string; linkedNote?: LinkedNote; }

// runAvailable=false (chatops: Discord/Teams) — no terminal exists there, so propose_run
// is only offered for `target: chat` skills (which run on Bean's own model, no agent
// harness); everything else routes to propose_delegate.
const behaviorInstructions = (runAvailable: boolean): string =>
  "You cannot do project work yourself — a separate `opencode` process does. " +
  (runAvailable
    ? "When the user " +
      "wants a concrete task done in one of their projects, call the propose_run tool with the " +
      "best matching skill name, project path, and a clear instruction; otherwise just reply in " +
      "text. "
    : "") +
  "Any other tools you are given (reminders etc.) you DO execute yourself — call them " +
  "directly when the user asks, then confirm what you did in one short sentence. " +
  "Only propose a run when the user clearly wants work done. The skills/projects list below " +
  "is for your own routing decisions — don't recite or summarize it unprompted. Only describe " +
  "your skills or projects if the user directly asks what you can do. " +
  "When the user asks to save this talk as a note, or a substantive discussion winds down " +
  "with unresolved threads, call propose_note to draft one — the user confirms it before " +
  "anything is saved. Notes capture conversation output (summaries, ideas, open questions), " +
  "NOT durable one-line facts about the user — those are handled elsewhere. Don't propose a " +
  "note for small talk or a talk that reached no substance. If you are given a " +
  "propose_delegate tool: use it when the user wants project work done; a background " +
  "agent does the work while the chat stays open, and its result returns to this " +
  "conversation. Call propose_delegate directly — don't ask the user in chat text whether " +
  "you should delegate first; the card Bean shows afterward is the confirmation step. " +
  "If the user asks you to inspect, explore, summarize, or explain a linked project, " +
  "use propose_delegate; do not say you cannot access the repository. " +
  (runAvailable
    ? "Use propose_run instead when the user wants to watch or continue the " +
      "work in their own terminal. Both are confirm-first via the card shown after you " +
      "propose — not by asking permission in chat text."
    : "There is no terminal here. If you are given a propose_run tool, its skills run " +
      "directly in this chat — call it for those. Any other request to run, launch, or " +
      "kick off work is a propose_delegate call. Delegates are confirm-first via the card " +
      "shown after you propose — not by asking permission in chat text.") +
  " When the user explicitly asks you to remember or save durable facts from this chat, call " +
  "propose_remember — the user then confirms which facts are kept; never save memory silently. " +
  "When the user asks you to create a new skill or change an existing one, call propose_skill " +
  "with the complete markdown — the user confirms the card before anything is written. " +
  "If you are given a propose_todo tool, use it when the user wants a task queued for later " +
  "instead of done now — the routine runs it on its own schedule; the card is the confirmation.";
  

function proposeNoteTool(projects: Project[], linkedNote?: LinkedNote): ToolSpec {
  const properties: Record<string, unknown> = {
    title: { type: "string", description: "short note title" },
    body: {
      type: "string",
      description:
        "the note as markdown with exactly these sections: '## Summary' (a short paragraph), " +
        "'## Key ideas' (bullets), and — only if threads are unresolved — '## Open questions' " +
        "with one unchecked '- [ ]' item per question",
    },
  };
  if (projects.length > 0) {
    properties.project = {
      type: "string",
      enum: projects.map((p) => p.path),
      description: "the project this note is about; omit for a general note",
    };
  }
  return {
    name: "propose_note",
    description: linkedNote
      ? `Draft an update to the linked note "${linkedNote.title}" (v${linkedNote.version}): resolve answered ` +
        "open questions (check them off or fold them into the body) and refresh the summary/ideas. " +
        "The user confirms before saving."
      : "Draft a note capturing this conversation's output for the user to confirm and save.",
    parameters: { type: "object", properties, required: ["title", "body"] },
  };
}

// Mirrors saveSkill's traversal guard — converse() must reject what the writer would reject,
// so an invalid model-supplied name dies here instead of as a save-time error on the card.
const INVALID_SKILL_NAME = /[/\\]|\.\./;

function proposeSkillTool(): ToolSpec {
  return {
    name: "propose_skill",
    description:
      "Draft a new skill, or a new version of an existing one, for the user to confirm and save. " +
      "A skill is a markdown file: optional frontmatter (`description:` — the one-line summary " +
      "shown in catalogs; `target: chat` if it should run right in the chat instead of a " +
      "terminal coding agent), then the full instructions as the body. Reusing an existing " +
      "skill's name replaces that skill. Nothing is written until the user confirms the card.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "kebab-case skill name; becomes the filename <name>.md" },
        body: { type: "string", description: "the complete markdown file content, frontmatter included" },
      },
      required: ["name", "body"],
    },
  };
}

// Enum-constrained to the caller's todo-driven routine names, same trick as propose_run's
// skill/project enums — the model can't invent a queue that doesn't exist.
function proposeTodoTool(todoRoutines: string[]): ToolSpec {
  return {
    name: "propose_todo",
    description:
      "Queue a task on one of the user's todo-driven routines — the routine works through its " +
      "queue on its own schedule (e.g. overnight). Use when the user wants a task queued for " +
      "later rather than done now. The user confirms a card before anything is queued.",
    parameters: {
      type: "object",
      properties: {
        routine: { type: "string", enum: todoRoutines, description: "which routine's queue to add to" },
        text: { type: "string", description: "the task as one self-contained sentence or short paragraph" },
      },
      required: ["routine", "text"],
    },
  };
}

// Argless: a trigger only. The model decides WHEN to offer to remember; extractMemories()
// (run by the caller) decides WHAT. Gated behind rememberAvailable so the desktop app —
// which captures memory at chat-close — never grows a second memory path.
function proposeRememberTool(): ToolSpec {
  return {
    name: "propose_remember",
    description:
      "Call this only when the user's LATEST message directly asks you to remember or save " +
      "durable facts (e.g. \"remember this\", \"save what we figured out\"). It offers the user " +
      "a card of candidate facts to confirm — do not use it to save anything silently. Never " +
      "call it without that direct ask: banter, jokes, messages addressed to someone else, or " +
      "remarks about you needing to learn/be taught are NOT requests to remember.",
    parameters: { type: "object", properties: {} },
  };
}

// Built per-call so the skill/project arguments are enum-constrained to the exact
// known values. This stops the model from emitting a display label or bare name
// (e.g. "bean (/path)" or "bean") where an exact project path is required — which
// converse()'s validation would otherwise silently drop, killing the confirm card.
function proposeRunTool(skills: Skill[], projects: Project[], inChatOnly = false): ToolSpec {
  return {
    name: "propose_run",
    description:
      (inChatOnly
        ? "Run one of these skills right here in this chat — no terminal or background agent involved. "
        : "Propose running one skill, optionally on one project. ") +
      "Use exactly one of the allowed " +
      "skill and project values (a project value is that project's path); omit project when the " +
      "user wants to run without one (a scratch workspace, e.g. for a URL-only task).",
    parameters: {
      type: "object",
      properties: {
        skill: { type: "string", enum: skills.map((s) => s.name), description: "the skill to run" },
        project: {
          type: "string",
          enum: projects.map((p) => p.path),
          description: "the project path to run in; omit to run without a project",
        },
        instruction: { type: "string", description: "the concrete task instruction" },
      },
      required: ["skill", "instruction"],
    },
  };
}

function proposeDelegateTool(skills: Skill[], projects: Project[], availableClis: CliName[], models: AvailableModel[]): ToolSpec {
  const properties: Record<string, unknown> = {
    project: { type: "string", enum: projects.map((p) => p.path), description: "the project path to work in" },
    instruction: {
      type: "string",
      description: "the concrete, self-contained task for the delegated agent — include all context it needs",
    },
  };
  if (skills.length > 0) {
    properties.skill = {
      type: "string",
      enum: skills.map((s) => s.name),
      description: "optional skill whose instructions frame the task; omit for a free-form task",
    };
  }
  if (availableClis.length > 0) {
    properties.cli = {
      type: "string",
      enum: availableClis,
      description: "only when the user explicitly asked for a specific CLI; omit otherwise",
    };
    const modelIds = models.filter((m) => m.availableOn.length > 0).map((m) => m.id);
    if (modelIds.length > 0) {
      properties.model = {
        type: "string",
        enum: modelIds,
        description: "only when the user explicitly asked for a specific model; omit otherwise",
      };
    }
  }
  return {
    name: "propose_delegate",
    description:
      "Delegate a task to a background coding agent that can inspect, summarize, explain, or work " +
      "inside the project and reports the result back to this chat when finished. Call it directly — " +
      "don't ask the user for permission in chat text first; the card shown afterward is what the " +
      "user confirms and edits before it actually starts.",
    parameters: { type: "object", properties, required: ["project", "instruction"] },
  };
}

function catalog(skills: Skill[], projects: Project[]): string {
  const skillList = skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
  const projectList = projects.map((p) => `- ${p.name} (${p.path})`).join("\n");
  return `Skills:\n${skillList}\n\nProjects:\n${projectList}`;
}

function memoriesBlock(memories: Memory[], projects: Project[]): string {
  if (memories.length === 0) return "";
  const nameFor = (path: string): string => projects.find((p) => p.path === path)?.name ?? path;
  const ordered = [...memories].sort((a, b) => Number(Boolean(a.projectPath)) - Number(Boolean(b.projectPath)));
  const lines = ordered.map((m) =>
    m.projectPath ? `- (project ${nameFor(m.projectPath)}) ${m.text}` : `- (about the user) ${m.text}`,
  );
  return `What you remember:\n${lines.join("\n")}`;
}

export interface ConverseInput {
  history: ChatTurn[];
  latestUserText: string;
  skills: Skill[];
  projects: Project[];
  persona: Persona;
  memories: Memory[];
  deps: ConverseDeps;
  droppedUrl?: string;
  actions?: ActionTool[];
  now?: () => Date;
  linkedNote?: LinkedNote;
  delegateAvailable?: boolean;
  availableClis?: CliName[];
  models?: AvailableModel[]; // configured models (clis.json) for the propose_delegate enum; [] = no model param offered
  rememberAvailable?: boolean;
  /** false where confirming a run couldn't execute anything (chatops — no desktop, no terminal). */
  runAvailable?: boolean;
  todoRoutines?: string[];
}

export async function converse(input: ConverseInput): Promise<ConverseResult> {
  const {
    history,
    latestUserText,
    skills,
    projects,
    persona,
    memories,
    deps,
    droppedUrl,
    actions = [],
    now = () => new Date(),
    linkedNote,
    delegateAvailable = false,
    availableClis = [],
    models = [],
    rememberAvailable = false,
    runAvailable = true,
    todoRoutines = [],
  } = input;
  // The leading system message must stay byte-stable for the life of a chat: OpenAI prompt
  // caching is exact-prefix, so anything per-turn here (a clock, per-message memory ranking)
  // re-bills the entire conversation uncached on every turn. Volatile context goes in a
  // second system message after history instead — only the tail misses the cache.
  const systemParts = [
    composePersonaPrompt(persona),
    behaviorInstructions(runAvailable),
    catalog(skills, projects),
  ];
  if (linkedNote) {
    systemParts.push(
      `This chat continues from the note "${linkedNote.title}" (v${linkedNote.version}). Its current ` +
        `content:\n\n${linkedNote.body}\n\nWhen the talk resolves its open threads, offer to fold the ` +
        "outcome back into the note via propose_note.",
    );
  }

  const contextParts: string[] = [];
  // Local time so the model can resolve "in 20 minutes" / "at 5pm" into a concrete timestamp.
  if (actions.length > 0) contextParts.push(`Current date and time: ${now().toString()}`);
  // No per-chat "current project" signal exists here (LinkedNote doesn't carry one) — force-
  // include is left unused from this call site, but selectRelevantMemories still supports it.
  const relevant = selectRelevantMemories(memories, latestUserText);
  const recall = memoriesBlock(relevant, projects);
  if (recall) contextParts.push(recall);

  const messages: ConvoMsg[] = [
    { role: "system", content: systemParts.join("\n\n") },
    ...history.map((t): ConvoMsg => ({ role: t.role, content: t.content })),
    ...(contextParts.length > 0
      ? [{ role: "system", content: contextParts.join("\n\n") } satisfies ConvoMsg]
      : []),
    { role: "user", content: latestUserText },
  ];

  // No skills means propose_run could never validly fire; project is optional (no-project /
  // scratch workspace runs) so an empty projects list no longer excludes the tool.
  // Without a terminal (chatops), only `target: chat` skills are runnable via propose_run —
  // they execute on Bean's own model; terminal skills there go through propose_delegate.
  const runnableSkills = runAvailable ? skills : skills.filter((s) => s.target === "chat");
  const tools = [
    ...(runnableSkills.length > 0 ? [proposeRunTool(runnableSkills, projects, !runAvailable)] : []),
    ...(delegateAvailable && projects.length > 0 ? [proposeDelegateTool(skills, projects, availableClis, models)] : []),
    proposeNoteTool(projects, linkedNote),
    proposeSkillTool(),
    ...(todoRoutines.length > 0 ? [proposeTodoTool(todoRoutines)] : []),
    ...(rememberAvailable ? [proposeRememberTool()] : []),
    ...actions.map((a) => a.spec),
  ];
  const actionByName = new Map(actions.map((a) => [a.spec.name, a]));

  // Tool-execution loop: action tools run here and their result goes back to the model
  // for a confirming reply; propose_run short-circuits out to the UI as before.
  let content = "";
  for (let round = 0; round < 3; round++) {
    let toolCalls: ToolCall[] = [];
    try {
      const res = await deps.chat({ model: deps.model, messages, tools });
      content = res.content;
      toolCalls = res.toolCalls;
    } catch {
      return { reply: "I couldn't reach the model — check your API key in ~/.bean/config.json.", model: deps.model };
    }

    const call = toolCalls.find((c) => c.name === "propose_run");
    if (call) {
      const args = (call.args ?? {}) as { skill?: unknown; project?: unknown; instruction?: unknown };
      const skill = runnableSkills.find((s) => s.name === args.skill);
      // args.project absent = a deliberate no-project run; present-but-unknown = the model
      // named something outside the enum, which we still treat as invalid.
      const project = args.project === undefined ? undefined : projects.find((p) => p.path === args.project);
      if (!skill || (args.project !== undefined && !project)) return { reply: content, model: deps.model };
      const instruction = typeof args.instruction === "string" ? args.instruction : latestUserText;
      return {
        reply: content,
        model: deps.model,
        proposedRun: {
          skillName: skill.name,
          projectPath: project?.path,
          composedPrompt: composePrompt(skill, instruction, droppedUrl),
          confidence: 1,
          target: skill.target,
        },
      };
    }

    const delegateCall = toolCalls.find((c) => c.name === "propose_delegate");
    if (delegateCall) {
      const args = (delegateCall.args ?? {}) as {
        project?: unknown; instruction?: unknown; skill?: unknown; cli?: unknown; model?: unknown;
      };
      const project = projects.find((p) => p.path === args.project);
      if (!project || typeof args.instruction !== "string" || !args.instruction.trim()) {
        return { reply: content, model: deps.model };
      }
      const skill = skills.find((s) => s.name === args.skill);
      return {
        reply: content,
        model: deps.model,
        proposedDelegate: {
          projectPath: project.path,
          instruction: args.instruction,
          skillName: skill?.name,
          composedPrompt: skill ? composePrompt(skill, args.instruction, droppedUrl) : args.instruction,
          cli: availableClis.includes(args.cli as CliName) ? (args.cli as CliName) : undefined,
          // Same availableOn filter as the tool's enum (line ~239) — a model listed in
          // config but not offered on any detected CLI was never a valid choice for the model.
          model: models.some((m) => m.id === args.model && m.availableOn.length > 0)
            ? (args.model as string)
            : undefined,
        },
      };
    }

    const noteCall = toolCalls.find((c) => c.name === "propose_note");
    if (noteCall) {
      const args = (noteCall.args ?? {}) as { title?: unknown; body?: unknown; project?: unknown };
      if (typeof args.title !== "string" || !args.title.trim() || typeof args.body !== "string") {
        return { reply: content, model: deps.model };
      }
      const project = projects.find((p) => p.path === args.project)?.path;
      return {
        reply: content,
        model: deps.model,
        proposedNote: { title: args.title.trim(), body: args.body, project, slug: linkedNote?.slug },
      };
    }

    const skillCall = toolCalls.find((c) => c.name === "propose_skill");
    if (skillCall) {
      const args = (skillCall.args ?? {}) as { name?: unknown; body?: unknown };
      const name = typeof args.name === "string" ? args.name.trim() : "";
      if (!name || INVALID_SKILL_NAME.test(name) || typeof args.body !== "string" || !args.body.trim()) {
        return { reply: content, model: deps.model };
      }
      return {
        reply: content,
        model: deps.model,
        proposedSkill: { name, body: args.body, updating: skills.some((s) => s.name === name) },
      };
    }

    const todoCall = toolCalls.find((c) => c.name === "propose_todo");
    if (todoCall) {
      const args = (todoCall.args ?? {}) as { routine?: unknown; text?: unknown };
      const text = typeof args.text === "string" ? args.text.trim() : "";
      if (!text || typeof args.routine !== "string" || !todoRoutines.includes(args.routine)) {
        return { reply: content, model: deps.model };
      }
      return { reply: content, model: deps.model, proposedTodo: { routine: args.routine, text } };
    }

    const rememberCall = toolCalls.find((c) => c.name === "propose_remember");
    if (rememberCall) {
      return { reply: content, model: deps.model, proposedRemember: true };
    }

    const actionCalls = toolCalls.filter((c) => actionByName.has(c.name));
    if (actionCalls.length === 0) return { reply: content, model: deps.model };

    messages.push({ role: "assistant", content, toolCalls });
    for (const c of actionCalls) {
      let result: string;
      try {
        result = await actionByName.get(c.name)!.run(c.args);
      } catch (err) {
        result = `error: ${err instanceof Error ? err.message : String(err)}`;
      }
      messages.push({ role: "tool", content: result, toolCallId: c.id ?? c.name });
    }
  }
  return { reply: content, model: deps.model };
}
