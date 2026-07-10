import type { AvailableModel, CliName } from "@bean/core";

const SCHEMA = "http://adaptivecards.io/schemas/adaptive-card.json";

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

/** Confirm-first proposal: verbatim instruction, cli/model ChoiceSets, Run/Cancel.
 * Input ids "cli"/"model" come back merged into the Action.Submit data. */
export function proposalCard(input: ProposalCardInput): object {
  const modelChoices = input.models.filter((m) => m.availableOn.length > 0);
  return {
    $schema: SCHEMA,
    type: "AdaptiveCard",
    version: "1.4",
    body: [
      { type: "TextBlock", size: "medium", weight: "bolder", text: "Bean proposes a delegate run" },
      {
        type: "FactSet",
        facts: [
          { title: "Project", value: input.projectName },
          ...(input.skillName ? [{ title: "Skill", value: input.skillName }] : []),
        ],
      },
      { type: "TextBlock", text: input.instruction, wrap: true },
      {
        type: "Input.ChoiceSet",
        id: "cli",
        label: "CLI",
        value: input.defaultCli,
        choices: input.clis.map((c) => ({ title: c, value: c })),
      },
      {
        type: "Input.ChoiceSet",
        id: "model",
        label: "Model",
        ...(input.defaultModel ? { value: input.defaultModel } : {}),
        choices: modelChoices.map((m) => ({ title: `${m.label} (${m.availableOn.join("/")})`, value: m.id })),
      },
    ],
    actions: [
      {
        type: "Action.Submit",
        title: "Run",
        style: "positive",
        data: { beanAction: "confirm", proposalId: input.proposalId },
      },
      { type: "Action.Submit", title: "Cancel", data: { beanAction: "cancel-proposal", proposalId: input.proposalId } },
    ],
  };
}

export function runningCard(input: {
  projectName: string;
  instruction: string;
  startedBy: string;
  tail?: string;
  projectPath: string;
}): object {
  return {
    $schema: SCHEMA,
    type: "AdaptiveCard",
    version: "1.4",
    body: [
      { type: "TextBlock", weight: "bolder", text: `Running in ${input.projectName}… (started by ${input.startedBy})` },
      { type: "TextBlock", text: input.instruction, wrap: true, isSubtle: true },
      ...(input.tail ? [{ type: "TextBlock", text: input.tail, wrap: true, fontType: "monospace" }] : []),
    ],
    actions: [
      { type: "Action.Submit", title: "Cancel run", data: { beanAction: "cancel-run", projectPath: input.projectPath } },
    ],
  };
}

export function finishedCard(input: {
  projectName: string;
  instruction: string;
  startedBy: string;
  outcome: "done" | "error" | "cancelled";
}): object {
  return {
    $schema: SCHEMA,
    type: "AdaptiveCard",
    version: "1.4",
    body: [
      { type: "TextBlock", weight: "bolder", text: `Run ${input.outcome} in ${input.projectName} (started by ${input.startedBy})` },
      { type: "TextBlock", text: input.instruction, wrap: true, isSubtle: true },
    ],
    actions: [],
  };
}
