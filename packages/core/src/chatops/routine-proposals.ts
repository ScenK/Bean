import { basename } from "node:path";
import type { ProposedRoutine } from "../converse.js";
import { parseCron } from "../cron.js";
import { memberTodoEligible, watchEveryMinutes, type Routine, type RoutineStep } from "../routine-store.js";
import type { RoutineProposalCardInput } from "./cards-api.js";
import { localTimeZone } from "./turn-cap.js";

/** A pending confirm-first routine draft awaiting Save/Cancel (and the enabled toggle). */
export interface PendingRoutine {
  id: string;
  proposal: ProposedRoutine;
  conversationId: string;
  proposedBy: string;
  cardActivityId?: string;
  createdAt: number;
}

const EXPIRY_MS = 10 * 60_000;

/** Pending routine proposals — the routine counterpart to SkillProposalStore. claim() is one-shot
 * so a double tap can't double-save; get() leaves the draft in place for the enabled toggle. */
export class RoutineProposalStore {
  private byId = new Map<string, PendingRoutine>();
  private seq = 0;

  constructor(private nowMs: () => number = () => Date.now()) {}

  add(p: Omit<PendingRoutine, "id" | "createdAt">): PendingRoutine {
    const full: PendingRoutine = { ...p, id: `routine-${++this.seq}`, createdAt: this.nowMs() };
    this.byId.set(full.id, full);
    return full;
  }

  setCardActivityId(id: string, activityId: string): void {
    const p = this.byId.get(id);
    if (p) p.cardActivityId = activityId;
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
      ? `agent (${s.skill}${s.project ? ` in ${basename(s.project)}` : ""}): ${clip(s.instruction)}`
      : `chat${s.skill ? ` (${s.skill})` : ""}: ${clip(s.instruction)}`;
  return `${i + 1}. ${what}`;
}

/** Destinations by name: a user sink resolves through `people`, a channel is a Discord mention. */
export function describeSinks(r: Routine, people: { id: string; name: string }[], ownerName: string): string[] {
  const out = (r.sinks.chatops ?? []).map((s) =>
    s.user ? `DM ${people.find((p) => p.id === s.user)?.name ?? s.user}`
      : s.channel ? `<#${s.channel}>`
        : `DM ${ownerName}`);
  if (r.sinks.note) out.push("Saved as a note");
  if (r.sinks.notify) out.push("Desktop notification");
  return out.length > 0 ? out : ["Nowhere — results are only kept in the run history"];
}

export function routineCardInput(
  p: PendingRoutine, people: { id: string; name: string }[], ownerName: string,
): RoutineProposalCardInput {
  const { routine: r, updating, problem } = p.proposal;
  const base = { proposalId: p.id, name: String(r.name), updating, enabled: r.enabled === true };
  // An invalid draft can be any shape: show only its name and the reason.
  if (problem) return { ...base, schedule: "", steps: [], sinks: [], problem };
  const shared = (r.sinks.chatops?.length ?? 0) > 0;
  return {
    ...base,
    ...(r.description ? { description: r.description } : {}),
    schedule: describeSchedule(r),
    steps: r.steps.map(describeStep),
    sinks: describeSinks(r, people, ownerName),
    ...(memberTodoEligible(r) && shared
      ? { todoNote: "Household members can queue todos on this — one digest covers everyone's todos and goes to every destination above." }
      : {}),
  };
}

export type RoutineCommand = { kind: "list" } | { kind: "enable" | "disable"; name: string };

/** Owner text commands `routines`, `enable <name>`, `disable <name>` (optional leading slash). */
export function parseRoutineCommand(text: string): RoutineCommand | undefined {
  const t = text.trim().replace(/^\/+/, "");
  if (/^routines$/i.test(t)) return { kind: "list" };
  const m = /^(enable|disable)\s+(\S.*)$/is.exec(t);
  if (!m) return undefined;
  return { kind: m[1]!.toLowerCase() as "enable" | "disable", name: m[2]!.trim().replace(/^["'`]+|["'`]+$/g, "") };
}

export function routineListText(routines: Routine[], tz: string = localTimeZone()): string {
  if (routines.length === 0) return "No routines yet — describe one and I'll draft it.";
  return routines
    .map((r) => `• **${r.name}** — ${r.enabled ? "on" : "off"} — ${describeSchedule(r, tz).replace(` (${tz})`, "")}`)
    .join("\n") + `\nTimes are ${tz}. \`enable <name>\` / \`disable <name>\` to switch one.`;
}
