import { useEffect, useState } from "preact/hooks";
import type { ChatItem } from "../../shared/chat-types.js";

type DelegateItem = Extract<ChatItem, { kind: "delegate" }>;

const STATE_LABEL: Record<DelegateItem["state"], string> = {
  pending: "Delegate",
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
}: {
  item: DelegateItem;
  onConfirm: (editedPrompt: string) => void;
  onDismiss: () => void;
  onCancelTask: () => void;
}) {
  const [prompt, setPrompt] = useState(item.proposal.composedPrompt);
  const [showDetail, setShowDetail] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (item.state !== "running") return;
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [item.state]);

  const pending = item.state === "pending";
  const running = item.state === "running";
  const mmss = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`;

  return (
    <div class="bean-card">
      <div class="bean-card-chips">
        <span class="bean-chip">delegate · background agent</span>
        <span class="bean-chip">project · {item.proposal.projectPath}</span>
        {item.proposal.skillName ? <span class="bean-chip">skill · {item.proposal.skillName}</span> : null}
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
          {showDetail ? <pre class="bean-card-prompt">{item.tail.join("\n")}</pre> : null}
        </>
      ) : null}
      {item.state === "done" && item.result ? (
        <>
          <button type="button" class="bean-btn bean-btn--ghost" onClick={() => setShowDetail(!showDetail)}>
            {showDetail ? "Hide result" : "Show result"}
          </button>
          {showDetail ? <pre class="bean-card-prompt">{item.result}</pre> : null}
        </>
      ) : null}
      {item.state === "failed" && item.error ? <div class="bean-status bean-status--error">{item.error}</div> : null}
      <div class="bean-card-actions">
        <button type="button" class="bean-btn" disabled={!pending} onClick={() => onConfirm(prompt)}>
          {running ? `Working... ${mmss}` : STATE_LABEL[item.state]}
        </button>
        {pending ? <button type="button" class="bean-btn bean-btn--ghost" onClick={onDismiss}>Dismiss</button> : null}
        {running ? <button type="button" class="bean-btn bean-btn--ghost" onClick={onCancelTask}>Cancel</button> : null}
      </div>
    </div>
  );
}
