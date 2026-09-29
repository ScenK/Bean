import { randomUUID } from "node:crypto";
import type { ActionTool } from "../converse.js";
import type { Project } from "../types.js";
import type { Memory } from "./memory.js";
import { rememberToolSpec, validateCandidate } from "./extract.js";

export interface MemoryToolDeps {
  append: (additions: Memory[]) => Promise<void>;
  /** Idempotent delete; returns how many rows went. */
  forget: (ids: string[]) => Promise<number>;
  /** The list converse() recalls from this turn — forget ids must come from it. */
  memories: Memory[];
  projects: Project[];
  /** The user's latest *typed* message. remember quotes must come from it — offer these tools
   * only on a typed turn, never on a delegate loopback or composed skill prompt. */
  latestUserText: string;
}

/** Per-turn factory for the direct remember / forget_memory action tools (no confirm card —
 * memory is internal and undoable). `remembered`/`forgotten` collect what this one turn did so
 * the surface can show it (desktop status line, chatops Forget button). Build a fresh one per
 * turn, same as makeGenerateImageTool. */
export function makeMemoryTools(deps: MemoryToolDeps): { tools: ActionTool[]; remembered: Memory[]; forgotten: string[] } {
  const remembered: Memory[] = [];
  const forgotten: string[] = [];
  const known = new Set(deps.memories.map((m) => m.id));
  const texts = new Set(deps.memories.map((m) => m.text.trim().toLowerCase()));

  const remember: ActionTool = {
    spec: rememberToolSpec(
      deps.projects,
      "Save one durable fact right away. Call only when the user's LATEST message directly asks " +
        "you to remember something (\"remember that…\"). Banter, messages addressed to someone " +
        "else, or remarks about you needing to learn are NOT requests to remember.",
    ),
    run: async (args) => {
      const c = validateCandidate(args, [deps.latestUserText], deps.projects);
      if (typeof c === "string") return `error: not remembered — ${c}`;
      if (texts.has(c.text.toLowerCase())) return "Already remembered.";
      // randomUUID: `id` is a SQLite PRIMARY KEY shared across processes (desktop + bots).
      const m: Memory = { id: randomUUID(), text: c.text, projectPath: c.projectPath, createdAt: new Date().toISOString() };
      await deps.append([m]);
      texts.add(c.text.toLowerCase());
      remembered.push(m);
      return `Remembered: ${m.text}`;
    },
  };

  const forget: ActionTool = {
    spec: {
      name: "forget_memory",
      description:
        "Delete remembered facts the user asks you to forget. Use the [id]s shown in what you " +
        "remember; call only when the user's latest message asks you to forget something.",
      parameters: {
        type: "object",
        properties: { ids: { type: "array", items: { type: "string" }, description: "ids of the facts to forget" } },
        required: ["ids"],
      },
    },
    run: async (args) => {
      const raw = (args as { ids?: unknown })?.ids;
      const ids = Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string" && known.has(id)) : [];
      if (ids.length === 0) return "error: no matching remembered facts — check the ids.";
      const n = await deps.forget(ids);
      forgotten.push(...ids);
      return `Forgot ${n} fact(s).`;
    },
  };

  return { tools: [remember, forget], remembered, forgotten };
}
