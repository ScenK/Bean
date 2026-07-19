import { useState } from "preact/hooks";
import type { AvailableModel, CliName, Project, ProposedRun } from "@bean/core";
import { resolveCliModelSelection } from "@bean/core/models";
import { ChipMenu } from "./ChipMenu.js";

export type PickableModel = AvailableModel;

// Just the hostname for the project chip's "no project · <host>" suffix — Bean doesn't
// classify the URL (repo vs page) itself anymore; the launched agent figures that out.
function urlHostLabel(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

// Which CLIs offer a model, as the row caption — shown regardless of which CLI is
// currently picked, so switching CLI later doesn't hide where a model is available.
function aliasCaption(m: PickableModel): string {
  return m.availableOn.join("  /  ");
}

export function ProposalCard({
  run,
  state,
  onConfirm,
  onCancel,
  cliOptions,
  projectOptions,
  modelOptions,
  lastUsedModel,
}: {
  run: ProposedRun;
  state: "pending" | "confirmed" | "cancelled";
  onConfirm: (
    editedPrompt: string,
    choice: { cli?: CliName; projectPath?: string; model?: string },
  ) => void;
  onCancel: () => void;
  /** CLIs found on this machine — a picker shows only when there's a real choice (2+, terminal target). */
  cliOptions?: CliName[];
  /** Projects this skill can run in. "No project" (scratch workspace) is always offered alongside these. */
  projectOptions?: Project[];
  /** Configured models, annotated with which enabled CLIs actually support each. */
  modelOptions?: PickableModel[];
  /** The model last confirmed for this skill, if any — drives the "LAST USED" badge. */
  lastUsedModel?: string;
}) {
  const [prompt, setPrompt] = useState(run.composedPrompt);
  const [extra, setExtra] = useState("");
  // Only used by the no-model fallback picker below — when there's a model list, the CLI is
  // derived from whichever model is picked instead of asked for separately (matches
  // RoutinesPanel/DelegateCard, which don't ask for a CLI up front either).
  const [cliChoice, setCliChoice] = useState<CliName | undefined>(undefined);
  const [projectPath, setProjectPath] = useState<string | undefined>(run.projectPath);
  const [sourceUrl, setSourceUrl] = useState(run.sourceUrl ?? "");
  const [modelChoice, setModelChoice] = useState<string | undefined>(undefined);
  const done = state !== "pending";
  const isChat = run.target === "chat";
  const models = modelOptions ?? [];
  // A chat-target run never needs a terminal pair. Terminal choices resolve together so a
  // disabled provider's dimmed model can never get paired with an unrelated enabled CLI.
  const selection = isChat ? undefined : resolveCliModelSelection(models, cliOptions ?? [], {
    cli: cliChoice,
    model: modelChoice,
    lastUsed: lastUsedModel,
  });
  const model = selection?.model;
  const cli = selection?.cli;
  const hasModelMenu = !isChat && models.length > 0;
  const showCliOnlyPicker = !isChat && !hasModelMenu && (cliOptions?.length ?? 0) > 1;
  const canConfirm = isChat || selection !== undefined;

  // ponytail: same "## Task" convention core's composePrompt() uses, applied here so users
  // can add instructions without editing the skill's own template text in the box above. An
  // optional "no project" URL seed is folded in the same way — Bean doesn't fetch/clone it
  // itself, the launched agent (opencode/claude/codex) has its own shell/git access to do that.
  const runFinalPrompt = (): void => {
    if (!canConfirm) return;
    const task = extra.trim();
    const withTask = task ? `${prompt}\n\n## Task\n${task}` : prompt;
    const url = projectPath === undefined ? sourceUrl.trim() : "";
    const finalPrompt = url ? `${withTask}\n\n## Source\n${url}` : withTask;
    onConfirm(finalPrompt, { ...(cli ? { cli } : {}), projectPath, ...(model ? { model } : {}) });
  };

  const projectName = projectOptions?.find((p) => p.path === projectPath)?.name ?? projectPath;
  const projectChipLabel = projectPath !== undefined
    ? <>📁 {projectName}</>
    : <>no project{sourceUrl.trim() ? <> · <span class="bean-chip-menu-sub">{urlHostLabel(sourceUrl.trim())}</span></> : null}</>;
  const modelLabel = models.find((m) => m.id === model)?.label ?? model;

  return (
    <div class="bean-card">
      <div class="bean-card-chips">
        <span class="bean-chip">skill · {run.skillName}</span>
        {isChat ? (
          <span class="bean-chip">runs · in chat</span>
        ) : (
          <ChipMenu
            chipLabel={projectChipLabel}
            chipClass={projectPath === undefined ? "bean-chip-menu-trigger--dashed" : undefined}
            disabled={done}
          >
            {(close) => (
              <div class="bean-chip-menu-list">
                {projectOptions?.map((p) => (
                  <button
                    key={p.path}
                    type="button"
                    class="bean-chip-menu-row"
                    onClick={() => { setProjectPath(p.path); close(); }}
                  >
                    {projectPath === p.path ? "✓ " : ""}{p.name}
                  </button>
                ))}
                <div class="bean-chip-menu-divider" />
                <button
                  type="button"
                  class="bean-chip-menu-row bean-chip-menu-row--no-project"
                  onClick={() => setProjectPath(undefined)}
                >
                  {projectPath === undefined ? "✓ " : ""}No project — runs in a scratch workspace
                </button>
                {projectPath === undefined ? (
                  <div class="bean-chip-menu-url-seed">
                    <span class="bean-field-label">START FROM A URL (optional)</span>
                    <input
                      class="bean-input bean-input--boxed"
                      type="text"
                      value={sourceUrl}
                      placeholder="https://…"
                      onInput={(e) => setSourceUrl((e.target as HTMLInputElement).value)}
                    />
                    <span class="bean-chip-menu-hint">
                      Added to the task as a source link — the launched agent fetches or clones it itself.
                    </span>
                  </div>
                ) : null}
              </div>
            )}
          </ChipMenu>
        )}
        {hasModelMenu ? (
          <ChipMenu
            chipLabel={selection
              ? <>{modelLabel ?? "Default model"} <span class="bean-chip-menu-sub">via {cli}</span></>
              : <>No CLI enabled <span class="bean-chip-menu-sub">· Settings</span></>}
            disabled={done}
            menuWidth={360}
          >
            {(close) => (
              <div class="bean-chip-menu-list">
                {models.map((m) => {
                  const available = m.availableOn.some((candidate) => cliOptions?.includes(candidate));
                  return (
                    <button
                      key={m.id}
                      type="button"
                      disabled={!available}
                      class={`bean-chip-menu-row bean-chip-menu-row--model${model === m.id ? " bean-chip-menu-row--on" : ""}${available ? "" : " bean-chip-menu-row--dimmed"}`}
                      onClick={() => { if (available) { setModelChoice(m.id); close(); } }}
                    >
                      <span class="bean-chip-menu-row-title">
                        {model === m.id ? "✓ " : ""}{m.label}
                        {m.id === lastUsedModel ? <em class="bean-chip-menu-badge">LAST USED · {run.skillName.toUpperCase()}</em> : null}
                      </span>
                      <span class="bean-chip-menu-caption">
                        {aliasCaption(m) || "no CLI support"}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </ChipMenu>
        ) : !isChat && !showCliOnlyPicker ? (
          <span class="bean-chip">{cli ? `cli · ${cli}` : "no CLI enabled · Settings"}</span>
        ) : null}
      </div>
      {showCliOnlyPicker ? (
        <div class="bean-card-picker">
          <span class="bean-field-label">RUN WITH</span>
          <div class="bean-skills-project-chips">
            {cliOptions!.map((c) => (
              <button
                key={c}
                type="button"
                disabled={done}
                class={`bean-skills-project-chip${cli === c ? " bean-skills-project-chip--on" : ""}`}
                onClick={() => setCliChoice(c)}
              >
                {cli === c ? "✓ " : ""}{c}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <textarea
        class="bean-card-prompt"
        value={prompt}
        disabled={done}
        onInput={(e) => setPrompt((e.target as HTMLTextAreaElement).value)}
      />
      <input
        class="bean-input bean-input--boxed"
        type="text"
        value={extra}
        disabled={done}
        placeholder="Add extra instructions for this run…"
        onInput={(e) => setExtra((e.target as HTMLInputElement).value)}
      />
      <div class="bean-card-actions">
        <button type="button" class="bean-btn" disabled={done || !canConfirm} onClick={runFinalPrompt}>
          {state === "confirmed"
            ? (run.target === "chat" ? "Running in chat" : "Launched in Terminal")
            : !canConfirm ? "Enable a CLI in Settings" : "Confirm & run"}
        </button>
        <button type="button" class="bean-btn bean-btn--ghost" disabled={done} onClick={onCancel}>
          {state === "cancelled" ? "Cancelled" : "Cancel"}
        </button>
      </div>
    </div>
  );
}
