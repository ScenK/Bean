import { composePrompt } from "./prompt.js";
import { composePersonaPrompt, type Persona } from "./persona.js";
import type { Project, RouteSuggestion, Skill } from "./types.js";
import type { Memory } from "./memory/memory.js";
import type { CliName } from "./launcher.js";
import { MODELS } from "./models.js";

export interface ConvoMsg { role: "system" | "user" | "assistant"; content: string; }
export interface ChatTurn { role: "user" | "assistant"; content: string; }
export interface ToolSpec { name: string; description: string; parameters: object; }
export interface ToolCall { name: string; args: unknown; }
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
// A confirm-first background coding task that reports its final result back to this chat.
export interface ProposedDelegate {
  projectPath: string;
  instruction: string;
  skillName?: string;
  composedPrompt: string;
  /** CLI the user explicitly asked for in chat, validated against the caller's detected CLIs. */
  cli?: CliName;
  /** Canonical model id (models.ts) the user explicitly asked for. */
  model?: string;
}
/** The note this chat was continued from: its body goes into the system prompt and a
 * propose_note from this chat targets it (update in place) by default. */
export interface LinkedNote { slug: string; title: string; version: number; body: string; }
export interface ConverseResult { reply: string; model?: string; proposedRun?: ProposedRun; proposedNote?: ProposedNote; proposedDelegate?: ProposedDelegate; proposedRemember?: boolean; }
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
  "propose_remember — the user then confirms which facts are kept; never save memory silently.";
  

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

function proposeDelegateTool(skills: Skill[], projects: Project[], availableClis: CliName[]): ToolSpec {
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
    const modelIds = MODELS.filter((m) => availableClis.some((cli) => m.aliases[cli] !== undefined)).map((m) => m.id);
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

export async function converse(
  history: ChatTurn[],
  latestUserText: string,
  skills: Skill[],
  projects: Project[],
  persona: Persona,
  memories: Memory[],
  deps: ConverseDeps,
  droppedUrl?: string,
  actions: ActionTool[] = [],
  now: () => Date = () => new Date(),
  linkedNote?: LinkedNote,
  delegateAvailable = false,
  availableClis: CliName[] = [],
  rememberAvailable = false,
  // false where confirming a run couldn't execute anything (chatops — no desktop, no terminal).
  runAvailable = true,
): Promise<ConverseResult> {
  const systemParts = [
    composePersonaPrompt(persona),
    behaviorInstructions(runAvailable),
    catalog(skills, projects),
  ];
  // Local time so the model can resolve "in 20 minutes" / "at 5pm" into a concrete timestamp.
  if (actions.length > 0) systemParts.push(`Current date and time: ${now().toString()}`);
  const recall = memoriesBlock(memories, projects);
  if (recall) systemParts.push(recall);
  if (linkedNote) {
    systemParts.push(
      `This chat continues from the note "${linkedNote.title}" (v${linkedNote.version}). Its current ` +
        `content:\n\n${linkedNote.body}\n\nWhen the talk resolves its open threads, offer to fold the ` +
        "outcome back into the note via propose_note.",
    );
  }

  const messages: ConvoMsg[] = [
    { role: "system", content: systemParts.join("\n\n") },
    ...history.map((t): ConvoMsg => ({ role: t.role, content: t.content })),
    { role: "user", content: latestUserText },
  ];

  // No skills means propose_run could never validly fire; project is optional (no-project /
  // scratch workspace runs) so an empty projects list no longer excludes the tool.
  // Without a terminal (chatops), only `target: chat` skills are runnable via propose_run —
  // they execute on Bean's own model; terminal skills there go through propose_delegate.
  const runnableSkills = runAvailable ? skills : skills.filter((s) => s.target === "chat");
  const tools = [
    ...(runnableSkills.length > 0 ? [proposeRunTool(runnableSkills, projects, !runAvailable)] : []),
    ...(delegateAvailable && projects.length > 0 ? [proposeDelegateTool(skills, projects, availableClis)] : []),
    proposeNoteTool(projects, linkedNote),
    ...(rememberAvailable ? [proposeRememberTool()] : []),
    ...actions.map((a) => a.spec),
  ];
  const actionByName = new Map(actions.map((a) => [a.spec.name, a]));

  // Tool-execution loop: action tools run here and their result goes back to the model
  // for a confirming reply; propose_run short-circuits out to the UI as before.
  // ponytail: tool results are fake user-role messages, not the OpenAI tool_call_id
  // protocol — switch to real tool messages if the model starts re-calling tools.
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
          model: MODELS.some((m) => m.id === args.model) ? (args.model as string) : undefined,
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

    const rememberCall = toolCalls.find((c) => c.name === "propose_remember");
    if (rememberCall) {
      return { reply: content, model: deps.model, proposedRemember: true };
    }

    const actionCalls = toolCalls.filter((c) => actionByName.has(c.name));
    if (actionCalls.length === 0) return { reply: content, model: deps.model };

    if (content) messages.push({ role: "assistant", content });
    for (const c of actionCalls) {
      let result: string;
      try {
        result = await actionByName.get(c.name)!.run(c.args);
      } catch (err) {
        result = `error: ${err instanceof Error ? err.message : String(err)}`;
      }
      messages.push({ role: "user", content: `[tool result for ${c.name}]: ${result}` });
    }
  }
  return { reply: content, model: deps.model };
}
