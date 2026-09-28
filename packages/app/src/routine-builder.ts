import {
  briefToRoutine, buildStageFromLine, composePrompt, describeRoutineError, discoverFeedUrl, looksLikeFeed,
  parseBuildResult,
} from "@bean/core";
import type { BuildStage, Routine, RoutineBrief, RoutineWatch, Skill, WatchItem } from "@bean/core";

/** One in-flight (or failed) build, as the Routines list and the 2b screen show it. A successful
 * build leaves no entry: the saved-disabled routine itself is the "needs review" row. */
export interface RoutineBuildView {
  name: string;
  brief: RoutineBrief;
  status: "building" | "failed";
  stage: BuildStage;
  detail?: string;
  startedAt: string;
  error?: string;
  exitCode?: number;
}

export interface AgentHandle { done: Promise<string>; cancel: () => void }

export interface RoutineBuilderDeps {
  loadRoutines: () => Promise<Routine[]>;
  saveRoutine: (routine: Routine) => Promise<void>;
  loadSkills: () => Promise<Skill[]>;
  saveSkill: (name: string, markdown: string) => Promise<void>;
  pollWatch: (watch: RoutineWatch) => Promise<WatchItem[]>;
  fetchText: (url: string) => Promise<string>;
  /** Runs the build agent headless (delegate path) in a scratch dir; resolves with its final message. */
  startAgent: (prompt: string, brief: RoutineBrief, onLine: (line: string) => void) => AgentHandle;
  tools: () => string[];
  now?: () => Date;
}

const BRIEF_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Builds live in the main process, so closing the Routines window never loses one — it stays in
 * the list as "building…" (or "build failed") until it finishes or is dismissed. */
export function createRoutineBuilder(deps: RoutineBuilderDeps) {
  const now = deps.now ?? (() => new Date());
  const builds = new Map<string, RoutineBuildView>();
  const cancels = new Map<string, () => void>();

  const live = (entry: RoutineBuildView): boolean => builds.get(entry.name) === entry;
  const update = (entry: RoutineBuildView, patch: Partial<RoutineBuildView>): void => {
    if (live(entry)) Object.assign(entry, patch);
  };
  const fail = (entry: RoutineBuildView, error: string, exitCode?: number): void =>
    update(entry, { status: "failed", error, ...(exitCode !== undefined ? { exitCode } : {}) });

  async function resolveFeed(source: string | undefined): Promise<string> {
    let url: URL;
    try { url = new URL(source ?? ""); } catch { throw new Error("paste the channel or site address (an http(s) URL) as the watch source"); }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("the watch source must be an http(s) URL");
    const body = await deps.fetchText(url.toString());
    if (looksLikeFeed(body)) return url.toString();
    const feed = discoverFeedUrl(body, url.toString());
    if (!feed) throw new Error(`couldn't find an RSS/Atom feed on ${url.host} — paste the feed URL itself`);
    return feed;
  }

  async function save(entry: RoutineBuildView, routine: Routine, skills: { name: string; markdown: string }[] = []): Promise<void> {
    const error = describeRoutineError(routine);
    if (error) throw new Error(`the built routine is invalid: ${error}`);
    if ((await deps.loadRoutines()).some((r) => r.name === routine.name)) {
      throw new Error(`a routine named "${routine.name}" already exists — rename the brief`);
    }
    if (!live(entry)) return; // cancelled while validating
    await deps.saveRoutine({ ...routine, enabled: false });
    // Drafted skills go in after the routine landed, and only under a free name — never
    // overwrite one the user has. A skill-save failure leaves a disabled routine to review.
    // Best-effort: the routine is saved (and reviewable) either way, so a skill write failure
    // must not flip the build to "failed · nothing was saved".
    try {
      const taken = new Set((await deps.loadSkills()).map((s) => s.name));
      for (const s of skills) if (!taken.has(s.name)) await deps.saveSkill(s.name, s.markdown);
    } catch (err) {
      console.error(`bean: couldn't save a skill drafted for "${routine.name}"`, err);
    }
    builds.delete(entry.name);
  }

  async function buildFeed(entry: RoutineBuildView): Promise<void> {
    update(entry, { stage: "command", detail: "Finding the feed" });
    const url = await resolveFeed(entry.brief.source);
    const watch: RoutineWatch = { kind: "feed", url };
    update(entry, { stage: "tested", detail: url });
    const items = await deps.pollWatch(watch);
    update(entry, { stage: "validating", detail: `${items.length} item${items.length === 1 ? "" : "s"} in the feed` });
    await save(entry, briefToRoutine(entry.brief, watch));
  }

  async function buildCommand(entry: RoutineBuildView): Promise<void> {
    const skill = (await deps.loadSkills()).find((s) => s.name === "build-routine");
    if (!skill) throw new Error("the build-routine skill is missing from this install");
    const instruction = [
      "Brief:",
      "```json",
      JSON.stringify(entry.brief, null, 2),
      "```",
      `Installed CLIs on PATH: ${deps.tools().join(", ") || "none detected"}.`,
    ].join("\n");
    const handle = deps.startAgent(composePrompt(skill, instruction), entry.brief, (line) => {
      const hit = buildStageFromLine(line);
      if (hit) update(entry, { stage: hit.stage, detail: hit.detail });
      else if (line.trim()) update(entry, { detail: line.trim().slice(0, 200) });
    });
    cancels.set(entry.name, handle.cancel);
    const text = await handle.done;
    cancels.delete(entry.name);
    if (!live(entry)) return;
    const result = parseBuildResult(text, entry.brief);
    if (result.testError) { fail(entry, result.testError.message, result.testError.exitCode); return; }
    const routine = result.routine!;
    update(entry, { stage: "validating", detail: "Bean re-runs the command" });
    try {
      await deps.pollWatch(routine.watch!);
    } catch (err) {
      throw new Error(`Bean re-ran the command and it failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    await save(entry, routine, result.skills);
  }

  return {
    list: (): RoutineBuildView[] => [...builds.values()].map((b) => ({ ...b })),
    async start(brief: RoutineBrief): Promise<void> {
      // Trust boundary: the name becomes a file and a scratch dir name — kebab-case only.
      if (typeof brief?.name !== "string" || !BRIEF_NAME.test(brief.name)) {
        throw new Error("routine names are lowercase letters, digits and dashes (e.g. review-queue)");
      }
      if (brief.trigger !== "watch") throw new Error("only watch routines are built — a scheduled one opens in the editor");
      if (builds.get(brief.name)?.status === "building") throw new Error(`"${brief.name}" is already building`);
      if ((await deps.loadRoutines()).some((r) => r.name === brief.name)) {
        throw new Error(`a routine named "${brief.name}" already exists — pick another name`);
      }
      const entry: RoutineBuildView = { name: brief.name, brief, status: "building", stage: "sent", startedAt: now().toISOString() };
      builds.set(brief.name, entry);
      void (brief.sourceKind === "feed" ? buildFeed(entry) : buildCommand(entry)).catch((err: unknown) => {
        cancels.delete(entry.name);
        fail(entry, err instanceof Error ? err.message : String(err));
      });
    },
    cancel(name: string): void {
      cancels.get(name)?.();
      cancels.delete(name);
      builds.delete(name);
    },
    dismiss(name: string): void {
      if (builds.get(name)?.status === "failed") builds.delete(name);
    },
    cancelAll(): void {
      for (const cancel of cancels.values()) cancel();
      cancels.clear();
    },
  };
}
