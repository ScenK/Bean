import type { AvailableModel, CliName, LiveCli, Project, Skill } from "@bean/core";
import { resolveCliModelSelection } from "@bean/core/models";
import { bestProjectForSkill } from "@bean/core/project-select";
import { AGENT_NAMES } from "../../shared/AgentAvatar.js";
import type { AgentId } from "../../shared/chat-types.js";
import { parseSlash } from "./agent-mode.js";

// The composer's `/` commands — pure, so they test without a DOM. A bare `/name` resolves agents >
// skills; `/skill:` picks a skill. Names are matched by slug (real skill names are file basenames
// with spaces), and a slug two entries share is never resolved silently. Sprouts aren't here —
// ask Bean to run one (#635).

export type SlashKind = "agent" | "skill";

export interface SlashEntry {
  kind: SlashKind;
  /** Canonical name: the agent id or skill name. */
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

export interface SlashCatalogs { agents: readonly LiveCli[]; skills: readonly Skill[]; delegate?: SlashDelegate }

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
  | { kind: "ambiguous"; of: "skill"; slug: string; names: string[] }
  | { kind: "unknown"; of: "skill"; slug: string };

/** The `/` menu's section order (Bean mode) — display only; `rank()` is resolution precedence. */
const MENU_ORDER: SlashKind[] = ["skill", "agent"];
export const SECTION_TITLES: Record<SlashKind, string> = { agent: "Switch to", skill: "Skills" };

export const slugify = (name: string): string =>
  name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** Every runnable entry for the mode: agents and skills. Agent mode captions a skill `→ <Agent>` (any
 * target runs in the live session). Hidden/disabled skills are left out. In Bean mode a terminal
 * skill's caption is its delegate destination, `<CLI> · <project>`. */
export function slashEntries(mode: AgentId, c: SlashCatalogs): SlashEntry[] {
  const agents: AgentId[] = ["bean", ...c.agents];
  const raw: Omit<SlashEntry, "command">[] = agents.map((a) => ({ kind: "agent", name: a, slug: a, caption: AGENT_NAMES[a], description: "" }));
  for (const s of c.skills) {
    if (s.hidden || s.enabled === false) continue;
    if (mode !== "bean") {
      raw.push({ kind: "skill", name: s.name, slug: slugify(s.name), caption: `→ ${AGENT_NAMES[mode]}`, description: s.description });
      continue;
    }
    const dest = s.target === "chat" || !c.delegate ? undefined : terminalDestination(s.name, c.delegate);
    const caption = s.target === "chat" ? "chat" : dest ? `${dest.cli ?? "no coding agent"} · ${dest.projectName}` : "terminal";
    raw.push({ kind: "skill", name: s.name, slug: slugify(s.name), caption, description: s.description });
  }
  return raw.map((e) => {
    // Bare only if no higher-precedence kind owns the slug; agents are always bare.
    const shadowed = e.kind !== "agent" && raw.some((o) => o.slug === e.slug && rank(o.kind) < rank(e.kind));
    return { ...e, command: shadowed ? `/${e.kind}:${e.slug}` : `/${e.slug}` };
  });
}

const rank = (k: SlashKind): number => (k === "agent" ? 0 : 1);

/** The command a composer submission names, if any. Unknown bare `/foo` (and `/sprout:x`) is undefined
 * (Bean, or in agent mode the CLI, gets the text — so a Bean skill shadows a same-slug CLI-native
 * command). Agent aliases resolve whether or not the CLI is installed — that check is the caller's. */
export function resolveSlash(text: string, mode: AgentId, c: SlashCatalogs): SlashResolution | undefined {
  const agent = parseSlash(text);
  if (agent) return { kind: "agent", name: agent.agent, rest: agent.rest };
  const m = /^\/(skill:)?(\S+)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!m) return undefined;
  const slug = slugify(m[2]!);
  const hits = slashEntries(mode, c).filter((e) => e.kind === "skill" && e.slug === slug);
  if (hits.length > 1) return { kind: "ambiguous", of: "skill", slug, names: hits.map((e) => e.name) };
  if (hits[0]) return { kind: "skill", name: hits[0].name, rest: (m[3] ?? "").trim() };
  return m[1] ? { kind: "unknown", of: "skill", slug } : undefined;
}

/** The `/` menu for the text typed so far (`/`, `/rev`, `/skill:re`): every match, by section —
 * Skills, Switch to — prefix matches before description matches. The row a typed command
 * resolves to (its exact bare/qualified command) leads, with its section, so Enter on the first
 * row still runs what `resolveSlash` would. This display order is separate from `rank()`, which
 * stays the resolution precedence. The menu box is CSS-bounded and scrolls. */
export function slashMenu(text: string, mode: AgentId, c: SlashCatalogs): SlashEntry[] {
  const m = /^\/(?:(skill):)?(\S*)$/i.exec(text);
  if (!m) return [];
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
