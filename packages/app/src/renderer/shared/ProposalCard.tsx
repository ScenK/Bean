import { useEffect, useState } from "preact/hooks";
import type { AvailableModel, CliName, Project, ProposedRun, UrlKind } from "@bean/core";
import { pickModel } from "@bean/core/models";
import { ChipMenu } from "./ChipMenu.js";

export type PickableModel = AvailableModel;

function urlSuffixLabel(url: string, kind: UrlKind | "checking" | undefined): string {
  try {
    const u = new URL(url);
    if (kind === "repo") {
      const parts = u.pathname.split("/").filter(Boolean);
      return parts.length >= 2 ? `${parts[0]}/${parts[1]} ⎘` : `${u.hostname} ⎘`;
    }
    return `${u.hostname} ↗`;
  } catch {
    return url;
  }
}

function sniffBadgeLabel(kind: UrlKind | "checking" | undefined): string | undefined {
  switch (kind) {
    case "checking": return "checking…";
    case "repo": return "⎘ detected: git repo — shallow clone";
    case "page": return "↗ detected: web page — will be fetched as content";
    case "unknown": return "? unreachable — will retry at run time";
    default: return undefined;
  }
}

// Every CLI alias a model has, as "<alias> · <cli>" captions — shown regardless of which CLI
// is currently picked, so switching CLI later doesn't hide what a model resolves to elsewhere.
function aliasCaption(m: PickableModel): string {
  return Object.entries(m.aliases).map(([cli, alias]) => `${alias} · ${cli}`).join("  /  ");
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
    choice: { cli: CliName; projectPath?: string; sourceUrl?: string; model?: string },
  ) => void;
  onCancel: () => void;
  /** CLIs found on this machine — a picker shows only when there's a real choice (2+, terminal target). */
  cliOptions?: CliName[];
  /** Projects this skill can run in. "No project" (scratch workspace) is always offered alongside these. */
  projectOptions?: Project[];
  /** Canonical models, annotated with which detected CLIs actually support each. */
  modelOptions?: PickableModel[];
  /** The model last confirmed for this skill, if any — drives the "LAST USED" badge. */
  lastUsedModel?: string;
}) {
  const [prompt, setPrompt] = useState(run.composedPrompt);
  const [extra, setExtra] = useState("");
  // Track only an explicit user pick; the effective CLI derives from the latest cliOptions.
  // cliOptions arrives async (after first render), so seeding useState from it would freeze
  // the pre-detection default — a claude-only machine would silently launch opencode.
  const [cliChoice, setCliChoice] = useState<CliName | undefined>(undefined);
  const cli: CliName = cliChoice ?? cliOptions?.[0] ?? "opencode";
  const [projectPath, setProjectPath] = useState<string | undefined>(run.projectPath);
  const [sourceUrl, setSourceUrl] = useState(run.sourceUrl ?? "");
  const [urlKind, setUrlKind] = useState<UrlKind | "checking" | undefined>(undefined);
  const [modelChoice, setModelChoice] = useState<string | undefined>(undefined);
  const done = state !== "pending";
  const isChat = run.target === "chat";
  const models = modelOptions ?? [];
  // Effective model, not the raw pick: if the user switches CLI to one that can't run the
  // picked/remembered model, pickModel falls back to a CLI-supported model so the chip label,
  // the menu checkmark, and the launched --model all stay consistent (an unsupported model
  // would otherwise drop --model and silently launch the CLI's default).
  const model = pickModel(models, cli, modelChoice, lastUsedModel);
  const hasModelMenu = !isChat && models.length > 0;
  const showCliOnlyPicker = !isChat && !hasModelMenu && (cliOptions?.length ?? 0) > 1;

  // Debounced live sniff of the "no project" URL seed, mirroring the mockup's inline badge.
  useEffect(() => {
    const trimmed = sourceUrl.trim();
    if (projectPath !== undefined || !trimmed) {
      setUrlKind(undefined);
      return;
    }
    let cancelled = false;
    setUrlKind("checking");
    const t = setTimeout(() => {
      void window.bean.sniffUrl(trimmed).then((k) => { if (!cancelled) setUrlKind(k); });
    }, 400);
    return () => { cancelled = true; clearTimeout(t); };
  }, [projectPath, sourceUrl]);

  // ponytail: same "## Task" convention core's composePrompt() uses, applied here so users
  // can add instructions without editing the skill's own template text in the box above.
  const runFinalPrompt = (): void => {
    const task = extra.trim();
    onConfirm(task ? `${prompt}\n\n## Task\n${task}` : prompt, {
      cli,
      projectPath,
      sourceUrl: projectPath === undefined ? sourceUrl.trim() || undefined : undefined,
      model,
    });
  };

  const projectName = projectOptions?.find((p) => p.path === projectPath)?.name ?? projectPath;
  const projectChipLabel = projectPath !== undefined
    ? <>📁 {projectName}</>
    : <>no project{sourceUrl.trim() ? <> · <span class="bean-chip-menu-sub">{urlSuffixLabel(sourceUrl.trim(), urlKind)}</span></> : null}</>;
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
                    {sniffBadgeLabel(urlKind) ? (
                      <span class="bean-chip-menu-sniff-badge">{sniffBadgeLabel(urlKind)}</span>
                    ) : (
                      <span class="bean-chip-menu-hint">
                        Bean detects what it is: a repo gets a shallow clone; a page is fetched as content.
                      </span>
                    )}
                  </div>
                ) : null}
              </div>
            )}
          </ChipMenu>
        )}
        {hasModelMenu ? (
          <ChipMenu
            chipLabel={<>{modelLabel} <span class="bean-chip-menu-sub">via {cli}</span></>}
            disabled={done}
            menuWidth={360}
          >
            {(close) => (
              <div class="bean-chip-menu-list">
                {models.map((m) => {
                  const available = m.aliases[cli] !== undefined;
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
                        {available ? aliasCaption(m) : `${aliasCaption(m) || "no CLI support"} — not available via ${cli}`}
                      </span>
                    </button>
                  );
                })}
                <div class="bean-chip-menu-divider" />
                <div class="bean-chip-menu-cli-footer">
                  <span class="bean-field-label">CLI</span>
                  <button
                    type="button"
                    class={`bean-chip-menu-pill${cliChoice === undefined ? " bean-chip-menu-pill--on" : ""}`}
                    onClick={() => setCliChoice(undefined)}
                  >
                    {cliChoice === undefined ? "✓ " : ""}auto
                  </button>
                  {cliOptions?.map((c) => (
                    <button
                      key={c}
                      type="button"
                      class={`bean-chip-menu-pill${cliChoice === c ? " bean-chip-menu-pill--on" : ""}`}
                      onClick={() => setCliChoice(c)}
                    >
                      {cliChoice === c ? "✓ " : ""}{c}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </ChipMenu>
        ) : !isChat && !showCliOnlyPicker ? (
          <span class="bean-chip">cli · {cli}</span>
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
        <button type="button" class="bean-btn" disabled={done} onClick={runFinalPrompt}>
          {state === "confirmed" ? (run.target === "chat" ? "Running in chat" : "Launched in Terminal") : "Confirm & run"}
        </button>
        <button type="button" class="bean-btn bean-btn--ghost" disabled={done} onClick={onCancel}>
          {state === "cancelled" ? "Cancelled" : "Cancel"}
        </button>
      </div>
    </div>
  );
}
