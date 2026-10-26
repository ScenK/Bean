import { useState } from "preact/hooks";
import type { AvailableModel, CliName, Project, RoutineStep, Skill, StepGate, StepRoute } from "@bean/core";
import { stepAvailabilityProblem } from "@bean/core/models";
import { continueTargets, DEFAULT_GATE_ROUNDS, MAX_GATE_ROUNDS, stepContinueCaptions, stepEdgeProblems, stepEdgeWarnings, stepGroupCaptions, stepGroups, stepLanes, stepPathCaptions, type StepGroup } from "@bean/core/routine-graph";
import { ChipMenu } from "../../shared/ChipMenu.js";
import { StepFlow } from "../../shared/StepFlow.js";
import { duplicateStep, moveStep, removeStep, setStepAlongside, setStepContinues, setStepNext, setStepRoute, switchStepKind, withStepIds } from "./step-ids.js";

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
      // A gate choice replaces a route (the two can't combine).
      const { gate: _old, route: _route, ...rest } = s;
      return (gate ? { ...rest, gate } : rest) as RoutineStep;
    }));
  };
  const setNext = (i: number, target: number | "end" | undefined): void => onSteps(setStepNext(steps, i, target));
  const setRoute = (i: number, route: StepRoute | undefined): void => onSteps(setStepRoute(steps, i, route));
  const indexOf = (id: string): number => steps.findIndex((s) => s.id === id);
  const idAt = (j: number): string => withStepIds(steps)[j]!.id!;
  // Re-checked on every render, so a reorder or delete that breaks an edge shows up here, not at save.
  const edgeProblems = stepEdgeProblems(steps);
  // Non-blocking: a path falling into a sibling path is legal, just rarely meant.
  const edgeWarnings = stepEdgeWarnings(steps);
  const pathCaptions = stepPathCaptions(steps);
  const groupCaptions = stepGroupCaptions(steps);
  const continueCaptions = stepContinueCaptions(steps);
  const groupOf = new Map<number, StepGroup>();
  for (const g of stepGroups(steps)) for (let k = g.first; k <= g.last; k++) groupOf.set(k, g);
  // Only a group's first step is a valid target — entering mid-group would skip its siblings.
  const midGroup = (j: number): StepGroup | undefined => { const g = groupOf.get(j); return g && j !== g.first ? g : undefined; };
  const midGroupCaption = (g: StepGroup): string => `runs alongside step ${g.first + 1} — go to step ${g.first + 1} to run the group`;
  const hasRoute = steps.some((s) => s.route);
  const targetName = (goto: string | undefined, none: string): string =>
    goto === undefined ? none : goto === "end" ? "end run" : indexOf(goto) >= 0 ? `step ${indexOf(goto) + 1}` : goto ? "step ?" : "choose…";

  // A route target picker: later steps only, "end run", and (for `otherwise`) "stop".
  const targetMenu = (i: number, goto: string | undefined, pick: (goto: string | undefined) => void, stop?: boolean) => (
    <ChipMenu
      chipClass={goto ? undefined : "bean-chip-menu-trigger--dashed"}
      chipLabel={<span class="bean-routines-chip-label">{targetName(goto, "stop")}</span>}
      menuWidth={260}
    >
      {(close) => (
        <div class="bean-chip-menu-list">
          {stop ? (
            <button type="button" class={`bean-chip-menu-row${goto === undefined ? " bean-chip-menu-row--on" : ""}`} onClick={() => { pick(undefined); close(); }}>
              <span class="bean-chip-menu-row-title">{goto === undefined ? "✓ " : ""}stop</span>
              <span class="bean-chip-menu-caption">the run ends here and asks for you</span>
            </button>
          ) : null}
          <button type="button" class={`bean-chip-menu-row${goto === "end" ? " bean-chip-menu-row--on" : ""}`} onClick={() => { pick("end"); close(); }}>
            <span class="bean-chip-menu-row-title">{goto === "end" ? "✓ " : ""}end run</span>
            <span class="bean-chip-menu-caption">the run ends ok after this step</span>
          </button>
          {i < steps.length - 1 ? <div class="bean-chip-menu-divider" /> : null}
          {steps.map((t, j) => {
            if (j <= i) return null;
            const mid = midGroup(j);
            return (
              <button key={j} type="button" disabled={!!mid} class={`bean-chip-menu-row${goto && indexOf(goto) === j ? " bean-chip-menu-row--on" : ""}${mid ? " bean-chip-menu-row--dimmed" : ""}`} onClick={() => { pick(idAt(j)); close(); }}>
                <span class="bean-chip-menu-row-title">{goto && indexOf(goto) === j ? "✓ " : ""}→ step {j + 1}</span>
                <span class="bean-chip-menu-caption">{mid ? midGroupCaption(mid) : t.skill || t.kind}</span>
              </button>
            );
          })}
        </div>
      )}
    </ChipMenu>
  );

  // Reorder by drag (the ⠿ handle is the drag source, each step card a drop target).
  const reorderStep = (from: number, to: number): void => {
    if (from !== to) onSteps(moveStep(steps, from, to));
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
  const switchKind = (i: number, step: RoutineStep, kind: RoutineStep["kind"]): void => setStep(i, switchStepKind(step, kind));

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
        const route = step.route;
        const last = i === steps.length - 1;
        const routeTitle = route ? [
          ...route.paths.map((p) => `${p.when || "?"} → ${p.goto === "end" ? "end" : indexOf(p.goto) >= 0 ? indexOf(p.goto) + 1 : "?"}`),
          `otherwise → ${route.otherwise === undefined ? "stop" : route.otherwise === "end" ? "end" : indexOf(route.otherwise) >= 0 ? indexOf(route.otherwise) + 1 : "?"}`,
        ].join(", ") : "";
        const setPaths = (paths: StepRoute["paths"]): void => { if (route) setRoute(i, { ...route, paths }); };
        const gateLabel = route ? `decides · ${route.paths.length} paths`
          : !onFail ? "if it fails · keep going"
          : onFail === "stop" ? "if it fails · stop"
          : `if it fails · go to ${gotoIndex >= 0 ? gotoIndex + 1 : "?"}`;
        const nextIndex = step.next && step.next !== "end" ? indexOf(step.next) : -1;
        const group = groupOf.get(i);
        // The group the toggle joins (or would join): the one the step above is in, else that step.
        const joins = (groupOf.get(i - 1)?.first ?? i - 1) + 1;
        const caption = [pathCaptions[i], groupCaptions[i], continueCaptions[i]].filter(Boolean).join(" · ");
        // Delegate-only by type, but hand-edited JSON may put one anywhere: the chip stays to clear it.
        const continues = (step as { continues?: string }).continues;
        const continueIndex = continues === undefined ? -1 : indexOf(continues);
        const sessions = step.kind === "delegate" || continues !== undefined ? continueTargets(steps, i) : [];
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
              {route ? <span class="bean-routines-step-edge" title={routeTitle}>⑂{route.paths.length}</span> : null}
              {group?.first === i ? (
                <span class="bean-routines-step-edge" title={`Starts a group: steps ${i + 1}–${group.last + 1} run at the same time`}>⫴{group.last - i + 1}</span>
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

                {sessions.length || continues !== undefined ? (
                  <ChipMenu
                    chipClass={continues === undefined ? "bean-chip-menu-trigger--dashed" : undefined}
                    chipLabel={<span class="bean-routines-chip-label">{continues === undefined ? "↻ new session" : `↻ continues step ${continueIndex >= 0 ? continueIndex + 1 : "?"}`}</span>}
                    menuWidth={320}
                  >
                    {(close) => (
                      <div class="bean-chip-menu-list">
                        <button
                          type="button"
                          class={`bean-chip-menu-row${continues === undefined ? " bean-chip-menu-row--on" : ""}`}
                          onClick={() => { onSteps(setStepContinues(steps, i, undefined)); close(); }}
                        >
                          <span class="bean-chip-menu-row-title">{continues === undefined ? "✓ " : ""}new session</span>
                          <span class="bean-chip-menu-caption">the agent starts fresh on this step</span>
                        </button>
                        {sessions.length ? <div class="bean-chip-menu-divider" /> : null}
                        {sessions.map(({ index: j, problem: why }) => {
                          const t = steps[j]!;
                          const on = continueIndex === j;
                          const where = t.kind === "delegate" ? [t.skill || "no skill", `agent · ${t.cli ?? "auto"}`, t.project ? (projects.find((p) => p.path === t.project)?.name ?? t.project) : "no project"].join(" · ") : t.kind;
                          return (
                            <button
                              key={j}
                              type="button"
                              disabled={!!why}
                              class={`bean-chip-menu-row${on ? " bean-chip-menu-row--on" : ""}${why ? " bean-chip-menu-row--dimmed" : ""}`}
                              onClick={() => { onSteps(setStepContinues(steps, i, j)); close(); }}
                            >
                              <span class="bean-chip-menu-row-title">{on ? "✓ " : ""}↻ continue step {j + 1}</span>
                              <span class="bean-chip-menu-caption">{where}</span>
                              {why ? <span class="bean-chip-menu-caption">{why}</span> : null}
                            </button>
                          );
                        })}
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

                {i > 0 ? (
                  <button
                    type="button"
                    class={`bean-chip-menu-trigger${step.alongside ? "" : " bean-chip-menu-trigger--dashed"}`}
                    aria-pressed={!!step.alongside}
                    title="Runs at the same time as the step above; the next step reads every result — best for checks that read, not write."
                    onClick={() => onSteps(setStepAlongside(steps, i, !step.alongside))}
                  >
                    <span class="bean-routines-chip-label">⫴ alongside step {joins}</span>
                  </button>
                ) : null}

                {/* A group's steps can't carry a gate or route — the chip stays only to clear one. */}
                {(steps.length > 1 || onFail || route) && (!group || onFail || route) ? (
                  <ChipMenu
                    chipClass={onFail || route ? "bean-routines-gate-chip" : "bean-chip-menu-trigger--dashed"}
                    chipLabel={<span class="bean-routines-chip-label">{gateLabel}</span>}
                    menuWidth={300}
                  >
                    {(close) => (
                      <div class="bean-chip-menu-list">
                        <button
                          type="button"
                          class={`bean-chip-menu-row${onFail || route ? "" : " bean-chip-menu-row--on"}`}
                          onClick={() => { setGate(i, undefined); close(); }}
                        >
                          <span class="bean-chip-menu-row-title">{onFail || route ? "" : "✓ "}Keep going</span>
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
                            disabled={!!midGroup(j)}
                            class={`bean-chip-menu-row${gotoIndex === j ? " bean-chip-menu-row--on" : ""}${midGroup(j) ? " bean-chip-menu-row--dimmed" : ""}`}
                            onClick={() => {
                              const goto = withStepIds(steps)[j]!.id!;
                              const keep = typeof onFail === "object" && onFail.maxRounds !== undefined && j < i ? { maxRounds: onFail.maxRounds } : {};
                              setGate(i, { onFail: { goto, ...keep } });
                              close();
                            }}
                          >
                            <span class="bean-chip-menu-row-title">{gotoIndex === j ? "✓ " : ""}Go to → step {j + 1}</span>
                            <span class="bean-chip-menu-caption">
                              {midGroup(j) ? midGroupCaption(midGroup(j)!) : `${j < i ? "loop back, then run this step again" : "branch forward"} · ${t.skill || t.kind}`}
                            </span>
                          </button>
                        ))}
                        <div class="bean-chip-menu-divider" />
                        <button
                          type="button"
                          class={`bean-chip-menu-row${route ? " bean-chip-menu-row--on" : ""}`}
                          onClick={() => { if (!route) setRoute(i, { paths: [{ when: "", goto: "" }, { when: "", goto: "" }] }); close(); }}
                        >
                          <span class="bean-chip-menu-row-title">{route ? "✓ " : ""}Choose a path…</span>
                          <span class="bean-chip-menu-caption">this step picks which step runs next, by label</span>
                        </button>
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

                {!route && (!last || step.next || hasRoute) && (!group || step.next) ? (
                  <ChipMenu
                    chipClass={step.next ? undefined : "bean-chip-menu-trigger--dashed"}
                    chipLabel={
                      <span class="bean-routines-chip-label">
                        {step.next === "end" ? "✓ end run here" : step.next ? `then · step ${nextIndex >= 0 ? nextIndex + 1 : "?"}` : last ? "then" : "then · following step"}
                      </span>
                    }
                    menuWidth={300}
                  >
                    {(close) => (
                      <div class="bean-chip-menu-list">
                        <button
                          type="button"
                          class={`bean-chip-menu-row${step.next ? "" : " bean-chip-menu-row--on"}`}
                          onClick={() => { setNext(i, undefined); close(); }}
                        >
                          <span class="bean-chip-menu-row-title">{step.next ? "" : "✓ "}{last ? "nothing set" : "following step"}</span>
                          <span class="bean-chip-menu-caption">{last ? "the last step ends the run" : "on success, run the step below"}</span>
                        </button>
                        <button
                          type="button"
                          class={`bean-chip-menu-row${step.next === "end" ? " bean-chip-menu-row--on" : ""}`}
                          onClick={() => { setNext(i, "end"); close(); }}
                        >
                          <span class="bean-chip-menu-row-title">{step.next === "end" ? "✓ " : ""}end run here</span>
                          <span class="bean-chip-menu-caption">on success, the run ends after this step</span>
                        </button>
                        {!last ? <div class="bean-chip-menu-divider" /> : null}
                        {steps.map((t, j) => j <= i ? null : (
                          <button
                            key={j}
                            type="button"
                            disabled={!!midGroup(j)}
                            class={`bean-chip-menu-row${nextIndex === j ? " bean-chip-menu-row--on" : ""}${midGroup(j) ? " bean-chip-menu-row--dimmed" : ""}`}
                            onClick={() => { setNext(i, j); close(); }}
                          >
                            <span class="bean-chip-menu-row-title">{nextIndex === j ? "✓ " : ""}→ step {j + 1}</span>
                            <span class="bean-chip-menu-caption">{midGroup(j) ? midGroupCaption(midGroup(j)!) : `skip ahead · ${t.skill || t.kind}`}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </ChipMenu>
                ) : null}
                {!route && last && hasRoute && !step.next ? <span class="bean-routines-step-path">ends run</span> : null}

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
              {route ? (
                <div class="bean-routines-route">
                  {route.paths.map((p, k) => (
                    <div key={k} class="bean-routines-route-row">
                      <input
                        class="bean-input bean-input--boxed bean-routines-route-label"
                        placeholder="label, e.g. bug"
                        aria-label={`Path ${k + 1} label`}
                        value={p.when}
                        onInput={(e) => setPaths(route.paths.map((q, m) => m === k
                          ? { ...q, when: (e.target as HTMLInputElement).value.toLowerCase().replace(/[^a-z0-9-]+/g, "-") } : q))}
                      />
                      <span class="bean-routines-route-arrow">→</span>
                      {targetMenu(i, p.goto, (goto) => setPaths(route.paths.map((q, m) => m === k ? { ...q, goto: goto ?? "" } : q)))}
                      <button
                        type="button"
                        class="bean-skills-delete-link"
                        aria-label={`Remove path ${k + 1}`}
                        title="Remove this path"
                        disabled={route.paths.length <= 2}
                        onClick={() => setPaths(route.paths.filter((_, m) => m !== k))}
                      >×</button>
                    </div>
                  ))}
                  <div class="bean-routines-route-row">
                    <button type="button" class="bean-routines-todo-link" onClick={() => setPaths([...route.paths, { when: "", goto: "" }])}>+ add path</button>
                  </div>
                  <div class="bean-routines-route-row">
                    <span class="bean-routines-route-arrow">if none matches →</span>
                    {targetMenu(i, route.otherwise, (otherwise) => {
                      const { otherwise: _old, ...rest } = route;
                      setRoute(i, otherwise === undefined ? rest : { ...rest, otherwise });
                    }, true)}
                  </div>
                </div>
              ) : null}
              {caption ? <div class="bean-routines-step-path">{caption}</div> : null}
              {edgeWarnings[i] ? <div class="bean-routines-step-warning">{edgeWarnings[i]}</div> : null}
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
                  onClick={() => onSteps(removeStep(steps, i))}
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
      {/* The whole shape at a glance; recomputed from the draft every render. */}
      <StepFlow steps={steps} lanes={stepLanes(steps)} />
    </div>
  );
}
