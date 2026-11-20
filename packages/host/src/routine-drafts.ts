import {
  chatRoutineProblem, draftNames, draftReplaces, hasEnded, routineDraftCard,
  type CliModels, type Destination, type DraftReplaces, type ProposedRoutine, type Routine, type RoutineAuthoring, type RoutineDraftCard,
} from "@bean/core";

// propose_routine on the desktop (#982): the card is the owner's one-tap confirm of a sprout Bean
// drafted. The host keeps each draft (as checked when the card was built); the renderer hands back
// only the card id and Save or Open in editor, so it can't change what gets saved.

export type RoutineDraftResult = { ok: true; name: string; enabled: boolean } | { ok: false; error: string };

export interface RoutineDraftDeps {
  loadRoutines: () => Promise<Routine[]>;
  /** The Sprouts panel's save (`buildRoutineHandlers().save`): the lane, restore and rebase. */
  save: (routine: Routine) => Promise<void>;
  /** Seeds a saved watch from now and turns it on (the scheduler's `enableWatch`). */
  enableWatch: (name: string) => Promise<unknown>;
  cliModels: () => CliModels[];
  destinations: () => Destination[];
  newId: () => string;
  now?: () => Date;
}

interface PendingDraft { routine: Routine; replaces: DraftReplaces | undefined; problem?: string }

/** Unconfirmed cards kept here; the oldest is dropped past this (its Save then says so). */
const PENDING_DRAFTS_MAX = 20;

const EXPIRED = "This draft has expired — ask me again.";

export function buildRoutineDraftHandlers(deps: RoutineDraftDeps) {
  const now = deps.now ?? (() => new Date());
  const pending = new Map<string, PendingDraft>();
  const problemOf = (routine: unknown): string | null =>
    chatRoutineProblem(routine, "desktop", [], deps.cliModels(), undefined, deps.destinations());
  /** Only an exact name replaces: another sprout differing only in case would share its file. */
  const clash = (name: string, routines: Routine[]): string | undefined =>
    routines.find((r) => r.name !== name && r.name.toLowerCase() === name.toLowerCase())?.name;
  return {
    /** converse()'s propose_routine input for a local chat: every name, sorted, for the tool text. */
    authoring: (routines: Routine[]): RoutineAuthoring => {
      const names = draftNames(routines, now());
      return {
        transport: "desktop", existing: names.existing, listed: { live: names.live, archived: names.archived },
        recipients: [], cliModels: deps.cliModels(), destinations: deps.destinations(),
      };
    },
    /** Builds the card and keeps the draft for its Save. */
    propose: async (proposal: ProposedRoutine): Promise<RoutineDraftCard> => {
      const routines = await deps.loadRoutines();
      const name = String(proposal.routine.name);
      const other = proposal.problem ? undefined : clash(name, routines);
      const checked = other ? { ...proposal, problem: `a sprout named "${other}" already exists — pick another name` } : proposal;
      const replaces = draftReplaces(name, routines, now());
      const id = deps.newId();
      pending.set(id, { routine: checked.routine, replaces, ...(checked.problem ? { problem: checked.problem } : {}) });
      while (pending.size > PENDING_DRAFTS_MAX) pending.delete(pending.keys().next().value!);
      return routineDraftCard(id, checked, replaces);
    },
    /** Save = on (a watch seeded from now); "edit" = saved off for the Sprouts editor. Everything
     * the card showed is checked again first: the draft, its end date and what it replaces. */
    save: async (id: unknown, mode: unknown): Promise<RoutineDraftResult> => {
      const p = typeof id === "string" ? pending.get(id) : undefined;
      if (!p) return { ok: false, error: EXPIRED };
      if (mode !== "save" && mode !== "edit") return { ok: false, error: "Unknown action." };
      if (p.problem) return { ok: false, error: p.problem };
      const name = p.routine.name;
      const routines = await deps.loadRoutines();
      const at = now();
      const problem = problemOf(p.routine);
      if (problem) return { ok: false, error: problem };
      const other = clash(name, routines);
      if (other) return { ok: false, error: `a sprout named "${other}" already exists — pick another name` };
      if (draftReplaces(name, routines, at) !== p.replaces) return { ok: false, error: `"${name}" changed since this card — ask me again.` };
      if (hasEnded(p.routine, at)) return { ok: false, error: "Its end date has passed — ask me again with a later one." };
      pending.delete(id as string);
      const enabled = mode === "save";
      // A replacement keeps its display-only "Listed under" (as chatops does).
      const prior = routines.find((r) => r.name === name);
      const draft = prior?.projects && p.routine.projects === undefined ? { ...p.routine, projects: prior.projects } : p.routine;
      try {
        if (draft.watch && enabled) {
          // Saved off, then seeded from now: items already in the feed aren't news.
          await deps.save({ ...draft, enabled: false });
          try {
            await deps.enableWatch(name);
          } catch (err) {
            return { ok: false, error: `Saved "${name}" switched off — couldn't check its feed: ${err instanceof Error ? err.message : String(err)}` };
          }
        } else {
          await deps.save({ ...draft, enabled });
        }
      } catch (err) {
        pending.set(id as string, p); // nothing was saved: the card can try again
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      return { ok: true, name, enabled };
    },
  };
}
