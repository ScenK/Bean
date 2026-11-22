import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { ProposedRoutine } from "../converse.js";
import { parseCron } from "../cron.js";
import { DEFAULT_PERSONA } from "../persona.js";
import { isArchived, memberTodoEligible, routesToDone, stopsLabel, watchEveryMinutes, type Routine, type RoutineStep } from "../routine-store.js";
import type { Project } from "../types.js";
import { isFolderProblem, sproutProblems, sproutProjects, type SproutProblem } from "../usage-sections.js";
import type { RoutineProposalCardInput } from "./cards-api.js";
import { localTimeZone } from "./turn-cap.js";

/** A pending confirm-first routine draft awaiting Save/Cancel (and the enabled toggle). */
export interface PendingRoutine {
  id: string;
  proposal: ProposedRoutine;
  conversationId: string;
  /** The server channel it was drafted in — the only channel sink it may save with. */
  channelId?: string;
  proposedBy: string;
  /** Platform id of the proposer: only they or the owner may tap Save/Cancel/toggle (#322). */
  proposedById: string;
  /** false = an admin's draft: it saves switched off, create-only, and the owner gets a DM. */
  byOwner: boolean;
  /** The owner's draft: the saved sprout of its name when the card was posted (JSON; absent = none).
   * Save refuses once that changed, so a stale card never overwrites newer edits (#982). */
  prior?: string;
  /** Where it was drafted (the conversation's display name), for the owner notice. */
  where?: string;
  cardActivityId?: string;
  createdAt: number;
}

const EXPIRY_MS = 10 * 60_000;

/** Pending routine proposals — the routine counterpart to SkillProposalStore. claim() is one-shot
 * so a double tap can't double-save; get() leaves the draft in place for the enabled toggle. */
export class RoutineProposalStore {
  private byId = new Map<string, PendingRoutine>();
  private seq = 0;
  // Per-process prefix: after a restart, a stale card's id must not land on a new draft.
  private readonly prefix = randomUUID().slice(0, 8);

  constructor(private nowMs: () => number = () => Date.now()) {}

  add(p: Omit<PendingRoutine, "id" | "createdAt">): PendingRoutine {
    const full: PendingRoutine = { ...p, id: `routine-${this.prefix}-${++this.seq}`, createdAt: this.nowMs() };
    this.byId.set(full.id, full);
    return full;
  }

  setCardActivityId(id: string, activityId: string): void {
    const p = this.byId.get(id);
    if (p) p.cardActivityId = activityId;
  }

  /** Raw read (expired entries included, nothing claimed) — bot.ts tells a held-but-expired card
   * from a consumed or forged id with it. */
  peek(id: string): PendingRoutine | undefined {
    return this.byId.get(id);
  }

  get(id: string): PendingRoutine | undefined {
    const p = this.byId.get(id);
    if (!p) return undefined;
    if (this.nowMs() - p.createdAt > EXPIRY_MS) {
      this.byId.delete(id);
      return undefined;
    }
    return p;
  }

  claim(id: string): PendingRoutine | undefined {
    const p = this.get(id);
    this.byId.delete(id);
    return p;
  }
}

const DAY_NAMES = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];

const clock = (hour: number, minute: number): string =>
  `${hour % 12 === 0 ? 12 : hour % 12}:${String(minute).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;

/** "Weekdays at 7:00 AM (America/Toronto)"; anything richer than one daily time shows the raw cron. */
export function describeSchedule(r: Routine, tz: string = localTimeZone()): string {
  if (r.watch) {
    const what = r.watch.kind === "feed" ? `${r.watch.url} has new items` : "its watch command finds new items";
    return `When ${what} (checked every ${watchEveryMinutes(r.watch)} min)`;
  }
  const cron = r.cron ?? "";
  try {
    const spec = parseCron(cron);
    const hour = spec.hours.size === 1 ? [...spec.hours][0] : undefined;
    const minute = spec.minutes.size === 1 ? [...spec.minutes][0] : undefined;
    if (hour !== undefined && minute !== undefined && !spec.dayRestricted && spec.months.size === 12) {
      const wd = [...spec.weekdays].sort((a, b) => a - b);
      const key = wd.join(",");
      const days = !spec.weekdayRestricted || key === "0,1,2,3,4,5,6" ? "Every day"
        : key === "1,2,3,4,5" ? "Weekdays"
          : key === "0,6" ? "Weekends"
            : wd.map((d) => DAY_NAMES[d]).join(", ");
      return `${days} at ${clock(hour, minute)} (${tz})`;
    }
  } catch {
    // fall through to the raw expression
  }
  return `cron \`${cron}\` (${tz})`;
}

const clip = (s: string, n = 120): string => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length <= n ? one : `${one.slice(0, n - 1)}…`;
};

export function describeStep(s: RoutineStep, i: number): string {
  const what = s.kind === "command"
    ? `command \`${clip(s.command, 80)}\``
    : s.kind === "delegate"
      ? `agent${s.skill || s.project ? ` (${[s.skill, s.project && `in ${basename(s.project)}`].filter(Boolean).join(" ")})` : ""}: ${clip(s.instruction)}`
      : `chat${s.skill ? ` (${s.skill})` : ""}: ${clip(s.instruction)}`;
  return `${i + 1}. ${what}`;
}

/** Destinations by name: a user sink resolves through `people`; the drafting channel reads as
 * "This channel"/"This chat"; another channel is a Discord mention, or the plain id on Teams. */
export function describeSinks(
  r: Routine, people: { id: string; name: string }[], ownerName: string, channelId?: string, beanName = DEFAULT_PERSONA.name,
): string[] {
  const out = (r.sinks.chatops ?? []).map((s) =>
    s.alias !== undefined ? s.alias
      : s.user ? `DM ${people.find((p) => p.id === s.user)?.name ?? s.user}`
      : s.channel === undefined ? `DM ${ownerName}`
        : s.channel === channelId ? (s.transport === "teams" ? "This chat" : "This channel")
          : s.transport === "teams" ? s.channel : `<#${s.channel}>`);
  if (r.sinks.home) out.unshift(`Your chat with ${beanName}`);
  if (r.sinks.note) out.push("Saved as a note");
  if (r.sinks.notify) out.push("Desktop notification");
  return out.length > 0 ? out : ["Nowhere — results are only kept in the run history"];
}

/** Schedule pitfalls worth a heads-up on the card: a day-of-month step (e.g. every 3rd day) restarts on
 * the 1st, so "every 3 days" fires on the 31st and again on the 1st. */
export function scheduleWarnings(r: Routine): string[] {
  if (!r.cron) return [];
  try {
    if (!parseCron(r.cron).dayRestricted) return [];
  } catch {
    return [];
  }
  const day = r.cron.trim().split(/\s+/)[2] ?? "";
  return day.includes("/")
    ? [`The day-of-month step "${day}" restarts every month on the 1st, so the gap isn't always the same — pick weekdays for an even rhythm.`]
    : [];
}

export function routineCardInput(
  p: PendingRoutine, people: { id: string; name: string }[], ownerName: string,
): RoutineProposalCardInput {
  const { routine: r, updating, problem } = p.proposal;
  const base = {
    proposalId: p.id, name: String(r.name), updating, enabled: r.enabled === true,
    ...(p.byOwner ? {} : { ownerEnables: ownerName }),
  };
  // An invalid draft can be any shape: show only its name and the reason.
  if (problem) return { ...base, schedule: "", steps: [], sinks: [], problem };
  const shared = (r.sinks.chatops?.length ?? 0) > 0;
  const warnings = scheduleWarnings(r);
  const stops = stopsLabel(r);
  return {
    ...base,
    ...(r.description ? { description: r.description } : {}),
    schedule: `${describeSchedule(r)}${stops ? ` · stops ${stops}` : ""}`,
    steps: r.steps.map(describeStep),
    sinks: describeSinks(r, people, ownerName, p.channelId),
    ...(memberTodoEligible(r) && shared
      ? { todoNote: "Members can queue todos on this — one digest covers everyone's todos and goes to every destination above." }
      : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/** How a desktop draft relates to the saved sprout of its name (#982): absent = a new sprout. */
export type DraftReplaces = "live" | "paused" | "archived";

/** The desktop's propose_routine card (#982), pre-rendered to plain lines. The host keeps the
 * draft itself: Save hands back only `id`. */
export interface RoutineDraftCard {
  id: string;
  name: string;
  /** The owner's ask and its date, as the draft recorded it (`description`, clipped). */
  ask?: string;
  /** True when it stops on its own once it finds the answer (a `done` route). */
  commitment: boolean;
  /** When it checks, then one line per step. */
  how: string[];
  tellYou: string[];
  /** "Dec 20, 2026, or sooner if found"; absent = it runs until turned off. */
  stops?: string;
  replaces?: DraftReplaces;
  /** Validation failure: shown instead of Save. */
  problem?: string;
}

/** What saving `name` would replace: the saved sprout of exactly that name, by state. */
export function draftReplaces(name: string, routines: Routine[], now: Date): DraftReplaces | undefined {
  const prior = routines.find((r) => r.name === name);
  if (!prior) return undefined;
  return isArchived(prior, now) ? "archived" : prior.enabled ? "live" : "paused";
}

export function routineDraftCard(
  id: string, proposal: ProposedRoutine, replaces: DraftReplaces | undefined, beanName?: string,
): RoutineDraftCard {
  const { routine: r, problem } = proposal;
  const base = { id, name: String(r.name), ...(replaces ? { replaces } : {}) };
  // An invalid draft can be any shape: show only its name and the reason.
  if (problem) return { ...base, commitment: false, how: [], tellYou: [], problem };
  const stops = stopsLabel(r);
  return {
    ...base,
    ...(r.description ? { ask: clip(r.description, 300) } : {}),
    commitment: routesToDone(r),
    how: [describeSchedule(r), ...r.steps.map(describeStep), ...(r.webSearch ? ["Searches the public web"] : [])],
    tellYou: describeSinks(r, [], "you", undefined, beanName),
    ...(stops ? { stops } : {}),
  };
}

/** The owner's DM after an admin saves a draft: who, what, where, when, the clipped steps (the
 * card's own lines) and the command that turns it on. */
export function ownerDraftNotice(p: PendingRoutine, people: { id: string; name: string }[], ownerName: string): string {
  const c = routineCardInput(p, people, ownerName);
  return [
    `${p.proposedBy} saved a sprout draft "${c.name}"${p.where ? ` in ${p.where}` : ""}. It's off.`,
    `When: ${c.schedule}`,
    ...(c.warnings ?? []).map((w) => `Heads up: ${w}`),
    "Steps:", ...(c.steps.length > 0 ? c.steps : ["None — it only notifies"]),
    `Sends to: ${c.sinks.join(", ")}`,
    `Say \`enable ${c.name}\` to turn it on.`,
  ].join("\n");
}

export type RoutineCommand = { kind: "list" } | { kind: "enable" | "disable"; name: string };

/** Owner text commands `sprouts` (or the old `routines`), `enable <name>`, `disable <name>` (optional leading slash). */
export function parseRoutineCommand(text: string): RoutineCommand | undefined {
  const t = text.trim().replace(/^\/+/, "");
  if (/^(sprouts|routines)$/i.test(t)) return { kind: "list" };
  const m = /^(enable|disable)\s+(\S.*)$/is.exec(t);
  if (!m) return undefined;
  return { kind: m[1]!.toLowerCase() as "enable" | "disable", name: stripQuotes(m[2]!.trim()) };
}

/** Index scan, not `/^["'`]+|["'`]+$/g`: the unanchored tail alternative is quadratic on long quote runs. */
function stripQuotes(s: string): string {
  const quote = (c: string | undefined): boolean => c === '"' || c === "'" || c === "`";
  let start = 0;
  let end = s.length;
  while (start < end && quote(s[start])) start++;
  while (end > start && quote(s[end - 1])) end--;
  return s.slice(start, end);
}

/** Free text (a project/skill name, a folder's basename) as inert chat text: one line, markdown
 * escaped, and no `@` that could mention anyone. */
const inert = (s: string): string =>
  s.replace(/\s+/g, " ").trim().replace(/[\\`*_~|<>[\]#]/g, "\\$&").replace(/@/g, "@\u200b");

/** A short marker for one problem; folders show their basename only (no absolute paths in channels). */
function problemText(p: SproutProblem): string {
  if (p.kind === "missing-skill") return `step ${p.step} skill ${inert(p.skill)} not found`;
  if (p.kind === "disabled-skill") return `step ${p.step} skill ${inert(p.skill)} is switched off`;
  const folder = inert(basename(p.folder) || p.folder);
  return p.kind === "ancestor-folder" ? `step ${p.step} folder ${folder} holds several projects` : `step ${p.step} folder ${folder} isn't a registered project`;
}

/** The owner's `sprouts` reply, sectioned like the desktop Sprouts list (#885): Needs fixing, the
 * registered projects A–Z, Scratch; empty sections dropped. Each sprout is listed once — under
 * Needs fixing if a step folder needs fixing, else its first project in registry order (`· also`
 * names the rest), else Scratch. `skillNames` must be the full catalog (hidden skills included);
 * `disabledSkills` its `enabled: false` names (flagged, never Needs fixing).
 * `runnable` = this bot can run a sprout on request (headless): the list says so. */
export function routineListText(
  routines: Routine[], projects: readonly Project[], skillNames: ReadonlySet<string>,
  tz: string = localTimeZone(), runnable = false, disabledSkills: ReadonlySet<string> = new Set(),
): string {
  if (routines.length === 0) return "No sprouts yet — describe one and I'll draft it.";
  const sorted = [...projects].sort((a, b) => a.name.localeCompare(b.name));
  const sections = [
    { label: "Needs fixing", lines: [] as string[] },
    ...sorted.map((p) => ({ label: p.name, lines: [] as string[] })),
    { label: "Scratch", lines: [] as string[] },
  ];
  const at = (p: Project | undefined): number => (p ? 1 + sorted.indexOf(p) : sections.length - 1);
  for (const r of routines) {
    const problems = sproutProblems(r, projects, skillNames, disabledSkills);
    const homes = sproutProjects(r, projects);
    const needsFixing = problems.some(isFolderProblem);
    const also = (needsFixing ? homes : homes.slice(1)).map((p) => inert(p.name));
    let line = `• **${r.name}** — ${r.enabled ? "on" : r.watch ? "off" : "on demand"} — ${describeSchedule(r, tz).replace(` (${tz})`, "")}`;
    if (also.length > 0) line += ` · also ${also.join(", ")}`;
    if (problems.length > 0) line += ` · ⚠ ${problems.map(problemText).join("; ")}`;
    sections[needsFixing ? 0 : at(homes[0])]!.lines.push(line);
  }
  return sections.filter((s) => s.lines.length > 0).map((s) => `**${inert(s.label)}**\n${s.lines.join("\n")}`).join("\n")
    + `\nTimes are ${tz}. \`enable <name>\` / \`disable <name>\` to switch one.${runnable ? " Ask me to run one." : ""}`;
}
