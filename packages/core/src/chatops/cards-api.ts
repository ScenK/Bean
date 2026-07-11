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

export interface CardBuilders {
  proposalCard: (input: ProposalCardInput) => object;
  runningCard: (input: RunningCardInput) => object;
  finishedCard: (input: FinishedCardInput) => object;
  noteProposalCard: (input: NoteProposalCardInput) => object;
  noteResultCard: (input: NoteResultCardInput) => object;
}
