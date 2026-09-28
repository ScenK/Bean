import { useState } from "preact/hooks";
import type { AvailableModel, CliName, Project, RoutineStep, Skill } from "@bean/core";
import { ChipMenu } from "../../shared/ChipMenu.js";

// The numbered step cards — shared by the manual editor and the builder's brief (2a), so what
// Bean guessed is edited with exactly the same chips as a routine you wrote by hand.
export function StepsEditor(props: {
  steps: RoutineStep[];
  onSteps: (steps: RoutineStep[]) => void;
  skills: Skill[];
  projects: Project[];
  clis: CliName[];
  models: AvailableModel[];
  /** A question under step i (the brief's missing fields). */
  note?: (index: number) => string | undefined;
  addHint?: string;
}) {
  const { steps, onSteps, skills, projects, clis, models } = props;
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  const setStep = (i: number, step: RoutineStep): void => onSteps(steps.map((s, j) => (j === i ? step : s)));

  // Reorder by drag (the ⠿ handle is the drag source, each step card a drop target).
  const reorderStep = (from: number, to: number): void => {
    if (from === to) return;
    const next = [...steps];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved!);
    onSteps(next);
  };

  // skill/model live on both step kinds; project only on delegate. Cast keeps the union spread
  // legible without widening the kind.
  const setSkill = (i: number, step: RoutineStep, name?: string): void =>
    setStep(i, step.kind === "delegate" ? { ...step, skill: name ?? "" } : { ...step, skill: name });
  const setModel = (i: number, step: RoutineStep, id?: string): void =>
    setStep(i, { ...step, model: id } as RoutineStep);
  const switchKind = (i: number, step: RoutineStep, kind: RoutineStep["kind"]): void =>
    setStep(i, kind === "delegate"
      ? { kind: "delegate", skill: step.skill ?? "", model: step.model, instruction: step.instruction }
      : { kind: "chat", skill: step.skill || undefined, model: step.model, instruction: step.instruction });

  return (
    <div class="bean-routines-steps">
      {steps.map((step, i) => {
        const skillLabel = step.skill ? `skill · ${step.skill}` : (step.kind === "delegate" ? "skill · choose…" : "skill · none");
        const projName = projects.find((p) => p.path === (step.kind === "delegate" ? step.project : undefined))?.name;
        const modelLabel = step.model ? (models.find((m) => m.id === step.model)?.label ?? step.model) : "Bean picks model";
        return (
          <div
            key={i}
            class={`bean-routines-step${dragIndex === i ? " bean-routines-step--dragging" : ""}${overIndex === i && dragIndex !== null ? " bean-routines-step--drop" : ""}`}
            onDragOver={(e) => { if (dragIndex !== null) { e.preventDefault(); setOverIndex(i); } }}
            onDragLeave={() => setOverIndex((v) => (v === i ? null : v))}
            onDrop={(e) => { e.preventDefault(); if (dragIndex !== null) reorderStep(dragIndex, i); setDragIndex(null); setOverIndex(null); }}
          >
            <div class="bean-routines-step-rail">
              <span class="bean-routines-step-num">{i + 1}</span>
              {i < steps.length - 1 ? <span class="bean-routines-step-line" /> : null}
            </div>
            <div class="bean-routines-step-card">
              <div class="bean-routines-pill-row">
                <ChipMenu chipLabel={<span class="bean-routines-chip-label">{step.kind}</span>}>
                  {(close) => (
                    <div class="bean-chip-menu-list">
                      {(["delegate", "chat"] as const).map((k) => (
                        <button
                          key={k}
                          type="button"
                          class={`bean-chip-menu-row${step.kind === k ? " bean-chip-menu-row--on" : ""}`}
                          onClick={() => { switchKind(i, step, k); close(); }}
                        >
                          <span class="bean-chip-menu-row-title">{step.kind === k ? "✓ " : ""}{k}</span>
                          <span class="bean-chip-menu-caption">
                            {k === "delegate" ? "coding agent (opencode / claude / codex)" : "Bean's own model + tools, in chat"}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </ChipMenu>

                <ChipMenu chipClass="bean-chip-menu-trigger--accent" chipLabel={<span class="bean-routines-chip-label">{skillLabel}</span>} menuWidth={340}>
                  {(close) => (
                    <div class="bean-chip-menu-list">
                      {step.kind === "chat" ? (
                        <button
                          type="button"
                          class={`bean-chip-menu-row${step.skill ? "" : " bean-chip-menu-row--on"}`}
                          onClick={() => { setSkill(i, step, undefined); close(); }}
                        >{step.skill ? "" : "✓ "}No skill</button>
                      ) : null}
                      {skills.map((s) => (
                        <button
                          key={s.name}
                          type="button"
                          class={`bean-chip-menu-row${step.skill === s.name ? " bean-chip-menu-row--on" : ""}`}
                          onClick={() => { setSkill(i, step, s.name); close(); }}
                        >
                          <span class="bean-chip-menu-row-title">{step.skill === s.name ? "✓ " : ""}{s.name}</span>
                          {s.description ? <span class="bean-chip-menu-caption">{s.description}</span> : null}
                        </button>
                      ))}
                    </div>
                  )}
                </ChipMenu>

                {step.kind === "delegate" ? (
                  <ChipMenu
                    chipClass={step.project ? undefined : "bean-chip-menu-trigger--dashed"}
                    chipLabel={<span class="bean-routines-chip-label">{step.project ? `📁 ${projName ?? step.project}` : "no project"}</span>}
                  >
                    {(close) => (
                      <div class="bean-chip-menu-list">
                        {projects.map((p) => (
                          <button
                            key={p.path}
                            type="button"
                            class={`bean-chip-menu-row${step.project === p.path ? " bean-chip-menu-row--on" : ""}`}
                            onClick={() => { setStep(i, { ...step, project: p.path }); close(); }}
                          >{step.project === p.path ? "✓ " : ""}{p.name}</button>
                        ))}
                        <div class="bean-chip-menu-divider" />
                        <button
                          type="button"
                          class={`bean-chip-menu-row${step.project ? "" : " bean-chip-menu-row--on"}`}
                          onClick={() => { setStep(i, { ...step, project: undefined }); close(); }}
                        >{step.project ? "" : "✓ "}No project — runs in a scratch workspace</button>
                      </div>
                    )}
                  </ChipMenu>
                ) : null}

                <ChipMenu
                  chipClass={step.model ? undefined : "bean-chip-menu-trigger--dashed"}
                  chipLabel={<span class="bean-routines-chip-label">{modelLabel}</span>}
                  menuWidth={320}
                >
                  {(close) => (
                    <div class="bean-chip-menu-list">
                      <button
                        type="button"
                        class={`bean-chip-menu-row${step.model ? "" : " bean-chip-menu-row--on"}`}
                        onClick={() => { setModel(i, step, undefined); close(); }}
                      >{step.model ? "" : "✓ "}Bean picks the model</button>
                      <div class="bean-chip-menu-divider" />
                      {models.map((m) => {
                        const available = m.availableOn.some((candidate) => clis.includes(candidate));
                        return (
                          <button
                            key={m.id}
                            type="button"
                            disabled={!available}
                            class={`bean-chip-menu-row bean-chip-menu-row--model${step.model === m.id ? " bean-chip-menu-row--on" : ""}${available ? "" : " bean-chip-menu-row--dimmed"}`}
                            onClick={() => { if (available) { setModel(i, step, m.id); close(); } }}
                          >
                            <span class="bean-chip-menu-row-title">{step.model === m.id ? "✓ " : ""}{m.label}</span>
                            <span class="bean-chip-menu-caption">
                              {m.availableOn.join("  /  ") || "no CLI support"}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </ChipMenu>

                <span class="bean-skills-spacer" />
                <span
                  class="bean-routines-handle"
                  title="Drag to reorder"
                  draggable
                  onDragStart={(e) => { setDragIndex(i); e.dataTransfer?.setData("text/plain", String(i)); }}
                  onDragEnd={() => { setDragIndex(null); setOverIndex(null); }}
                >⠿</span>
              </div>
              <textarea
                class="bean-routines-step-instruction"
                placeholder="What should this step do?"
                value={step.instruction}
                onInput={(e) => setStep(i, { ...step, instruction: (e.target as HTMLTextAreaElement).value })}
              />
              {props.note?.(i) ? <div class="bean-routines-step-missing">{props.note(i)}</div> : null}
              <div class="bean-routines-step-actions">
                <span class="bean-skills-spacer" />
                <button
                  type="button"
                  class="bean-skills-delete-link"
                  disabled={steps.length === 1}
                  onClick={() => onSteps(steps.filter((_, j) => j !== i))}
                >Remove</button>
              </div>
            </div>
          </div>
        );
      })}
      <button
        type="button"
        class="bean-routines-add"
        onClick={() => onSteps([...steps, { kind: "chat", instruction: "" }])}
      >
        <span class="bean-routines-add-plus">＋</span>
        Add a step
        <span class="bean-routines-add-hint">{props.addHint ?? "— another delegate under this cadence"}</span>
      </button>
    </div>
  );
}
