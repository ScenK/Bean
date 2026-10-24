import { useState } from "preact/hooks";
import type { AvailableModel, CliName, Project, RoutineStep, Skill, StepGate } from "@bean/core";
import { stepAvailabilityProblem } from "@bean/core/models";
import { DEFAULT_GATE_ROUNDS, MAX_GATE_ROUNDS, stepEdgeProblems } from "@bean/core/routine-graph";
import { ChipMenu } from "../../shared/ChipMenu.js";
import { duplicateStep, withStepIds } from "./step-ids.js";

const HARNESSES: CliName[] = ["claude", "codex", "opencode"];

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
  const { steps, skills, projects, clis, models } = props;
  // Every edit assigns ids to id-less steps; an untouched routine never passes through here.
  const onSteps = (next: RoutineStep[]): void => props.onSteps(withStepIds(next));
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  const setStep = (i: number, step: RoutineStep): void => onSteps(steps.map((s, j) => (j === i ? step : s)));
  // Edges point at ids, so give every step one first (a legacy routine may have none yet).
  const setGate = (i: number, gate: StepGate | undefined): void => {
    const withIds = withStepIds(steps);
    onSteps(withIds.map((s, j) => {
      if (j !== i) return s;
      const { gate: _old, ...rest } = s;
      return (gate ? { ...rest, gate } : rest) as RoutineStep;
    }));
  };
  const toggleEnd = (i: number, step: RoutineStep): void => {
    const { next: _old, ...rest } = step;
    setStep(i, (step.next ? rest : { ...rest, next: "end" }) as RoutineStep);
  };
  const indexOf = (id: string): number => steps.findIndex((s) => s.id === id);
  // Re-checked on every render, so a reorder or delete that breaks an edge shows up here, not at save.
  const edgeProblems = stepEdgeProblems(steps);

  // Reorder by drag (the ⠿ handle is the drag source, each step card a drop target).
  const reorderStep = (from: number, to: number): void => {
    if (from === to) return;
    const next = [...steps];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved!);
    onSteps(next);
  };

  // skill/model live on delegate and chat steps; project on delegate and command. Cast keeps the
  // union spread legible without widening the kind.
  const setSkill = (i: number, step: RoutineStep, name?: string): void =>
    setStep(i, step.kind === "delegate" ? { ...step, skill: name ?? "" } : { ...step, skill: name } as RoutineStep);
  const setModel = (i: number, step: RoutineStep, id?: string): void =>
    setStep(i, { ...step, model: id } as RoutineStep);
  // A pinned harness keeps only a model it offers; "auto" keeps any model.
  const setCli = (i: number, step: RoutineStep & { kind: "delegate" }, cli?: CliName): void => {
    const keepModel = !cli || !step.model || models.some((m) => m.id === step.model && m.availableOn.includes(cli));
    setStep(i, { ...step, cli, model: keepModel ? step.model : undefined });
  };
  // `id` and the gate/next edges ride along so a kind change never re-keys or re-wires the
  // step; `cli` is delegate-only; the text carries over as instruction ⇄ command.
  const switchKind = (i: number, step: RoutineStep, kind: RoutineStep["kind"]): void => {
    const edges = { ...(step.gate ? { gate: step.gate } : {}), ...(step.next ? { next: step.next } : {}) };
    const text = step.kind === "command" ? step.command : step.instruction;
    setStep(i, kind === "delegate"
      ? { kind: "delegate", id: step.id, skill: step.skill ?? "", model: step.model, instruction: text, ...edges }
      : kind === "chat"
        ? { kind: "chat", id: step.id, skill: step.skill || undefined, model: step.model, instruction: text, ...edges }
        : { kind: "command", id: step.id, command: text, ...(step.kind !== "chat" && step.project ? { project: step.project } : {}), ...edges });
  };

  return (
    <div class="bean-routines-steps">
      {steps.map((step, i) => {
        const skillLabel = step.skill ? `skill · ${step.skill}` : (step.kind === "delegate" ? "skill · choose…" : "skill · none");
        const projName = projects.find((p) => p.path === (step.kind !== "chat" ? step.project : undefined))?.name;
        const modelLabel = step.model ? (models.find((m) => m.id === step.model)?.label ?? step.model) : "Bean picks model";
        const cli = step.kind === "delegate" ? step.cli : undefined;
        const problem = step.kind === "delegate" ? stepAvailabilityProblem(step, clis, models) : undefined;
        const onFail = step.gate?.onFail;
        const gotoIndex = typeof onFail === "object" ? indexOf(onFail.goto) : -1;
        const loops = gotoIndex >= 0 && gotoIndex < i;
        const gateLabel = !onFail ? "if it fails · keep going"
          : onFail === "stop" ? "if it fails · stop"
          : `if it fails · go to ${gotoIndex >= 0 ? gotoIndex + 1 : "?"}`;
        const nextIndex = step.next && step.next !== "end" ? indexOf(step.next) : -1;
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
              {onFail === "stop" ? <span class="bean-routines-step-edge" title="Stops the run if this step fails">■</span> : null}
              {typeof onFail === "object" ? (
                <span class="bean-routines-step-edge" title={loops ? `Loops back to step ${gotoIndex + 1} if this step fails` : `Branches to step ${gotoIndex + 1} if this step fails`}>
                  {loops ? "↩" : "↪"}{gotoIndex >= 0 ? gotoIndex + 1 : "?"}
                </span>
              ) : null}
              {step.next ? (
                <span class="bean-routines-step-edge" title={step.next === "end" ? "Ends the run here on success" : `Then goes to step ${nextIndex + 1}`}>
                  {step.next === "end" ? "end" : `→${nextIndex >= 0 ? nextIndex + 1 : "?"}`}
                </span>
              ) : null}
              {i < steps.length - 1 ? <span class="bean-routines-step-line" /> : null}
            </div>
            <div class="bean-routines-step-card">
              <div class="bean-routines-pill-row">
                <ChipMenu chipLabel={<span class="bean-routines-chip-label">{step.kind}</span>}>
                  {(close) => (
                    <div class="bean-chip-menu-list">
                      {(["delegate", "chat", "command"] as const).map((k) => (
                        <button
                          key={k}
                          type="button"
                          class={`bean-chip-menu-row${step.kind === k ? " bean-chip-menu-row--on" : ""}`}
                          onClick={() => { switchKind(i, step, k); close(); }}
                        >
                          <span class="bean-chip-menu-row-title">{step.kind === k ? "✓ " : ""}{k}</span>
                          <span class="bean-chip-menu-caption">
                            {k === "delegate" ? "coding agent (opencode / claude / codex)"
                              : k === "chat" ? "Bean's own model + tools, in chat"
                              : "shell check, no model — exit 0 passes"}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </ChipMenu>

                {step.kind !== "command" ? (
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
                ) : null}

                {step.kind !== "chat" ? (
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

                {step.kind === "delegate" ? (
                  <ChipMenu
                    chipClass={cli ? undefined : "bean-chip-menu-trigger--dashed"}
                    chipLabel={<span class="bean-routines-chip-label">{cli ? `agent · ${cli}` : "agent · auto"}</span>}
                  >
                    {(close) => (
                      <div class="bean-chip-menu-list">
                        <button
                          type="button"
                          class={`bean-chip-menu-row${cli ? "" : " bean-chip-menu-row--on"}`}
                          onClick={() => { setCli(i, step, undefined); close(); }}
                        >
                          <span class="bean-chip-menu-row-title">{cli ? "" : "✓ "}auto</span>
                          <span class="bean-chip-menu-caption">picked from the model and your Settings default</span>
                        </button>
                        <div class="bean-chip-menu-divider" />
                        {HARNESSES.map((h) => (
                          <button
                            key={h}
                            type="button"
                            class={`bean-chip-menu-row${cli === h ? " bean-chip-menu-row--on" : ""}${clis.includes(h) ? "" : " bean-chip-menu-row--dimmed"}`}
                            onClick={() => { setCli(i, step, h); close(); }}
                          >
                            <span class="bean-chip-menu-row-title">{cli === h ? "✓ " : ""}{h}</span>
                            {clis.includes(h) ? null : <span class="bean-chip-menu-caption">not enabled on this Mac</span>}
                          </button>
                        ))}
                      </div>
                    )}
                  </ChipMenu>
                ) : null}

                {step.kind !== "command" ? (
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
                      {models.filter((m) => !cli || m.availableOn.includes(cli)).map((m) => {
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
                ) : null}

                {steps.length > 1 || onFail ? (
                  <ChipMenu
                    chipClass={onFail ? "bean-routines-gate-chip" : "bean-chip-menu-trigger--dashed"}
                    chipLabel={<span class="bean-routines-chip-label">{gateLabel}</span>}
                    menuWidth={300}
                  >
                    {(close) => (
                      <div class="bean-chip-menu-list">
                        <button
                          type="button"
                          class={`bean-chip-menu-row${onFail ? "" : " bean-chip-menu-row--on"}`}
                          onClick={() => { setGate(i, undefined); close(); }}
                        >
                          <span class="bean-chip-menu-row-title">{onFail ? "" : "✓ "}Keep going</span>
                          <span class="bean-chip-menu-caption">no gate — a failure is reported, the next step still runs</span>
                        </button>
                        <button
                          type="button"
                          class={`bean-chip-menu-row${onFail === "stop" ? " bean-chip-menu-row--on" : ""}`}
                          onClick={() => { setGate(i, { onFail: "stop" }); close(); }}
                        >
                          <span class="bean-chip-menu-row-title">{onFail === "stop" ? "✓ " : ""}Stop</span>
                          <span class="bean-chip-menu-caption">the run ends here and asks for you</span>
                        </button>
                        <div class="bean-chip-menu-divider" />
                        {steps.map((t, j) => j === i ? null : (
                          <button
                            key={j}
                            type="button"
                            class={`bean-chip-menu-row${gotoIndex === j ? " bean-chip-menu-row--on" : ""}`}
                            onClick={() => {
                              const goto = withStepIds(steps)[j]!.id!;
                              const keep = typeof onFail === "object" && onFail.maxRounds !== undefined && j < i ? { maxRounds: onFail.maxRounds } : {};
                              setGate(i, { onFail: { goto, ...keep } });
                              close();
                            }}
                          >
                            <span class="bean-chip-menu-row-title">{gotoIndex === j ? "✓ " : ""}Go to → step {j + 1}</span>
                            <span class="bean-chip-menu-caption">
                              {j < i ? "loop back, then run this step again" : "branch forward"} · {t.skill || t.kind}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </ChipMenu>
                ) : null}

                {loops && typeof onFail === "object" ? (
                  <ChipMenu chipLabel={<span class="bean-routines-chip-label">max rounds · {onFail.maxRounds ?? DEFAULT_GATE_ROUNDS}</span>}>
                    {(close) => (
                      <div class="bean-chip-menu-list">
                        {Array.from({ length: MAX_GATE_ROUNDS }, (_, k) => k + 1).map((n) => (
                          <button
                            key={n}
                            type="button"
                            class={`bean-chip-menu-row${(onFail.maxRounds ?? DEFAULT_GATE_ROUNDS) === n ? " bean-chip-menu-row--on" : ""}`}
                            onClick={() => { setGate(i, { onFail: { goto: onFail.goto, maxRounds: n } }); close(); }}
                          >{(onFail.maxRounds ?? DEFAULT_GATE_ROUNDS) === n ? "✓ " : ""}{n} round{n === 1 ? "" : "s"}</button>
                        ))}
                      </div>
                    )}
                  </ChipMenu>
                ) : null}

                {i < steps.length - 1 || step.next ? (
                  <button
                    type="button"
                    class={`bean-chip-menu-trigger${step.next ? "" : " bean-chip-menu-trigger--dashed"}`}
                    aria-pressed={step.next === "end"}
                    title={step.next && step.next !== "end" ? "Clear this step's next edge" : "On success, end the run after this step"}
                    onClick={() => toggleEnd(i, step)}
                  >
                    <span class="bean-routines-chip-label">
                      {step.next === "end" ? "✓ end run here" : step.next ? `then · step ${nextIndex >= 0 ? nextIndex + 1 : "?"}` : "end run here"}
                    </span>
                  </button>
                ) : null}

                <span class="bean-skills-spacer" />
                <span
                  class="bean-routines-handle"
                  title="Drag to reorder"
                  draggable
                  onDragStart={(e) => { setDragIndex(i); e.dataTransfer?.setData("text/plain", String(i)); }}
                  onDragEnd={() => { setDragIndex(null); setOverIndex(null); }}
                >⠿</span>
              </div>
              {step.kind === "command" ? (
                <textarea
                  class="bean-routines-step-instruction"
                  placeholder="Shell command, e.g. pnpm test && pnpm typecheck"
                  value={step.command}
                  onInput={(e) => setStep(i, { ...step, command: (e.target as HTMLTextAreaElement).value })}
                />
              ) : (
                <textarea
                  class="bean-routines-step-instruction"
                  placeholder="What should this step do?"
                  value={step.instruction}
                  onInput={(e) => setStep(i, { ...step, instruction: (e.target as HTMLTextAreaElement).value })}
                />
              )}
              {edgeProblems[i] ? <div class="bean-routines-step-missing bean-routines-step-edge-problem" role="alert">{edgeProblems[i]}</div> : null}
              {problem ? <div class="bean-routines-step-missing" role="alert">{problem}{cli ? " — this step will refuse to run" : " — Bean will pick another"}</div> : null}
              {props.note?.(i) ? <div class="bean-routines-step-missing">{props.note(i)}</div> : null}
              <div class="bean-routines-step-actions">
                <span class="bean-skills-spacer" />
                <button
                  type="button"
                  class="bean-routines-todo-link"
                  title="Copy this step below"
                  onClick={() => props.onSteps(duplicateStep(steps, i))}
                >Duplicate</button>
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
