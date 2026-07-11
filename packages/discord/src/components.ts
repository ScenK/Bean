import type {
  CardBuilders, FinishedCardInput, NoteProposalCardInput, NoteResultCardInput, ProposalCardInput, RunningCardInput,
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

// Discord embed descriptions cap at 4096 chars; note bodies from chat are well under that.
// ponytail: truncate if a note ever overflows — not worth the code until it does.
function noteProposalCard(input: NoteProposalCardInput): object {
  return {
    embeds: [{
      title: input.updating ? "Bean proposes a note update" : "Bean proposes a note",
      description: `**${input.title}**\n\n${input.body}`,
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

export const discordCards: CardBuilders = { proposalCard, runningCard, finishedCard, noteProposalCard, noteResultCard };
