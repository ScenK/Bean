import type { CliName } from "../launcher.js";
import type { AvailableModel } from "../models.js";

export interface ProposalCardInput {
  proposalId: string;
  projectName: string;
  skillName?: string;
  instruction: string;
  clis: CliName[];
  models: AvailableModel[];
  defaultCli: CliName;
  defaultModel?: string;
}

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
}

export interface NoteProposalCardInput {
  proposalId: string;
  title: string;
  body: string;
  /** Resolved display name of the note's project; absent = a general note. */
  projectName?: string;
  /** True when this updates an existing linked note in place rather than creating one. */
  updating: boolean;
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

export interface MemoryProposalCardInput {
  proposalId: string;
  /** Candidate facts to confirm; projectName is the resolved display name or absent for global. */
  facts: { text: string; projectName?: string }[];
}

export interface MemoryResultCardInput {
  count: number;
  savedBy: string;
  outcome: "saved" | "cancelled";
}

export interface ConsolidationProposalCardInput {
  proposalId: string;
  /** Each merge group's combined text and how many facts it replaces. */
  merges: { mergedText: string; count: number }[];
  /** Text of each fact proposed for dropping. */
  drops: string[];
}

export interface ConsolidationResultCardInput {
  outcome: "applied" | "cancelled";
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
  /** Selectable projects for the on-card project picker; the one matching projectName is default. */
  projects: { name: string; path: string }[];
  /** Selectable claude models for the on-card model picker; empty = no picker (claude's default). */
  models: { id: string; label: string }[];
  /** Selectable skills for the on-card skill picker; empty = no picker. */
  skills: { name: string }[];
  /** Live-capable CLIs for the on-card CLI picker — only claude today (live-session.ts is
   * claude-specific), but rendered so the surface matches the delegate card. */
  clis: string[];
}

export interface LiveSessionResultCardInput {
  projectName: string;
  startedBy: string;
  outcome: "started" | "cancelled" | "ended";
}

export interface CardBuilders {
  proposalCard: (input: ProposalCardInput) => object;
  runningCard: (input: RunningCardInput) => object;
  finishedCard: (input: FinishedCardInput) => object;
  noteProposalCard: (input: NoteProposalCardInput) => object;
  noteResultCard: (input: NoteResultCardInput) => object;
  todoProposalCard: (input: TodoProposalCardInput) => object;
  todoResultCard: (input: TodoResultCardInput) => object;
  memoryProposalCard: (input: MemoryProposalCardInput) => object;
  memoryResultCard: (input: MemoryResultCardInput) => object;
  consolidationProposalCard: (input: ConsolidationProposalCardInput) => object;
  consolidationResultCard: (input: ConsolidationResultCardInput) => object;
  skillProposalCard: (input: SkillProposalCardInput) => object;
  skillResultCard: (input: SkillResultCardInput) => object;
  liveSessionProposalCard: (input: LiveSessionProposalCardInput) => object;
  liveSessionResultCard: (input: LiveSessionResultCardInput) => object;
}
