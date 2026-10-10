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
  /** Claude session id for a "Continue live" button (beanAction `resume-live`); absent = no button. */
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
  /** Selectable claude models for the on-card model picker; empty = no picker (claude's default). */
  models: { id: string; label: string }[];
  /** Selectable skills for the on-card skill picker; empty = no picker. */
  skills: { name: string }[];
  /** Live-capable CLIs for the on-card CLI picker — only claude today (live-session.ts is
   * claude-specific), but rendered so the surface matches the delegate card. */
  clis: string[];
  /** Set when continuing a recorded delegate session: the original run's instruction, shown as
   * "Continues: …". The project is locked — no project picker. */
  continues?: string;
}

export interface LiveSessionResultCardInput {
  projectName: string;
  startedBy: string;
  outcome: "started" | "cancelled" | "ended";
  /** On "ended": re-offer "Continue live" for this Claude session id (a resumed session). */
  resumeLiveId?: string;
}

export interface CardBuilders {
  proposalCard: (input: ProposalCardInput) => object;
  runningCard: (input: RunningCardInput) => object;
  finishedCard: (input: FinishedCardInput) => object;
  noteProposalCard: (input: NoteProposalCardInput) => object;
  noteResultCard: (input: NoteResultCardInput) => object;
  todoProposalCard: (input: TodoProposalCardInput) => object;
  todoResultCard: (input: TodoResultCardInput) => object;
  rememberedCard: (input: RememberedCardInput) => object;
  skillProposalCard: (input: SkillProposalCardInput) => object;
  skillResultCard: (input: SkillResultCardInput) => object;
  liveSessionProposalCard: (input: LiveSessionProposalCardInput) => object;
  liveSessionResultCard: (input: LiveSessionResultCardInput) => object;
}
