import type { AliasInUse, AliasResult, ChatopsSurface, Destination, DestinationKey, Routine, RoutineChatopsSink } from "@bean/core";

// Settings → ChatOps → Destinations (#686): list the conversations the bots have seen and let the
// owner name, retarget and clear their aliases. Every rule (uniqueness, the referenced-alias
// guard, same-platform retarget) lives in core's destinations.ts; this only feeds it the sprout
// references and validates what the renderer sent.

/** One Settings row. Platform names are untrusted display data — the renderer shows them as text. */
export interface DestinationView extends Destination {
  /** Display label (alias, else a de-duplicated platform name); absent = unnamed and unlabelled. */
  label?: string;
  /** Sprouts whose chat sinks name this row's alias — non-empty = rename/clear refused. */
  usedBy: string[];
  /** For a row with no platform name: who talks there ("1:1 · Ana", "with Ana, Bo"). */
  hint?: string;
}

/** The sprouts naming `alias` in a chat sink. */
export const aliasUsers = (routines: readonly Routine[]): AliasInUse => (alias) =>
  routines.filter((r) => (r.sinks.chatops ?? []).some((c) => c.alias === alias)).map((r) => r.name);

/** A legacy raw-id sink pointing at `key` (a plain channel id, not a user DM). */
const rawSinkFor = (key: DestinationKey) => (c: RoutineChatopsSink): boolean =>
  c.transport === key.surface && c.channel === key.conversationId;

/** "Name it" on a legacy raw-id sink: the result names the sprouts rewritten to the alias. */
export type NameRawResult = { ok: true; alias: string; sprouts: string[] } | { ok: false; error: string };

export interface DestinationHandlerDeps {
  dbFile: string;
  loadRoutines: () => Promise<Routine[]>;
  /** Unchecked write (no clis.json check) — "Name it" only swaps a sink's id for its alias. */
  saveRoutine: (routine: Routine) => Promise<void>;
  owners: () => Promise<Array<{ ownerName: string }>>;
  listDestinations: (file: string) => Destination[];
  destinationLabel: (row: Destination, rows: readonly Destination[]) => string | undefined;
  ambientSpeakers: (file: string, conversationId: string) => string[];
  setAlias: (file: string, key: DestinationKey, alias: string, inUse: AliasInUse) => AliasResult;
  clearAlias: (file: string, key: DestinationKey, inUse: AliasInUse) => AliasResult;
  retargetAlias: (file: string, alias: string, to: DestinationKey, inUse: AliasInUse) => AliasResult;
}

const toKey = (surface: unknown, conversationId: unknown): DestinationKey => {
  if ((surface !== "discord" && surface !== "teams") || typeof conversationId !== "string" || !conversationId) {
    throw new Error("malformed destination");
  }
  return { surface: surface as ChatopsSurface, conversationId };
};

export function buildDestinationHandlers(deps: DestinationHandlerDeps) {
  const inUse = async (): Promise<AliasInUse> => aliasUsers(await deps.loadRoutines());
  const hint = (row: Destination, ownerNames: ReadonlySet<string>): string | undefined => {
    if (row.platformName) return undefined;
    const others = deps.ambientSpeakers(deps.dbFile, row.conversationId).filter((n) => !ownerNames.has(n));
    if (!others.length) return undefined;
    // Teams 1:1 human chats with Bean added: `19:<aad>_<aad>@unq.gbl.spaces`, no topic.
    return row.conversationId.endsWith("@unq.gbl.spaces") ? `1:1 · ${others[0]}` : `with ${others.slice(0, 3).join(", ")}`;
  };
  return {
    list: async (): Promise<DestinationView[]> => {
      const [rows, used, owners] = await Promise.all([deps.listDestinations(deps.dbFile), inUse(), deps.owners()]);
      const ownerNames = new Set(owners.map((o) => o.ownerName));
      return rows.map((row) => {
        const label = deps.destinationLabel(row, rows);
        const h = hint(row, ownerNames);
        return { ...row, ...(label ? { label } : {}), usedBy: row.alias ? [...used(row.alias)] : [], ...(h ? { hint: h } : {}) };
      });
    },
    name: async (surface: unknown, conversationId: unknown, alias: unknown): Promise<AliasResult> => {
      const key = toKey(surface, conversationId);
      if (typeof alias !== "string") throw new Error("malformed name");
      return deps.setAlias(deps.dbFile, key, alias, await inUse());
    },
    clear: async (surface: unknown, conversationId: unknown): Promise<AliasResult> =>
      deps.clearAlias(deps.dbFile, toKey(surface, conversationId), await inUse()),
    /** Names the conversation a legacy raw-id sink points at, then rewrites that id to the alias
     * in every sprout using it. The renderer lists those sprouts before calling. */
    nameRaw: async (surface: unknown, conversationId: unknown, alias: unknown): Promise<NameRawResult> => {
      const key = toKey(surface, conversationId);
      if (typeof alias !== "string") throw new Error("malformed name");
      const routines = await deps.loadRoutines();
      const named = deps.setAlias(deps.dbFile, key, alias, aliasUsers(routines));
      if (!named.ok) return named;
      const saved = deps.listDestinations(deps.dbFile)
        .find((r) => r.surface === key.surface && r.conversationId === key.conversationId)?.alias;
      if (!saved) return { ok: false, error: "That conversation isn't known." };
      const raw = rawSinkFor(key);
      const users = routines.filter((r) => (r.sinks.chatops ?? []).some(raw));
      for (const r of users) {
        const chatops = (r.sinks.chatops ?? []).map((c) => (raw(c) ? { transport: c.transport, alias: saved } : c));
        await deps.saveRoutine({ ...r, sinks: { ...r.sinks, chatops } });
      }
      return { ok: true, alias: saved, sprouts: users.map((r) => r.name) };
    },
    retarget: async (alias: unknown, surface: unknown, conversationId: unknown): Promise<AliasResult> => {
      const key = toKey(surface, conversationId);
      if (typeof alias !== "string") throw new Error("malformed name");
      return deps.retargetAlias(deps.dbFile, alias, key, await inUse());
    },
  };
}
