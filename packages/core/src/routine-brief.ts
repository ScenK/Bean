import type { ConvoMsg } from "./converse.js";
import type { CliName } from "./launcher.js";
import { describeRoutineError, type Routine, type RoutineChatopsSink, type RoutineSinks, type RoutineStep, type RoutineWatch } from "./routine-store.js";
import { unfence } from "./routine-runner.js";

/** The editable brief Bean drafts from one sentence (screen 2a). It covers the whole saved
 * routine, so nothing gets filled in later; `missing` is the only thing that changes shape. */
export interface RoutineBrief {
  name: string;
  description?: string;
  trigger: "schedule" | "watch";
  cron?: string; // trigger = schedule
  /** trigger = watch: what to watch, as plain text ("Open PRs where my review is requested")
   * or a URL for a site/channel/feed. */
  source?: string;
  sourceKind?: "feed" | "command";
  /** The CLI the watch command will use (e.g. "gh"), shown as "via gh · installed ✓". */
  via?: string;
  everyMinutes?: number;
  /** Watch only: true = just notify on each new item; false = run the steps on each one. */
  notifyOnly?: boolean;
  steps: RoutineStep[];
  sinks: RoutineSinks;
  /** Fields the sentence didn't pin down, each with a plain question for the user. */
  missing: { field: string; question: string }[];
  builder?: { cli?: CliName; model?: string };
}

export interface BriefContext {
  /** Extra CLIs found on the user's PATH (gh, glab, acli, …). */
  tools: string[];
  projects: { name: string; path: string }[];
  skills: { name: string; description: string }[];
  clis: CliName[];
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const str = (v: unknown): v is string => typeof v === "string";

export function briefMessages(sentence: string, ctx: BriefContext, previous?: RoutineBrief): ConvoMsg[] {
  const system = [
    "You turn one sentence into a routine brief for Bean, a desktop assistant. Reply with ONE JSON object and nothing else.",
    "Shape:",
    `{"name": "kebab-case", "description": "one line, first person, what it does",
 "trigger": "schedule" | "watch",
 "cron": "5-field local-time cron (schedule only)",
 "source": "watch only: plain text of WHAT to watch, or the URL of a site/channel/feed",
 "sourceKind": "feed" (a URL: YouTube channel, blog, RSS/Atom) | "command" (anything needing a CLI or API),
 "via": "the CLI a command watch would use, e.g. gh",
 "everyMinutes": 15,
 "notifyOnly": true | false,
 "steps": [{"kind": "delegate", "skill": "<skill name>", "project": "<project path>", "instruction": "..."} | {"kind": "chat", "skill": "<optional>", "instruction": "..."}],
 "sinks": {"chatops": [{"transport": "discord" | "teams", "channel"?: "id"}], "note": true, "notify": true},
 "missing": [{"field": "steps.0.project" | "sinks" | "source" | "cron" | ..., "question": "plain question"}]}`,
    "Rules:",
    "- trigger is \"watch\" when the user wants something to happen when something new appears (a new video, post, PR, ticket, assignment); \"schedule\" for a fixed time.",
    "- For a YouTube handle like @name use source \"https://www.youtube.com/@name\" and sourceKind \"feed\".",
    "- notifyOnly = true when the user only wants to be told (\"ping me\", \"let me know\"); then steps is []. Otherwise one step per thing Bean should do to each new item; delegate for code/repo/review work, chat for summarising/writing.",
    "- everyMinutes: 5 for work queues (PRs, tickets), 15 for feeds, unless the user says otherwise (hourly = 60, daily = 1440).",
    "- Pick a step skill only from the skill list; for a delegate step set project only when the user named one from the project list.",
    "- Destinations: DM on Discord/Teams = a chatops sink with no channel; set channel only when the user gives a specific channel/conversation id. Only include sinks the user asked for; if none, ask in missing.",
    "- missing: only what the sentence truly leaves open. Leave a field out rather than invent it.",
    `Installed CLIs: ${ctx.tools.join(", ") || "none detected"}.`,
    `Coding agents: ${ctx.clis.join(", ") || "none"}.`,
    `Projects: ${ctx.projects.map((p) => `${p.name} (${p.path})`).join("; ") || "none"}.`,
    `Skills: ${ctx.skills.map((s) => `${s.name}: ${s.description}`).join("; ") || "none"}.`,
  ].join("\n");
  const messages: ConvoMsg[] = [{ role: "system", content: system }];
  if (previous) messages.push({ role: "user", content: `Current brief (keep what still fits):\n${JSON.stringify(previous)}` });
  messages.push({ role: "user", content: sentence });
  return messages;
}

function parseJsonObject(raw: string): Record<string, unknown> {
  const text = unfence(raw.trim());
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Bean's model didn't return a brief — try rephrasing");
  const parsed: unknown = JSON.parse(text.slice(start, end + 1));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("brief must be a JSON object");
  return parsed as Record<string, unknown>;
}

function cleanStep(v: unknown, ctx: BriefContext): RoutineStep | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const s = v as Record<string, unknown>;
  const instruction = str(s.instruction) ? s.instruction.trim() : "";
  const skill = str(s.skill) && ctx.skills.some((k) => k.name === s.skill) ? s.skill : undefined;
  if (s.kind === "delegate") {
    const project = str(s.project) && ctx.projects.some((p) => p.path === s.project) ? s.project : undefined;
    return { kind: "delegate", skill: skill ?? "", ...(project ? { project } : {}), instruction };
  }
  return { kind: "chat", ...(skill ? { skill } : {}), instruction };
}

function cleanSinks(v: unknown): RoutineSinks {
  if (typeof v !== "object" || v === null) return {};
  const s = v as Record<string, unknown>;
  const chatops: RoutineChatopsSink[] = [];
  for (const c of Array.isArray(s.chatops) ? s.chatops as (Record<string, unknown> | null)[] : []) {
    const transport = c?.transport;
    if ((transport !== "discord" && transport !== "teams") || chatops.some((x) => x.transport === transport)) continue;
    const channel = typeof c?.channel === "string" ? c.channel.trim() : "";
    chatops.push({ transport, ...(channel ? { channel } : {}) });
  }
  return {
    ...(chatops.length > 0 ? { chatops } : {}),
    ...(s.note === true ? { note: true } : {}),
    ...(s.notify === true ? { notify: true } : {}),
  };
}

const slug = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63) || "new-routine";

/** Sanitizes the model's brief: unknown skills/projects dropped (and asked about), bad values
 * reset to safe defaults. Throws only when the reply isn't JSON at all. */
export function parseBrief(raw: string, ctx: BriefContext): RoutineBrief {
  const b = parseJsonObject(raw);
  const trigger = b.trigger === "schedule" ? "schedule" : "watch";
  const name = str(b.name) && NAME_RE.test(b.name) ? b.name : slug(str(b.name) ? b.name : "");
  const missing = Array.isArray(b.missing)
    ? b.missing.flatMap((m) => {
      const r = m as Record<string, unknown> | null;
      return r && str(r.field) && str(r.question) && r.question.trim() ? [{ field: r.field, question: r.question.trim() }] : [];
    })
    : [];
  const steps = Array.isArray(b.steps) ? b.steps.map((s) => cleanStep(s, ctx)).filter((s): s is RoutineStep => s !== undefined) : [];
  const minutes = typeof b.everyMinutes === "number" && Number.isInteger(b.everyMinutes) && b.everyMinutes >= 1 ? b.everyMinutes : undefined;
  const source = str(b.source) && b.source.trim() ? b.source.trim() : undefined;
  const sourceKind = b.sourceKind === "feed" || b.sourceKind === "command" ? b.sourceKind
    : source && /^https?:\/\//i.test(source) ? "feed" : "command";
  const notifyOnly = trigger === "watch" && (b.notifyOnly === true || steps.length === 0);
  return {
    name,
    ...(str(b.description) && b.description.trim() ? { description: b.description.trim() } : {}),
    trigger,
    ...(trigger === "schedule" && str(b.cron) ? { cron: b.cron.trim() } : {}),
    ...(trigger === "watch" ? {
      ...(source ? { source } : {}),
      sourceKind,
      ...(str(b.via) && b.via.trim() ? { via: b.via.trim() } : {}),
      everyMinutes: minutes ?? (sourceKind === "feed" ? 15 : 5),
      notifyOnly,
    } : {}),
    steps: notifyOnly ? [] : steps,
    sinks: cleanSinks(b.sinks),
    missing,
  };
}

/** The routine a brief describes, saved disabled. `watch` is resolved by the builder (feed URL
 * found, or the agent's tested command); the brief's sinks always win — the agent never picks
 * where results go. */
export function briefToRoutine(brief: RoutineBrief, watch?: RoutineWatch, steps?: RoutineStep[]): Routine {
  const finalSteps = brief.trigger === "watch" && brief.notifyOnly ? [] : (steps ?? brief.steps);
  return {
    name: brief.name,
    ...(brief.description ? { description: brief.description } : {}),
    enabled: false,
    ...(brief.trigger === "schedule" ? { cron: brief.cron ?? "0 8 * * *" } : {}),
    ...(watch ? { watch: { ...watch, everyMinutes: brief.everyMinutes ?? watch.everyMinutes } } : {}),
    ...(watch && finalSteps.length > 0 ? { todoDriven: true } : {}),
    steps: finalSteps,
    sinks: brief.sinks,
  };
}

export interface BuildResult {
  routine?: Routine;
  skills: { name: string; markdown: string }[];
  testError?: { message: string; exitCode?: number };
}

const MAX_AGENT_OUTPUT = 1024 * 1024;

/** The object in the last ```json fence that parses (the agent's output is untrusted, so an
 * index scan rather than a backtracking fence regex — CodeQL js/polynomial-redos). Walks fences
 * from the last one back, since a drafted skill's markdown can itself contain ```json. */
function lastJsonFence(raw: string): Record<string, unknown> | undefined {
  const text = raw.slice(-MAX_AGENT_OUTPUT);
  for (let at = text.lastIndexOf("```json"); at >= 0; at = at === 0 ? -1 : text.lastIndexOf("```json", at - 1)) {
    const bodyStart = text.indexOf("\n", at);
    if (bodyStart < 0) continue;
    // JSON can't hold a raw newline inside a string, so the first "\n```" after the opener is
    // this fence's real closer even when a skill's markdown contains fences of its own.
    const close = text.indexOf("\n```", bodyStart);
    try {
      return parseJsonObject(text.slice(bodyStart + 1, close < 0 ? undefined : close));
    } catch { /* not this fence — try the previous one */ }
  }
  try { return parseJsonObject(unfence(text)); } catch { return undefined; }
}

/** The build agent's output contract: the LAST fenced ```json block of its final message,
 * `{ routine, skills? }` or `{ routine, testError }`. The brief's name/sinks override the
 * agent's; the result is validated like any saved routine. */
export function parseBuildResult(text: string, brief: RoutineBrief): BuildResult {
  const parsed = lastJsonFence(text);
  if (!parsed) throw new Error("the build agent didn't return the routine JSON");
  const te = parsed.testError as Record<string, unknown> | string | undefined;
  if (te) {
    const message = str(te) ? te : str(te.message) ? te.message : "the watch command failed its test";
    const exitCode = !str(te) && typeof te.exitCode === "number" ? te.exitCode : undefined;
    return { skills: [], testError: { message, ...(exitCode !== undefined ? { exitCode } : {}) } };
  }
  const r = parsed.routine as Record<string, unknown> | undefined;
  if (typeof r !== "object" || r === null) throw new Error("the build agent's JSON has no routine");
  const w = r.watch as Record<string, unknown> | undefined;
  if (!w || w.kind !== "command" || !str(w.command) || !w.command.trim()) throw new Error("the built routine has no watch command");
  const agentSteps = Array.isArray(r.steps) ? r.steps as RoutineStep[] : brief.steps;
  const routine = briefToRoutine(brief, { kind: "command", command: w.command.trim() }, agentSteps);
  const error = describeRoutineError(routine);
  if (error) throw new Error(`the built routine is invalid: ${error}`);
  const skills = Array.isArray(parsed.skills)
    ? parsed.skills.flatMap((s) => {
      const k = s as Record<string, unknown> | null;
      return k && str(k.name) && NAME_RE.test(k.name) && str(k.markdown) && k.markdown.trim()
        ? [{ name: k.name, markdown: k.markdown }] : [];
    })
    : [];
  return { routine, skills };
}

export type BuildStage = "sent" | "command" | "tested" | "steps" | "validating";

/** Progress markers the build-routine skill prints (`BEAN-STEP: <stage> …`). */
export function buildStageFromLine(line: string): { stage: BuildStage; detail?: string } | undefined {
  const m = /BEAN-STEP:\s*(command|tested|steps)\b\s*(.*)/.exec(line);
  if (!m) return undefined;
  const detail = m[2]!.trim();
  return { stage: m[1] as BuildStage, ...(detail ? { detail } : {}) };
}
