import type {
  CardBuilders, FinishedCardInput, MemoryProposalCardInput, MemoryResultCardInput,
  NoteProposalCardInput, NoteResultCardInput, ProposalCardInput, RunningCardInput,
  ConsolidationProposalCardInput, ConsolidationResultCardInput,
  SkillProposalCardInput, SkillResultCardInput, TodoProposalCardInput, TodoResultCardInput,
  LiveSessionProposalCardInput, LiveSessionResultCardInput,
} from "@bean/core";

// Raw Discord API component payloads (type 1 = action row, 2 = button, 3 = string select).
// Plain JSON keeps the builders pure/testable and discord.js accepts them directly.
const BUTTON = 2;
const STRING_SELECT = 3;
const row = (components: object[]): object => ({ type: 1, components });

function proposalCard(input: ProposalCardInput): object {
  const cliSelect = {
    type: STRING_SELECT,
    custom_id: `bean:cli:${input.proposalId}`,
    placeholder: "CLI",
    options: input.clis.map((c) => ({ label: c, value: c, default: c === input.defaultCli })),
  };
  const modelSelect = {
    type: STRING_SELECT,
    custom_id: `bean:model:${input.proposalId}`,
    placeholder: "Model",
    options: input.models
      .filter((m) => m.availableOn.length > 0)
      .map((m) => ({
        label: `${m.label} (${m.availableOn.join("/")})`,
        value: m.id,
        default: m.id === input.defaultModel,
      })),
  };
  const buttons = [
    { type: BUTTON, style: 3, label: "Run", custom_id: `bean:confirm:${input.proposalId}` },
    { type: BUTTON, style: 2, label: "Cancel", custom_id: `bean:cancel-proposal:${input.proposalId}` },
  ];
  return {
    embeds: [{
      title: "Bean proposes a delegate run",
      description: input.instruction,
      fields: [
        { name: "Project", value: input.projectName, inline: true },
        ...(input.skillName ? [{ name: "Skill", value: input.skillName, inline: true }] : []),
      ],
    }],
    components: [row([cliSelect]), row([modelSelect]), row(buttons)],
  };
}

function runningCard(input: RunningCardInput): object {
  return {
    embeds: [{
      title: `Running in ${input.projectName}… (started by ${input.startedBy})`,
      description: input.instruction,
      ...(input.tail ? { fields: [{ name: "Progress", value: `\`\`\`\n${input.tail}\n\`\`\`` }] } : {}),
    }],
    // cancel-run carries the projectPath in the customId's id slot; server.ts resolves it
    // via its proposal-message state (spec: adapter-local maps). Using projectPath directly
    // here keeps the id self-contained instead.
    components: [row([{ type: BUTTON, style: 4, label: "Cancel run", custom_id: `bean:cancel-run:${input.projectPath}` }])],
  };
}

function finishedCard(input: FinishedCardInput): object {
  return {
    embeds: [{
      title: `Run ${input.outcome} in ${input.projectName} (started by ${input.startedBy})`,
      description: input.instruction,
    }],
    components: [],
  };
}

// Discord rejects an embed whose description exceeds 4096 chars, which would drop the whole
// Save/Cancel card for a long-but-valid note. Clamp the *display* only — NoteProposalStore
// keeps the full draft, so Save still writes every character.
const EMBED_DESC_LIMIT = 4096;
function noteDescription(title: string, body: string): string {
  const full = `**${title}**\n\n${body}`;
  if (full.length <= EMBED_DESC_LIMIT) return full;
  const suffix = "\n\n…(preview truncated; the full note is saved)";
  return full.slice(0, EMBED_DESC_LIMIT - suffix.length) + suffix;
}

function noteProposalCard(input: NoteProposalCardInput): object {
  return {
    embeds: [{
      title: input.updating ? "Bean proposes a note update" : "Bean proposes a note",
      description: noteDescription(input.title, input.body),
      fields: [{ name: "Note", value: input.projectName ?? "general", inline: true }],
    }],
    components: [row([
      { type: BUTTON, style: 3, label: input.updating ? "Update note" : "Save note", custom_id: `bean:save-note:${input.proposalId}` },
      { type: BUTTON, style: 2, label: "Cancel", custom_id: `bean:cancel-note:${input.proposalId}` },
    ])],
  };
}

function noteResultCard(input: NoteResultCardInput): object {
  return {
    embeds: [{ title: `Note ${input.outcome} (by ${input.savedBy})`, description: input.title }],
    components: [],
  };
}

function todoProposalCard(input: TodoProposalCardInput): object {
  return {
    embeds: [{
      title: `Queue a todo on "${input.routine}"`,
      description: input.text,
    }],
    components: [row([
      { type: BUTTON, style: 3, label: "Queue", custom_id: `bean:queue-todo:${input.proposalId}` },
      { type: BUTTON, style: 2, label: "Cancel", custom_id: `bean:cancel-todo:${input.proposalId}` },
    ])],
  };
}

function todoResultCard(input: TodoResultCardInput): object {
  const title = input.outcome === "queued" ? `Queued by ${input.queuedBy}` : "Cancelled";
  return { embeds: [{ title, description: input.routine }], components: [] };
}

function skillProposalCard(input: SkillProposalCardInput): object {
  return {
    embeds: [{
      title: input.updating ? "Bean proposes a skill update" : "Bean proposes a new skill",
      description: noteDescription(input.name, `\`\`\`markdown\n${input.body}\n\`\`\``),
      fields: [{ name: "Skill", value: input.updating ? `${input.name} (replaces existing)` : input.name, inline: true }],
    }],
    components: [row([
      { type: BUTTON, style: 3, label: input.updating ? "Update skill" : "Save skill", custom_id: `bean:save-skill:${input.proposalId}` },
      { type: BUTTON, style: 2, label: "Cancel", custom_id: `bean:cancel-skill:${input.proposalId}` },
    ])],
  };
}

function skillResultCard(input: SkillResultCardInput): object {
  return {
    embeds: [{ title: `Skill ${input.outcome} (by ${input.savedBy})`, description: input.name }],
    components: [],
  };
}

// Discord select option labels are capped at 100 chars; the full fact is kept in the
// MemoryProposalStore, so Remember still saves the untruncated text.
const OPTION_LABEL_LIMIT = 100;
function clampLabel(text: string): string {
  return text.length <= OPTION_LABEL_LIMIT ? text : text.slice(0, OPTION_LABEL_LIMIT - 1) + "…";
}

function memoryProposalCard(input: MemoryProposalCardInput): object {
  const facts = input.facts.slice(0, 25); // Discord select menus allow at most 25 options
  const select = {
    type: STRING_SELECT,
    custom_id: `bean:pick-memories:${input.proposalId}`,
    placeholder: "Facts to remember",
    min_values: 0,
    max_values: facts.length,
    options: facts.map((f, i) => ({
      label: clampLabel(f.projectName ? `[${f.projectName}] ${f.text}` : f.text),
      value: String(i),
      default: true,
    })),
  };
  return {
    embeds: [{
      title: "Bean wants to remember",
      description: facts
        .map((f, i) => `${i + 1}. ${f.projectName ? `(${f.projectName}) ` : ""}${f.text}`)
        .join("\n")
        .slice(0, 4096),
    }],
    components: [
      row([select]),
      row([
        { type: BUTTON, style: 3, label: "Remember selected", custom_id: `bean:save-memories:${input.proposalId}` },
        { type: BUTTON, style: 2, label: "Cancel", custom_id: `bean:cancel-memories:${input.proposalId}` },
      ]),
    ],
  };
}

function memoryResultCard(input: MemoryResultCardInput): object {
  const title = input.outcome === "saved"
    ? `Memory saved: remembered ${input.count} fact(s) (by ${input.savedBy})`
    : `Memory cancelled (by ${input.savedBy})`;
  return { embeds: [{ title }], components: [] };
}

function consolidationProposalCard(input: ConsolidationProposalCardInput): object {
  const lines = [
    ...input.merges.map((m) => `Merge ${m.count} → ${m.mergedText}`),
    ...input.drops.map((d) => `Drop: ${d}`),
  ];
  return {
    embeds: [{ title: "Bean suggests tidying up memory", description: lines.join("\n").slice(0, 4096) }],
    components: [row([
      { type: BUTTON, style: 3, label: "Apply", custom_id: `bean:confirm-consolidation:${input.proposalId}` },
      { type: BUTTON, style: 2, label: "Cancel", custom_id: `bean:cancel-consolidation:${input.proposalId}` },
    ])],
  };
}

function consolidationResultCard(input: ConsolidationResultCardInput): object {
  const title = input.outcome === "applied" ? "Memory tidied up." : "Tidy-up cancelled.";
  return { embeds: [{ title }], components: [] };
}

// Discord embed description cap; also the modal text-input cap, so a stored prompt never
// overflows what the Edit modal can hold.
const LIVE_PROMPT_LIMIT = 4000;

function liveSessionProposalCard(input: LiveSessionProposalCardInput): object {
  // Discord: select value ≤ 100 chars (drops any project whose path is longer), ≤ 25 options.
  const projectSelect = {
    type: STRING_SELECT,
    custom_id: `bean:live-project:${input.proposalId}`,
    placeholder: "Project",
    options: input.projects
      .filter((p) => p.path.length <= 100)
      .slice(0, 25)
      .map((p) => ({ label: p.name.slice(0, 100), value: p.path, default: p.name === input.projectName })),
  };
  // "No skill" sentinel — double-underscore so it can't collide with a real kebab-case skill.
  const skillRows = input.skills.length > 0
    ? [row([{
        type: STRING_SELECT,
        custom_id: `bean:live-skill:${input.proposalId}`,
        placeholder: "Skill (optional)",
        options: [
          { label: "— no skill —", value: "__none__", default: !input.skillName },
          ...input.skills.slice(0, 24).map((s) => ({ label: s.name.slice(0, 100), value: s.name, default: s.name === input.skillName })),
        ],
      }])]
    : [];
  const cliRows = input.clis.length > 0
    ? [row([{
        type: STRING_SELECT,
        custom_id: `bean:live-cli:${input.proposalId}`,
        placeholder: "CLI",
        options: input.clis.slice(0, 25).map((c, i) => ({ label: c, value: c, default: i === 0 })),
      }])]
    : [];
  // Only shown when claude has configured models; empty = claude picks its own default.
  const modelRows = input.models.length > 0
    ? [row([{
        type: STRING_SELECT,
        custom_id: `bean:live-model:${input.proposalId}`,
        placeholder: "Model (optional)",
        options: input.models.slice(0, 25).map((m) => ({ label: m.label.slice(0, 100), value: m.id, default: m.id === input.model })),
      }])]
    : [];
  const restricted = (input.steering ?? "restricted") === "restricted";
  const steeringHelp = restricted
    ? "Restricted: only the starter steers (add co-drivers in-session with `+driver @name`)."
    : "War-room: anyone in this channel steers.";
  return {
    embeds: [{
      title: "Bean proposes a live agent session",
      description: input.instruction.slice(0, LIVE_PROMPT_LIMIT),
      fields: [{ name: "How it works", value: `Output streams here; each steering message becomes the agent's next turn. Say \`stop\` to end it.\n${steeringHelp}` }],
    }],
    // Discord caps a message at 5 action rows: project, skill, cli, model, buttons.
    components: [
      row([projectSelect]),
      ...skillRows,
      ...cliRows,
      ...modelRows,
      row([
        // Label shows the CURRENT mode; tapping toggles restricted ⇄ war-room.
        { type: BUTTON, style: 2, label: restricted ? "Mode: Restricted" : "Mode: War-room", custom_id: `bean:live-mode:${input.proposalId}` },
        { type: BUTTON, style: 1, label: "Edit prompt", custom_id: `bean:live-edit:${input.proposalId}` },
        { type: BUTTON, style: 3, label: "Start session", custom_id: `bean:start-live:${input.proposalId}` },
        { type: BUTTON, style: 2, label: "Cancel", custom_id: `bean:cancel-live:${input.proposalId}` },
      ]),
    ],
  };
}

function liveSessionResultCard(input: LiveSessionResultCardInput): object {
  const title = input.outcome === "started"
    ? `Live session started in ${input.projectName} (by ${input.startedBy})`
    : input.outcome === "cancelled"
      ? `Live session cancelled (by ${input.startedBy})`
      : `Live session in ${input.projectName} ended`;
  return { embeds: [{ title }], components: [] };
}

export const discordCards: CardBuilders = {
  proposalCard, runningCard, finishedCard, noteProposalCard, noteResultCard, memoryProposalCard, memoryResultCard,
  consolidationProposalCard, consolidationResultCard, skillProposalCard, skillResultCard, todoProposalCard, todoResultCard,
  liveSessionProposalCard, liveSessionResultCard,
};
