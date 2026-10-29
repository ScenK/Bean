import type { LiveCli, Routine, Skill } from "@bean/core";
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
  /** Why the row can't run yet (shown greyed). */
  disabled?: string;
  /** What Tab puts in the composer (no trailing space) — qualified when a higher kind shadows the slug. */
  command: string;
}

export interface SlashCatalogs { agents: readonly LiveCli[]; skills: readonly Skill[]; sprouts: readonly Routine[] }

export type SlashResolution =
  | { kind: SlashKind; name: string; rest: string }
  | { kind: "ambiguous"; of: "skill" | "sprout"; slug: string; names: string[] }
  | { kind: "unknown"; of: "skill" | "sprout"; slug: string };

export const SLASH_MENU_ROWS = 8;
export const SECTION_TITLES: Record<SlashKind, string> = { agent: "Switch to", skill: "Skills", sprout: "Sprouts" };

export const slugify = (name: string): string =>
  name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

const sinkNames = (r: Routine): string => [
  ...new Set((r.sinks.chatops ?? []).map((c) => (c.transport === "discord" ? "Discord" : "Teams"))),
  ...(r.sinks.note ? ["note"] : []),
  ...(r.sinks.notify ? ["notification"] : []),
].join(", ") || "Dashboard";

/** Every runnable entry for the mode. Agent mode lists agents only. Hidden/disabled skills and
 * notify-only watches (nothing to run) are left out; terminal skills show but can't run yet. */
export function slashEntries(mode: AgentId, c: SlashCatalogs): SlashEntry[] {
  const agents: AgentId[] = ["bean", ...c.agents];
  const raw: Omit<SlashEntry, "command">[] = agents.map((a) => ({ kind: "agent", name: a, slug: a, caption: AGENT_NAMES[a], description: "" }));
  if (mode === "bean") {
    for (const s of c.skills) {
      if (s.hidden || s.enabled === false) continue;
      const chat = s.target === "chat";
      raw.push({
        kind: "skill", name: s.name, slug: slugify(s.name), caption: chat ? "chat" : "terminal", description: s.description,
        ...(chat ? {} : { disabled: "coming next" }),
      });
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

/** The `/` menu for the text typed so far (`/`, `/rev`, `/sprout:ni`): prefix matches before
 * description matches, at most SLASH_MENU_ROWS rows in section order, plus how many more matched. */
export function slashMenu(text: string, mode: AgentId, c: SlashCatalogs): { entries: SlashEntry[]; more: number } {
  const m = /^\/(?:(skill|sprout):)?(\S*)$/i.exec(text);
  if (!m || (m[1] && mode !== "bean")) return { entries: [], more: 0 };
  const of = m[1]?.toLowerCase();
  const q = m[2]!.toLowerCase();
  const qSlug = slugify(q);
  const scored = slashEntries(mode, c).flatMap((e) => {
    if (of && e.kind !== of) return [];
    const score = e.slug.startsWith(qSlug) || e.name.toLowerCase().startsWith(q) ? 0
      : q && e.description.toLowerCase().includes(q) ? 1 : -1;
    return score < 0 ? [] : [{ e, score }];
  });
  const shown = [...scored].sort((a, b) => a.score - b.score).slice(0, SLASH_MENU_ROWS);
  return {
    entries: shown.sort((a, b) => rank(a.e.kind) - rank(b.e.kind) || a.score - b.score).map((s) => s.e),
    more: scored.length - shown.length,
  };
}
