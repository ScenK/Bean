import type {
  ProposalCardInput, RunningCardInput, FinishedCardInput, NoteProposalCardInput, NoteResultCardInput,
  RememberedCardInput,
  SkillProposalCardInput, SkillResultCardInput, TodoProposalCardInput, TodoResultCardInput,
  LiveSessionProposalCardInput, LiveSessionResultCardInput,
} from "@bean/core";

const SCHEMA = "http://adaptivecards.io/schemas/adaptive-card.json";

/** Confirm-first proposal: editable instruction, skill/cli/model ChoiceSets, Run/Cancel.
 * Input ids "instruction"/"skillName"/"cli"/"model" come back merged into the Action.Submit data. */
export function proposalCard(input: ProposalCardInput): object {
  const modelChoices = input.models.filter((m) => m.availableOn.length > 0);
  return {
    $schema: SCHEMA,
    type: "AdaptiveCard",
    version: "1.4",
    body: [
      { type: "TextBlock", size: "medium", weight: "bolder", text: "Bean proposes a delegate run" },
      { type: "FactSet", facts: [{ title: "Project", value: input.projectName }] },
      // Editable before Run; the value merges into the Run submit and core validates it.
      { type: "Input.Text", id: "instruction", label: "Prompt", isMultiline: true, isRequired: true, maxLength: 4000, value: input.instruction },
      ...(input.skills.length > 0 ? [{
        type: "Input.ChoiceSet",
        id: "skillName",
        label: "Skill",
        value: input.skillName ?? "__none__",
        choices: [
          { title: "— no skill —", value: "__none__" },
          ...input.skills.map((s) => ({ title: s.name, value: s.name })),
        ],
      }] : []),
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

/** Confirm-first todo draft: which routine's queue, the todo text, Queue/Cancel.
 * data ids come back merged into the Action.Submit payload as beanAction + proposalId. */
export function todoProposalCard(input: TodoProposalCardInput): object {
  return {
    $schema: SCHEMA,
    type: "AdaptiveCard",
    version: "1.4",
    body: [
      { type: "TextBlock", size: "medium", weight: "bolder", text: `Queue a todo on "${input.routine}"` },
      { type: "TextBlock", text: input.text, wrap: true },
    ],
    actions: [
      {
        type: "Action.Submit",
        title: "Queue",
        style: "positive",
        data: { beanAction: "queue-todo", proposalId: input.proposalId },
      },
      { type: "Action.Submit", title: "Cancel", data: { beanAction: "cancel-todo", proposalId: input.proposalId } },
    ],
  };
}

export function todoResultCard(input: TodoResultCardInput): object {
  const text = input.outcome === "queued"
    ? `Queued by ${input.queuedBy}`
    : "Cancelled";
  return {
    $schema: SCHEMA,
    type: "AdaptiveCard",
    version: "1.4",
    body: [
      { type: "TextBlock", weight: "bolder", text },
      { type: "TextBlock", text: input.routine, wrap: true, isSubtle: true },
    ],
    actions: [],
  };
}

/** Confirm-first skill draft: name, full markdown body, Save/Cancel.
 * data comes back merged into the Action.Submit payload as beanAction + proposalId. */
export function skillProposalCard(input: SkillProposalCardInput): object {
  return {
    $schema: SCHEMA,
    type: "AdaptiveCard",
    version: "1.4",
    body: [
      { type: "TextBlock", size: "medium", weight: "bolder", text: input.updating ? "Bean proposes a skill update" : "Bean proposes a new skill" },
      { type: "FactSet", facts: [{ title: "Skill", value: input.updating ? `${input.name} (replaces existing)` : input.name }] },
      { type: "TextBlock", text: input.body, wrap: true, fontType: "monospace" },
    ],
    actions: [
      {
        type: "Action.Submit",
        title: input.updating ? "Update skill" : "Save skill",
        style: "positive",
        data: { beanAction: "save-skill", proposalId: input.proposalId },
      },
      { type: "Action.Submit", title: "Cancel", data: { beanAction: "cancel-skill", proposalId: input.proposalId } },
    ],
  };
}

export function skillResultCard(input: SkillResultCardInput): object {
  return {
    $schema: SCHEMA,
    type: "AdaptiveCard",
    version: "1.4",
    body: [
      { type: "TextBlock", weight: "bolder", text: `Skill ${input.outcome} (by ${input.savedBy})` },
      { type: "TextBlock", text: input.name, wrap: true, isSubtle: true },
    ],
    actions: [],
  };
}

/** Receipt for a fact the remember tool saved directly; Forget carries the memory id. */
export function rememberedCard(input: RememberedCardInput): object {
  return {
    $schema: SCHEMA,
    type: "AdaptiveCard",
    version: "1.4",
    body: [
      { type: "TextBlock", weight: "bolder", text: "🧠 Got it — remembered" },
      { type: "TextBlock", text: `${input.projectName ? `(${input.projectName}) ` : ""}${input.text}`, wrap: true },
    ],
    actions: [{ type: "Action.Submit", title: "Forget", data: { beanAction: "forget-memory", proposalId: input.memoryId } }],
  };
}

// Input ids (projectPath/model/skillName/cli/steering/instruction) come back merged into the
// Start Action.Submit data — the Teams-native counterpart to Discord's per-select interactions.
export function liveSessionProposalCard(input: LiveSessionProposalCardInput): object {
  const steering = input.steering ?? "restricted";
  const body: object[] = [
    { type: "TextBlock", text: "Bean proposes a live agent session", weight: "Bolder" },
    { type: "Input.Text", id: "instruction", label: "Prompt", isMultiline: true, value: input.instruction },
    {
      type: "Input.ChoiceSet", id: "projectPath", label: "Project", value: input.projectName,
      // value must be the path (what start-live applies); default to the named project's path.
      choices: input.projects.map((p) => ({ title: p.name, value: p.path })),
    },
  ];
  const named = input.projects.find((p) => p.name === input.projectName);
  if (named) (body[2] as { value: string }).value = named.path;
  if (input.skills.length > 0) {
    body.push({
      type: "Input.ChoiceSet", id: "skillName", label: "Skill (optional)", value: input.skillName ?? "__none__",
      choices: [{ title: "— no skill —", value: "__none__" }, ...input.skills.map((s) => ({ title: s.name, value: s.name }))],
    });
  }
  if (input.clis.length > 0) {
    body.push({
      type: "Input.ChoiceSet", id: "cli", label: "CLI", value: input.clis[0],
      choices: input.clis.map((c) => ({ title: c, value: c })),
    });
  }
  if (input.models.length > 0) {
    body.push({
      type: "Input.ChoiceSet", id: "model", label: "Model (optional)", ...(input.model ? { value: input.model } : {}),
      choices: input.models.map((m) => ({ title: m.label, value: m.id })),
    });
  }
  body.push({
    type: "Input.ChoiceSet", id: "steering", label: "Who can steer", value: steering,
    choices: [
      { title: "Restricted (only you + co-drivers)", value: "restricted" },
      { title: "War-room (anyone in this chat)", value: "open" },
    ],
  });
  return {
    $schema: SCHEMA,
    type: "AdaptiveCard", version: "1.4",
    body,
    actions: [
      { type: "Action.Submit", title: "Start session", style: "positive", data: { beanAction: "start-live", proposalId: input.proposalId } },
      { type: "Action.Submit", title: "Cancel", data: { beanAction: "cancel-live", proposalId: input.proposalId }, associatedInputs: "none" },
    ],
  };
}

export function liveSessionResultCard(input: LiveSessionResultCardInput): object {
  const text = input.outcome === "started"
    ? `Live session started in ${input.projectName} (by ${input.startedBy})`
    : input.outcome === "cancelled"
      ? `Live session cancelled (by ${input.startedBy})`
      : `Live session in ${input.projectName} ended`;
  return { type: "AdaptiveCard", version: "1.4", body: [{ type: "TextBlock", text, weight: "Bolder" }] };
}
