import type { CliName } from "../launcher.js";
import type { AvailableModel } from "../models.js";
import type { SproutRunPlan } from "../sprout-trigger.js";
import type { SkillBrowserChange } from "../frontmatter.js";

export interface ProposalCardInput {
  proposalId: string;
  /** Default of the on-card project picker: a registered project's path, or `__none__` for the
   * scratch workspace. Never displayed — the scratch path is absolute and the card is shared. */
  projectPath: string;
  /** Selectable projects for the on-card project picker. */
  projects: { name: string; path: string }[];
  /** Offer the "no project (scratch)" option (`__none__`): the bot has a scratch workspace. */
  scratch: boolean;
  /** Picked skill name (default in the skill picker); absent = no skill. */
  skillName?: string;
  instruction: string;
  /** Selectable skills for the on-card skill picker; empty = no picker. `browser` marks a
   * `browser: true` skill so the picker can disclose it. */
  skills: { name: string; browser?: boolean }[];
  clis: CliName[];
  models: AvailableModel[];
  defaultCli: CliName;
  defaultModel?: string;
}

// Defined in the node-free frontmatter module so the desktop renderer can share them.
export { BROWSER_SKILL_NOTE, SKILL_BROWSER_NOTES, skillBrowserChange } from "../frontmatter.js";
export type { SkillBrowserChange } from "../frontmatter.js";

export interface RunningCardInput {
  projectName: string;
  instruction: string;
  startedBy: string;
  tail?: string;
  /** RunRegistry id the Cancel button carries. */
  runId: string;
  /** A follow-up continuing the confirmed task's agent session with no card (epic #1111): the
   * compact card. */
  continued?: true;
  /** Bean's own automatic follow-up on the task (#1133): which one of FOLLOW_UP_MAX it is. */
  followUp?: number;
}

/** The delegate proposal card's grant line (epic #1111): what confirming it allows. */
export const DELEGATE_GRANT_LINE =
  "Run it and your follow-ups here continue this agent session without a new card — until /new or 30 idle minutes.";

export interface FinishedCardInput {
  projectName: string;
  instruction: string;
  startedBy: string;
  outcome: "done" | "error" | "cancelled";
  /** Resume command for the run's CLI session (e.g. `claude --resume <id>`), once it started.
   * Never carries a path — this card is posted to a shared channel. */
  resume?: string;
  /** CLI session id for a "Continue live" button (beanAction `resume-live`); absent = no button. */
  resumeLiveId?: string;
  /** The CLI that ran it (claude/codex/opencode). */
  agent?: string;
  /** Where it stopped: the last thing the agent said, one clamped line (`lastSaidLine`). */
  lastLine?: string;
  /** Set when a session exists but no button is offered: the card says why. */
  noContinue?: NoContinueReason;
}

/** Why a finished/ended card with a session carries no Continue live button. `surface` = this
 * surface can't carry the id (Discord's 100-char custom_id) or it isn't a live session id. */
export type NoContinueReason = "disabled" | "cli-missing" | "surface";

/** The Continue live button's one-line explanation, shown beside it. */
export const continueLiveLine = (agent = "agent"): string =>
  `Continue live reopens this ${agent} session with everything it did so far. Messages here go to it until you end it.`;

/** The one line a card shows instead of Continue live. */
export function noContinueLine(reason: NoContinueReason, agent = "the agent"): string {
  return reason === "disabled" ? "No Continue live: live sessions are off."
    : reason === "cli-missing" ? `No Continue live: ${agent} isn't installed here any more.`
      : "No Continue live: it can't be offered on this surface.";
}

/** The last non-blank line of an agent's output, clamped from its end — where it stopped. */
export function lastSaidLine(text: string | undefined, max = 200): string | undefined {
  const line = text?.split("\n").map((l) => l.trim()).filter(Boolean).pop();
  if (!line) return undefined;
  return line.length <= max ? line : "…" + line.slice(-(max - 1));
}

export interface NoteProposalCardInput {
  proposalId: string;
  title: string;
  body: string;
  /** Resolved display name of the note's project; absent = a general note. */
  projectName?: string;
  /** True when this updates an existing linked note in place rather than creating one. */
  updating: boolean;
  /** Chat images that Save will store and append to the note ("N image(s) attached"). */
  imageCount?: number;
}

export interface NoteResultCardInput {
  title: string;
  savedBy: string;
  outcome: "saved" | "cancelled";
}

export interface NoteArchiveProposalCardInput {
  proposalId: string;
  title: string;
  /** Resolved display name of the note's project; absent = a general note. */
  projectName?: string;
  /** ISO timestamp of the note's last save. */
  updated: string;
  /** First non-blank line of the body, clamped. */
  snippet: string;
}

/** "archived" carries the note id for the receipt's Restore button (beanAction `restore-note`). */
export interface NoteArchiveResultCardInput {
  title: string;
  by: string;
  outcome: "archived" | "cancelled";
  noteId?: string;
}

export interface TodoProposalCardInput {
  proposalId: string;
  routine: string;
  text: string;
  /** Pending todos a queued one would wait behind ("N ahead in queue"); absent = unknown. */
  ahead?: number;
  /** Offer Run now (#923): only the owner's card, on a host that runs sprouts. */
  runNow?: boolean;
}

/** The Queue button's line on a todo card. */
export const todoQueueLine = (ahead: number | undefined): string | undefined =>
  ahead === undefined ? undefined : ahead === 0 ? "Queue: nothing ahead in queue" : `Queue: ${ahead} ahead in queue`;
/** The Run now button's line on a todo card. */
export const TODO_RUN_NOW_LINE = "Run now: runs only this task";

/** "Run the X sprout" (#636): the desktop card's contents. `result` set = tapped or cancelled —
 * the card is updated in place with it and shows no buttons. */
export interface SproutRunCardInput {
  proposalId: string;
  plan: SproutRunPlan;
  result?: string;
}

/** The owner-DM send card (#689): one platform's destinations only. `options` are ordered
 * pick → aliased → most recently seen; `pick` (an option id) is set only for a confident match.
 * `result` set = sent or cancelled — the card shows it and no controls. */
export interface SendCardInput {
  proposalId: string;
  body: string;
  /** `detail` = "platform name · parent · kind" (untrusted names: render as plain text). */
  options: { id: string; label: string; detail: string }[];
  pick?: string;
  result?: string;
}

export interface TodoResultCardInput {
  routine: string;
  queuedBy: string;
  outcome: "queued" | "cancelled";
  /** What happens next (#923): "Running only this task…", "Queued — I'll report here…". */
  note?: string;
}

/** A fact the remember tool saved directly (no confirm step) — the card is the receipt,
 * and its Forget button carries the memory id. */
export interface RememberedCardInput {
  memoryId: string;
  text: string;
  /** Resolved display name of the fact's project; absent = a global fact. */
  projectName?: string;
  /** The fact's category (owner paths only, #648); absent = uncategorized. */
  category?: string;
  /** Who the fact is for — the receipt states it ("saved for you — used in our DMs"). */
  scope: "private" | "shared";
}

export function rememberedScopeLine(scope: RememberedCardInput["scope"], category?: string): string {
  const line = scope === "private" ? "Saved for you — used in our DMs." : "Saved for everyone.";
  return category ? `Category: ${category} · ${line}` : line;
}

/** Receipt for a reminder set_reminder saved directly; Cancel carries the reminder id. */
export interface ReminderCardInput {
  reminderId: string;
  text: string;
  at: string; // ISO 8601
}

export interface SkillProposalCardInput {
  proposalId: string;
  name: string;
  body: string;
  /** True when a skill with this name already exists (save replaces/overrides it). */
  updating: boolean;
  /** `skillBrowserChange()` of the body against the existing skill; absent = no browser line. */
  browser?: SkillBrowserChange;
}

export interface SkillResultCardInput {
  name: string;
  savedBy: string;
  outcome: "saved" | "cancelled";
}

/** A drafted routine (#285), pre-rendered to plain lines so every surface shows the same text. */
export interface RoutineProposalCardInput {
  proposalId: string;
  name: string;
  description?: string;
  /** A routine with this name exists: saving replaces it. */
  updating: boolean;
  enabled: boolean;
  /** Plain-English schedule with the time zone, e.g. "Weekdays at 7:00 AM (America/Toronto)". */
  schedule: string;
  /** One line per step. */
  steps: string[];
  /** Where results go, by name. */
  sinks: string[];
  /** Set when members can queue todos and one digest covers several members' todos. */
  todoNote?: string;
  /** Schedule pitfalls (e.g. a day-of-month step that restarts monthly) — the draft still saves. */
  warnings?: string[];
  /** Validation failure: shown instead of a Save button. */
  problem?: string;
  /** Set (to the owner's name) on a non-owner's draft: "Save draft" + Cancel, no toggle, and
   * "Starts off — <owner> turns it on". */
  ownerEnables?: string;
}

export interface RoutineResultCardInput {
  name: string;
  by: string;
  outcome: "saved" | "cancelled" | "failed";
  enabled?: boolean;
  problem?: string;
}

export interface LiveSessionProposalCardInput {
  proposalId: string;
  projectName: string;
  instruction: string;
  model?: string;
  /** Picked skill name (default in the skill picker); absent = no skill. */
  skillName?: string;
  /** Current steering mode, drives the on-card toggle label. Absent = "restricted". */
  steering?: "open" | "restricted";
  /** Selectable projects for the on-card project picker; the one matching projectName is default. */
  projects: { name: string; path: string }[];
  /** Every live CLI's configured models, tagged with the CLIs that offer them. Discord shows the
   * selected CLI's; Teams shows all (Start resolves within the CLI). Empty = no picker. */
  models: AvailableModel[];
  /** Selectable skills for the on-card skill picker; empty = no picker. */
  skills: { name: string }[];
  /** The selected engine (a LIVE_CLIS entry). */
  cli: string;
  /** Live-capable detected CLIs for the on-card CLI picker; empty = no picker (a resume). */
  clis: string[];
  /** A resume's frozen engine, shown as an "Agent" fact instead of the CLI picker. */
  agent?: string;
  /** Set when continuing a recorded delegate session: the original run's instruction, shown as
   * "Continues: …". The project is locked — no project picker. */
  continues?: string;
}

export interface LiveSessionResultCardInput {
  projectName: string;
  startedBy: string;
  outcome: "started" | "cancelled" | "ended";
  /** A fresh session's opening prompt: this card replaces the proposal card that showed it (and a
   * Discord `/live-session` prompt is never a message of its own), so it would vanish otherwise. */
  prompt?: string;
  /** On "ended": offer "Continue live" for this session id. */
  resumeLiveId?: string;
  /** On "ended": the CLI, the turns this session ran, the last thing the agent said, and why no
   * button is offered (see FinishedCardInput). */
  agent?: string;
  turns?: number;
  lastLine?: string;
  noContinue?: NoContinueReason;
}

export interface CardBuilders {
  proposalCard: (input: ProposalCardInput) => object;
  runningCard: (input: RunningCardInput) => object;
  finishedCard: (input: FinishedCardInput) => object;
  noteProposalCard: (input: NoteProposalCardInput) => object;
  noteResultCard: (input: NoteResultCardInput) => object;
  noteArchiveProposalCard: (input: NoteArchiveProposalCardInput) => object;
  noteArchiveResultCard: (input: NoteArchiveResultCardInput) => object;
  todoProposalCard: (input: TodoProposalCardInput) => object;
  todoResultCard: (input: TodoResultCardInput) => object;
  sproutRunCard: (input: SproutRunCardInput) => object;
  /** Optional: only surfaces that wire `send` need it. */
  sendCard?: (input: SendCardInput) => object;
  rememberedCard: (input: RememberedCardInput) => object;
  /** Optional: only surfaces that wire `reminders` need it. */
  reminderCard?: (input: ReminderCardInput) => object;
  skillProposalCard: (input: SkillProposalCardInput) => object;
  skillResultCard: (input: SkillResultCardInput) => object;
  /** Optional: only surfaces that wire `routines` need them. */
  routineProposalCard?: (input: RoutineProposalCardInput) => object;
  routineResultCard?: (input: RoutineResultCardInput) => object;
  liveSessionProposalCard: (input: LiveSessionProposalCardInput) => object;
  liveSessionResultCard: (input: LiveSessionResultCardInput) => object;
}
