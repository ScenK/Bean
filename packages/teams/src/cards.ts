import type {
  ProposalCardInput, RunningCardInput, FinishedCardInput, NoteProposalCardInput, NoteResultCardInput,
  NoteArchiveProposalCardInput, NoteArchiveResultCardInput,
  RememberedCardInput, ReminderCardInput,
  SkillProposalCardInput, SkillResultCardInput, TodoProposalCardInput, TodoResultCardInput,
  RoutineProposalCardInput, RoutineResultCardInput,
  LiveSessionProposalCardInput, LiveSessionResultCardInput,
} from "@bean/core";
import { BROWSER_SKILL_NOTE, rememberedScopeLine } from "@bean/core";

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
          ...input.skills.map((s) => ({ title: s.browser ? `${s.name} — ${BROWSER_SKILL_NOTE}` : s.name, value: s.name })),
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
      // associatedInputs "none": the required prompt input must not block Cancel.
      { type: "Action.Submit", title: "Cancel", associatedInputs: "none", data: { beanAction: "cancel-proposal", proposalId: input.proposalId } },
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
      { type: "Action.Submit", title: "Cancel run", data: { beanAction: "cancel-run", runId: input.runId } },
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
      ...(input.resume
        ? [{ type: "TextBlock", text: `Resume (${input.projectName}):` }, { type: "TextBlock", text: input.resume, fontType: "monospace", wrap: true }]
        : []),
    ],
    actions: continueLiveActions(input.resumeLiveId),
  };
}

// "Continue live" on a finished delegate / ended live-session card; the session id rides the
// generic proposalId slot.
function continueLiveActions(sessionId: string | undefined): object[] {
  return sessionId ? [{ type: "Action.Submit", title: "Continue live", data: { beanAction: "resume-live", proposalId: sessionId } }] : [];
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
      {
        type: "FactSet",
        facts: [
          { title: "Note", value: input.projectName ?? "general" },
          ...(input.imageCount ? [{ title: "Images", value: `${input.imageCount} image(s) attached` }] : []),
        ],
      },
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

/** Confirm-first note archive: title, project, last update, first-line snippet, Archive/Cancel. */
export function noteArchiveProposalCard(input: NoteArchiveProposalCardInput): object {
  return {
    $schema: SCHEMA,
    type: "AdaptiveCard",
    version: "1.4",
    body: [
      { type: "TextBlock", size: "medium", weight: "bolder", text: "Archive this note?" },
      { type: "TextBlock", text: input.title, weight: "bolder", wrap: true },
      ...(input.snippet ? [{ type: "TextBlock", text: input.snippet, wrap: true, isSubtle: true }] : []),
      {
        type: "FactSet",
        facts: [
          { title: "Note", value: input.projectName ?? "general" },
          { title: "Updated", value: input.updated.slice(0, 10) },
        ],
      },
    ],
    actions: [
      { type: "Action.Submit", title: "Archive", style: "destructive", data: { beanAction: "archive-note", proposalId: input.proposalId } },
      { type: "Action.Submit", title: "Cancel", data: { beanAction: "cancel-archive-note", proposalId: input.proposalId } },
    ],
  };
}

/** Archive receipt; Restore carries the note id. */
export function noteArchiveResultCard(input: NoteArchiveResultCardInput): object {
  return {
    $schema: SCHEMA,
    type: "AdaptiveCard",
    version: "1.4",
    body: [
      { type: "TextBlock", weight: "bolder", text: `Note archive ${input.outcome === "archived" ? "done" : "cancelled"} (by ${input.by})` },
      { type: "TextBlock", text: input.title, wrap: true, isSubtle: true },
    ],
    actions: input.outcome === "archived" && input.noteId
      ? [{ type: "Action.Submit", title: "Restore", data: { beanAction: "restore-note", proposalId: input.noteId } }]
      : [],
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

// Mobile-first: When / Steps / Sends to as a FactSet; the toggle title shows the CURRENT state.
// An invalid draft shows the reason and only Cancel.
export function routineProposalCard(input: RoutineProposalCardInput): object {
  const id = input.proposalId;
  const cancel = { type: "Action.Submit", title: "Cancel", data: { beanAction: "cancel-routine", proposalId: id } };
  const facts = [
    { title: "When", value: input.schedule },
    { title: "Steps", value: input.steps.join("\n") || "None — it only notifies" },
    { title: "Sends to", value: input.sinks.join("\n") },
    ...(input.todoNote ? [{ title: "Todos", value: input.todoNote }] : []),
  ];
  return {
    $schema: SCHEMA,
    type: "AdaptiveCard",
    version: "1.4",
    body: [
      { type: "TextBlock", size: "medium", weight: "bolder", wrap: true, text: input.updating ? `Bean proposes replacing sprout ${input.name}` : `Bean proposes sprout ${input.name}` },
      ...(input.description ? [{ type: "TextBlock", text: input.description, wrap: true }] : []),
      ...(input.problem
        ? [{ type: "TextBlock", text: `Can't save: ${input.problem}`, wrap: true, color: "attention" }]
        : [
            { type: "FactSet", facts },
            ...(input.warnings ?? []).map((w) => ({ type: "TextBlock", text: `Heads up: ${w}`, wrap: true, color: "warning" })),
            ...(input.ownerEnables ? [{ type: "TextBlock", text: `Starts off — ${input.ownerEnables} turns it on.`, wrap: true, isSubtle: true }] : []),
          ]),
    ],
    // A non-owner's draft: no toggle (it always saves off).
    actions: input.problem ? [cancel] : input.ownerEnables ? [
      { type: "Action.Submit", title: "Save draft", style: "positive", data: { beanAction: "save-routine", proposalId: id } },
      cancel,
    ] : [
      { type: "Action.Submit", title: input.enabled ? "Enabled: on" : "Enabled: off", data: { beanAction: "toggle-routine", proposalId: id } },
      { type: "Action.Submit", title: input.updating ? "Replace sprout" : "Save sprout", style: "positive", data: { beanAction: "save-routine", proposalId: id } },
      cancel,
    ],
  };
}

export function routineResultCard(input: RoutineResultCardInput): object {
  const title = input.outcome === "saved"
    ? `Sprout saved (by ${input.by}) — ${input.enabled ? "on" : "off"}`
    : input.outcome === "failed" ? "Sprout not saved" : `Sprout cancelled (by ${input.by})`;
  return {
    $schema: SCHEMA,
    type: "AdaptiveCard",
    version: "1.4",
    body: [
      { type: "TextBlock", weight: "bolder", text: title, wrap: true },
      { type: "TextBlock", text: input.problem ? `${input.name}: ${input.problem}` : input.name, wrap: true, isSubtle: true },
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
      { type: "TextBlock", text: rememberedScopeLine(input.scope), isSubtle: true, wrap: true },
    ],
    actions: [
      { type: "Action.Submit", title: "Forget", data: { beanAction: "forget-memory", proposalId: input.memoryId } },
      ...(input.scope === "private"
        ? [{ type: "Action.Submit", title: "Share with everyone", data: { beanAction: "share-memory", proposalId: input.memoryId } }]
        : []),
    ],
  };
}

/** Receipt for a set_reminder; Teams renders {{DATE()}}/{{TIME()}} in each viewer's timezone.
 * They need RFC 3339 with a `Z` and no milliseconds, so normalise whatever `at` the model gave. */
export function reminderCard(input: ReminderCardInput): object {
  const at = new Date(input.at).toISOString().replace(/\.\d{3}Z$/, "Z");
  return {
    $schema: SCHEMA,
    type: "AdaptiveCard",
    version: "1.4",
    body: [
      { type: "TextBlock", weight: "bolder", text: "⏰ Reminder set" },
      { type: "TextBlock", text: input.text, wrap: true },
      // TextBlock, not FactSet: DATE()/TIME() are documented for TextBlock text.
      { type: "TextBlock", text: `When: {{DATE(${at}, SHORT)}} {{TIME(${at})}}`, isSubtle: true, wrap: true },
    ],
    actions: [{ type: "Action.Submit", title: "Cancel", data: { beanAction: "cancel-reminder", proposalId: input.reminderId } }],
  };
}

// Input ids (projectPath/model/skillName/cli/steering/instruction) come back merged into the
// Start Action.Submit data — the Teams-native counterpart to Discord's per-select interactions.
export function liveSessionProposalCard(input: LiveSessionProposalCardInput): object {
  const steering = input.steering ?? "restricted";
  const projectPicker = {
    type: "Input.ChoiceSet", id: "projectPath", label: "Project",
    // value must be the path (what start-live applies); default to the named project's path.
    value: input.projects.find((p) => p.name === input.projectName)?.path ?? input.projectName,
    choices: input.projects.map((p) => ({ title: p.name, value: p.path })),
  };
  // A resumed session's project is locked (core ignores a submitted projectPath): no picker. It has
  // no opening turn either, so no prompt or skill: the chat's first message opens it.
  const resuming = input.continues !== undefined;
  const body: object[] = [
    { type: "TextBlock", text: resuming ? "Bean proposes continuing a session live" : "Bean proposes a live agent session", weight: "Bolder" },
    ...(resuming ? [{ type: "FactSet", facts: [
      { title: "Continues", value: input.continues }, { title: "Project", value: input.projectName },
      ...(input.agent ? [{ title: "Agent", value: input.agent }] : []),
    ] }] : []),
    resuming
      ? { type: "TextBlock", text: "Picks up where it left off on your next message here — nothing runs until then.", wrap: true }
      : { type: "Input.Text", id: "instruction", label: "Prompt", isMultiline: true, value: input.instruction },
    ...(resuming ? [] : [projectPicker]),
  ];
  if (input.skills.length > 0 && !resuming) {
    body.push({
      type: "Input.ChoiceSet", id: "skillName", label: "Skill (optional)", value: input.skillName ?? "__none__",
      choices: [{ title: "— no skill —", value: "__none__" }, ...input.skills.map((s) => ({ title: s.name, value: s.name }))],
    });
  }
  if (input.clis.length > 0) {
    body.push({
      type: "Input.ChoiceSet", id: "cli", label: "CLI", value: input.cli,
      choices: input.clis.map((c) => ({ title: c, value: c })),
    });
  }
  // No re-render on a CLI pick here, so every live CLI's models are listed (tagged when only one
  // offers it); Start resolves the pick within the chosen CLI, else that CLI's own default.
  if (input.models.length > 0) {
    const tagged = new Set(input.models.flatMap((m) => m.availableOn)).size > 1;
    body.push({
      type: "Input.ChoiceSet", id: "model", label: "Model (optional)", ...(input.model ? { value: input.model } : {}),
      choices: input.models.map((m) => ({
        title: tagged && m.availableOn.length === 1 ? `${m.label} (${m.availableOn[0]})` : m.label, value: m.id,
      })),
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
  return {
    type: "AdaptiveCard", version: "1.4", body: [{ type: "TextBlock", text, weight: "Bolder" }],
    ...(input.outcome === "ended" && input.resumeLiveId ? { actions: continueLiveActions(input.resumeLiveId) } : {}),
  };
}
