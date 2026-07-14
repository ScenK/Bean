import type { ConvoMsg, ConverseDeps, ToolCall, ToolSpec } from "../converse.js";
import type { Memory } from "./memory.js";

export interface ConsolidationResult {
  merges: { ids: string[]; mergedText: string }[];
  drops: string[];
}

const CONSOLIDATE_INSTRUCTIONS =
  "You are reviewing the full list of remembered facts for duplicates or facts that are no " +
  "longer useful. Call merge_memories for two or more near-duplicate/overlapping facts, " +
  "combining them into one clearer fact. Call drop_memory for a fact that is stale, " +
  "contradicted by a newer fact, or no longer meaningful. Only act when confident — leave " +
  "everything else alone. If nothing needs merging or dropping, call no tools.";

function mergeTool(ids: string[]): ToolSpec {
  return {
    name: "merge_memories",
    description: "Merge two or more overlapping/duplicate facts into one.",
    parameters: {
      type: "object",
      properties: {
        ids: {
          type: "array",
          items: { type: "string", enum: ids },
          description: "ids of the facts to merge (2 or more)",
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
  return memories.map((m) => `- [${m.id}] ${m.text}${m.projectPath ? ` (project: ${m.projectPath})` : ""}`).join("\n");
}

/** Reviews the full memory list for merge/drop candidates — mirrors extractMemories's shape
 * (one model call, defensive tool-call parsing) but over existing memories instead of a fresh
 * transcript. Triggered from bot.ts when the memory count crosses a threshold after a save;
 * the result is confirm-first via ConsolidationProposalStore, same as every other memory change. */
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
      if (mergeIds.length >= 2 && typeof args.mergedText === "string" && args.mergedText.trim()) {
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
