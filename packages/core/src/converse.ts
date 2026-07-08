import { composePrompt } from "./prompt.js";
import { composePersonaPrompt, type Persona } from "./persona.js";
import type { Project, RouteSuggestion, Skill } from "./types.js";
import type { Memory } from "./memory/memory.js";

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
}
/** The note this chat was continued from: its body goes into the system prompt and a
 * propose_note from this chat targets it (update in place) by default. */
export interface LinkedNote { slug: string; title: string; version: number; body: string; }
export interface ConverseResult { reply: string; model?: string; proposedRun?: ProposedRun; proposedNote?: ProposedNote; proposedDelegate?: ProposedDelegate; }
export interface ChatRequest { history: ChatTurn[]; message: string; droppedUrl?: string; linkedNote?: LinkedNote; }

const BEHAVIOR_INSTRUCTIONS =
  "You cannot do project work yourself — a separate `opencode` process does. When the user " +
  "wants a concrete task done in one of their projects, call the propose_run tool with the " +
  "best matching skill name, project path, and a clear instruction; otherwise just reply in " +
  "text. Any other tools you are given (reminders etc.) you DO execute yourself — call them " +
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
  "Use propose_run instead when the user wants to watch or continue the " +
  "work in their own terminal. Both are confirm-first via the card shown after you " +
  "propose — not by asking permission in chat text.";
  

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

// Built per-call so the skill/project arguments are enum-constrained to the exact
// known values. This stops the model from emitting a display label or bare name
// (e.g. "bean (/path)" or "bean") where an exact project path is required — which
// converse()'s validation would otherwise silently drop, killing the confirm card.
function proposeRunTool(skills: Skill[], projects: Project[]): ToolSpec {
  return {
    name: "propose_run",
    description:
      "Propose running one skill on one project. Use exactly one of the allowed skill " +
      "and project values (a project value is that project's path).",
    parameters: {
      type: "object",
      properties: {
        skill: { type: "string", enum: skills.map((s) => s.name), description: "the skill to run" },
        project: { type: "string", enum: projects.map((p) => p.path), description: "the project path to run in" },
        instruction: { type: "string", description: "the concrete task instruction" },
      },
      required: ["skill", "project", "instruction"],
    },
  };
}

function proposeDelegateTool(skills: Skill[], projects: Project[]): ToolSpec {
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
): Promise<ConverseResult> {
  const systemParts = [
    composePersonaPrompt(persona),
    BEHAVIOR_INSTRUCTIONS,
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

  // No skills or projects means propose_run could never validly fire (and an empty
  // enum is an invalid tool schema), so offer no propose_run tool.
  const tools = [
    ...(skills.length > 0 && projects.length > 0 ? [proposeRunTool(skills, projects)] : []),
    ...(delegateAvailable && projects.length > 0 ? [proposeDelegateTool(skills, projects)] : []),
    proposeNoteTool(projects, linkedNote),
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
      const skill = skills.find((s) => s.name === args.skill);
      const project = projects.find((p) => p.path === args.project);
      if (!skill || !project) return { reply: content, model: deps.model };
      const instruction = typeof args.instruction === "string" ? args.instruction : latestUserText;
      return {
        reply: content,
        model: deps.model,
        proposedRun: {
          skillName: skill.name,
          projectPath: project.path,
          composedPrompt: composePrompt(skill, instruction, droppedUrl),
          confidence: 1,
          target: skill.target,
        },
      };
    }

    const delegateCall = toolCalls.find((c) => c.name === "propose_delegate");
    if (delegateCall) {
      const args = (delegateCall.args ?? {}) as { project?: unknown; instruction?: unknown; skill?: unknown };
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
