import { useEffect, useRef, useState } from "preact/hooks";
import type { ChatItem } from "../../shared/chat-types.js";
import type { PickableModel } from "../../shared/ProposalCard.js";
import { ChipMenu } from "../../shared/ChipMenu.js";
import { AgentAvatar } from "../../shared/AgentAvatar.js";
import type { CliName, Project } from "@bean/core";
import { pickModel, resolveCliModelSelection } from "@bean/core/models";

type DelegateItem = Extract<ChatItem, { kind: "delegate" }>;

const STATE_LABEL: Record<DelegateItem["state"], string> = {
  pending: "Delegate",
  starting: "Starting...",
  running: "Working...",
  done: "Finished",
  failed: "Failed",
  cancelled: "Cancelled",
  dismissed: "Dismissed",
  expired: "Expired",
  interrupted: "Interrupted",
};

// Copies `cd '<project>' && <cli resume id>` so the user can reopen the session by hand.
function ResumeReceipt({ receipt }: { receipt: NonNullable<DelegateItem["receipt"]> }) {
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    navigator.clipboard.writeText(receipt.command).then(() => setCopied(true), () => {});
  };
  return (
    <div class="bean-card-chips">
      <span class="bean-chip" title={receipt.command}>{receipt.label}</span>
      <button type="button" class="bean-btn bean-btn--ghost" onClick={copy}>{copied ? "Copied" : "Copy resume command"}</button>
    </div>
  );
}

export function DelegateCard({
  item,
  onConfirm,
  onDismiss,
  onCancelTask,
  cliOptions,
  delegateCli,
  modelOptions,
  projectOptions,
  browser,
  onContinueLive,
  lastUsedModel,
  autoFocus,
  onReturnFocus,
}: {
  item: DelegateItem;
  /** projectPath "" = scratch workspace (main maps it). `cli` is the CLI the card shows; main runs
   * exactly it or fails the task. `model` is unset when that CLI lists none (it runs its default). */
  onConfirm: (editedPrompt: string, choice: { projectPath: string; model?: string; cli?: CliName }) => void;
  onDismiss: () => void;
  onCancelTask: () => void;
  cliOptions?: CliName[];
  /** Settings' delegate CLI preference ("" = auto) — with the remembered model, picks the default CLI. */
  delegateCli?: string;
  /** Configured models annotated with which enabled CLIs support each; the menu lists the chosen CLI's. */
  modelOptions?: PickableModel[];
  /** The project picker's rows (ChatPanel lists the skill's assigned projects first). "No project —
   * scratch" is always offered alongside them. */
  projectOptions?: Project[];
  /** Display only — main re-resolves the skill's `browser:` frontmatter at launch. */
  browser?: boolean;
  /** Set only when Continue live is offered (eligible receipt, CLI enabled, no live session). */
  onContinueLive?: () => void;
  /** The skill's remembered model — a default only, so a late read never overwrites a pick. */
  lastUsedModel?: string;
  /** Only the card a `/` send just created: its Start takes focus so ↵ ↵ runs it. */
  autoFocus?: boolean;
  /** Start, Dismiss and Esc hand focus back to the composer. */
  onReturnFocus?: () => void;
}) {
  const [prompt, setPrompt] = useState(item.proposal.composedPrompt);
  const [showDetail, setShowDetail] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const pending = item.state === "pending";
  const [modelChoice, setModelChoice] = useState<string | undefined>(undefined);
  const [cliChoice, setCliChoice] = useState<CliName | undefined>(undefined);
  const [projectPath, setProjectPath] = useState(item.proposal.projectPath);
  const startRef = useRef<HTMLButtonElement>(null);
  const models = modelOptions ?? [];
  const clis = cliOptions ?? [];
  // The real pair the run uses: the user's CLI pick, else the one main's resolveDelegateSelection
  // picks from Settings + the remembered model; then a model that CLI offers (pickModel keeps the
  // pick/remembered model only while the CLI offers it). Sent as-is, so the chip never lies.
  const preferred = clis.includes(delegateCli as CliName) ? delegateCli as CliName : clis[0];
  const cli = cliChoice ?? resolveCliModelSelection(models, clis, {
    ...(preferred ? { cli: preferred } : {}), ...(lastUsedModel ? { lastUsed: lastUsedModel } : {}),
  })?.cli;
  const cliModels = cli ? models.filter((m) => m.availableOn.includes(cli)) : [];
  const model = cli ? pickModel(models, cli, modelChoice, lastUsedModel) : undefined;
  const modelLabel = model ? (models.find((m) => m.id === model)?.label ?? model) : "default model";
  // Once started, the card shows the project the run committed to (confirmDelegate writes it back).
  const shownPath = pending ? projectPath : item.proposal.projectPath;
  const projectName = projectOptions?.find((p) => p.path === shownPath)?.name ?? (shownPath || "scratch");

  useEffect(() => { if (autoFocus && pending) startRef.current?.focus(); }, []);

  const start = (): void => {
    onConfirm(prompt, { projectPath, ...(model ? { model } : {}), ...(cli ? { cli } : {}) });
    onReturnFocus?.();
  };

  useEffect(() => {
    if (item.state !== "running" && item.state !== "starting") return;
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [item.state]);

  const starting = item.state === "starting";
  const running = item.state === "running";
  const mmss = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`;

  return (
    <div
      class="bean-card"
      onKeyDown={(e) => { if (e.key === "Escape" && onReturnFocus) { e.preventDefault(); onReturnFocus(); } }}
    >
      <div class="bean-card-chips">
        <span class="bean-chip">delegate · background agent</span>
        {pending ? (
          <ChipMenu
            chipLabel={<>project · {projectName}</>}
            chipClass={projectPath === "" ? "bean-chip-menu-trigger--dashed" : undefined}
          >
            {(close) => (
              <div class="bean-chip-menu-list">
                {projectOptions?.map((p) => (
                  <button key={p.path} type="button" class="bean-chip-menu-row" onClick={() => { setProjectPath(p.path); close(); }}>
                    {projectPath === p.path ? "✓ " : ""}{p.name}
                  </button>
                ))}
                <div class="bean-chip-menu-divider" />
                <button
                  type="button"
                  class="bean-chip-menu-row bean-chip-menu-row--no-project"
                  onClick={() => { setProjectPath(""); close(); }}
                >
                  {projectPath === "" ? "✓ " : ""}No project — scratch
                </button>
              </div>
            )}
          </ChipMenu>
        ) : (
          <span class="bean-chip">project · {projectName}</span>
        )}
        {item.proposal.skillName ? <span class="bean-chip">skill · {item.proposal.skillName}</span> : null}
        {browser ? (
          <span class="bean-chip">{pending && cli === "codex" ? "🌐 uses your browser and computer" : "🌐 uses your browser"}</span>
        ) : null}
        {pending && cli ? (
          <>
            <ChipMenu chipLabel={<>{cli}</>}>
              {(close) => (
                <div class="bean-chip-menu-list">
                  {clis.map((c) => (
                    <button
                      key={c}
                      type="button"
                      class="bean-chip-menu-row"
                      onClick={() => {
                        setCliChoice(c);
                        // A pick the new CLI doesn't offer is cleared, not carried back on a later switch.
                        if (modelChoice && !models.some((m) => m.id === modelChoice && m.availableOn.includes(c))) setModelChoice(undefined);
                        close();
                      }}
                    >
                      {cli === c ? "✓ " : ""}{c}
                    </button>
                  ))}
                </div>
              )}
            </ChipMenu>
            {cliModels.length > 0 ? (
              <ChipMenu chipLabel={<>{modelLabel}</>}>
                {(close) => (
                  <div class="bean-chip-menu-list">
                    {cliModels.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        class={`bean-chip-menu-row bean-chip-menu-row--model${model === m.id ? " bean-chip-menu-row--on" : ""}`}
                        onClick={() => { setModelChoice(m.id); close(); }}
                      >
                        {model === m.id ? "✓ " : ""}{m.label}
                      </button>
                    ))}
                  </div>
                )}
              </ChipMenu>
            ) : (
              <span class="bean-chip">{modelLabel}</span>
            )}
          </>
        ) : pending ? (
          <span class="bean-chip">no CLI enabled · Settings</span>
        ) : null}
      </div>
      {pending ? (
        <textarea
          class="bean-card-prompt"
          value={prompt}
          onInput={(e) => setPrompt((e.target as HTMLTextAreaElement).value)}
        />
      ) : null}
      {running && item.tail.length > 0 ? (
        <>
          <button type="button" class="bean-btn bean-btn--ghost" onClick={() => setShowDetail(!showDetail)}>
            {showDetail ? "Hide output" : `Show output (${item.tail.length})`}
          </button>
          {showDetail ? <pre class="bean-card-prompt bean-delegate-output">{item.tail.join("\n")}</pre> : null}
        </>
      ) : null}
      {item.state === "done" && item.result ? (
        <>
          <button type="button" class="bean-btn bean-btn--ghost" onClick={() => setShowDetail(!showDetail)}>
            {showDetail ? "Hide result" : "Show result"}
          </button>
          {showDetail ? <pre class="bean-card-prompt bean-delegate-output">{item.result}</pre> : null}
        </>
      ) : null}
      {item.state === "failed" && item.error ? <div class="bean-status bean-status--error">{item.error}</div> : null}
      {item.receipt ? <ResumeReceipt receipt={item.receipt} /> : null}
      <div class="bean-card-actions">
        <button
          type="button"
          class="bean-btn"
          ref={startRef}
          disabled={!pending || !cli}
          onClick={start}
          // A held Enter (the one that sent the `/` command) must not press the new Start.
          onKeyDown={(e) => { if (e.key === "Enter" && e.repeat) e.preventDefault(); }}
        >
          {running || starting
            ? `${STATE_LABEL[item.state]} ${mmss}`
            : pending && !cli ? "Enable a CLI in Settings" : STATE_LABEL[item.state]}
        </button>
        {pending ? <button type="button" class="bean-btn bean-btn--ghost" onClick={() => { onDismiss(); onReturnFocus?.(); }}>Dismiss</button> : null}
        {running ? <button type="button" class="bean-btn bean-btn--ghost" onClick={onCancelTask}>Cancel</button> : null}
        {onContinueLive && item.receipt?.agent ? (
          <button type="button" class="bean-btn bean-btn--ghost" onClick={onContinueLive}>
            <AgentAvatar agent={item.receipt.agent} size={16} /> Continue live
          </button>
        ) : null}
      </div>
    </div>
  );
}
