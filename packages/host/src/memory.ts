import { randomUUID } from "node:crypto";
import type {
  ChatRequest, ChatTurn, ConverseDeps, ConverseResult, DreamDigest, ExtractResult, Memory, Project,
} from "@bean/core";

export interface MemoryHandlerDeps {
  loadMemories: (file: string) => Promise<Memory[]>;
  // Every write is insert-only or per-row: auto-remember, a chatops bot, and the Persona panel
  // can all write at once, and a whole-list replace would silently drop one of them
  // (.memory/safety-memory-append-vs-replace.md).
  appendMemories: (file: string, additions: Memory[]) => Promise<void>;
  updateMemory: (file: string, id: string, text: string) => Promise<void>;
  updateMemoryCategory: (file: string, id: string, category: string | null) => Promise<void>;
  renameMemoryCategory: (file: string, from: string, to: string) => Promise<number>;
  ownerSubjectIds?: () => Promise<string[]>;
  /** Channel captures' current names by `sourceId` (`<surface>:<conversationId>`): the Settings
   * alias, else the platform name. Display only; a missing id keeps the row's capture-time title. */
  sourceLabels?: () => Map<string, string>;
  deleteMemories: (file: string, ids: string[]) => Promise<string[]>;
  extractMemories: (
    transcript: ChatTurn[], existing: Memory[], projects: Project[], deps: ConverseDeps, opts?: { latestTurn?: boolean; categorize?: boolean },
  ) => Promise<ExtractResult>;
  loadProjects: (file: string) => Promise<Project[]>;
  converse: ConverseDeps["chat"];
  getModel: () => string;
  /** Config `autoMemory`, read per close so a Settings toggle applies without restart. */
  autoMemory: () => boolean;
  /** A non-empty auto-remember batch landed — main shows the avatar bubble (and checks dream).
   * `pendingIds` reads the batch whose Undo is live *now* (a later close may have replaced it). */
  onMemoryBatch?: (batch: Memory[], pendingIds: () => string[]) => void;
  /** A close-time save broke (model call or store) — main shows a sticky failure bubble, so
   * "broken" no longer looks like "nothing worth saving". */
  onMemoryFailure?: () => void;
  /** A per-turn capture saved something — main checks dream (no bubble: the chat's
   * "Memory updated" row is the receipt). */
  onTurnBatch?: (pendingIds: () => string[]) => void;
  getLastDream: (file: string) => Promise<DreamDigest | undefined>;
  restoreDreamRun: (file: string, runId: string) => Promise<{ restored: number; skipped: number }>;
  dreamDetails: (file: string, runId: string) => Promise<{ before: string[]; after?: string }[]>;
  dbFile: string;
  projectsFile: string;
}

/** The latest auto-remember batch — Persona's "Just remembered" + Undo. Held in main's memory
 * only: the Undo window lasts until the next batch (or an app restart). */
export interface MemoryBatch { ids: string[]; at: string }

/** A close-time transcript turn; `id` = the renderer's turn id (typed turns), matched against
 * the turns per-turn capture already handled. */
export type CloseTurn = ChatTurn & { id?: string };

export function buildMemoryHandlers(deps: MemoryHandlerDeps) {
  let lastBatch: MemoryBatch | undefined;
  // Per chat (mount id — see buildChatMounts), dropped at its close or release: typed turns whose
  // per-turn capture is in flight or done (close catch-up won't re-cite them), and the ids those
  // captures saved — still undoable from the chat's "Memory updated" rows, so dream leaves them alone.
  // `incognito` = the chat's live 🕶 chip (a request's flag is a send-time snapshot); `queue`
  // runs captures one at a time so facts are saved — and timestamped — in turn order.
  type ChatWindowState = { turns: Set<string>; ids: string[]; incognito: boolean; queue: Promise<unknown> };
  const windows = new Map<string, ChatWindowState>();
  // Chats already closed/released: a reply that settles after close must not recreate their state
  // (and lose the chip) — close catch-up already covered that turn under the close-time flag.
  // ponytail: one UUID per chat mount per app run; mount ids are never re-attached.
  const closed = new Set<string>();
  const windowState = (key: string): ChatWindowState => {
    let w = windows.get(key);
    if (!w) windows.set(key, w = { turns: new Set(), ids: [], incognito: false, queue: Promise.resolve() });
    return w;
  };
  const close = (key: string): void => {
    windows.delete(key);
    closed.add(key);
  };
  const pendingIds = (): string[] => [...(lastBatch?.ids ?? []), ...[...windows.values()].flatMap((w) => w.ids)];
  const extract = async (transcript: ChatTurn[], extra: Memory[], latestTurn: boolean): Promise<Memory[]> => {
    const [existing, projects] = await Promise.all([
      deps.loadMemories(deps.dbFile),
      deps.loadProjects(deps.projectsFile),
    ]);
    const { candidates, rejected, failed } = await deps.extractMemories(
      transcript, extra.length ? [...existing, ...extra] : existing, projects,
      { chat: deps.converse, model: deps.getModel() }, { latestTurn, categorize: true },
    );
    // Counts only — a rejected candidate's text may be exactly what validation refused to keep.
    if (rejected > 0) console.warn(`auto-remember: rejected ${rejected} candidate(s)`);
    if (failed) throw new Error("auto-remember: extraction model call failed");
    const at = new Date().toISOString();
    return candidates.map((c) => ({
      id: randomUUID(), text: c.text, projectPath: c.projectPath, createdAt: at, ...(c.category ? { category: c.category } : {}),
      ...(c.context ? { context: c.context } : {}),
    }));
  };
  const remember = async (transcript: ChatTurn[], extra: Memory[]): Promise<Memory[]> => {
    const batch = await extract(transcript, extra, false);
    if (batch.length === 0) return [];
    const at = batch[0]!.createdAt;
    // Pending before the insert lands, so a dream snapshot can never see these rows without
    // also seeing them as the live Undo batch it must leave alone.
    const prevBatch = lastBatch;
    lastBatch = { ids: batch.map((m) => m.id), at };
    try {
      await deps.appendMemories(deps.dbFile, batch);
    } catch (err) {
      lastBatch = prevBatch;
      throw err;
    }
    deps.onMemoryBatch?.(batch, pendingIds);
    return batch;
  };
  return {
    list: async (): Promise<Memory[]> => {
      const labels = deps.sourceLabels?.();
      return (await deps.loadMemories(deps.dbFile)).map((m) => {
        const label = m.sourceId && labels?.get(m.sourceId);
        return label ? { ...m, sourceTitle: label } : m;
      });
    },
    append: (additions: Memory[]): Promise<void> => deps.appendMemories(deps.dbFile, additions),
    update: (id: string, text: string): Promise<void> => deps.updateMemory(deps.dbFile, id, text),
    updateCategory: (id: string, category: string | null): Promise<void> => deps.updateMemoryCategory(deps.dbFile, id, category),
    renameCategory: (from: string, to: string): Promise<number> => deps.renameMemoryCategory(deps.dbFile, from, to),
    ownerIds: (): Promise<string[]> => deps.ownerSubjectIds?.() ?? Promise.resolve([]),
    delete: async (ids: string[]): Promise<number> => (await deps.deleteMemories(deps.dbFile, ids)).length,
    /** After a chat reply: capture this typed turn's facts (only it is citable; a few prior
     * turns are context). Skipped when the turn used the explicit remember/forget tools or errored. */
    captureTurn: async (key: string, req: ChatRequest, result: ConverseResult): Promise<Memory[]> => {
      if (req.source !== "typed" || req.incognito || !deps.autoMemory() || result.error) return [];
      if (closed.has(key)) return [];
      const w = windowState(key);
      if (w.incognito) return [];
      if (req.turnId) w.turns.add(req.turnId);
      // Handled before skipping: close catch-up must not re-cite a turn that just saved or
      // forgot something explicitly (a forgotten fact would be re-saved from its own words).
      if (result.remembered?.length || result.forgotten?.length) return [];
      // Re-checked before the model call and again before the insert: the chip can be switched
      // on while this turn waits or extracts.
      const offRecord = (): boolean => w.incognito || !deps.autoMemory();
      const run = w.queue.then(async (): Promise<Memory[]> => {
        if (offRecord()) return [];
        const batch = await extract([...req.history, { role: "user", content: req.message, source: "typed" }], [], true);
        if (batch.length === 0 || offRecord()) return [];
        w.ids.push(...batch.map((m) => m.id)); // pending before the insert, same as the close batch
        await deps.appendMemories(deps.dbFile, batch);
        deps.onTurnBatch?.(pendingIds);
        return batch;
      }).catch((err: unknown) => {
        if (req.turnId) w.turns.delete(req.turnId);
        // Chat still open: close catch-up retries this turn. Already closed: catch-up skipped
        // it as in flight, so nothing will — surface it like a failed close save.
        if (windows.get(key) !== w) deps.onMemoryFailure?.();
        throw err;
      });
      w.queue = run.catch(() => {});
      return run;
    },
    /** A chat's 🕶 chip changed — gates its per-turn captures from now on. */
    setIncognito: (key: string, on: boolean): void => {
      if (!closed.has(key)) windowState(key).incognito = on;
    },
    /** A chat's live 🕶 chip — also keeps its delegate instructions out of `delegate_runs`. */
    isIncognito: (key: string): boolean => windows.get(key)?.incognito ?? false,
    /** The chat mount is gone without a close catch-up: drop its state; a late reply captures nothing. */
    release: close,
    /** Chat close: a catch-up — extract → validate → append in the background, no review
     * card. Turns per-turn capture handled stay as context only; `rejected` = facts the user
     * undid in this chat, shown to extraction as already remembered so they aren't re-saved. */
    rememberOnClose: async (
      transcript: CloseTurn[], opts: { incognito?: boolean; rejected?: string[]; key?: string },
    ): Promise<Memory[]> => {
      const w = opts.key === undefined ? undefined : windows.get(opts.key);
      // An in-flight capture keeps its own reference to `w` — the close-time chip must reach it.
      if (w && opts.incognito) w.incognito = true;
      if (opts.key !== undefined) close(opts.key);
      if (opts.incognito || !deps.autoMemory()) return [];
      const turns = transcript.map(({ id, ...t }): ChatTurn => (id && w?.turns.has(id) ? { ...t, source: undefined } : t));
      const rejected = (opts.rejected ?? []).map((text): Memory => ({ id: "", text, createdAt: "" }));
      try {
        return await remember(turns, rejected);
      } catch (err) {
        deps.onMemoryFailure?.();
        throw err;
      }
    },
    batch: (): MemoryBatch | undefined => lastBatch,
    lastDream: (): Promise<DreamDigest | undefined> => deps.getLastDream(deps.dbFile),
    /** Undo last dream: restores only groups untouched since; `skipped` = kept user edits. */
    undoLastDream: async (): Promise<{ restored: number; skipped: number }> => {
      const d = await deps.getLastDream(deps.dbFile);
      return d && !d.undone ? deps.restoreDreamRun(deps.dbFile, d.runId) : { restored: 0, skipped: 0 };
    },
    dreamDetails: async (): Promise<{ before: string[]; after?: string }[]> => {
      const d = await deps.getLastDream(deps.dbFile);
      return d ? deps.dreamDetails(deps.dbFile, d.runId) : [];
    },
    /** Deletes exactly the last batch's ids (rows edited since are still that batch's rows). */
    undoBatch: async (): Promise<number> => {
      if (!lastBatch) return 0;
      const n = (await deps.deleteMemories(deps.dbFile, lastBatch.ids)).length;
      lastBatch = undefined;
      return n;
    },
  };
}

// Renderer payloads are erased types by the time they cross IPC — keep only well-formed turns.
export function toTranscript(v: unknown): CloseTurn[] {
  if (!Array.isArray(v)) return [];
  const sources = new Set(["typed", "loopback", "ambient", "skill", "summary"]);
  return v.flatMap((t): CloseTurn[] => {
    const o = t as Partial<CloseTurn> | null;
    if (!o || (o.role !== "user" && o.role !== "assistant") || typeof o.content !== "string") return [];
    const turn: CloseTurn = { role: o.role, content: o.content, source: sources.has(o.source as string) ? o.source : undefined };
    if (typeof o.id === "string") turn.id = o.id;
    return [turn];
  });
}
