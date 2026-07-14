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

export interface CardBuilders {
  proposalCard: (input: ProposalCardInput) => object;
  runningCard: (input: RunningCardInput) => object;
  finishedCard: (input: FinishedCardInput) => object;
  noteProposalCard: (input: NoteProposalCardInput) => object;
  noteResultCard: (input: NoteResultCardInput) => object;
  memoryProposalCard: (input: MemoryProposalCardInput) => object;
  memoryResultCard: (input: MemoryResultCardInput) => object;
  consolidationProposalCard: (input: ConsolidationProposalCardInput) => object;
  consolidationResultCard: (input: ConsolidationResultCardInput) => object;
}
