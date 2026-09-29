import type { ConvoMsg, ConverseDeps, ToolCall, ToolSpec } from "../converse.js";
import type { Memory } from "./memory.js";

export interface ConsolidationResult {
  merges: { ids: string[]; mergedText: string }[];
  drops: string[];
}

const CONSOLIDATE_INSTRUCTIONS =
  "You are tidying the full list of remembered facts. Each line shows the date it was saved. " +
  "Call merge_memories for two or more near-duplicate/overlapping facts, combining them into " +
  "one clearer fact. Call merge_memories with a single id to rewrite one fact — e.g. to turn a " +
  "relative date (\"next week\", \"yesterday\") into an absolute one using its saved date. " +
  "Call drop_memory for a fact that is stale, contradicted by a newer fact (when two facts " +
  "conflict, the more recently saved one wins), or no longer meaningful. Only merge facts about " +
  "the same project (or both global). Only act when confident — leave everything else alone. " +
  "If nothing needs changing, call no tools.";

function mergeTool(ids: string[]): ToolSpec {
  return {
    name: "merge_memories",
    description: "Merge overlapping/duplicate facts into one, or rewrite a single fact (one id).",
    parameters: {
      type: "object",
      properties: {
        ids: {
          type: "array",
          items: { type: "string", enum: ids },
          description: "ids of the facts to merge (one id = rewrite that fact)",
        },
        mergedText: { type: "string", description: "the single combined fact, as one concise sentence" },
      },
      required: ["ids", "mergedText"],
    },
  };
}

function dropTool(ids: string[]): ToolSpec {
  return {
    name: "drop_memory",
    description: "Drop one fact that is stale, contradicted, or no longer useful.",
    parameters: {
      type: "object",
      properties: { id: { type: "string", enum: ids, description: "id of the fact to drop" } },
      required: ["id"],
    },
  };
}

function factsBlock(memories: Memory[]): string {
  return memories
    .map((m) => `- [${m.id}] (saved ${m.createdAt.slice(0, 10)}) ${m.text}${m.projectPath ? ` (project: ${m.projectPath})` : ""}`)
    .join("\n");
}

/** Reviews the memory list for merge/rewrite/drop candidates — mirrors extractMemories's shape
 * (one model call, defensive tool-call parsing) but over existing memories instead of a fresh
 * transcript. The dream pass (dream.ts) runs it in the background and validates the result in
 * code (disjoint groups, same-scope merges, drop cap) before a transactional apply. */
export async function proposeMemoryConsolidation(memories: Memory[], deps: ConverseDeps): Promise<ConsolidationResult> {
  if (memories.length === 0) return { merges: [], drops: [] };
  const ids = memories.map((m) => m.id);
  const messages: ConvoMsg[] = [
    { role: "system", content: CONSOLIDATE_INSTRUCTIONS },
    { role: "user", content: `Remembered facts:\n${factsBlock(memories)}` },
  ];
  let toolCalls: ToolCall[] = [];
  try {
    const res = await deps.chat({ model: deps.model, messages, tools: [mergeTool(ids), dropTool(ids)] });
    toolCalls = res.toolCalls;
  } catch {
    return { merges: [], drops: [] };
  }

  const known = new Set(ids);
  const merges: ConsolidationResult["merges"] = [];
  const drops = new Set<string>();
  for (const call of toolCalls) {
    if (call.name === "merge_memories") {
      const args = (call.args ?? {}) as { ids?: unknown; mergedText?: unknown };
      const mergeIds = Array.isArray(args.ids)
        ? args.ids.filter((id): id is string => typeof id === "string" && known.has(id))
        : [];
      if (mergeIds.length >= 1 && typeof args.mergedText === "string" && args.mergedText.trim()) {
        merges.push({ ids: [...new Set(mergeIds)], mergedText: args.mergedText.trim() });
      }
    } else if (call.name === "drop_memory") {
      const args = (call.args ?? {}) as { id?: unknown };
      if (typeof args.id === "string" && known.has(args.id)) drops.add(args.id);
    }
  }
  // A merged id is already handled — don't also drop it standalone.
  const mergedIds = new Set(merges.flatMap((m) => m.ids));
  return { merges, drops: [...drops].filter((id) => !mergedIds.has(id)) };
}
