import type { CliName } from "../launcher.js";
import type { AvailableModel } from "../models.js";

export interface ProposalCardInput {
  proposalId: string;
  projectName: string;
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

/** Picker disclosure for a `browser: true` skill; codex's browser tools also control the computer. */
export const BROWSER_SKILL_NOTE = "🌐 uses your browser (and computer on codex)";

export interface RunningCardInput {
  projectName: string;
  instruction: string;
  startedBy: string;
  tail?: string;
  projectPath: string;
}

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
}

export interface TodoResultCardInput {
  routine: string;
  queuedBy: string;
  outcome: "queued" | "cancelled";
}

/** A fact the remember tool saved directly (no confirm step) — the card is the receipt,
 * and its Forget button carries the memory id. */
export interface RememberedCardInput {
  memoryId: string;
  text: string;
  /** Resolved display name of the fact's project; absent = a global fact. */
  projectName?: string;
  /** Who the fact is for — the receipt states it ("saved for you — used in our DMs"). */
  scope: "private" | "shared";
}

export function rememberedScopeLine(scope: RememberedCardInput["scope"]): string {
  return scope === "private" ? "Saved for you — used in our DMs." : "Saved for the household.";
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
  /** On "ended": re-offer "Continue live" for this session id (a resumed session). */
  resumeLiveId?: string;
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
  rememberedCard: (input: RememberedCardInput) => object;
  /** Optional: only surfaces that wire `reminders` (Discord) need it. */
  reminderCard?: (input: ReminderCardInput) => object;
  skillProposalCard: (input: SkillProposalCardInput) => object;
  skillResultCard: (input: SkillResultCardInput) => object;
  /** Optional: only surfaces that wire `routines` need them. */
  routineProposalCard?: (input: RoutineProposalCardInput) => object;
  routineResultCard?: (input: RoutineResultCardInput) => object;
  liveSessionProposalCard: (input: LiveSessionProposalCardInput) => object;
  liveSessionResultCard: (input: LiveSessionResultCardInput) => object;
}
