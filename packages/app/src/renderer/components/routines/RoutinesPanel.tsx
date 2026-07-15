import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { Routine, RoutineStep, Skill, Project, AvailableModel, TodoItem } from "@bean/core";
import { nextRun, parseCron } from "@bean/core/cron";
import { ChipMenu } from "../../shared/ChipMenu.js";
import { PanelEmptyState } from "../../shared/PanelEmptyState.js";
import type { RoutineStateView } from "../../../ipc.js";

const DOW_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pad2 = (n: number): string => String(n).padStart(2, "0");

const emptyRoutine = (): Routine => ({
  name: "",
  enabled: true,
  cron: "0 8 * * *",
  steps: [{ kind: "chat", instruction: "" }],
  sinks: {},
});

// --- cadence sentence model -------------------------------------------------
// The cadence reads as "Run every <day> at <time> in local time". Those two chips
// are dropdowns backed by a 5-field cron; anything richer than a single time on a
// known day-set (ranges, day-of-month, months, stepped minutes) falls back to a
// raw cron field — see toSentence()/cadenceCustom.

type DaySel = "everyday" | "weekday" | "weekend" | "0" | "1" | "2" | "3" | "4" | "5" | "6";

const DAY_OPTIONS: { value: DaySel; label: string }[] = [
  { value: "everyday", label: "day" },
  { value: "weekday", label: "weekday" },
  { value: "weekend", label: "weekend" },
  { value: "1", label: "Monday" },
  { value: "2", label: "Tuesday" },
  { value: "3", label: "Wednesday" },
  { value: "4", label: "Thursday" },
  { value: "5", label: "Friday" },
  { value: "6", label: "Saturday" },
  { value: "0", label: "Sunday" },
];

const timeLabel = (h: number, m: number): string =>
  `${((h + 11) % 12) + 1}:${pad2(m)} ${h < 12 ? "AM" : "PM"}`;

const TIME_OPTIONS: { value: string; label: string }[] = [];
for (let h = 0; h < 24; h++) {
  for (const m of [0, 30]) TIME_OPTIONS.push({ value: `${h}:${m}`, label: timeLabel(h, m) });
}

const dowField = (day: DaySel): string =>
  day === "everyday" ? "*" : day === "weekday" ? "1-5" : day === "weekend" ? "0,6" : day;

const buildCron = (day: DaySel, hour: number, minute: number): string =>
  `${minute} ${hour} * * ${dowField(day)}`;

interface Sentence { day: DaySel; hour: number; minute: number }

// Map a cron string to the (day, time) sentence model, or null when it's richer than
// the two chips can express — the caller then shows the raw cron field instead.
function toSentence(cron: string): Sentence | null {
  let spec;
  try { spec = parseCron(cron); } catch { return null; }
  if (spec.dayRestricted || spec.months.size !== 12) return null;
  if (spec.hours.size !== 1 || spec.minutes.size !== 1) return null;
  const hour = [...spec.hours][0]!;
  const minute = [...spec.minutes][0]!;
  if (!spec.weekdayRestricted) return { day: "everyday", hour, minute };
  const wd = [...spec.weekdays].sort((a, b) => a - b);
  const key = wd.join(",");
  const day: DaySel | null =
    key === "1,2,3,4,5" ? "weekday" : key === "0,6" ? "weekend"
      : wd.length === 1 ? (String(wd[0]) as DaySel) : null;
  return day ? { day, hour, minute } : null;
}

// Short cadence caption for the list rows, e.g. "Weekdays 6:30" — raw cron otherwise.
function humanCadence(cron: string): string {
  const s = toSentence(cron);
  if (!s) return cron;
  const dw = s.day === "everyday" ? "Daily" : s.day === "weekday" ? "Weekdays"
    : s.day === "weekend" ? "Weekends" : DOW_SHORT[Number(s.day)]!;
  return `${dw} ${s.hour}:${pad2(s.minute)}`;
}

function humanizeDelta(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60000));
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60), m = mins % 60;
  if (h < 24) return m ? `${h}h ${m}m` : `${h}h`;
  const d = Math.floor(h / 24), rh = h % 24;
  return rh ? `${d}d ${rh}h` : `${d}d`;
}

function whenLabel(next: Date, now: Date): string {
  const startOfDay = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(next) - startOfDay(now)) / 86400000);
  const time = `${pad2(next.getHours())}:${pad2(next.getMinutes())}`;
  if (days === 0) return `today ${time}`;
  if (days === 1) return `tomorrow ${time}`;
  return `${DOW_SHORT[next.getDay()]} ${time}`;
}

function nextRunView(cron: string): { ok: boolean; text: string } {
  try {
    const now = new Date();
    const next = nextRun(cron, now);
    return { ok: true, text: `Next run in ${humanizeDelta(next.getTime() - now.getTime())} · ${whenLabel(next, now)}` };
  } catch {
    return { ok: false, text: "invalid cron — won't be scheduled" };
  }
}

type DotKind = "running" | "failed" | "enabled" | "off";

// Enabled = green, running = glowing green, failed/missed = red, disabled = grey — the pill's
// on/off state always wins over run history so a paused routine never reads as healthy.
function dotKind(enabled: boolean, state: RoutineStateView | undefined): DotKind {
  if (!enabled) return "off";
  if (state?.running) return "running";
  if (state?.missed || state?.history[0]?.status === "failed") return "failed";
  return "enabled";
}

function statusText(state: RoutineStateView | undefined): string {
  if (!state) return "not run yet";
  if (state.running) return "running…";
  if (state.missed) return "missed last run";
  const last = state.history[0];
  return last ? `last: ${last.status} · ${new Date(last.finishedAt).toLocaleString()}` : "not run yet";
}

// A textarea that grows to fit its content (no manual resize handle) — so the description
// reads as flowing text in view mode and wraps/grows as you type in edit mode.
function AutoTextarea(props: { value: string; onValue: (v: string) => void; class?: string; placeholder?: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fit = (): void => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };
  useLayoutEffect(fit, [props.value]);
  return (
    <textarea
      ref={ref}
      rows={1}
      class={props.class}
      placeholder={props.placeholder}
      value={props.value}
      onInput={(e) => { props.onValue((e.target as HTMLTextAreaElement).value); fit(); }}
    />
  );
}

// 1a "Routine as a recipe": list rail on the left, a recipe-style editor on the right —
// cadence reads as a sentence, the fan-out is a numbered timeline of delegate steps.
export function RoutinesPanel() {
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [states, setStates] = useState<Record<string, RoutineStateView>>({});
  const [selected, setSelected] = useState<string | undefined>(undefined);
  // Nothing selected and not creating = the detail pane starts blank, not a create form.
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<Routine>(emptyRoutine());
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [customCron, setCustomCron] = useState(false);
  // Catalogs that back the per-step skill / project / model pickers (same sources the
  // ProposalCard/DelegateCard chips use).
  const [skills, setSkills] = useState<Skill[]>([]);
  // Step skill pickers should only offer skills currently enabled — a disabled skill stays
  // assigned to a step that already references it, it just can't be newly picked.
  const enabledSkills = useMemo(() => skills.filter((s) => s.enabled !== false), [skills]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [models, setModels] = useState<AvailableModel[]>([]);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [triggering, setTriggering] = useState(false);
  // The todo queue for a todo-driven routine — only loaded when there's a saved routine
  // selected and it's todo-driven; empty otherwise (mirrors refreshTodos()'s own guard).
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [newTodo, setNewTodo] = useState("");

  const refresh = async (): Promise<void> => {
    const [list, st] = await Promise.all([window.bean.routinesList(), window.bean.routinesState()]);
    setRoutines(list);
    setStates(st);
  };

  const refreshTodos = async (): Promise<void> => {
    setTodos(selected && draft.todoDriven ? await window.bean.todosList(selected) : []);
  };

  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    void Promise.all([window.bean.listSkills(), window.bean.listProjects(), window.bean.availableModels()])
      .then(([sk, pr, md]) => { setSkills(sk); setProjects(pr); setModels(md); });
  }, []);
  useEffect(() => {
    // Piggyback on the same 5s poll so "running now" chips update live while a todo-driven
    // routine is open.
    const t = setInterval(() => {
      void window.bean.routinesState().then(setStates);
      void refreshTodos();
    }, 5000);
    return () => clearInterval(t);
  }, [selected, draft.todoDriven]);
  useEffect(() => {
    setDraft(routines.find((r) => r.name === selected) ?? emptyRoutine());
    setError("");
    setCustomCron(false);
  }, [selected, routines]);
  useEffect(() => { void refreshTodos(); }, [selected, draft.todoDriven]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? routines.filter((r) => r.name.toLowerCase().includes(q) || (r.description ?? "").toLowerCase().includes(q))
      : routines;
    // Enabled routines first, paused sink to the bottom (dimmed), original order otherwise.
    return [...list].sort((a, b) => Number(b.enabled) - Number(a.enabled));
  }, [routines, query]);

  const setStep = (i: number, step: RoutineStep): void =>
    setDraft({ ...draft, steps: draft.steps.map((s, j) => (j === i ? step : s)) });

  // Reorder by drag (the ⠿ handle is the drag source, each step card a drop target).
  const reorderStep = (from: number, to: number): void => {
    if (from === to) return;
    const steps = [...draft.steps];
    const [moved] = steps.splice(from, 1);
    steps.splice(to, 0, moved!);
    setDraft({ ...draft, steps });
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

  const select = (name: string): void => { setSelected(name); setCreating(false); setError(""); };
  const startNew = (): void => { setSelected(undefined); setCreating(true); setDraft(emptyRoutine()); setError(""); };

  const toggleEnabled = async (r: Routine): Promise<void> => {
    await window.bean.routinesSave({ ...r, enabled: !r.enabled });
    await refresh();
  };

  // The detail header's toggle mirrors the list-row pill, but for an existing routine it must
  // persist right away too — otherwise the next poll's refresh() overwrites the local draft
  // with the still-disabled saved copy and the flip silently reverts.
  const toggleDraftEnabled = async (): Promise<void> => {
    const next = { ...draft, enabled: !draft.enabled };
    setDraft(next);
    if (selected) {
      await window.bean.routinesSave(next);
      await refresh();
    }
  };

  const save = async (): Promise<void> => {
    try {
      await window.bean.routinesSave(draft);
      setError("");
      await refresh();
      setSelected(draft.name);
      setCreating(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "save failed — check name, cadence, and steps");
    }
  };

  const runNow = async (): Promise<void> => {
    if (!selected) return;
    setTriggering(true);
    try {
      const { started, reason } = await window.bean.routinesRunNow(selected);
      setError(started ? "" : (reason ?? "couldn't start run"));
      await refresh();
    } finally {
      // The scheduler's isRunning() flag is set synchronously on start, so by the time refresh()
      // resolves the polled state already reflects it — safe to drop the optimistic flag here
      // and let selectedState.running (polled every 5s) own the button until the run finishes.
      setTriggering(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (!selected) return;
    if (!confirm(`Delete routine "${selected}"?`)) return;
    await window.bean.routinesDelete(selected);
    setSelected(undefined);
    await refresh();
  };

  // --- cadence derivations --------------------------------------------------
  const sentence = toSentence(draft.cron);
  const cadenceCustom = customCron || sentence === null;
  const day: DaySel = sentence?.day ?? "everyday";
  const timeValue = sentence ? `${sentence.hour}:${sentence.minute}` : "8:0";
  const timeOptions = useMemo(() => {
    if (TIME_OPTIONS.some((o) => o.value === timeValue)) return TIME_OPTIONS;
    const [h, m] = timeValue.split(":").map(Number) as [number, number];
    return [{ value: timeValue, label: timeLabel(h, m) }, ...TIME_OPTIONS];
  }, [timeValue]);
  const nrv = nextRunView(draft.cron);

  const setDay = (v: string): void => {
    if (v === "custom") { setCustomCron(true); return; }
    setDraft({ ...draft, cron: buildCron(v as DaySel, sentence?.hour ?? 8, sentence?.minute ?? 0) });
  };
  const setTime = (v: string): void => {
    const [h, m] = v.split(":").map(Number) as [number, number];
    setDraft({ ...draft, cron: buildCron(day, h, m) });
  };

  const sinkTargets: string[] = [];
  if (draft.sinks.note) sinkTargets.push("your Daily Dashboard");
  for (const c of draft.sinks.chatops ?? []) sinkTargets.push(c.transport === "discord" ? "Discord" : "Teams");
  if (draft.sinks.notify) sinkTargets.push("a desktop notification");

  const routineRow = (r: Routine) => (
    <div
      key={r.name}
      class={`bean-skills-row bean-routines-row${r.enabled ? "" : " bean-routines-row--off"}${selected === r.name ? " bean-skills-row--selected" : ""}`}
      onClick={() => select(r.name)}
    >
      <button
        type="button"
        class={`bean-skills-pill${r.enabled ? " bean-skills-pill--on" : ""}`}
        title={r.enabled ? "Runs automatically — click to pause" : "Paused — click to enable"}
        onClick={(e) => { e.stopPropagation(); void toggleEnabled(r); }}
      >
        <span class="bean-skills-pill-knob" />
      </button>
      <div class="bean-skills-row-main">
        <div class="bean-skills-row-name">{r.name}</div>
        <div class="bean-routines-row-sub">
          {humanCadence(r.cron)} · {r.enabled ? `${r.steps.length} step${r.steps.length === 1 ? "" : "s"}` : "paused"}
          {r.todoDriven ? " · ⚡ todo-driven" : ""}
        </div>
      </div>
      <span class={`bean-routines-dot bean-routines-dot--${dotKind(r.enabled, states[r.name])}`} />
    </div>
  );

  const selectedState = selected ? states[selected] : undefined;
  const isRunningSelected = triggering || Boolean(selectedState?.running);
  const pendingCount = todos.filter((t) => t.status === "pending").length;
  const emptyTodoQueue = Boolean(draft.todoDriven) && pendingCount === 0;

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
        <div class="bean-skills-list-label">Your routines · {routines.length}</div>
        {routines.length === 0 ? (
          <div class="bean-panel-empty">No routines yet — set up something Bean should run on a schedule.</div>
        ) : filtered.length === 0 ? (
          <div class="bean-panel-empty">No routines match "{query}".</div>
        ) : (
          filtered.map(routineRow)
        )}
        <span class="bean-skills-spacer" />
        <button type="button" class="bean-routines-new" onClick={startNew}>＋ New routine</button>
        <div class="bean-skills-path">~/.bean/routines/*.json · runs via the scheduler</div>
      </div>

      <div class="bean-skills-detail">
        {!selected && !creating ? (
          <PanelEmptyState message="Select a routine to view it, or set up a new one." />
        ) : (
        <>
        <div class="bean-skills-header">
          <div class="bean-skills-header-main">
            {selected ? (
              <>
                <div class="bean-skills-title-row">
                  <h2 class="bean-routines-name-text">{draft.name}</h2>
                  <span class="bean-skills-badge bean-skills-badge--yours">YOURS</span>
                </div>
                <AutoTextarea
                  class="bean-routines-desc-text"
                  placeholder="Add a description…"
                  value={draft.description ?? ""}
                  onValue={(v) => setDraft({ ...draft, description: v || undefined })}
                />
              </>
            ) : (
              <>
                <div class="bean-skills-title-row">
                  <input
                    class="bean-input bean-input--boxed bean-routines-name-input"
                    type="text"
                    placeholder="routine-name"
                    value={draft.name}
                    onInput={(e) => setDraft({ ...draft, name: (e.target as HTMLInputElement).value })}
                  />
                </div>
                <AutoTextarea
                  class="bean-input bean-input--boxed bean-routines-desc-input"
                  placeholder="Description (optional)"
                  value={draft.description ?? ""}
                  onValue={(v) => setDraft({ ...draft, description: v || undefined })}
                />
              </>
            )}
          </div>
          <div class="bean-skills-toggle-col">
            <button
              type="button"
              role="switch"
              aria-checked={draft.enabled}
              class={`bean-skills-toggle${draft.enabled ? " bean-skills-toggle--on" : ""}`}
              onClick={() => void toggleDraftEnabled()}
            >
              <span class="bean-skills-toggle-knob" />
            </button>
            <span class="bean-skills-toggle-label">{draft.enabled ? "Runs automatically" : "Paused"}</span>
          </div>
        </div>

        <div class="bean-skills-projects">
          <div class="bean-field-label">CADENCE</div>
          {cadenceCustom ? (
            <div class="bean-routines-sentence">
              Run on a{" "}
              <span class="bean-routines-tz">custom schedule</span> —{" "}
              <input
                class="bean-input bean-input--boxed bean-routines-cron-input"
                type="text"
                placeholder="cron (5 fields)"
                value={draft.cron}
                onInput={(e) => setDraft({ ...draft, cron: (e.target as HTMLInputElement).value })}
              />
              {sentence ? (
                <button type="button" class="bean-routines-custom-link" onClick={() => setCustomCron(false)}>use the simple picker</button>
              ) : null}
            </div>
          ) : (
            <div class="bean-routines-sentence">
              Run every{" "}
              <select class="bean-routines-chip-select" value={day} onChange={(e) => setDay((e.target as HTMLSelectElement).value)}>
                {DAY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                <option value="custom">custom…</option>
              </select>{" "}
              at{" "}
              <select class="bean-routines-chip-select" value={timeValue} onChange={(e) => setTime((e.target as HTMLSelectElement).value)}>
                {timeOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>{" "}
              <span class="bean-routines-tz">in local time</span>.
            </div>
          )}
          <div class="bean-routines-cadence-meta">
            <span class="bean-routines-cron-cap">cron&nbsp;&nbsp;{draft.cron}</span>
            <span class={`bean-routines-next${nrv.ok ? "" : " bean-routines-next--bad"}`}>
              <span class="bean-routines-next-dot" />{nrv.text}{draft.todoDriven ? " · only if the queue has items" : ""}
            </span>
          </div>
        </div>

        <div class="bean-routines-divider" />

        <div class="bean-skills-projects">
          <div class="bean-routines-section-head">
            <div class="bean-field-label">TYPE</div>
          </div>
          <div class="bean-routines-type-row">
            <button
              type="button"
              class={`bean-btn bean-btn--ghost bean-routines-type-btn${draft.todoDriven ? "" : " bean-routines-type-btn--on"}`}
              onClick={() => setDraft({ ...draft, todoDriven: undefined })}
            >Always runs</button>
            <button
              type="button"
              class={`bean-btn bean-btn--ghost bean-routines-type-btn${draft.todoDriven ? " bean-routines-type-btn--on" : ""}`}
              onClick={() => setDraft({ ...draft, todoDriven: true })}
            >⚡ Todo-driven</button>
            <span class="bean-routines-section-note">
              {draft.todoDriven
                ? "runs the steps below on each queued todo — skips the run when the queue is empty"
                : "runs the steps below on every scheduled fire"}
            </span>
          </div>
        </div>

        {draft.todoDriven && selected ? (
          <div class="bean-skills-projects">
            <div class="bean-routines-section-head">
              <div class="bean-field-label">QUEUE</div>
              <span class="bean-routines-section-note">
                a backlog you fill — each pending item runs through the steps below
              </span>
            </div>
            <div class="bean-routines-queue-meta">
              {pendingCount} pending · gates this routine
            </div>
            {[...todos]
              .sort((a, b) => Number(a.status === "done" || a.status === "failed") - Number(b.status === "done" || b.status === "failed"))
              .map((t) => (
                <div key={t.id} class={`bean-routines-todo bean-routines-todo--${t.status}`}>
                  <span class="bean-routines-todo-text">{t.text}</span>
                  <span class="bean-routines-todo-chip">{t.status === "running" ? "running now" : t.status}</span>
                  {t.status === "failed" ? (
                    <button
                      type="button"
                      class="bean-skills-delete-link"
                      title={t.resultSummary}
                      onClick={() => void window.bean.todosRetry(t.id).then(refreshTodos)}
                    >Retry</button>
                  ) : null}
                  {t.status === "pending" ? (
                    <button
                      type="button"
                      class="bean-skills-delete-link"
                      onClick={() => void window.bean.todosDelete(t.id).then(refreshTodos)}
                    >Remove</button>
                  ) : null}
                </div>
              ))}
            <div class="bean-routines-todo-add">
              <input
                class="bean-input bean-input--boxed"
                placeholder="＋ Queue a todo — runs through the steps on the next run"
                value={newTodo}
                onInput={(e) => setNewTodo((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newTodo.trim() && selected) {
                    void window.bean.todosAdd(selected, newTodo).then(() => { setNewTodo(""); void refreshTodos(); });
                  }
                }}
              />
            </div>
            {todos.some((t) => t.status === "done" || t.status === "failed") ? (
              <button
                type="button"
                class="bean-skills-delete-link"
                onClick={() => { if (selected) void window.bean.todosClearFinished(selected).then(refreshTodos); }}
              >Clear finished</button>
            ) : null}
          </div>
        ) : null}

        <div class="bean-routines-divider" />

        <div class="bean-skills-projects">
          <div class="bean-routines-section-head">
            <div class="bean-field-label">WHAT BEAN DOES</div>
            <span class="bean-routines-section-note">
              {draft.steps.length} step{draft.steps.length === 1 ? "" : "s"}
              {draft.todoDriven ? " · run in order on each queued todo · one digest at the end" : " · run in order · one digest at the end"}
            </span>
          </div>
          <div class="bean-routines-steps">
            {draft.steps.map((step, i) => {
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
                    {i < draft.steps.length - 1 ? <span class="bean-routines-step-line" /> : null}
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
                                  {k === "delegate" ? "coding agent (opencode / claude)" : "Bean's own model + tools, in chat"}
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
                            {enabledSkills.map((s) => (
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
                            {models.map((m) => (
                              <button
                                key={m.id}
                                type="button"
                                class={`bean-chip-menu-row bean-chip-menu-row--model${step.model === m.id ? " bean-chip-menu-row--on" : ""}`}
                                onClick={() => { setModel(i, step, m.id); close(); }}
                              >
                                <span class="bean-chip-menu-row-title">{step.model === m.id ? "✓ " : ""}{m.label}</span>
                                <span class="bean-chip-menu-caption">
                                  {Object.entries(m.aliases).map(([cli, alias]) => `${alias} · ${cli}`).join("  /  ") || "no CLI support"}
                                </span>
                              </button>
                            ))}
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
                    <div class="bean-routines-step-actions">
                      <span class="bean-skills-spacer" />
                      <button
                        type="button"
                        class="bean-skills-delete-link"
                        disabled={draft.steps.length === 1}
                        onClick={() => setDraft({ ...draft, steps: draft.steps.filter((_, j) => j !== i) })}
                      >Remove</button>
                    </div>
                  </div>
                </div>
              );
            })}
            <button
              type="button"
              class="bean-routines-add"
              onClick={() => setDraft({ ...draft, steps: [...draft.steps, { kind: "chat", instruction: "" }] })}
            >
              <span class="bean-routines-add-plus">＋</span>
              Add a step
              <span class="bean-routines-add-hint">— another delegate under this cadence</span>
            </button>
          </div>
        </div>

        <div class="bean-routines-divider" />

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
          <label class="bean-routines-sink-row">
            <input
              type="checkbox"
              checked={draft.sinks.notify === true}
              onChange={(e) => setDraft({ ...draft, sinks: { ...draft.sinks, notify: (e.target as HTMLInputElement).checked || undefined } })}
            />
            Send a desktop notification
          </label>
          {(["discord", "teams"] as const).map((transport) => {
            const entry = draft.sinks.chatops?.find((c) => c.transport === transport);
            const label = transport === "discord" ? "Discord" : "Teams";
            const specific = entry?.channel !== undefined;
            return (
              <div key={transport} class="bean-routines-sink-row">
                <label class="bean-routines-sink-row">
                  <input
                    type="checkbox"
                    checked={entry !== undefined}
                    onChange={(e) => {
                      const on = (e.target as HTMLInputElement).checked;
                      const rest = (draft.sinks.chatops ?? []).filter((c) => c.transport !== transport);
                      // Default to DM (no channel) — a specific channel/conversation is opt-in below.
                      const chatops = on ? [...rest, { transport, channel: undefined }] : rest;
                      setDraft({ ...draft, sinks: { ...draft.sinks, chatops: chatops.length > 0 ? chatops : undefined } });
                    }}
                  />
                  Post to {label} (DM)
                </label>
                {entry ? (
                  <label class="bean-routines-sink-row bean-routines-sink-suboption">
                    <input
                      type="checkbox"
                      checked={specific}
                      onChange={(e) => {
                        const useSpecific = (e.target as HTMLInputElement).checked;
                        setDraft({
                          ...draft,
                          sinks: {
                            ...draft.sinks,
                            chatops: (draft.sinks.chatops ?? []).map((c) =>
                              c.transport === transport ? { ...c, channel: useSpecific ? "" : undefined } : c),
                          },
                        });
                      }}
                    />
                    Use a specific {transport === "discord" ? "channel" : "conversation"} instead
                  </label>
                ) : null}
                {entry && specific ? (
                  <input
                    class="bean-input bean-input--boxed bean-routines-sink-suboption"
                    placeholder={transport === "discord" ? "channel id" : "conversation id"}
                    value={entry.channel ?? ""}
                    onInput={(e) => setDraft({
                      ...draft,
                      sinks: {
                        ...draft.sinks,
                        chatops: (draft.sinks.chatops ?? []).map((c) =>
                          c.transport === transport ? { ...c, channel: (e.target as HTMLInputElement).value } : c),
                      },
                    })}
                  />
                ) : null}
              </div>
            );
          })}
        </div>

        {error ? <div class="bean-status bean-status--error">{error}</div> : null}

        <div class="bean-routines-divider" />
        <div class="bean-routines-footer">
          <span class="bean-routines-digest-line">
            <span class="bean-routines-bean-chip" />
            {sinkTargets.length > 0
              ? <>Posts a digest to <b>{sinkTargets.join(", ")}</b></>
              : "No digest sink — results stay in run history."}
          </span>
          <span class="bean-skills-spacer" />
          {selected ? (
            <>
              <button
                type="button"
                class="bean-btn bean-btn--ghost"
                disabled={isRunningSelected || emptyTodoQueue}
                onClick={() => void runNow()}
              >
                {isRunningSelected ? "Running…" : "Run now"}
              </button>
              {emptyTodoQueue ? <span class="bean-routines-section-note">queue a todo first</span> : null}
            </>
          ) : null}
          <button type="button" class="bean-btn" onClick={() => void save()}>Save routine</button>
        </div>
        {selected ? (
          <button type="button" class="bean-skills-delete-link bean-routines-delete" onClick={() => void remove()}>Delete routine…</button>
        ) : null}

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
        </>
        )}
      </div>
    </div>
  );
}
