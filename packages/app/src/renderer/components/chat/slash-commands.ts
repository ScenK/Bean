import type { AvailableModel, CliName, LiveCli, Project, Routine, Skill } from "@bean/core";
import { resolveCliModelSelection } from "@bean/core/models";
import { bestProjectForSkill } from "@bean/core/project-select";
import { AGENT_NAMES } from "../../shared/AgentAvatar.js";
import type { AgentId } from "../../shared/chat-types.js";
import { parseSlash } from "./agent-mode.js";

// The composer's `/` commands — pure, so they test without a DOM. A bare `/name` resolves agents >
// skills > sprouts; `/skill:` and `/sprout:` pick a kind. Names are matched by slug (real skill
// names are file basenames with spaces), and a slug two entries share is never resolved silently.

export type SlashKind = "agent" | "skill" | "sprout";

export interface SlashEntry {
  kind: SlashKind;
  /** Canonical name: the agent id, skill name or sprout name. */
  name: string;
  slug: string;
  caption: string;
  description: string;
  /** What Tab puts in the composer (no trailing space) — qualified when a higher kind shadows the slug. */
  command: string;
}

/** What a terminal skill's caption needs to name its destination before Enter. */
export interface SlashDelegate {
  projects: Project[]; clis: CliName[]; models: AvailableModel[];
  /** Settings' delegate CLI preference ("" = auto). */
  delegateCli: string;
  /** getModelMemory per skill name. */
  lastUsedModels: Record<string, string>;
}

export interface SlashCatalogs { agents: readonly LiveCli[]; skills: readonly Skill[]; sprouts: readonly Routine[]; delegate?: SlashDelegate }

export interface SlashDestination { projectPath: string; projectName: string; model?: string; cli?: CliName }

/** Where a `/` terminal skill runs as a delegate: the skill's linked project (bestProjectForSkill), else
 * the scratch workspace ("" — main maps it to the real path), on the skill's remembered model.
 * `cli` mirrors main's resolveDelegateSelection so the caption names the CLI that will run;
 * undefined = no enabled CLI (main reports that failure on the card). */
export function terminalDestination(skillName: string, d: SlashDelegate): SlashDestination {
  const project = bestProjectForSkill(skillName, d.projects);
  const model = d.lastUsedModels[skillName];
  const preferred = d.clis.includes(d.delegateCli as CliName) ? d.delegateCli as CliName : d.clis[0];
  const cli = resolveCliModelSelection(d.models, d.clis, { ...(preferred ? { cli: preferred } : {}), ...(model ? { model } : {}) })?.cli;
  return { projectPath: project?.path ?? "", projectName: project?.name ?? "scratch", ...(model ? { model } : {}), ...(cli ? { cli } : {}) };
}

export type SlashResolution =
  | { kind: SlashKind; name: string; rest: string }
  | { kind: "ambiguous"; of: "skill" | "sprout"; slug: string; names: string[] }
  | { kind: "unknown"; of: "skill" | "sprout"; slug: string };

/** The `/` menu's section order (Bean mode) — display only; `rank()` is resolution precedence. */
const MENU_ORDER: SlashKind[] = ["skill", "sprout", "agent"];
export const SECTION_TITLES: Record<SlashKind, string> = { agent: "Switch to", skill: "Skills", sprout: "Sprouts" };

export const slugify = (name: string): string =>
  name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

const sinkNames = (r: Routine): string => [
  ...new Set((r.sinks.chatops ?? []).map((c) => (c.transport === "discord" ? "Discord" : "Teams"))),
  ...(r.sinks.note ? ["note"] : []),
  ...(r.sinks.notify ? ["notification"] : []),
].join(", ") || "Dashboard";

/** Every runnable entry for the mode. Agent mode lists agents only. Hidden/disabled skills and
 * notify-only watches (nothing to run) are left out. A terminal skill's caption is its delegate
 * destination, `<CLI> · <project>`. */
export function slashEntries(mode: AgentId, c: SlashCatalogs): SlashEntry[] {
  const agents: AgentId[] = ["bean", ...c.agents];
  const raw: Omit<SlashEntry, "command">[] = agents.map((a) => ({ kind: "agent", name: a, slug: a, caption: AGENT_NAMES[a], description: "" }));
  if (mode === "bean") {
    for (const s of c.skills) {
      if (s.hidden || s.enabled === false) continue;
      const dest = s.target === "chat" || !c.delegate ? undefined : terminalDestination(s.name, c.delegate);
      const caption = s.target === "chat" ? "chat" : dest ? `${dest.cli ?? "no coding agent"} · ${dest.projectName}` : "terminal";
      raw.push({ kind: "skill", name: s.name, slug: slugify(s.name), caption, description: s.description });
    }
    for (const r of c.sprouts) {
      if (r.watch && r.steps.length === 0) continue;
      raw.push({
        kind: "sprout", name: r.name, slug: slugify(r.name), description: r.description ?? "",
        caption: `sprout → ${sinkNames(r)}${r.enabled ? "" : " · Paused · runs once"}`,
      });
    }
  }
  return raw.map((e) => {
    // Bare only if no higher-precedence kind owns the slug; agents are always bare.
    const shadowed = e.kind !== "agent" && raw.some((o) => o.slug === e.slug && rank(o.kind) < rank(e.kind));
    return { ...e, command: shadowed ? `/${e.kind}:${e.slug}` : `/${e.slug}` };
  });
}

const rank = (k: SlashKind): number => (k === "agent" ? 0 : k === "skill" ? 1 : 2);

/** The command a composer submission names, if any. Unknown bare `/foo` is undefined (Bean gets the
 * text); in agent mode only agent aliases resolve, everything else goes to the agent. Agent aliases
 * resolve whether or not the CLI is installed — that check is the caller's. */
export function resolveSlash(text: string, mode: AgentId, c: SlashCatalogs): SlashResolution | undefined {
  const agent = parseSlash(text);
  if (agent) return { kind: "agent", name: agent.agent, rest: agent.rest };
  if (mode !== "bean") return undefined;
  const m = /^\/(?:(skill|sprout):)?(\S+)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!m) return undefined;
  const of = m[1]?.toLowerCase() as "skill" | "sprout" | undefined;
  const slug = slugify(m[2]!);
  const rest = (m[3] ?? "").trim();
  const entries = slashEntries(mode, c);
  for (const kind of of ? [of] : (["skill", "sprout"] as const)) {
    const hits = entries.filter((e) => e.kind === kind && e.slug === slug);
    if (hits.length > 1) return { kind: "ambiguous", of: kind, slug, names: hits.map((e) => e.name) };
    if (hits[0]) return { kind, name: hits[0].name, rest };
  }
  return of ? { kind: "unknown", of, slug } : undefined;
}

/** The `/` menu for the text typed so far (`/`, `/rev`, `/sprout:ni`): every match, by section —
 * Skills, Sprouts, Switch to — prefix matches before description matches. The row a typed command
 * resolves to (its exact bare/qualified command) leads, with its section, so Enter on the first
 * row still runs what `resolveSlash` would. This display order is separate from `rank()`, which
 * stays the resolution precedence. The menu box is CSS-bounded and scrolls. */
export function slashMenu(text: string, mode: AgentId, c: SlashCatalogs): SlashEntry[] {
  const m = /^\/(?:(skill|sprout):)?(\S*)$/i.exec(text);
  if (!m || (m[1] && mode !== "bean")) return [];
  const of = m[1]?.toLowerCase();
  const q = m[2]!.toLowerCase();
  const qSlug = slugify(q);
  const scored = slashEntries(mode, c).flatMap((e) => {
    if (of && e.kind !== of) return [];
    // 0 = what resolveSlash picks for this text (a qualified slug, or the bare command), 1 = prefix, 2 = description.
    const score = qSlug && (of ? e.slug === qSlug : e.command === `/${qSlug}`) ? 0
      : e.slug.startsWith(qSlug) || e.name.toLowerCase().startsWith(q) ? 1
      : q && e.description.toLowerCase().includes(q) ? 2 : -1;
    return score < 0 ? [] : [{ e, score }];
  });
  const exactKind = scored.find((s) => s.score === 0)?.e.kind;
  const section = (k: SlashKind): number => (k === exactKind ? -1 : MENU_ORDER.indexOf(k));
  return scored.sort((a, b) => section(a.e.kind) - section(b.e.kind) || a.score - b.score).map((s) => s.e);
}
