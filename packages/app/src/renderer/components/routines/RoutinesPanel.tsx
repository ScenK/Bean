import { useEffect, useMemo, useState } from "preact/hooks";
import type { Routine, RoutineStep } from "@bean/core";
import type { RoutineStateView } from "../../../ipc.js";

const CADENCES: { label: string; cron: string }[] = [
  { label: "Every weekday at 6:30", cron: "30 6 * * 1-5" },
  { label: "Every day at 8:00", cron: "0 8 * * *" },
  { label: "Hourly, 9–18", cron: "0 9-18 * * *" },
  { label: "Every Monday at 8:00", cron: "0 8 * * 1" },
];

const emptyRoutine = (): Routine => ({
  name: "",
  enabled: true,
  cron: "0 8 * * *",
  steps: [{ kind: "chat", instruction: "" }],
  sinks: {},
});

// Friendly cadence sentence for the list rows — falls back to the raw cron for anything
// that doesn't match one of the presets.
const cadenceLabel = (cron: string): string => CADENCES.find((c) => c.cron === cron)?.label ?? cron;

type DotKind = "running" | "failed" | "missed" | "ok" | "idle";

function dotKind(state: RoutineStateView | undefined): DotKind {
  if (!state) return "idle";
  if (state.running) return "running";
  if (state.missed) return "missed";
  const last = state.history[0];
  if (!last) return "idle";
  return last.status === "failed" ? "failed" : "ok";
}

function statusText(state: RoutineStateView | undefined): string {
  if (!state) return "not run yet";
  if (state.running) return "running…";
  if (state.missed) return "missed last run";
  const last = state.history[0];
  return last ? `last: ${last.status} · ${new Date(last.finishedAt).toLocaleString()}` : "not run yet";
}

// Reuses the Skills/Notes panel anatomy (bean-skills-* styles): list left, detail right.
export function RoutinesPanel() {
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [states, setStates] = useState<Record<string, RoutineStateView>>({});
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [draft, setDraft] = useState<Routine>(emptyRoutine());
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");

  const refresh = async (): Promise<void> => {
    const [list, st] = await Promise.all([window.bean.routinesList(), window.bean.routinesState()]);
    setRoutines(list);
    setStates(st);
  };

  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    const t = setInterval(() => void window.bean.routinesState().then(setStates), 5000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    setDraft(routines.find((r) => r.name === selected) ?? emptyRoutine());
    setError("");
  }, [selected, routines]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? routines.filter((r) => r.name.toLowerCase().includes(q) || (r.description ?? "").toLowerCase().includes(q)) : routines;
  }, [routines, query]);

  const groups = useMemo(() => {
    const active = filtered.filter((r) => r.enabled);
    const off = filtered.filter((r) => !r.enabled);
    const out: { label: string; routines: Routine[] }[] = [];
    if (active.length > 0) out.push({ label: "Active", routines: active });
    if (off.length > 0) out.push({ label: "Off", routines: off });
    return out;
  }, [filtered]);

  const setStep = (i: number, step: RoutineStep): void =>
    setDraft({ ...draft, steps: draft.steps.map((s, j) => (j === i ? step : s)) });

  const select = (name: string): void => { setSelected(name); setError(""); };

  const startNew = (): void => { setSelected(undefined); setDraft(emptyRoutine()); setError(""); };

  const save = async (): Promise<void> => {
    try {
      await window.bean.routinesSave(draft);
      setError("");
      await refresh();
      setSelected(draft.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : "save failed — check name, cadence, and steps");
    }
  };

  const runNow = async (): Promise<void> => {
    if (!selected) return;
    await window.bean.routinesRunNow(selected);
    await refresh();
  };

  const remove = async (): Promise<void> => {
    if (!selected) return;
    if (!confirm(`Delete routine "${selected}"?`)) return;
    await window.bean.routinesDelete(selected);
    setSelected(undefined);
    await refresh();
  };

  const routineRow = (r: Routine) => (
    <div
      key={r.name}
      class={`bean-skills-row${selected === r.name ? " bean-skills-row--selected" : ""}`}
      onClick={() => select(r.name)}
    >
      <div class="bean-skills-row-main">
        <div class="bean-notes-row-title">
          <span class={`bean-routines-dot bean-routines-dot--${dotKind(states[r.name])}`} />
          <span class="bean-notes-row-text">{r.name}</span>
        </div>
        <div class="bean-notes-snippet">{cadenceLabel(r.cron)} · {r.steps.length} step{r.steps.length === 1 ? "" : "s"}</div>
      </div>
    </div>
  );

  const selectedState = selected ? states[selected] : undefined;

  return (
    <div class="bean-skills">
      <div class="bean-skills-list">
        <div class="bean-skills-search">
          <input
            type="text"
            class="bean-skills-search-input"
            placeholder="Search routines"
            value={query}
            onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
          />
        </div>
        <div class="bean-skills-list-label">All routines · {routines.length}</div>
        {routines.length === 0 ? (
          <div class="bean-panel-empty">No routines yet — set up something Bean should run on a schedule.</div>
        ) : filtered.length === 0 ? (
          <div class="bean-panel-empty">No routines match "{query}".</div>
        ) : (
          groups.map((g) => (
            <div key={g.label} class="bean-skills-row-group">
              <div class="bean-skills-list-label">{g.label} · {g.routines.length}</div>
              {g.routines.map(routineRow)}
            </div>
          ))
        )}
        <span class="bean-skills-spacer" />
        <button type="button" class="bean-btn" onClick={startNew}>+ New routine</button>
        <div class="bean-skills-path">~/.bean/routines/*.json</div>
      </div>

      <div class="bean-skills-detail">
        <div class="bean-skills-header">
          <div class="bean-skills-header-main">
            <div class="bean-skills-title-row">
              <input
                class="bean-input bean-input--boxed bean-notes-title"
                type="text"
                placeholder="Routine name"
                value={draft.name}
                disabled={selected !== undefined}
                onInput={(e) => setDraft({ ...draft, name: (e.target as HTMLInputElement).value })}
              />
            </div>
            <label class="bean-routines-toggle-row">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(e) => setDraft({ ...draft, enabled: (e.target as HTMLInputElement).checked })}
              />
              Runs automatically
            </label>
            <input
              class="bean-input bean-input--boxed"
              type="text"
              placeholder="Description (optional)"
              value={draft.description ?? ""}
              onInput={(e) => setDraft({ ...draft, description: (e.target as HTMLInputElement).value || undefined })}
            />
          </div>
        </div>

        <div class="bean-skills-projects">
          <div class="bean-field-label">CADENCE</div>
          <div class="bean-routines-cadence-row">
            <select
              class="bean-input bean-input--boxed"
              value={CADENCES.find((c) => c.cron === draft.cron) ? draft.cron : "custom"}
              onChange={(e) => {
                const v = (e.target as HTMLSelectElement).value;
                if (v !== "custom") setDraft({ ...draft, cron: v });
              }}
            >
              {CADENCES.map((c) => <option key={c.cron} value={c.cron}>{c.label}</option>)}
              <option value="custom">Custom…</option>
            </select>
            <input
              class="bean-input bean-input--boxed"
              type="text"
              placeholder="cron (5 fields)"
              value={draft.cron}
              onInput={(e) => setDraft({ ...draft, cron: (e.target as HTMLInputElement).value })}
            />
          </div>
        </div>

        <div class="bean-skills-projects">
          <div class="bean-field-label">STEPS</div>
          {draft.steps.map((step, i) => (
            <div key={i} class="bean-routines-step-card">
              <div class="bean-routines-pill-row">
                <span class="bean-routines-step-index">{i + 1}</span>
                <select
                  class="bean-routines-pill-select"
                  value={step.kind}
                  onChange={(e) => {
                    const kind = (e.target as HTMLSelectElement).value;
                    setStep(i, kind === "delegate"
                      ? { kind: "delegate", skill: "", instruction: step.instruction }
                      : { kind: "chat", instruction: step.instruction });
                  }}
                >
                  <option value="delegate">delegate (coding agent)</option>
                  <option value="chat">chat (Bean's model + tools)</option>
                </select>
                {step.kind === "delegate" && (
                  <>
                    <input
                      class="bean-routines-pill-input"
                      placeholder="skill"
                      value={step.skill}
                      onInput={(e) => setStep(i, { ...step, skill: (e.target as HTMLInputElement).value })}
                    />
                    <input
                      class="bean-routines-pill-input"
                      placeholder="project path (none = scratch)"
                      value={step.project ?? ""}
                      onInput={(e) => setStep(i, { ...step, project: (e.target as HTMLInputElement).value || undefined })}
                    />
                  </>
                )}
                {step.kind === "chat" && (
                  <input
                    class="bean-routines-pill-input"
                    placeholder="skill (optional)"
                    value={step.skill ?? ""}
                    onInput={(e) => setStep(i, { ...step, skill: (e.target as HTMLInputElement).value || undefined })}
                  />
                )}
                <input
                  class="bean-routines-pill-input"
                  placeholder="model (Bean picks)"
                  value={step.model ?? ""}
                  onInput={(e) => setStep(i, { ...step, model: (e.target as HTMLInputElement).value || undefined })}
                />
              </div>
              <textarea
                class="bean-skills-editor bean-routines-step-instruction"
                placeholder="What should this step do?"
                value={step.instruction}
                onInput={(e) => setStep(i, { ...step, instruction: (e.target as HTMLTextAreaElement).value })}
              />
              <div class="bean-card-actions">
                <button
                  type="button"
                  class="bean-btn bean-btn--ghost"
                  disabled={i === 0}
                  onClick={() => {
                    const steps = [...draft.steps];
                    [steps[i - 1], steps[i]] = [steps[i]!, steps[i - 1]!];
                    setDraft({ ...draft, steps });
                  }}
                >↑ Move up</button>
                <span class="bean-skills-spacer" />
                <button
                  type="button"
                  class="bean-skills-delete-link"
                  disabled={draft.steps.length === 1}
                  onClick={() => setDraft({ ...draft, steps: draft.steps.filter((_, j) => j !== i) })}
                >Remove</button>
              </div>
            </div>
          ))}
          <button
            type="button"
            class="bean-btn bean-btn--ghost"
            onClick={() => setDraft({ ...draft, steps: [...draft.steps, { kind: "chat", instruction: "" }] })}
          >+ Add a step</button>
        </div>

        <div class="bean-skills-projects">
          <div class="bean-field-label">DIGEST SINKS</div>
          <label class="bean-routines-sink-row">
            <input
              type="checkbox"
              checked={draft.sinks.note === true}
              onChange={(e) => setDraft({ ...draft, sinks: { ...draft.sinks, note: (e.target as HTMLInputElement).checked || undefined } })}
            />
            Save digest as a note
          </label>
          {(["discord", "teams"] as const).map((transport) => {
            const entry = draft.sinks.chatops?.find((c) => c.transport === transport);
            return (
              <div key={transport} class="bean-routines-sink-row">
                <label class="bean-routines-sink-row">
                  <input
                    type="checkbox"
                    checked={entry !== undefined}
                    onChange={(e) => {
                      const on = (e.target as HTMLInputElement).checked;
                      const rest = (draft.sinks.chatops ?? []).filter((c) => c.transport !== transport);
                      const chatops = on ? [...rest, { transport, channel: "" }] : rest;
                      setDraft({ ...draft, sinks: { ...draft.sinks, chatops: chatops.length > 0 ? chatops : undefined } });
                    }}
                  />
                  Post to {transport}
                </label>
                {entry && (
                  <input
                    class="bean-input bean-input--boxed"
                    placeholder={transport === "discord" ? "channel id" : "conversation id"}
                    value={entry.channel}
                    onInput={(e) => setDraft({
                      ...draft,
                      sinks: {
                        ...draft.sinks,
                        chatops: (draft.sinks.chatops ?? []).map((c) =>
                          c.transport === transport ? { ...c, channel: (e.target as HTMLInputElement).value } : c),
                      },
                    })}
                  />
                )}
              </div>
            );
          })}
        </div>

        {error ? <div class="bean-status bean-status--error">{error}</div> : null}
        <div class="bean-card-actions">
          <button type="button" class="bean-btn" onClick={() => void save()}>Save routine</button>
          {selected ? (
            <>
              <button type="button" class="bean-btn bean-btn--ghost" onClick={() => void runNow()}>Run now</button>
              <span class="bean-skills-spacer" />
              <button type="button" class="bean-skills-delete-link" onClick={() => void remove()}>Delete…</button>
            </>
          ) : null}
        </div>

        {selected && selectedState && selectedState.history.length > 0 ? (
          <div class="bean-skills-projects">
            <div class="bean-field-label">RUN HISTORY</div>
            <div class="bean-skills-description">{statusText(selectedState)}</div>
            {selectedState.history.map((h, i) => (
              <details key={i} class="bean-routines-history-entry">
                <summary>{h.status} · {new Date(h.finishedAt).toLocaleString()}</summary>
                <pre class="bean-routines-history-digest">{h.digest}</pre>
              </details>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
