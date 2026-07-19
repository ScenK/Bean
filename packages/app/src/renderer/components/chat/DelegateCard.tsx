import { useEffect, useState } from "preact/hooks";
import type { ChatItem } from "../../shared/chat-types.js";
import type { PickableModel } from "../../shared/ProposalCard.js";
import { ChipMenu } from "../../shared/ChipMenu.js";
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
};

export function DelegateCard({
  item,
  onConfirm,
  onDismiss,
  onCancelTask,
  cliOptions,
  modelOptions,
  projectOptions,
}: {
  item: DelegateItem;
  onConfirm: (editedPrompt: string, model?: string) => void;
  onDismiss: () => void;
  onCancelTask: () => void;
  cliOptions?: CliName[];
  /** Configured models annotated with which enabled CLIs support each. The chosen model and
   * compatible CLI are resolved as one pair in main before the delegate starts. */
  modelOptions?: PickableModel[];
  /** Projects this delegate's skill can run in — same "assigned, else every project" list
   * ChatPanel already builds for the sibling ProposalCard — used to show the project's name
   * instead of its full filesystem path (matching ProposalCard's chip). */
  projectOptions?: Project[];
}) {
  const [prompt, setPrompt] = useState(item.proposal.composedPrompt);
  const [showDetail, setShowDetail] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [modelChoice, setModelChoice] = useState<string | undefined>(undefined);
  const models = modelOptions ?? [];
  // selection only answers "is any CLI enabled" (the confirm gate). The CLI/model pair the run
  // actually uses is resolved in main from the Settings delegate preference, which this card
  // can't see — so displaying selection.model here would lie (e.g. show "sonnet" while main
  // starts opencode's default). Show/checkmark only the user's explicit pick; otherwise neutral.
  const selection = resolveCliModelSelection(models, cliOptions ?? [], { model: modelChoice });
  const explicitLabel = modelChoice ? (models.find((m) => m.id === modelChoice)?.label ?? modelChoice) : undefined;
  const projectName =
    projectOptions?.find((p) => p.path === item.proposal.projectPath)?.name ?? item.proposal.projectPath;

  useEffect(() => {
    if (item.state !== "running" && item.state !== "starting") return;
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [item.state]);

  const pending = item.state === "pending";
  const starting = item.state === "starting";
  const running = item.state === "running";
  const mmss = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`;

  return (
    <div class="bean-card">
      <div class="bean-card-chips">
        <span class="bean-chip">delegate · background agent</span>
        <span class="bean-chip">project · {projectName}</span>
        {item.proposal.skillName ? <span class="bean-chip">skill · {item.proposal.skillName}</span> : null}
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
                      class={`bean-chip-menu-row bean-chip-menu-row--model${modelChoice === m.id ? " bean-chip-menu-row--on" : ""}${available ? "" : " bean-chip-menu-row--dimmed"}`}
                      onClick={() => { if (available) { setModelChoice(m.id); close(); } }}
                    >
                      <span class="bean-chip-menu-row-title">{modelChoice === m.id ? "✓ " : ""}{m.label}</span>
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
      <div class="bean-card-actions">
        <button type="button" class="bean-btn" disabled={!pending || !selection} onClick={() => onConfirm(prompt, modelChoice)}>
          {running || starting
            ? `${STATE_LABEL[item.state]} ${mmss}`
            : pending && !selection ? "Enable a CLI in Settings" : STATE_LABEL[item.state]}
        </button>
        {pending ? <button type="button" class="bean-btn bean-btn--ghost" onClick={onDismiss}>Dismiss</button> : null}
        {running ? <button type="button" class="bean-btn bean-btn--ghost" onClick={onCancelTask}>Cancel</button> : null}
      </div>
    </div>
  );
}
