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
  /** Saved facts are private to this speaker (chatops DM, or "just for me"); absent = shared. */
  subjectId?: string;
}

// Code-side intent gate: a tool is only offered when the typed message actually asks for it, so
// injected page/tool text on an ordinary turn can't talk the model into saving or deleting.
// Memory-directed phrasing only — "I can't remember the command", "note that the build is slow",
// "forget the last draft", or "delete the API docs" aren't asks to change Bean's memory.
// ponytail: phrase heuristics; a miss just means the user rephrases or uses Persona.
const REMEMBER_INTENT =
  /(?<!\b(?:can'?t|cannot|don'?t|do not|never|not)\s)\b(?:remember|memori[sz]e)\s+(?:that|this|my|me|i|i'm|we|our|to|how|what)\b|\bkeep in mind\b|\b(?:save|add)\b[^.?!]*\b(?:to|in)\s+(?:your\s+)?memory\b/i;
const PRIVATE_SCOPE = /\b(?:just|only)\s+(?:for|between)\s+(?:me|us)\b|\bkeep\s+(?:it|this|that)\s+private\b|\bprivately\b/i;
const SHARED_SCOPE = /\bfor\s+(?:everyone|everybody|all\s+of\s+us|the\s+(?:whole\s+)?(?:household|family|house))\b/i;

// A negation within a few words of the sharing phrase ("not for everyone", "isn't for the family",
// "don't share it for everyone") voids the override, so a doubtful DM stays private. The gap can't
// cross punctuation (opening quotes/parens aside): a correction's "it's not Kim anymore, remember for everyone" still shares.
// ponytail: word-window heuristic; a miss errs private in a DM, and "for everyone" can be re-said.
const NEGATED_SHARED = new RegExp(
  String.raw`\b(?:not|never|no|\w+n['’]t|dont|doesnt|isnt|wont|cant)(?:\s+[\w'’]+){0,3}?\s+["“'‘(]*` + SHARED_SCOPE.source,
  "i",
);

/** Where a chatops remember lands: a DM saves private to the speaker, a channel saves to the
 * household; explicit wording ("just for me" / "for everyone") overrides. */
export function saveScope(typedText: string, direct: boolean): "private" | "shared" {
  if (PRIVATE_SCOPE.test(typedText)) return "private";
  if (SHARED_SCOPE.test(typedText) && !NEGATED_SHARED.test(typedText)) return "shared";
  return direct ? "private" : "shared";
}

const FORGET_INTENT =
  /\bforget\s+(?:that|what|about|this|my|everything|i|i'm)\b|\b(?:delete|remove|erase|drop|clear)\b[^.?!]*\b(?:memor(?:y|ies)|remember\w*)\b/i;

/** Per-turn factory for the direct remember / forget_memory action tools (no confirm card —
 * memory is internal and undoable). `remembered`/`forgotten` collect what this one turn did so
 * the surface can show it (desktop status line, chatops Forget button). Build a fresh one per
 * turn, same as makeGenerateImageTool. */
export function makeMemoryTools(deps: MemoryToolDeps): { tools: ActionTool[]; remembered: Memory[]; forgotten: string[] } {
  const remembered: Memory[] = [];
  const forgotten: string[] = [];
  const known = new Set(deps.memories.map((m) => m.id));
  // Dedupe within the destination scope only: a private fact re-saved "for everyone" is new.
  const texts = new Set(deps.memories.filter((m) => m.subjectId === deps.subjectId).map((m) => m.text.trim().toLowerCase()));

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
      const m: Memory = {
        id: randomUUID(), text: c.text, projectPath: c.projectPath, createdAt: new Date().toISOString(),
        ...(deps.subjectId ? { subjectId: deps.subjectId } : {}),
      };
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
      // The surface's forget may refuse rows the speaker doesn't own (household or another member's).
      return n < ids.length
        ? `Forgot ${n} fact(s). The other ${ids.length - n} weren't removed: already gone, or not yours to forget (only the owner removes household facts or another member's).`
        : `Forgot ${n} fact(s).`;
    },
  };

  const tools = [
    ...(REMEMBER_INTENT.test(deps.latestUserText) ? [remember] : []),
    ...(FORGET_INTENT.test(deps.latestUserText) ? [forget] : []),
  ];
  return { tools, remembered, forgotten };
}
