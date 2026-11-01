import { useEffect, useRef, useState } from "preact/hooks";
import type { ChatItem } from "../../shared/chat-types.js";
import type { PickableModel } from "../../shared/ProposalCard.js";
import { ChipMenu } from "../../shared/ChipMenu.js";
import { AgentAvatar } from "../../shared/AgentAvatar.js";
import type { CliName, Project } from "@bean/core";
import { resolveCliModelSelection } from "@bean/core/models";

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
  modelOptions,
  projectOptions,
  browser,
  onContinueLive,
  lastUsedModel,
  autoFocus,
  onReturnFocus,
}: {
  item: DelegateItem;
  /** projectPath "" = scratch workspace (main maps it). model is set only when chosen. */
  onConfirm: (editedPrompt: string, choice: { projectPath: string; model?: string }) => void;
  onDismiss: () => void;
  onCancelTask: () => void;
  cliOptions?: CliName[];
  /** Configured models annotated with which enabled CLIs support each. The chosen model and
   * compatible CLI are resolved as one pair in main before the delegate starts. */
  modelOptions?: PickableModel[];
  /** The project picker's rows (ChatPanel lists the skill's assigned projects first). "No project —
   * scratch" is always offered alongside them. */
  projectOptions?: Project[];
  /** Display only — main re-resolves the skill's `browser:` frontmatter at launch. */
  browser?: boolean;
  /** Set only when Continue live is offered (eligible receipt, CLI enabled, no live session). */
  onContinueLive?: () => void;
  /** The skill's remembered model — seeds the picker once, so a late read never overwrites a pick. */
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
  const [modelChoice, setModelChoice] = useState<string | undefined>(pending ? lastUsedModel : undefined);
  const [projectPath, setProjectPath] = useState(item.proposal.projectPath);
  const seeded = useRef(pending && lastUsedModel !== undefined);
  const startRef = useRef<HTMLButtonElement>(null);
  const models = modelOptions ?? [];
  // selection only answers "is any CLI enabled" (the confirm gate). The CLI/model pair the run
  // actually uses is resolved in main from the Settings delegate preference, which this card
  // can't see — so displaying selection.model here would lie (e.g. show "sonnet" while main
  // starts opencode's default). Show/checkmark only the user's explicit pick; otherwise neutral.
  const selection = resolveCliModelSelection(models, cliOptions ?? [], { model: modelChoice });
  // A remembered model no enabled CLI supports anymore is dropped, not shown or sent.
  const chosenModel = modelChoice && selection?.model === modelChoice ? modelChoice : undefined;
  const explicitLabel = chosenModel ? (models.find((m) => m.id === chosenModel)?.label ?? chosenModel) : undefined;
  // Once started, the card shows the project the run committed to (confirmDelegate writes it back).
  const shownPath = pending ? projectPath : item.proposal.projectPath;
  const projectName = projectOptions?.find((p) => p.path === shownPath)?.name ?? (shownPath || "scratch");

  useEffect(() => {
    if (seeded.current || !pending || !lastUsedModel) return;
    seeded.current = true;
    setModelChoice((c) => c ?? lastUsedModel);
  }, [lastUsedModel, pending]);

  useEffect(() => { if (autoFocus && pending) startRef.current?.focus(); }, []);

  const start = (): void => {
    onConfirm(prompt, { projectPath, ...(chosenModel ? { model: chosenModel } : {}) });
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
          <span class="bean-chip">{chosenModel && selection?.cli === "codex" ? "🌐 uses your browser and computer" : "🌐 uses your browser"}</span>
        ) : null}
        {pending && models.length > 0 ? (
          <ChipMenu chipLabel={selection
            ? <>{explicitLabel ?? "Bean picks model"}</>
            : <>No CLI enabled · Settings</>}>
            {(close) => (
              <div class="bean-chip-menu-list">
                {models.map((m) => {
                  const available = m.availableOn.some((candidate) => cliOptions?.includes(candidate));
                  return (
                    <button
                      key={m.id}
                      type="button"
                      disabled={!available}
                      class={`bean-chip-menu-row bean-chip-menu-row--model${chosenModel === m.id ? " bean-chip-menu-row--on" : ""}${available ? "" : " bean-chip-menu-row--dimmed"}`}
                      onClick={() => { if (available) { seeded.current = true; setModelChoice(m.id); close(); } }}
                    >
                      <span class="bean-chip-menu-row-title">{chosenModel === m.id ? "✓ " : ""}{m.label}</span>
                      <span class="bean-chip-menu-caption">
                        {m.availableOn.join("  /  ") || "no CLI support"}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </ChipMenu>
        ) : selection ? (
          <span class="bean-chip">{explicitLabel ?? "Bean picks model"}</span>
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
          disabled={!pending || !selection}
          onClick={start}
          // A held Enter (the one that sent the `/` command) must not press the new Start.
          onKeyDown={(e) => { if (e.key === "Enter" && e.repeat) e.preventDefault(); }}
        >
          {running || starting
            ? `${STATE_LABEL[item.state]} ${mmss}`
            : pending && !selection ? "Enable a CLI in Settings" : STATE_LABEL[item.state]}
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
