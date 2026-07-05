import { useState } from "preact/hooks";
import type { CliName, Project, ProposedRun } from "@bean/core";

export function ProposalCard({
  run,
  state,
  onConfirm,
  onCancel,
  cliOptions,
  projectOptions,
}: {
  run: ProposedRun;
  state: "pending" | "confirmed" | "cancelled";
  onConfirm: (editedPrompt: string, choice: { cli: CliName; projectPath: string }) => void;
  onCancel: () => void;
  /** CLIs found on this machine — a picker shows only when there's a real choice (2+, terminal target). */
  cliOptions?: CliName[];
  /** Projects this skill can run in — a picker shows only when there's a real choice (2+). */
  projectOptions?: Project[];
}) {
  const [prompt, setPrompt] = useState(run.composedPrompt);
  const [extra, setExtra] = useState("");
  const [cli, setCli] = useState<CliName>(cliOptions?.[0] ?? "opencode");
  const [projectPath, setProjectPath] = useState(run.projectPath);
  const done = state !== "pending";
  const showCliPicker = run.target !== "chat" && (cliOptions?.length ?? 0) > 1;
  const showProjectPicker = (projectOptions?.length ?? 0) > 1;

  // ponytail: same "## Task" convention core's composePrompt() uses, applied here so users
  // can add instructions without editing the skill's own template text in the box above.
  const runFinalPrompt = (): void => {
    const task = extra.trim();
    onConfirm(task ? `${prompt}\n\n## Task\n${task}` : prompt, { cli, projectPath });
  };

  return (
    <div class="bean-card">
      <div class="bean-card-chips">
        <span class="bean-chip">skill · {run.skillName}</span>
        {run.target === "chat" && !run.projectPath
          ? <span class="bean-chip">runs · in chat</span>
          : showProjectPicker ? null : <span class="bean-chip">project · {run.projectPath}</span>}
        {run.target !== "chat" && !showCliPicker ? <span class="bean-chip">cli · {cli}</span> : null}
      </div>
      {showProjectPicker ? (
        <div class="bean-card-picker">
          <span class="bean-field-label">PROJECT</span>
          <div class="bean-skills-project-chips">
            {projectOptions!.map((p) => (
              <button
                key={p.path}
                type="button"
                disabled={done}
                class={`bean-skills-project-chip${projectPath === p.path ? " bean-skills-project-chip--on" : ""}`}
                onClick={() => setProjectPath(p.path)}
              >
                {projectPath === p.path ? "✓ " : ""}{p.name}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {showCliPicker ? (
        <div class="bean-card-picker">
          <span class="bean-field-label">RUN WITH</span>
          <div class="bean-skills-project-chips">
            {cliOptions!.map((c) => (
              <button
                key={c}
                type="button"
                disabled={done}
                class={`bean-skills-project-chip${cli === c ? " bean-skills-project-chip--on" : ""}`}
                onClick={() => setCli(c)}
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
