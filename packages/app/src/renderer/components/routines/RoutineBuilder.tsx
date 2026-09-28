import { useEffect, useState } from "preact/hooks";
import type {
  AvailableModel, CliName, Project, Routine, RoutineBrief, RoutineSinks, RoutineStep, Skill, WatchItem,
} from "@bean/core";
import type { RoutineStateView, SinkRecipients } from "../../../ipc.js";
import type { RoutineBuildView } from "../../../routine-builder.js";
import { StepsEditor } from "./StepsEditor.js";

// The describe-it builder: 2a (sentence → editable brief), 2b (building, cancellable), 2c
// (review before enabling). The manual editor stays one link away ("Start from a blank form").

export function ipcErrorMessage(e: unknown): string | undefined {
  if (!(e instanceof Error)) return undefined;
  const m = /^Error invoking remote method '[^']*': (?:Error: )?([\s\S]*)$/.exec(e.message);
  return m ? m[1] : e.message;
}

const TRY = [
  "Ping me when @veritasium posts",
  "Triage Jira tickets assigned to me",
  "Draft release notes every Friday 5pm",
];
const MINUTES = [1, 5, 10, 15, 30, 60];
const CLI_LABEL: Record<string, string> = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode" };
const cliLabel = (cli: string | undefined): string => (cli ? CLI_LABEL[cli] ?? cli : "your coding agent");

interface CatalogProps {
  skills: Skill[];
  projects: Project[];
  clis: CliName[];
  models: AvailableModel[];
}

const isUrl = (s: string): boolean => /^https?:\/\//i.test(s.trim());

// --- 2a --------------------------------------------------------------------------------------

export function DescribePane(props: CatalogProps & {
  initial?: RoutineBrief;
  onCancel: () => void;
  onBlank: () => void;
  onBuild: (brief: RoutineBrief) => Promise<void>;
  onOpenEditor: (routine: Routine) => void;
  onDrafting: (drafting: boolean) => void;
}) {
  const [sentence, setSentence] = useState("");
  const [brief, setBrief] = useState<RoutineBrief | undefined>(props.initial);
  const [tools, setTools] = useState<string[]>([]);
  const [drafting, setDrafting] = useState(false);
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => props.onDrafting(drafting), [drafting]);

  const draft = async (text: string): Promise<void> => {
    if (!text.trim() || drafting) return;
    setDrafting(true);
    setError("");
    try {
      const res = await window.bean.routinesDraftBrief(text, brief);
      setBrief(res.brief);
      setTools(res.tools);
    } catch (e) {
      setError(ipcErrorMessage(e) ?? "couldn't draft a brief");
    } finally {
      setDrafting(false);
    }
  };

  // Editing a field answers its question — drop the matching "missing" entries.
  const patch = (next: Partial<RoutineBrief>, answers: string[] = []): void => {
    if (!brief) return;
    const missing = brief.missing.filter((m) => !answers.some((a) => m.field === a || m.field.startsWith(`${a}.`)));
    setBrief({ ...brief, ...next, missing });
  };
  const missingFor = (field: string): string | undefined =>
    brief?.missing.filter((m) => m.field === field || m.field.startsWith(`${field}.`)).map((m) => m.question).join(" ") || undefined;

  const build = async (): Promise<void> => {
    if (!brief) return;
    const problem = !brief.name.trim() ? "give the routine a name"
      : brief.trigger === "watch" && !brief.source?.trim() ? "say what to watch"
      : brief.trigger === "schedule" && !brief.cron?.trim() ? "set a schedule"
      : !(brief.trigger === "watch" && brief.notifyOnly) && brief.steps.some((s) => !s.instruction.trim()) ? "every step needs an instruction"
      : !(brief.trigger === "watch" && brief.notifyOnly) && brief.steps.length === 0 ? "add a step, or choose Just notify me"
      : brief.trigger === "watch" && brief.notifyOnly && !brief.sinks.chatops?.length && !brief.sinks.note && !brief.sinks.notify
        ? "pick where to send new items — a notify-only watch with no destination tells no one"
      : "";
    if (problem) { setError(problem); return; }
    if (brief.trigger === "schedule") {
      // Nothing to build or test for a schedule — the manual editor, pre-filled.
      props.onOpenEditor({
        name: brief.name, ...(brief.description ? { description: brief.description } : {}),
        enabled: true, cron: brief.cron ?? "0 8 * * *", steps: brief.steps, sinks: brief.sinks,
      });
      return;
    }
    setBuilding(true);
    setError("");
    try {
      await props.onBuild(brief);
    } catch (e) {
      setError(ipcErrorMessage(e) ?? "couldn't start the build");
    } finally {
      setBuilding(false);
    }
  };

  const setSink = (key: "discord" | "teams" | "note" | "notify", on: boolean): void => {
    if (!brief) return;
    const sinks: RoutineSinks = { ...brief.sinks };
    if (key === "note" || key === "notify") {
      if (on) sinks[key] = true; else delete sinks[key];
    } else {
      const rest = (sinks.chatops ?? []).filter((c) => c.transport !== key);
      const chatops = on ? [...rest, { transport: key }] : rest;
      if (chatops.length > 0) sinks.chatops = chatops; else delete sinks.chatops;
    }
    patch({ sinks }, ["sinks"]);
  };
  const hasChatops = (t: "discord" | "teams"): boolean => Boolean(brief?.sinks.chatops?.some((c) => c.transport === t));
  // Blank = DM (the default); a value targets that discord channel / teams conversation id.
  const setChannel = (t: "discord" | "teams", value: string): void => {
    if (!brief) return;
    const channel = value.trim();
    const chatops = (brief.sinks.chatops ?? []).map((c) => (c.transport === t ? { transport: t, ...(channel ? { channel } : {}) } : c));
    patch({ sinks: { ...brief.sinks, chatops } }, ["sinks"]);
  };

  const watch = brief?.trigger === "watch";
  const feed = watch && brief?.sourceKind === "feed";
  const viaInstalled = brief?.via ? tools.includes(brief.via) : false;
  const builderCli = brief?.builder?.cli ?? props.clis[0];
  const builderModels = props.models.filter((m) => !builderCli || m.availableOn.includes(builderCli));

  return (
    <div class="bean-rb">
      <div class="bean-rb-head">
        <div class="bean-field-label">DESCRIBE IT</div>
        <span class="bean-skills-spacer" />
        <button type="button" class="bean-routines-custom-link" onClick={props.onBlank}>Start from a blank form →</button>
      </div>
      <div class="bean-rb-describe">
        <textarea
          class="bean-rb-sentence"
          rows={2}
          placeholder="When someone asks me to review a PR on GitHub, have Bean review it and DM me the summary on Discord."
          value={sentence}
          onInput={(e) => setSentence((e.target as HTMLTextAreaElement).value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void draft(sentence); } }}
        />
        <button type="button" class="bean-btn bean-btn--ghost bean-rb-redraft" disabled={drafting || !sentence.trim()} onClick={() => void draft(sentence)}>
          {drafting ? "Drafting…" : brief ? "Redraft ↵" : "Draft ↵"}
        </button>
      </div>
      <div class="bean-rb-try">
        Try:
        {TRY.map((t) => (
          <button key={t} type="button" class="bean-rb-try-chip" onClick={() => { setSentence(t); void draft(t); }}>{t}</button>
        ))}
      </div>

      {error ? <div class="bean-status bean-status--error">{error}</div> : null}

      {brief ? (
        <>
          <div class="bean-routines-divider" />
          <div class="bean-rb-head">
            <div class="bean-field-label">BRIEF</div>
            <span class="bean-routines-section-note">Bean drafted this — change anything. Nothing is built until you click Build.</span>
            <span class="bean-skills-spacer" />
            {brief.missing.length > 0 ? <span class="bean-rb-missing-badge">{brief.missing.length} missing</span> : null}
          </div>
          <div class="bean-rb-form">
            <div class="bean-rb-row">
              <span class="bean-rb-label">Name</span>
              <div class="bean-rb-field bean-rb-field--name">
                <input
                  class="bean-input bean-input--boxed bean-rb-name"
                  value={brief.name}
                  onInput={(e) => patch({ name: (e.target as HTMLInputElement).value }, ["name"])}
                />
                <input
                  class="bean-input bean-input--boxed bean-rb-desc"
                  placeholder="What it does, in one line"
                  value={brief.description ?? ""}
                  onInput={(e) => patch({ description: (e.target as HTMLInputElement).value || undefined }, ["description"])}
                />
              </div>
            </div>
            <div class="bean-rb-rule" />
            <div class="bean-rb-row">
              <span class="bean-rb-label">Trigger</span>
              <div class="bean-rb-seg">
                <button type="button" class={`bean-rb-seg-btn${watch ? "" : " bean-rb-seg-btn--on"}`} onClick={() => patch({ trigger: "schedule", cron: brief.cron ?? "0 8 * * *" }, ["trigger"])}>On a schedule</button>
                <button type="button" class={`bean-rb-seg-btn${watch ? " bean-rb-seg-btn--on" : ""}`} onClick={() => patch({ trigger: "watch", everyMinutes: brief.everyMinutes ?? 15, sourceKind: brief.sourceKind ?? "command", notifyOnly: brief.notifyOnly ?? brief.steps.length === 0 }, ["trigger"])}>When something new appears</button>
              </div>
            </div>
            {watch ? (
              <>
                <div class="bean-rb-row">
                  <span class="bean-rb-label">Watch</span>
                  <div class="bean-rb-field">
                    <input
                      class={`bean-input bean-input--boxed bean-rb-grow${missingFor("source") ? " bean-rb-input--missing" : ""}`}
                      placeholder="Open PRs where my review is requested — or paste a channel/site URL"
                      value={brief.source ?? ""}
                      onInput={(e) => {
                        const source = (e.target as HTMLInputElement).value;
                        patch({ source, sourceKind: isUrl(source) ? "feed" : "command" }, ["source"]);
                      }}
                    />
                    <span class="bean-rb-caption">
                      {feed ? "a feed · Bean finds it" : brief.via ? <>via <b>{brief.via}</b> · {viaInstalled ? <span class="bean-rb-ok">installed ✓</span> : <span class="bean-rb-warn">not found on PATH</span>}</> : null}
                    </span>
                  </div>
                </div>
                {missingFor("source") ? <div class="bean-rb-question">{missingFor("source")}</div> : null}
                <div class="bean-rb-row">
                  <span class="bean-rb-label">Check every</span>
                  <div class="bean-rb-field">
                    <select
                      class="bean-routines-chip-select"
                      value={String(brief.everyMinutes ?? 15)}
                      onChange={(e) => patch({ everyMinutes: Number((e.target as HTMLSelectElement).value) }, ["everyMinutes"])}
                    >
                      {[...new Set([...MINUTES, brief.everyMinutes ?? 15])].sort((a, b) => a - b).map((m) => <option key={m} value={String(m)}>{m} min</option>)}
                    </select>
                    <span class="bean-rb-caption">a few minutes' lag — no tokens spent per check</span>
                  </div>
                </div>
                <div class="bean-rb-row">
                  <span class="bean-rb-label">Type</span>
                  <div class="bean-rb-field">
                    <div class="bean-rb-seg">
                      <button type="button" class={`bean-rb-seg-btn${brief.notifyOnly ? " bean-rb-seg-btn--on" : ""}`} onClick={() => patch({ notifyOnly: true }, ["notifyOnly", "steps"])}>Just notify me</button>
                      <button
                        type="button"
                        class={`bean-rb-seg-btn${brief.notifyOnly ? "" : " bean-rb-seg-btn--on"}`}
                        onClick={() => patch({ notifyOnly: false, steps: brief.steps.length > 0 ? brief.steps : [{ kind: "chat", instruction: "" }] }, ["notifyOnly"])}
                      >⚡ Run steps on each new item</button>
                    </div>
                    <span class="bean-rb-caption">{brief.notifyOnly ? "no model, no steps — a line per new item" : "each new item is queued as a todo"}</span>
                  </div>
                </div>
              </>
            ) : (
              <div class="bean-rb-row">
                <span class="bean-rb-label">Schedule</span>
                <div class="bean-rb-field">
                  <input
                    class={`bean-input bean-input--boxed bean-routines-cron-input${missingFor("cron") ? " bean-rb-input--missing" : ""}`}
                    placeholder="cron (5 fields)"
                    value={brief.cron ?? ""}
                    onInput={(e) => patch({ cron: (e.target as HTMLInputElement).value }, ["cron"])}
                  />
                  <span class="bean-rb-caption">local time · fine-tune it in the editor</span>
                </div>
              </div>
            )}
            {!(watch && brief.notifyOnly) ? (
              <div class="bean-rb-row bean-rb-row--top">
                <span class="bean-rb-label">Steps</span>
                <div class="bean-rb-steps">
                  <StepsEditor
                    steps={brief.steps}
                    onSteps={(steps: RoutineStep[]) => {
                      const changed = steps.flatMap((s, i) => (JSON.stringify(s) !== JSON.stringify(brief.steps[i]) ? [`steps.${i}`] : []));
                      patch({ steps }, changed);
                    }}
                    skills={props.skills}
                    projects={props.projects}
                    clis={props.clis}
                    models={props.models}
                    note={(i) => missingFor(`steps.${i}`)}
                    addHint={watch ? "— runs on each new item, in order" : undefined}
                  />
                </div>
              </div>
            ) : null}
            <div class="bean-rb-row">
              <span class="bean-rb-label">Send to</span>
              <div class="bean-rb-field bean-rb-field--wrap">
                {([
                  ["discord", "Discord", hasChatops("discord")],
                  ["teams", "Teams", hasChatops("teams")],
                  ["note", "Save as note", brief.sinks.note === true],
                  ["notify", "Desktop notification", brief.sinks.notify === true],
                ] as const).map(([key, label, on]) => (
                  <button key={key} type="button" class={`bean-rb-chip${on ? " bean-rb-chip--on" : ""}`} aria-pressed={on} onClick={() => setSink(key, !on)}>
                    {on ? "✓ " : ""}{label}
                  </button>
                ))}
              </div>
            </div>
            {(brief.sinks.chatops ?? []).map((c) => (
              <div key={c.transport} class="bean-rb-row">
                <span class="bean-rb-label">{c.transport === "discord" ? "Discord" : "Teams"}</span>
                <div class="bean-rb-field">
                  <input
                    class="bean-input bean-input--boxed bean-rb-grow"
                    placeholder={c.transport === "discord" ? "channel id — blank to DM you" : "conversation id — blank to DM you"}
                    value={c.channel ?? ""}
                    onInput={(e) => setChannel(c.transport, (e.target as HTMLInputElement).value)}
                  />
                </div>
              </div>
            ))}
            {missingFor("sinks") ? <div class="bean-rb-question">{missingFor("sinks")}</div> : null}
            {watch && !feed ? (
              <>
                <div class="bean-rb-rule" />
                <div class="bean-rb-row">
                  <span class="bean-rb-label">Built by</span>
                  <div class="bean-rb-field">
                    {props.clis.length === 0 ? <span class="bean-rb-warn">no coding agent enabled — turn one on in Settings</span> : null}
                    <select
                      hidden={props.clis.length === 0}
                      class="bean-routines-chip-select"
                      value={builderCli ?? ""}
                      onChange={(e) => patch({ builder: { cli: (e.target as HTMLSelectElement).value as CliName } })}
                    >
                      {props.clis.map((c) => <option key={c} value={c}>{cliLabel(c)}</option>)}
                    </select>
                    <select
                      hidden={props.clis.length === 0}
                      class="bean-routines-chip-select"
                      value={brief.builder?.model ?? ""}
                      onChange={(e) => patch({ builder: { ...(builderCli ? { cli: builderCli } : {}), ...((e.target as HTMLSelectElement).value ? { model: (e.target as HTMLSelectElement).value } : {}) } })}
                    >
                      <option value="">default model</option>
                      {builderModels.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                    </select>
                    <span class="bean-rb-caption">writes + tests the watch command once, with your real credentials</span>
                  </div>
                </div>
              </>
            ) : null}
          </div>
          <div class="bean-routines-footer">
            <span class="bean-routines-section-note">
              {watch ? "Saved disabled — you review it before anything runs." : "Opens in the editor — nothing to build for a schedule."}
            </span>
            <span class="bean-skills-spacer" />
            <button type="button" class="bean-btn bean-btn--ghost" onClick={props.onCancel}>Cancel</button>
            <button type="button" class="bean-btn" disabled={building || (watch && !feed && props.clis.length === 0)} onClick={() => void build()}>
              {watch ? (building ? "Starting…" : "Build it") : "Open in editor"}
            </button>
          </div>
        </>
      ) : (
        <>
          <span class="bean-routines-section-note">
            Describe what should happen and when — Bean drafts a brief you can change before anything is built.
          </span>
          <div class="bean-routines-footer">
            <span class="bean-skills-spacer" />
            <button type="button" class="bean-btn bean-btn--ghost" onClick={props.onCancel}>Cancel</button>
          </div>
        </>
      )}
    </div>
  );
}

// --- 2b --------------------------------------------------------------------------------------

const STAGE_INDEX = { sent: 0, command: 1, tested: 2, steps: 3, validating: 4 } as const;

function elapsed(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function buildElapsed(b: RoutineBuildView): string {
  return elapsed(b.startedAt, Date.now());
}

export function BuildPane(props: {
  build: RoutineBuildView;
  onCancel: () => void;
  onEditBrief: (brief: RoutineBrief) => void;
  onRetry: (brief: RoutineBrief) => void;
  onDismiss: () => void;
}) {
  const { build } = props;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (build.status !== "building") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [build.status]);

  if (build.status === "failed") {
    return (
      <div class="bean-rb">
        <div class="bean-rb-fail">
          <div class="bean-rb-fail-title">
            <span class="bean-rb-fail-mark">!</span>
            {build.brief.sourceKind === "feed" ? "Couldn't find a working feed" : build.exitCode !== undefined ? "The watch command didn't work" : "The build didn't finish"}
          </div>
          <pre class="bean-rb-fail-error">{build.error}{build.exitCode !== undefined ? `\nexit ${build.exitCode}` : ""}</pre>
          <div class="bean-routines-section-note">Nothing was saved. Fix what the error says (often a CLI login in a terminal), then retry.</div>
          <div class="bean-routines-footer">
            <button type="button" class="bean-skills-delete-link" onClick={props.onDismiss}>Dismiss</button>
            <span class="bean-skills-spacer" />
            <button type="button" class="bean-btn bean-btn--ghost" onClick={() => props.onEditBrief(build.brief)}>Edit brief</button>
            <button type="button" class="bean-btn" onClick={() => props.onRetry(build.brief)}>Retry build</button>
          </div>
        </div>
      </div>
    );
  }

  const feed = build.brief.sourceKind === "feed";
  const items: { label: string; doneAt: number }[] = feed
    ? [
      { label: "Read the brief", doneAt: 0 },
      { label: "Found the feed", doneAt: 2 },
      { label: "Checked it", doneAt: 4 },
      { label: "Bean validates the routine", doneAt: 5 },
    ]
    : [
      { label: `Brief sent to ${cliLabel(build.brief.builder?.cli)}`, doneAt: 0 },
      { label: "Wrote the watch command", doneAt: 1 },
      { label: `Testing it with your ${build.brief.via ?? "CLI"} login`, doneAt: 2 },
      { label: build.brief.notifyOnly ? "Checking the output" : "Drafting the steps", doneAt: 3 },
      { label: "Bean validates the routine", doneAt: 5 },
    ];
  const at = STAGE_INDEX[build.stage];
  const active = items.findIndex((i) => i.doneAt > at);

  return (
    <div class="bean-rb">
      <div class="bean-rb-build-head">
        <span class="bean-rb-build-orb" />
        <span class="bean-rb-build-title">Building <code>{build.name}</code></span>
        <span class="bean-skills-spacer" />
        <span class="bean-rb-build-time">{elapsed(build.startedAt, now)}</span>
      </div>
      <ol class="bean-rb-stages">
        {items.map((item, i) => {
          const state = i < active || active < 0 ? "done" : i === active ? "active" : "todo";
          return (
            <li key={item.label} class={`bean-rb-stage bean-rb-stage--${state}`}>
              <span class="bean-rb-stage-mark">{state === "done" ? "✓" : ""}</span>
              <span class="bean-rb-stage-label">{item.label}</span>
              {state === "active" && build.detail ? <pre class="bean-rb-stage-detail">{build.detail}</pre> : null}
            </li>
          );
        })}
      </ol>
      <div class="bean-routines-divider" />
      <div class="bean-routines-footer">
        <span class="bean-routines-section-note">Nothing is saved yet. Close anytime — it stays in your list as <b>building…</b></span>
        <span class="bean-skills-spacer" />
        <button type="button" class="bean-btn bean-btn--ghost" onClick={props.onCancel}>Cancel build</button>
      </div>
    </div>
  );
}

// --- 2c --------------------------------------------------------------------------------------

function destinations(sinks: RoutineSinks, recipients: SinkRecipients | undefined): { on: string[]; off: string[] } {
  const on: string[] = [];
  const off: string[] = [];
  for (const transport of ["discord", "teams"] as const) {
    const label = transport === "discord" ? "Discord" : "Teams";
    const sink = sinks.chatops?.find((c) => c.transport === transport);
    if (!sink) { off.push(`no ${label}`); continue; }
    if (sink.channel) { on.push(`${label} ${transport === "discord" ? "channel" : "conversation"} ${sink.channel}`); continue; }
    const n = recipients?.[transport];
    // Counts, never names — the desktop app can't look up who those ids are.
    on.push(n === undefined
      ? `${label} DM — ${transport === "discord" ? "discord.json isn't set up" : "no Teams chats known yet"}`
      : `${label} DM to every ${transport === "discord" ? "allowlisted user" : "personal chat Bean knows"} (${n}) — no channel set`);
  }
  if (sinks.note) on.push("Saved as a note on your Daily Dashboard"); else off.push("no note");
  if (sinks.notify) on.push("Desktop notification"); else off.push("no desktop notification");
  return { on, off };
}

export function ReviewPane(props: {
  routine: Routine;
  state: RoutineStateView | undefined;
  models: AvailableModel[];
  projects: Project[];
  onDiscard: () => void;
  onOpenEditor: () => void;
  onEnabled: (note: string) => void;
}) {
  const { routine } = props;
  const [preview, setPreview] = useState<{ items?: WatchItem[]; error?: string }>({});
  const [queueExisting, setQueueExisting] = useState(false);
  const [recipients, setRecipients] = useState<SinkRecipients | undefined>(undefined);
  const [enabling, setEnabling] = useState(false);
  const [error, setError] = useState("");
  const watch = routine.watch!;
  const todo = routine.steps.length > 0;

  useEffect(() => {
    setPreview({});
    void window.bean.routinesPreviewWatch(watch)
      .then((items) => setPreview({ items }))
      .catch((e) => setPreview({ error: ipcErrorMessage(e) ?? "couldn't check the source" }));
    void window.bean.routinesSinkRecipients().then(setRecipients).catch(() => setRecipients(undefined));
  }, [routine.name, JSON.stringify(watch)]);

  const enable = async (): Promise<void> => {
    setEnabling(true);
    setError("");
    try {
      const { count } = await window.bean.routinesEnableWatch(routine.name, todo && queueExisting);
      const before = preview.items?.length;
      props.onEnabled(before !== undefined && before !== count
        ? `Enabled — the source had ${count} item${count === 1 ? "" : "s"} when Enable checked (${before} at preview)${todo && queueExisting ? ", all queued" : ", all skipped"}.`
        : `Enabled — ${count} existing item${count === 1 ? "" : "s"} ${todo && queueExisting ? "queued" : "skipped"}.`);
    } catch (e) {
      setError(ipcErrorMessage(e) ?? "couldn't enable — the source check failed");
    } finally {
      setEnabling(false);
    }
  };

  const every = watch.everyMinutes ?? 15;
  const items = preview.items ?? [];
  const dest = destinations(routine.sinks, recipients);

  return (
    <div class="bean-rb">
      <div>
        <div class="bean-skills-title-row">
          <h2 class="bean-routines-name-text">{routine.name}</h2>
          <span class="bean-rb-disabled-badge">DISABLED</span>
        </div>
        <div class="bean-routines-section-note">Built and tested. Check these before it starts running on its own.</div>
      </div>

      <div class="bean-rb-review-section">
        <div class="bean-routines-section-head">
          <div class="bean-field-label">1 · WATCHES</div>
          <span class="bean-routines-section-note">
            {watch.kind === "command" ? <>runs this exact command every <b>{every} min</b> — no model involved</> : <>reads this feed every <b>{every} min</b> — no model involved</>}
          </span>
        </div>
        <pre class="bean-rb-command">{watch.kind === "command" ? watch.command : watch.url}</pre>
      </div>

      <div class="bean-rb-review-section">
        <div class="bean-routines-section-head">
          <div class="bean-field-label">2 · ALREADY THERE</div>
          <span class="bean-routines-section-note">
            {preview.error ? "couldn't check right now" : preview.items === undefined ? "checking…"
              : <>{items.length} match right now — these <b>won't</b> fire. Only what shows up after you enable will. Enable checks again first — this count updates if it changed.</>}
          </span>
        </div>
        {preview.error ? <div class="bean-status bean-status--error">{preview.error}</div> : null}
        {items.length > 0 ? (
          <div class="bean-rb-items">
            {items.slice(0, 8).map((i) => (
              <div key={i.id} class="bean-rb-item">
                <span class="bean-rb-item-text">{i.text}</span>
                <span class="bean-rb-item-chip">{todo && queueExisting ? "queued" : "skipped"}</span>
              </div>
            ))}
            {items.length > 8 ? <div class="bean-rb-item bean-rb-item--more">+ {items.length - 8} more</div> : null}
          </div>
        ) : null}
        {todo && items.length > 0 ? (
          <label class="bean-routines-sink-row bean-rb-queue-too">
            <input type="checkbox" checked={queueExisting} onChange={(e) => setQueueExisting((e.target as HTMLInputElement).checked)} />
            Queue these {items.length} too
          </label>
        ) : null}
      </div>

      <div class="bean-rb-review-section">
        <div class="bean-routines-section-head">
          <div class="bean-field-label">3 · THEN DOES</div>
          <span class="bean-routines-section-note">{todo ? "on each new item" : "just notifies — no steps"}</span>
        </div>
        {routine.steps.map((s, i) => (
          <div key={i} class="bean-routines-step">
            <div class="bean-routines-step-rail"><span class="bean-routines-step-num">{i + 1}</span></div>
            <div class="bean-routines-step-card">
              <div class="bean-routines-pill-row">
                <span class="bean-rb-pill">{s.kind}</span>
                {s.skill ? <span class="bean-rb-pill bean-rb-pill--accent">skill · {s.skill}</span> : null}
                {s.kind === "delegate" ? (
                  <span class="bean-rb-pill bean-rb-pill--dashed">
                    {s.project ? `📁 ${props.projects.find((p) => p.path === s.project)?.name ?? s.project}` : "scratch checkout per item"}
                  </span>
                ) : null}
                <span class="bean-rb-pill bean-rb-pill--dashed">{s.model ? props.models.find((m) => m.id === s.model)?.label ?? s.model : "Bean picks model"}</span>
              </div>
              <div class="bean-rb-step-text">{s.instruction}</div>
            </div>
          </div>
        ))}
      </div>

      <div class="bean-rb-review-section">
        <div class="bean-field-label">4 · SENDS TO</div>
        <ul class="bean-rb-dest">
          {dest.on.map((d) => <li key={d} class="bean-rb-dest-on">{d}</li>)}
          {dest.on.length === 0 ? <li class="bean-rb-dest-on">Nowhere — results stay in run history</li> : null}
          {dest.off.length > 0 ? <li class="bean-rb-dest-off">{dest.off.join(" · ")}</li> : null}
        </ul>
      </div>

      {error ? <div class="bean-status bean-status--error">{error}</div> : null}
      <div class="bean-routines-divider" />
      <div class="bean-routines-footer">
        <button type="button" class="bean-skills-delete-link" onClick={props.onDiscard}>Discard</button>
        <span class="bean-skills-spacer" />
        <button type="button" class="bean-btn bean-btn--ghost" onClick={props.onOpenEditor}>Open in editor</button>
        <button type="button" class="bean-btn" disabled={enabling} onClick={() => void enable()}>{enabling ? "Checking…" : "Enable"}</button>
      </div>
    </div>
  );
}
