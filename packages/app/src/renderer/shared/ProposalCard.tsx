import { useState } from "preact/hooks";
import type { ProposedRun } from "@bean/core";

export function ProposalCard({
  run,
  state,
  onConfirm,
  onCancel,
}: {
  run: ProposedRun;
  state: "pending" | "confirmed" | "cancelled";
  onConfirm: (editedPrompt: string) => void;
  onCancel: () => void;
}) {
  const [prompt, setPrompt] = useState(run.composedPrompt);
  const [extra, setExtra] = useState("");
  const done = state !== "pending";

  // ponytail: same "## Task" convention core's composePrompt() uses, applied here so users
  // can add instructions without editing the skill's own template text in the box above.
  const runFinalPrompt = (): void => {
    const task = extra.trim();
    onConfirm(task ? `${prompt}\n\n## Task\n${task}` : prompt);
  };

  return (
    <div class="bean-card">
      <div class="bean-card-chips">
        <span class="bean-chip">skill · {run.skillName}</span>
        {run.target === "chat" && !run.projectPath
          ? <span class="bean-chip">runs · in chat</span>
          : <span class="bean-chip">project · {run.projectPath}</span>}
      </div>
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
