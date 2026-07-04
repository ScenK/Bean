import type { ChatTurn, ConvoMsg, ConverseDeps, ToolCall, ToolSpec } from "../converse.js";
import type { Memory, MemoryCandidate } from "./memory.js";
import type { Project } from "../types.js";

const EXTRACT_INSTRUCTIONS =
  "You are reviewing a finished conversation to decide what — if anything — is worth " +
  "remembering long-term about the user or their projects. Call the remember tool once per " +
  "fact worth keeping. Remember ONLY durable, reusable facts: the user's stable preferences " +
  "and working style, and project conventions, decisions, or gotchas. Do NOT remember one-off " +
  "task details, transient state, anything already in the existing memory list, or small talk. " +
  "If nothing meets that bar, call no tools. Tag a fact with a projectPath only when it is " +
  "clearly about that specific project; otherwise leave it global.";

function rememberTool(projects: Project[]): ToolSpec {
  const properties: Record<string, unknown> = {
    text: { type: "string", description: "the fact to remember, as one concise sentence" },
  };
  if (projects.length > 0) {
    properties.projectPath = {
      type: "string",
      enum: projects.map((p) => p.path),
      description: "the project this fact is about; omit for a global fact about the user",
    };
  }
  return {
    name: "remember",
    description: "Record one durable fact worth remembering about the user or a project.",
    parameters: { type: "object", properties, required: ["text"] },
  };
}

function existingBlock(existing: Memory[]): string {
  if (existing.length === 0) return "Existing memory is empty.";
  return "Already remembered (do not repeat):\n" + existing.map((m) => `- ${m.text}`).join("\n");
}

export async function extractMemories(
  transcript: ChatTurn[],
  existing: Memory[],
  projects: Project[],
  deps: ConverseDeps,
): Promise<MemoryCandidate[]> {
  if (transcript.length === 0) return [];

  const messages: ConvoMsg[] = [
    { role: "system", content: `${EXTRACT_INSTRUCTIONS}\n\n${existingBlock(existing)}` },
    { role: "user", content: `Conversation:\n${transcript.map((t) => `${t.role}: ${t.content}`).join("\n")}` },
  ];

  let toolCalls: ToolCall[] = [];
  try {
    const res = await deps.chat({ model: deps.model, messages, tools: [rememberTool(projects)] });
    toolCalls = res.toolCalls;
  } catch {
    return [];
  }

  const known = new Set(projects.map((p) => p.path));
  const seen = new Set(existing.map((m) => m.text.trim().toLowerCase()));
  const out: MemoryCandidate[] = [];
  for (const call of toolCalls) {
    if (call.name !== "remember") continue;
    const args = (call.args ?? {}) as { text?: unknown; projectPath?: unknown };
    if (typeof args.text !== "string" || args.text.trim() === "") continue;
    const key = args.text.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const projectPath =
      typeof args.projectPath === "string" && known.has(args.projectPath) ? args.projectPath : undefined;
    out.push({ text: args.text.trim(), projectPath });
  }
  return out;
}
