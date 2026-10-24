import type {
  CardBuilders, FinishedCardInput, RememberedCardInput, ReminderCardInput,
  NoteProposalCardInput, NoteResultCardInput, NoteArchiveProposalCardInput, NoteArchiveResultCardInput, ProposalCardInput, RunningCardInput,
  SkillProposalCardInput, SkillResultCardInput, RoutineProposalCardInput, RoutineResultCardInput, TodoProposalCardInput, TodoResultCardInput,
  LiveSessionProposalCardInput, LiveSessionResultCardInput, CliName,
} from "@bean/core";
import { BROWSER_SKILL_NOTE, rememberedScopeLine } from "@bean/core";

// Raw Discord API component payloads (type 1 = action row, 2 = button, 3 = string select).
// Plain JSON keeps the builders pure/testable and discord.js accepts them directly.
const BUTTON = 2;
const STRING_SELECT = 3;
const row = (components: object[]): object => ({ type: 1, components });

// The skill dropdown shared by the delegate and live-session cards. Discord caps a select at
// 25 options with values ≤ 100 chars, so an over-long name is dropped (an invalid value would
// reject the whole payload) and the picked skill is hoisted to the front — truncation must
// never drop the option the card defaults to. "__none__" is the no-skill sentinel: double
// underscores so it can't collide with a real kebab-case skill name.
function skillSelectRows(customId: string, skills: { name: string; browser?: boolean }[], skillName?: string): object[] {
  const selectable = skills.filter((s) => s.name.length <= 100);
  const options = [
    ...selectable.filter((s) => s.name === skillName),
    ...selectable.filter((s) => s.name !== skillName),
  ].slice(0, 24);
  if (options.length === 0) return [];
  return [row([{
    type: STRING_SELECT,
    custom_id: customId,
    placeholder: "Skill (optional)",
    options: [
      { label: "— no skill —", value: "__none__", default: !skillName },
      ...options.map((s) => ({
        label: s.name, value: s.name, default: s.name === skillName,
        ...(s.browser ? { description: BROWSER_SKILL_NOTE } : {}),
      })),
    ],
  }])];
}

// Discord rejects an embed whose description exceeds 4096 chars. The delegate cards show the
// model-written instruction there, so clamp the *display* only — the stored instruction runs in full.
const EMBED_DESC_LIMIT = 4096;
function clampInstruction(instruction: string): string {
  return instruction.length <= EMBED_DESC_LIMIT ? instruction : instruction.slice(0, EMBED_DESC_LIMIT - 1) + "…";
}

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
  const skillRows = skillSelectRows(`bean:skill:${input.proposalId}`, input.skills, input.skillName);
  const buttons = [
    { type: BUTTON, style: 2, label: "Edit prompt", custom_id: `bean:delegate-edit:${input.proposalId}` },
    { type: BUTTON, style: 3, label: "Run", custom_id: `bean:confirm:${input.proposalId}` },
    { type: BUTTON, style: 2, label: "Cancel", custom_id: `bean:cancel-proposal:${input.proposalId}` },
  ];
  return {
    embeds: [{
      title: "Bean proposes a delegate run",
      description: clampInstruction(input.instruction),
      fields: [{ name: "Project", value: input.projectName, inline: true }],
    }],
    components: [...skillRows, row([cliSelect]), row([modelSelect]), row(buttons)],
  };
}

// Discord rejects an embed field value over 1024 chars. The tail is often a delegate's whole
// final answer, and a rejected edit used to crash the bot mid-run — keep only the newest end.
const FIELD_VALUE_LIMIT = 1024;
function clampField(text: string): string {
  return text.length <= FIELD_VALUE_LIMIT ? text : text.slice(0, FIELD_VALUE_LIMIT - 1) + "…";
}
function clampTail(tail: string): string {
  const max = FIELD_VALUE_LIMIT - "```\n\n```".length;
  return tail.length <= max ? tail : "…" + tail.slice(-(max - 1));
}

function runningCard(input: RunningCardInput): object {
  return {
    embeds: [{
      title: `Running in ${input.projectName}… (started by ${input.startedBy})`,
      description: clampInstruction(input.instruction),
      ...(input.tail ? { fields: [{ name: "Progress", value: `\`\`\`\n${clampTail(input.tail)}\n\`\`\`` }] } : {}),
    }],
    // cancel-run carries the run id in the customId's id slot (self-contained, no adapter state).
    components: [row([{ type: BUTTON, style: 4, label: "Cancel run", custom_id: `bean:cancel-run:${input.runId}` }])],
  };
}

// "Continue live" carries the Claude session id in its custom_id — rendered only when it fits
// Discord's 100-char cap (a truncated id would resume nothing).
function continueLiveRows(sessionId: string | undefined): object[] {
  const customId = `bean:resume-live:${sessionId}`;
  return sessionId && customId.length <= 100
    ? [row([{ type: BUTTON, style: 1, label: "Continue live", custom_id: customId }])]
    : [];
}

function finishedCard(input: FinishedCardInput): object {
  return {
    embeds: [{
      title: `Run ${input.outcome} in ${input.projectName} (started by ${input.startedBy})`,
      description: clampInstruction(input.instruction),
      ...(input.resume ? { fields: [{ name: `Resume (${input.projectName})`, value: `\`${input.resume}\`` }] } : {}),
    }],
    components: continueLiveRows(input.resumeLiveId),
  };
}

// A long-but-valid note would likewise drop the whole Save/Cancel card. Clamp the *display*
// only — NoteProposalStore keeps the full draft, so Save still writes every character.
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
      fields: [
        { name: "Note", value: input.projectName ?? "general", inline: true },
        ...(input.imageCount ? [{ name: "Images", value: `${input.imageCount} image(s) attached`, inline: true }] : []),
      ],
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

// Mobile-first: schedule, steps and destinations as short fields; the toggle label shows the
// CURRENT state. An invalid draft shows the reason and only Cancel.
function routineProposalCard(input: RoutineProposalCardInput): object {
  const id = input.proposalId;
  const fields = input.problem
    ? [{ name: "Can't save", value: clampField(input.problem) }]
    : [
        { name: "When", value: clampField(input.schedule) },
        { name: "Steps", value: clampField(input.steps.join("\n") || "None — it only notifies") },
        { name: "Sends to", value: clampField(input.sinks.join("\n")) },
        ...(input.todoNote ? [{ name: "Todos", value: clampField(input.todoNote) }] : []),
        ...(input.warnings?.length ? [{ name: "Heads up", value: clampField(input.warnings.join("\n")) }] : []),
        ...(input.ownerEnables ? [{ name: "Starts off", value: clampField(`${input.ownerEnables} turns it on.`) }] : []),
      ];
  return {
    embeds: [{
      title: (input.updating ? `Bean proposes replacing sprout ${input.name}` : `Bean proposes sprout ${input.name}`).slice(0, 256),
      // 1000, not 4096: Discord also caps a whole embed at 6000 chars, and the fields take up to ~3.2k.
      ...(input.description ? { description: input.description.slice(0, 1000) } : {}),
      fields,
    }],
    // A non-owner's draft: no toggle (it always saves off).
    components: [row(input.problem
      ? [{ type: BUTTON, style: 2, label: "Cancel", custom_id: `bean:cancel-routine:${id}` }]
      : input.ownerEnables ? [
          { type: BUTTON, style: 3, label: "Save draft", custom_id: `bean:save-routine:${id}` },
          { type: BUTTON, style: 2, label: "Cancel", custom_id: `bean:cancel-routine:${id}` },
        ] : [
          { type: BUTTON, style: 2, label: input.enabled ? "Enabled: on" : "Enabled: off", custom_id: `bean:toggle-routine:${id}` },
          { type: BUTTON, style: 3, label: input.updating ? "Replace sprout" : "Save sprout", custom_id: `bean:save-routine:${id}` },
          { type: BUTTON, style: 2, label: "Cancel", custom_id: `bean:cancel-routine:${id}` },
        ])],
  };
}

function routineResultCard(input: RoutineResultCardInput): object {
  const title = input.outcome === "saved"
    ? `Sprout saved (by ${input.by}) — ${input.enabled ? "on" : "off"}`
    : input.outcome === "failed" ? "Sprout not saved" : `Sprout cancelled (by ${input.by})`;
  return {
    embeds: [{ title: title.slice(0, 256), description: input.problem ? `${input.name}: ${input.problem}`.slice(0, 4096) : input.name }],
    components: [],
  };
}

function noteArchiveProposalCard(input: NoteArchiveProposalCardInput): object {
  return {
    embeds: [{
      title: "Archive this note?",
      description: noteDescription(input.title, input.snippet),
      fields: [
        { name: "Note", value: input.projectName ?? "general", inline: true },
        { name: "Updated", value: `<t:${Math.floor(Date.parse(input.updated) / 1000)}:D>`, inline: true },
      ],
    }],
    components: [row([
      { type: BUTTON, style: 4, label: "Archive", custom_id: `bean:archive-note:${input.proposalId}` },
      { type: BUTTON, style: 2, label: "Cancel", custom_id: `bean:cancel-archive-note:${input.proposalId}` },
    ])],
  };
}

// Restore carries the note id in its custom_id — rendered only when it fits Discord's 100-char
// cap (a UUID is ~55; a long legacy title-derived slug would restore nothing if truncated).
function noteArchiveResultCard(input: NoteArchiveResultCardInput): object {
  const customId = `bean:restore-note:${input.noteId}`;
  return {
    embeds: [{
      title: `Note archive ${input.outcome === "archived" ? "done" : "cancelled"} (by ${input.by})`,
      description: input.title.slice(0, 4096),
    }],
    components: input.outcome === "archived" && input.noteId && customId.length <= 100
      ? [row([{ type: BUTTON, style: 2, label: "Restore", custom_id: customId }])]
      : [],
  };
}

// custom_id caps at 100 chars; a UUID memory id plus the prefix is ~55.
function rememberedCard(input: RememberedCardInput): object {
  return {
    embeds: [{
      title: "🧠 Got it — remembered",
      description: `${input.projectName ? `(${input.projectName}) ` : ""}${input.text}`.slice(0, 4096),
      footer: { text: rememberedScopeLine(input.scope) },
    }],
    components: [row([
      { type: BUTTON, style: 2, label: "Forget", custom_id: `bean:forget-memory:${input.memoryId}` },
      ...(input.scope === "private"
        ? [{ type: BUTTON, style: 2, label: "Share with everyone", custom_id: `bean:share-memory:${input.memoryId}` }]
        : []),
    ])],
  };
}

// Discord renders <t:unix:F> in each viewer's own timezone.
function reminderCard(input: ReminderCardInput): object {
  return {
    embeds: [{
      title: "⏰ Reminder set",
      description: input.text.slice(0, 4096),
      fields: [{ name: "When", value: `<t:${Math.floor(Date.parse(input.at) / 1000)}:F>` }],
    }],
    components: [row([
      { type: BUTTON, style: 2, label: "Cancel", custom_id: `bean:cancel-reminder:${input.reminderId}` },
    ])],
  };
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
  const skillRows = skillSelectRows(`bean:live-skill:${input.proposalId}`, input.skills, input.skillName);
  const cliRows = input.clis.length > 0
    ? [row([{
        type: STRING_SELECT,
        custom_id: `bean:live-cli:${input.proposalId}`,
        placeholder: "CLI",
        options: input.clis.slice(0, 25).map((c) => ({ label: c, value: c, default: c === input.cli })),
      }])]
    : [];
  // The selected CLI's models (re-rendered on a CLI switch); none configured = its own default.
  const models = input.models.filter((m) => m.availableOn.includes(input.cli as CliName));
  const modelRows = models.length > 0
    ? [row([{
        type: STRING_SELECT,
        custom_id: `bean:live-model:${input.proposalId}`,
        placeholder: "Model (optional)",
        options: models.slice(0, 25).map((m) => ({ label: m.label.slice(0, 100), value: m.id, default: m.id === input.model })),
      }])]
    : [];
  const restricted = (input.steering ?? "restricted") === "restricted";
  const steeringHelp = restricted
    ? "Restricted: only the starter steers (add co-drivers in-session with `+driver @name`)."
    : "War-room: anyone in this channel steers.";
  // A resumed session's project is locked: shown as a field, no picker.
  const resuming = input.continues !== undefined;
  return {
    embeds: [{
      title: resuming ? "Bean proposes continuing a session live" : "Bean proposes a live agent session",
      description: input.instruction.slice(0, LIVE_PROMPT_LIMIT),
      fields: [
        ...(resuming ? [
          { name: "Continues", value: clampField(input.continues ?? "") },
          { name: "Project", value: input.projectName.slice(0, FIELD_VALUE_LIMIT), inline: true },
          ...(input.agent ? [{ name: "Agent", value: input.agent, inline: true }] : []),
        ] : []),
        { name: "How it works", value: `Output streams here; each steering message becomes the agent's next turn. Say \`stop\` to end it.\n${steeringHelp}` },
      ],
    }],
    // Discord caps a message at 5 action rows: project, skill, cli, model, buttons.
    components: [
      ...(resuming ? [] : [row([projectSelect])]),
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
  return { embeds: [{ title }], components: input.outcome === "ended" ? continueLiveRows(input.resumeLiveId) : [] };
}

export const discordCards: CardBuilders = {
  proposalCard, runningCard, finishedCard, noteProposalCard, noteResultCard, noteArchiveProposalCard, noteArchiveResultCard,
  rememberedCard, reminderCard,
  skillProposalCard, skillResultCard, todoProposalCard, todoResultCard, routineProposalCard, routineResultCard,
  liveSessionProposalCard, liveSessionResultCard,
};
