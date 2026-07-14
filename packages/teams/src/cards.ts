import type {
  ProposalCardInput, RunningCardInput, FinishedCardInput, NoteProposalCardInput, NoteResultCardInput,
  MemoryProposalCardInput, MemoryResultCardInput, ConsolidationProposalCardInput, ConsolidationResultCardInput,
} from "@bean/core";

const SCHEMA = "http://adaptivecards.io/schemas/adaptive-card.json";

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

export function runningCard(input: RunningCardInput): object {
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

export function finishedCard(input: FinishedCardInput): object {
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

/** Confirm-first note draft: title, body, project/general, Save/Cancel.
 * data ids come back merged into the Action.Submit payload as beanAction + proposalId. */
export function noteProposalCard(input: NoteProposalCardInput): object {
  return {
    $schema: SCHEMA,
    type: "AdaptiveCard",
    version: "1.4",
    body: [
      { type: "TextBlock", size: "medium", weight: "bolder", text: input.updating ? "Bean proposes a note update" : "Bean proposes a note" },
      { type: "TextBlock", weight: "bolder", text: input.title, wrap: true },
      { type: "FactSet", facts: [{ title: "Note", value: input.projectName ?? "general" }] },
      { type: "TextBlock", text: input.body, wrap: true },
    ],
    actions: [
      {
        type: "Action.Submit",
        title: input.updating ? "Update note" : "Save note",
        style: "positive",
        data: { beanAction: "save-note", proposalId: input.proposalId },
      },
      { type: "Action.Submit", title: "Cancel", data: { beanAction: "cancel-note", proposalId: input.proposalId } },
    ],
  };
}

export function noteResultCard(input: NoteResultCardInput): object {
  return {
    $schema: SCHEMA,
    type: "AdaptiveCard",
    version: "1.4",
    body: [
      { type: "TextBlock", weight: "bolder", text: `Note ${input.outcome} (by ${input.savedBy})` },
      { type: "TextBlock", text: input.title, wrap: true, isSubtle: true },
    ],
    actions: [],
  };
}

/** Confirm-first memory batch: one selectable toggle per candidate fact (default on),
 * Remember selected / Cancel. Toggle ids fact-<i> come back merged into the Submit payload;
 * the Teams server turns the "true" ones into memoryPicks. */
export function memoryProposalCard(input: MemoryProposalCardInput): object {
  return {
    $schema: SCHEMA,
    type: "AdaptiveCard",
    version: "1.4",
    body: [
      { type: "TextBlock", size: "medium", weight: "bolder", text: "Bean wants to remember" },
      ...input.facts.map((f, i) => ({
        type: "Input.Toggle",
        id: `fact-${i}`,
        title: f.projectName ? `(${f.projectName}) ${f.text}` : f.text,
        value: "true",
        wrap: true,
      })),
    ],
    actions: [
      {
        type: "Action.Submit",
        title: "Remember selected",
        style: "positive",
        data: { beanAction: "save-memories", proposalId: input.proposalId },
      },
      { type: "Action.Submit", title: "Cancel", data: { beanAction: "cancel-memories", proposalId: input.proposalId } },
    ],
  };
}

export function memoryResultCard(input: MemoryResultCardInput): object {
  const text = input.outcome === "saved"
    ? `Memory saved: remembered ${input.count} fact(s) (by ${input.savedBy})`
    : `Memory cancelled (by ${input.savedBy})`;
  return {
    $schema: SCHEMA,
    type: "AdaptiveCard",
    version: "1.4",
    body: [{ type: "TextBlock", weight: "bolder", text }],
    actions: [],
  };
}

/** Follow-up card offered after a save-memories that pushed the list past the tidy-up
 * threshold: proposed merges/drops, Apply/Cancel — same confirm-first shape as every other
 * memory change. */
export function consolidationProposalCard(input: ConsolidationProposalCardInput): object {
  const factSets = [
    ...input.merges.map((m) => ({ title: `Merge ${m.count}`, value: m.mergedText })),
    ...input.drops.map((d) => ({ title: "Drop", value: d })),
  ];
  return {
    $schema: SCHEMA,
    type: "AdaptiveCard",
    version: "1.4",
    body: [
      { type: "TextBlock", size: "medium", weight: "bolder", text: "Bean suggests tidying up memory" },
      { type: "FactSet", facts: factSets },
    ],
    actions: [
      {
        type: "Action.Submit",
        title: "Apply",
        style: "positive",
        data: { beanAction: "confirm-consolidation", proposalId: input.proposalId },
      },
      { type: "Action.Submit", title: "Cancel", data: { beanAction: "cancel-consolidation", proposalId: input.proposalId } },
    ],
  };
}

export function consolidationResultCard(input: ConsolidationResultCardInput): object {
  const text = input.outcome === "applied" ? "Memory tidied up." : "Tidy-up cancelled.";
  return {
    $schema: SCHEMA,
    type: "AdaptiveCard",
    version: "1.4",
    body: [{ type: "TextBlock", weight: "bolder", text }],
    actions: [],
  };
}
