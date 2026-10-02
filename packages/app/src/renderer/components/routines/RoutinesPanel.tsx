import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { Routine, RoutineBrief, RoutineWatch, Skill, Project, TodoItem, WatchWindow } from "@bean/core";
import { nextRun, parseCron } from "@bean/core/cron";
import { watchWindowText } from "@bean/core/watch-window";
import { PanelEmptyState } from "../../shared/PanelEmptyState.js";
import { ListFoldToggle, useListFold } from "../../shared/ListFold.js";
import { useCliAvailability } from "../../shared/cli-availability.js";
import type { RoutineStateView } from "../../../ipc.js";
import type { RoutineBuildView } from "../../../routine-builder.js";
import { StepsEditor } from "./StepsEditor.js";
import { BuildPane, DescribePane, ReviewPane, buildElapsed, ipcErrorMessage } from "./RoutineBuilder.js";
import { everyMinutes, failureCount, intervalText, needsReview, WATCH_MINUTES, watchRowSub, watchStatusLine, windowTooShortNote } from "./watch-status.js";

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

// This panel is for editing a routine, not reading its output — the last few runs are enough to
// see whether it's healthy, and the Dashboard is where the whole kept history lives.
const HISTORY_SHOWN = 3;

type DotKind = "running" | "failed" | "enabled" | "off" | "review";

// Enabled = green, running = glowing green, failed/missed = red, disabled = grey — the pill's
// on/off state always wins over run history so a paused routine never reads as healthy.
function dotKind(r: Routine, state: RoutineStateView | undefined): DotKind {
  if (needsReview(r, state)) return "review";
  if (!r.enabled) return "off";
  if (r.watch && failureCount(state) > 0) return "failed"; // matches the row's "check failing"
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
  // Refit when the width changes too (window resize, list fold) — wrapping changes the height.
  // Height-only callbacks are fit()'s own doing; skip them so it can't loop.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let width = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fit();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
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
  const [listFolded, toggleListFold] = useListFold("bean.routines.listFolded");
  const [states, setStates] = useState<Record<string, RoutineStateView>>({});
  const [selected, setSelected] = useState<string | undefined>(undefined);
  // Nothing selected and not creating = the detail pane starts blank, not a create form.
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<Routine>(emptyRoutine());
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [customCron, setCustomCron] = useState(false);
  // The describe-it builder (2a) is what ＋ New routine opens; builds (2b) live in main.
  const [describing, setDescribing] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [briefSeed, setBriefSeed] = useState<RoutineBrief | undefined>(undefined);
  const [builds, setBuilds] = useState<RoutineBuildView[]>([]);
  const [selectedBuild, setSelectedBuild] = useState<string | undefined>(undefined);
  // Needs-review routines open on the review card (2c) unless "Open in editor" was picked.
  const [editorFor, setEditorFor] = useState<string | undefined>(undefined);
  const [checking, setChecking] = useState(false);
  const [notice, setNotice] = useState("");
  // Catalogs that back the per-step skill / project / model pickers (same sources the
  // ProposalCard/DelegateCard chips use).
  const [skills, setSkills] = useState<Skill[]>([]);
  // Step skill pickers should only offer skills currently enabled — a disabled skill stays
  // assigned to a step that already references it, it just can't be newly picked.
  const enabledSkills = useMemo(() => skills.filter((s) => s.enabled !== false), [skills]);
  const [projects, setProjects] = useState<Project[]>([]);
  const { clis, models } = useCliAvailability();
  const [triggering, setTriggering] = useState(false);
  // The todo queue for a todo-driven routine — only loaded when there's a saved routine
  // selected and it's todo-driven; empty otherwise (mirrors refreshTodos()'s own guard).
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [newTodo, setNewTodo] = useState("");
  // Inline edit is pending-items-only; editingId gates which row (if any) shows the input
  // in place of its static text.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  // Drag-to-reorder for pending todos — same interaction as the steps list's ⠿ handle
  // (separate state since the two lists reorder independently).
  const [todoDragId, setTodoDragId] = useState<string | null>(null);
  const [todoOverId, setTodoOverId] = useState<string | null>(null);

  const refresh = async (): Promise<void> => {
    const [list, st, bs] = await Promise.all([window.bean.routinesList(), window.bean.routinesState(), window.bean.routinesBuilds()]);
    setRoutines(list);
    setStates(st);
    setBuilds(bs);
  };

  const refreshTodos = async (): Promise<void> => {
    setTodos(selected && draft.todoDriven ? await window.bean.todosList(selected) : []);
  };

  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    void Promise.all([window.bean.listSkills(), window.bean.listProjects()])
      .then(([sk, pr]) => { setSkills(sk); setProjects(pr); });
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
  // Builds tick faster while one runs; when one finishes its routine appears (needs review).
  const anyBuilding = builds.some((b) => b.status === "building");
  useEffect(() => {
    if (!anyBuilding) return;
    const t = setInterval(() => {
      void window.bean.routinesBuilds().then((bs) => {
        setBuilds(bs);
        if (bs.length !== builds.length || bs.some((b, i) => b.status !== builds[i]?.status)) void refresh();
      });
    }, 1500);
    return () => clearInterval(t);
  }, [anyBuilding, builds]);
  // A selected build that finished successfully becomes its (needs-review) routine.
  useEffect(() => {
    if (selectedBuild && !builds.some((b) => b.name === selectedBuild) && routines.some((r) => r.name === selectedBuild)) {
      setSelected(selectedBuild);
      setSelectedBuild(undefined);
    }
  }, [builds, routines, selectedBuild]);
  // Keyed on the selected routine's saved content, not the list's identity: a refresh for some
  // other routine (a build finishing) must not wipe unsaved edits here.
  const savedJson = JSON.stringify(routines.find((r) => r.name === selected) ?? null);
  useEffect(() => {
    if (!selected) return;
    setDraft(routines.find((r) => r.name === selected) ?? emptyRoutine());
    setError("");
    setNotice("");
    setCustomCron(false);
  }, [selected, savedJson]);
  useEffect(() => { void refreshTodos(); }, [selected, draft.todoDriven]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? routines.filter((r) => r.name.toLowerCase().includes(q) || (r.description ?? "").toLowerCase().includes(q))
      : routines;
    // Enabled routines first, paused sink to the bottom (dimmed), original order otherwise.
    return [...list].sort((a, b) => Number(b.enabled) - Number(a.enabled));
  }, [routines, query]);

  const select = (name: string): void => {
    setSelected(name); setCreating(false); setDescribing(false); setSelectedBuild(undefined); setEditorFor(undefined); setError("");
  };
  const selectBuild = (name: string): void => {
    setSelectedBuild(name); setSelected(undefined); setCreating(false); setDescribing(false);
  };
  const startNew = (): void => {
    setSelected(undefined); setSelectedBuild(undefined); setCreating(false); setBriefSeed(undefined); setDescribing(true); setError("");
  };
  const startBlank = (): void => {
    setDescribing(false); setSelected(undefined); setCreating(true); setDraft(emptyRoutine()); setError("");
  };
  const openDraftInEditor = (routine: Routine): void => {
    setDescribing(false); setSelected(undefined); setCreating(true); setDraft(routine); setError("");
  };
  const startBuild = async (brief: RoutineBrief): Promise<void> => {
    await window.bean.routinesBuild(brief);
    setBriefSeed(undefined);
    setDescribing(false);
    await refresh();
    selectBuild(brief.name);
  };

  const checkNow = async (): Promise<void> => {
    if (!selected) return;
    setChecking(true);
    try {
      const r = await window.bean.routinesCheckNow(selected);
      setNotice(r.error ? "" : r.newItems > 0 ? `${r.newItems} new` : "nothing new");
      if (r.error && !r.error.includes("fail")) setError(r.error);
      await refresh();
    } finally {
      setChecking(false);
    }
  };

  // Trigger: Schedule XOR Watch (cron and watch are mutually exclusive in the saved JSON).
  const setTrigger = (kind: "schedule" | "watch"): void => {
    if (kind === "watch" && !draft.watch) {
      const { cron: _cron, ...rest } = draft;
      setDraft({ ...rest, watch: { kind: "command", command: "", everyMinutes: 15 }, todoDriven: rest.steps.length > 0 ? true : undefined });
    } else if (kind === "schedule" && draft.watch) {
      const { watch: _watch, ...rest } = draft;
      setDraft({ ...rest, cron: "0 8 * * *", steps: rest.steps.length > 0 ? rest.steps : [{ kind: "chat", instruction: "" }] });
    }
  };
  const setWatch = (watch: RoutineWatch): void => setDraft({ ...draft, watch });
  const setWatchKind = (kind: RoutineWatch["kind"]): void => {
    const every = draft.watch?.everyMinutes;
    const window = draft.watch?.window;
    const keep = { ...(every ? { everyMinutes: every } : {}), ...(window ? { window } : {}) };
    setWatch(kind === "feed" ? { kind: "feed", url: "", ...keep } : { kind: "command", command: "", ...keep });
  };
  // "Any time" drops the field entirely — never save an empty window.
  const setWatchWindow = (window: WatchWindow | undefined): void => {
    const { window: _old, ...rest } = draft.watch!;
    setWatch(window ? { ...rest, window } : rest);
  };
  // Watch type: notify-only (no steps) or run the steps on each item (todo-driven). Local only —
  // switching to steps needs an instruction before it can validate, so it saves with the rest.
  const setWatchNotifyOnly = (notifyOnly: boolean): void =>
    setDraft(notifyOnly
      ? { ...draft, steps: [], todoDriven: undefined }
      : { ...draft, steps: draft.steps.length > 0 ? draft.steps : [{ kind: "chat", instruction: "" }], todoDriven: true });

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

  // Same reasoning as toggleDraftEnabled just above: for an already-saved routine, flipping
  // TYPE must persist right away. The Queue section (and its add/edit/reorder calls) is gated
  // on the local draft's todoDriven, but the backend validates todo actions against the
  // on-disk routine — so without this, the queue appears to work but every action against it
  // fails silently until "Save routine" is clicked.
  const setTodoDriven = async (on: boolean): Promise<void> => {
    const next = { ...draft, todoDriven: on || undefined };
    setDraft(next);
    if (selected) {
      try {
        await window.bean.routinesSave(next);
        await refresh();
      } catch (e) {
        setError(ipcErrorMessage(e) ?? "couldn't save the type change");
      }
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
      setError(ipcErrorMessage(e) ?? "save failed — check name, cadence, and steps");
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
    if (!confirm(`${needsReview(draft, states[selected]) ? "Discard" : "Delete"} routine "${selected}"?`)) return;
    await window.bean.routinesDelete(selected);
    setSelected(undefined);
    await refresh();
  };

  // --- cadence derivations --------------------------------------------------
  const sentence = toSentence(draft.cron ?? "");
  const cadenceCustom = customCron || sentence === null;
  const day: DaySel = sentence?.day ?? "everyday";
  const timeValue = sentence ? `${sentence.hour}:${sentence.minute}` : "8:0";
  const timeOptions = useMemo(() => {
    if (TIME_OPTIONS.some((o) => o.value === timeValue)) return TIME_OPTIONS;
    const [h, m] = timeValue.split(":").map(Number) as [number, number];
    return [{ value: timeValue, label: timeLabel(h, m) }, ...TIME_OPTIONS];
  }, [timeValue]);
  const nrv = nextRunView(draft.cron ?? "");

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
      class={`bean-skills-row bean-routines-row${r.enabled ? "" : " bean-routines-row--off"}${needsReview(r, states[r.name]) ? " bean-routines-row--review" : ""}${selected === r.name ? " bean-skills-row--selected" : ""}`}
      onClick={() => select(r.name)}
    >
      <button
        type="button"
        class={`bean-skills-pill${r.enabled ? " bean-skills-pill--on" : ""}`}
        title={r.enabled ? "Runs automatically — click to pause" : "Paused — click to enable"}
        // A needs-review watch enables from its review card (re-check + seed), not a bare flip.
        onClick={(e) => { e.stopPropagation(); if (needsReview(r, states[r.name])) select(r.name); else void toggleEnabled(r); }}
      >
        <span class="bean-skills-pill-knob" />
      </button>
      <div class="bean-skills-row-main">
        <div class="bean-skills-row-name">{r.name}</div>
        <div class="bean-routines-row-sub">
          {r.watch ? (
            <span class={watchRowSub(r, states[r.name]).bad ? "bean-routines-row-sub--bad" : undefined}>{watchRowSub(r, states[r.name]).text}</span>
          ) : (
            <>
              {humanCadence(r.cron ?? "")} · {r.enabled ? `${r.steps.length} step${r.steps.length === 1 ? "" : "s"}` : "paused"}
              {r.todoDriven ? " · ⚡ todo-driven" : ""}
            </>
          )}
        </div>
      </div>
      <span class={`bean-routines-dot bean-routines-dot--${dotKind(r, states[r.name])}`} />
    </div>
  );

  const buildRow = (b: RoutineBuildView) => (
    <div
      key={`build:${b.name}`}
      class={`bean-skills-row bean-routines-row bean-routines-row--build${selectedBuild === b.name ? " bean-skills-row--selected" : ""}`}
      onClick={() => selectBuild(b.name)}
    >
      <span class={`bean-routines-build-mark${b.status === "failed" ? " bean-routines-build-mark--failed" : ""}`}>{b.status === "failed" ? "!" : ""}</span>
      <div class="bean-skills-row-main">
        <div class="bean-skills-row-name">{b.name}</div>
        <div class={`bean-routines-row-sub${b.status === "failed" ? " bean-routines-row-sub--bad" : ""}`}>
          {b.status === "failed" ? "build failed · open to retry" : `building… · ${buildElapsed(b)}`}
        </div>
      </div>
    </div>
  );

  const selectedState = selected ? states[selected] : undefined;
  const savedRoutine = selected ? routines.find((r) => r.name === selected) : undefined;
  const reviewing = Boolean(savedRoutine && needsReview(savedRoutine, selectedState) && editorFor !== selected);
  const buildView = selectedBuild ? builds.find((b) => b.name === selectedBuild) : undefined;
  const notifyOnly = Boolean(draft.watch) && draft.steps.length === 0;
  const status = draft.watch ? watchStatusLine(savedRoutine?.watch ? savedRoutine : draft, selectedState, new Date()) : undefined;
  const isRunningSelected = triggering || Boolean(selectedState?.running);
  const pendingCount = todos.filter((t) => t.status === "pending").length;
  const emptyTodoQueue = Boolean(draft.todoDriven) && pendingCount === 0;
  // A saved watch with steps and nothing queued: Run now checks the watch instead (ignoring
  // its window), and anything new drains through the queue.
  // Keyed on the saved definition: Check now runs against it, not the unsaved draft.
  const checkInsteadOfRun = emptyTodoQueue && Boolean(savedRoutine?.watch && savedRoutine.todoDriven && savedRoutine.steps.length > 0);
  const savedWindow = savedRoutine?.watch?.window;
  const runNowNote = !emptyTodoQueue ? undefined
    : !checkInsteadOfRun ? (draft.watch ? "nothing queued yet" : "queue a todo first")
    : !savedRoutine?.enabled ? "enable to check now"
    : notice || `checks the watch now${savedWindow ? `, even outside ${watchWindowText(savedWindow)}` : ""}`;

  return (
    <div class={listFolded ? "bean-skills bean-skills--folded" : "bean-skills"}>
      <ListFoldToggle folded={listFolded} onToggle={toggleListFold} listId="bean-routines-list" />
      <div class="bean-skills-list" id="bean-routines-list">
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
        {describing ? (
          <div class="bean-skills-row bean-routines-row bean-routines-row--build bean-skills-row--selected">
            <span class="bean-skills-pill"><span class="bean-skills-pill-knob" /></span>
            <div class="bean-skills-row-main">
              <div class="bean-skills-row-name">New routine</div>
              <div class="bean-routines-row-sub">{drafting ? "drafting…" : "describe it"}</div>
            </div>
          </div>
        ) : null}
        {builds.map(buildRow)}
        {routines.length === 0 && builds.length === 0 && !describing ? (
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
        {describing ? (
          <DescribePane
            initial={briefSeed}
            skills={enabledSkills}
            projects={projects}
            clis={clis}
            models={models}
            onCancel={() => { setDescribing(false); setBriefSeed(undefined); }}
            onBlank={startBlank}
            onBuild={startBuild}
            onOpenEditor={openDraftInEditor}
            onDrafting={setDrafting}
          />
        ) : buildView ? (
          <BuildPane
            build={buildView}
            onCancel={() => void window.bean.routinesCancelBuild(buildView.name).then(() => { setSelectedBuild(undefined); void refresh(); })}
            onEditBrief={(brief) => void window.bean.routinesDismissBuild(buildView.name).then(() => {
              setSelectedBuild(undefined); setBriefSeed(brief); setDescribing(true); void refresh();
            })}
            onRetry={(brief) => void window.bean.routinesBuild(brief).then(refresh)
              .catch((e) => setError(ipcErrorMessage(e) ?? "couldn't restart the build"))}
            onDismiss={() => void window.bean.routinesDismissBuild(buildView.name).then(() => { setSelectedBuild(undefined); void refresh(); })}
          />
        ) : reviewing && savedRoutine ? (
          <ReviewPane
            routine={savedRoutine}
            state={selectedState}
            models={models}
            projects={projects}
            onDiscard={() => void remove()}
            onOpenEditor={() => setEditorFor(savedRoutine.name)}
            onEnabled={(note) => { void refresh().then(() => { setEditorFor(savedRoutine.name); setNotice(note); }); }}
          />
        ) : !selected && !creating ? (
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
          <div class="bean-routines-section-head">
            <div class="bean-field-label">TRIGGER</div>
            <div class="bean-rb-seg bean-rb-seg--small">
              <button type="button" class={`bean-rb-seg-btn${draft.watch ? "" : " bean-rb-seg-btn--on"}`} onClick={() => setTrigger("schedule")}>Schedule</button>
              <button type="button" class={`bean-rb-seg-btn${draft.watch ? " bean-rb-seg-btn--on" : ""}`} onClick={() => setTrigger("watch")}>Watch</button>
            </div>
          </div>
          {draft.watch ? (
            <>
              <div class="bean-routines-sentence">
                Check{" "}
                <select class="bean-routines-chip-select" value={draft.watch.kind} onChange={(e) => setWatchKind((e.target as HTMLSelectElement).value as RoutineWatch["kind"])}>
                  <option value="command">a command</option>
                  <option value="feed">a feed</option>
                </select>{" "}
                every{" "}
                <select
                  class="bean-routines-chip-select"
                  value={String(everyMinutes(draft))}
                  onChange={(e) => setWatch({ ...draft.watch!, everyMinutes: Number((e.target as HTMLSelectElement).value) })}
                >
                  {[...new Set([...WATCH_MINUTES, everyMinutes(draft)])].sort((a, b) => a - b).map((m) => <option key={m} value={String(m)}>{intervalText(m)}</option>)}
                </select>{" "}
                <select
                  class="bean-routines-chip-select"
                  value={draft.watch.window ? "between" : "any"}
                  onChange={(e) => setWatchWindow((e.target as HTMLSelectElement).value === "between" ? { from: "09:00", to: "17:00" } : undefined)}
                >
                  <option value="any">any time</option>
                  <option value="between">between</option>
                </select>{" "}
                {draft.watch.window ? (
                  <>
                    <input
                      class="bean-input bean-input--boxed"
                      type="time"
                      aria-label="Window start"
                      required
                      value={draft.watch.window.from}
                      onChange={(e) => {
                        const from = (e.target as HTMLInputElement).value;
                        if (from) setWatchWindow({ ...draft.watch!.window!, from });
                      }}
                    />{" – "}
                    <input
                      class="bean-input bean-input--boxed"
                      type="time"
                      aria-label="Window end (blank = midnight)"
                      value={draft.watch.window.to ?? ""}
                      onChange={(e) => {
                        const to = (e.target as HTMLInputElement).value;
                        setWatchWindow({ from: draft.watch!.window!.from, ...(to ? { to } : {}) });
                      }}
                    />{" "}
                  </>
                ) : null}
                and {notifyOnly ? "notify me" : "queue each new item"}.
              </div>
              {draft.watch.kind === "command" ? (
                <textarea
                  class="bean-routines-watch-command"
                  spellcheck={false}
                  placeholder={'gh search prs --review-requested=@me --state=open --json url,title --jq \'.[] | {id: .url, text: "\\(.url) \\(.title)"}\''}
                  value={draft.watch.command}
                  onInput={(e) => setWatch({ ...(draft.watch as Extract<RoutineWatch, { kind: "command" }>), command: (e.target as HTMLTextAreaElement).value })}
                />
              ) : (
                <input
                  class="bean-input bean-input--boxed bean-routines-watch-url"
                  type="url"
                  placeholder="https://www.youtube.com/feeds/videos.xml?channel_id=UC…"
                  value={draft.watch.url}
                  onInput={(e) => setWatch({ ...(draft.watch as Extract<RoutineWatch, { kind: "feed" }>), url: (e.target as HTMLInputElement).value })}
                />
              )}
              {status ? (
                <div class="bean-routines-cadence-meta">
                  <span class={`bean-routines-next bean-routines-next--${status.tone}`}>
                    <span class="bean-routines-next-dot" />{status.text}
                  </span>
                  {savedRoutine?.watch && savedRoutine.enabled ? (
                    <button type="button" class="bean-btn bean-btn--ghost bean-routines-check" disabled={checking} onClick={() => void checkNow()}>
                      {checking ? "Checking…" : "Check now"}
                    </button>
                  ) : null}
                  {notice ? <span class="bean-routines-section-note">{notice}</span> : null}
                </div>
              ) : null}
              {status?.detail ? <div class={`bean-routines-watch-error bean-routines-watch-error--${status.tone}`}>{status.detail}</div> : null}
              {draft.watch.window ? (
                <span class="bean-routines-section-note">Times are this Mac's local time. Changing the window doesn't re-seed.</span>
              ) : null}
              {windowTooShortNote(draft) ? <span class="bean-routines-section-note">{windowTooShortNote(draft)}</span> : null}
              <span class="bean-routines-section-note">
                Editing the {draft.watch.kind === "command" ? "command" : "feed URL"} re-seeds — what's there now won't fire.
              </span>
            </>
          ) : (
            <>
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
            </>
          )}
        </div>

        <div class="bean-routines-divider" />

        <div class="bean-skills-projects">
          <div class="bean-routines-section-head">
            <div class="bean-field-label">TYPE</div>
          </div>
          {draft.watch ? (
            <div class="bean-routines-type-row">
              <div class="bean-routines-type-buttons">
                <button
                  type="button"
                  class={`bean-btn bean-btn--ghost bean-routines-type-btn${notifyOnly ? " bean-routines-type-btn--on" : ""}`}
                  onClick={() => setWatchNotifyOnly(true)}
                >Just notify me</button>
                <button
                  type="button"
                  class={`bean-btn bean-btn--ghost bean-routines-type-btn${notifyOnly ? "" : " bean-routines-type-btn--on"}`}
                  onClick={() => setWatchNotifyOnly(false)}
                >⚡ Run steps on each new item</button>
              </div>
              <span class="bean-routines-section-note">
                {notifyOnly
                  ? "each new item goes straight to the sinks below — no model, no steps"
                  : "each new item is queued as a todo and runs the steps below"}
              </span>
            </div>
          ) : (
          <div class="bean-routines-type-row">
            <div class="bean-routines-type-buttons">
              <button
                type="button"
                class={`bean-btn bean-btn--ghost bean-routines-type-btn${draft.todoDriven ? "" : " bean-routines-type-btn--on"}`}
                onClick={() => void setTodoDriven(false)}
              >Always runs</button>
              <button
                type="button"
                class={`bean-btn bean-btn--ghost bean-routines-type-btn${draft.todoDriven ? " bean-routines-type-btn--on" : ""}`}
                onClick={() => void setTodoDriven(true)}
              >⚡ Todo-driven</button>
            </div>
            <span class="bean-routines-section-note">
              {draft.todoDriven
                ? "runs the steps below on each queued todo — skips the run when the queue is empty"
                : "runs the steps below on every scheduled fire"}
            </span>
          </div>
          )}
        </div>

        {draft.todoDriven && !selected ? (
          // Queue needs a saved routine name to attach todos to (Task 8's original design) —
          // but showing nothing here is indistinguishable from the feature being missing
          // (reported: "there isn't a place I can add any todo items"). Say why instead.
          <div class="bean-skills-projects">
            <div class="bean-routines-section-head">
              <div class="bean-field-label">QUEUE</div>
            </div>
            <span class="bean-routines-section-note">Save this routine to start queuing todos.</span>
          </div>
        ) : null}

        {draft.todoDriven && selected ? (
          <div class="bean-skills-projects">
            <div class="bean-routines-section-head">
              <div class="bean-field-label">QUEUE</div>
              <span class="bean-routines-section-note">
                {draft.watch
                  ? "the watch fills this — you can still add by hand"
                  : "a backlog you fill — each pending item runs through the steps below"}
              </span>
            </div>
            <div class="bean-routines-queue-meta">
              {pendingCount} pending{draft.watch ? "" : " · gates this routine"}
            </div>
            {(() => {
              // Reorder targets: pending items already arrive order-ASC from todosList, so this
              // is the drag-drop sequence as-is — no re-sort.
              const pendingOrdered = todos.filter((t) => t.status === "pending");
              // Same splice-and-reassign shape as reorderStep, generalized to any drag distance
              // (not just adjacent swaps) and persisted: after splicing the dragged id into its
              // drop position, re-assign each pending item's `order` from the existing ascending
              // sequence by position — no new integers needed, no collision risk.
              const reorderTodoDrag = (fromId: string, toId: string): void => {
                if (fromId === toId) return;
                const ids = pendingOrdered.map((t) => t.id);
                const fromIdx = ids.indexOf(fromId);
                const toIdx = ids.indexOf(toId);
                if (fromIdx < 0 || toIdx < 0) return;
                const reordered = [...ids];
                const [moved] = reordered.splice(fromIdx, 1);
                reordered.splice(toIdx, 0, moved!);
                const orderValues = pendingOrdered.map((t) => t.order); // already ascending
                void Promise.all(reordered.map((id, idx) => window.bean.todosReorder(id, orderValues[idx]!)))
                  .then(refreshTodos)
                  .catch((e) => setError(ipcErrorMessage(e) ?? "couldn't reorder the queue"));
              };
              return [...todos]
                .sort((a, b) => Number(a.status === "done" || a.status === "failed") - Number(b.status === "done" || b.status === "failed"))
                .map((t) => {
                  const editing = editingId === t.id;
                  const isPending = t.status === "pending";
                  const commitEdit = (): void => {
                    const text = editText.trim();
                    if (!text) return;
                    void window.bean.todosEdit(t.id, text)
                      .then(() => { setEditingId(null); void refreshTodos(); })
                      .catch((e) => setError(ipcErrorMessage(e) ?? "couldn't save the edit"));
                  };
                  return (
                    <div
                      key={t.id}
                      class={`bean-routines-todo bean-routines-todo--${t.status}${todoDragId === t.id ? " bean-routines-todo--dragging" : ""}${todoOverId === t.id && todoDragId !== null && todoDragId !== t.id ? " bean-routines-todo--drop" : ""}`}
                      onDragOver={(e) => { if (todoDragId !== null && isPending) { e.preventDefault(); setTodoOverId(t.id); } }}
                      onDragLeave={() => setTodoOverId((v) => (v === t.id ? null : v))}
                      onDrop={(e) => { e.preventDefault(); if (todoDragId !== null) reorderTodoDrag(todoDragId, t.id); setTodoDragId(null); setTodoOverId(null); }}
                    >
                      {editing ? (
                        <input
                          class="bean-input bean-input--boxed"
                          value={editText}
                          onInput={(e) => setEditText((e.target as HTMLInputElement).value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitEdit();
                            else if (e.key === "Escape") setEditingId(null);
                          }}
                        />
                      ) : (
                        <span class="bean-routines-todo-text">{t.text}</span>
                      )}
                      <span class="bean-routines-todo-chip">{t.status === "running" ? "running now" : t.status}</span>
                      {!editing && t.status === "failed" ? (
                        <button
                          type="button"
                          class="bean-skills-delete-link"
                          title={t.resultSummary}
                          onClick={() => void window.bean.todosRetry(t.id).then(refreshTodos)
                            .catch((e) => setError(ipcErrorMessage(e) ?? "couldn't retry the todo"))}
                        >Retry</button>
                      ) : null}
                      {!editing && isPending ? (
                        <>
                          <button
                            type="button"
                            class="bean-routines-todo-link"
                            onClick={() => { setEditingId(t.id); setEditText(t.text); }}
                          >Edit</button>
                          <button
                            type="button"
                            class="bean-skills-delete-link"
                            onClick={() => void window.bean.todosDelete(t.id).then(refreshTodos)
                              .catch((e) => setError(ipcErrorMessage(e) ?? "couldn't remove the todo"))}
                          >Remove</button>
                          <span
                            class="bean-routines-handle"
                            title="Drag to reorder"
                            draggable
                            onDragStart={(e) => { setTodoDragId(t.id); e.dataTransfer?.setData("text/plain", t.id); }}
                            onDragEnd={() => { setTodoDragId(null); setTodoOverId(null); }}
                          >⠿</span>
                        </>
                      ) : null}
                    </div>
                  );
                });
            })()}
            <div class="bean-routines-todo-add">
              <input
                class="bean-input bean-routines-todo-add-input"
                placeholder="+ Queue a todo"
                value={newTodo}
                onInput={(e) => setNewTodo((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newTodo.trim() && selected) {
                    void window.bean.todosAdd(selected, newTodo)
                      .then(() => { setNewTodo(""); void refreshTodos(); })
                      .catch((e2) => setError(e2 instanceof Error ? e2.message : "couldn't queue the todo"));
                  }
                }}
              />
            </div>
            {todos.some((t) => t.status === "done" || t.status === "failed") ? (
              <button
                type="button"
                class="bean-skills-delete-link"
                onClick={() => { if (selected) void window.bean.todosClearFinished(selected).then(refreshTodos)
                  .catch((e) => setError(ipcErrorMessage(e) ?? "couldn't clear finished todos")); }}
              >Clear finished</button>
            ) : null}
          </div>
        ) : null}

        {notifyOnly ? null : (
        <>
        <div class="bean-routines-divider" />

        <div class="bean-skills-projects">
          <div class="bean-routines-section-head">
            <div class="bean-field-label">WHAT BEAN DOES</div>
            <span class="bean-routines-section-note">
              {draft.steps.length} step{draft.steps.length === 1 ? "" : "s"}
              {draft.watch ? " · run in order on each new item" : draft.todoDriven ? " · run in order on each queued todo · one digest at the end" : " · run in order · one digest at the end"}
            </span>
          </div>
          <StepsEditor
            steps={draft.steps}
            onSteps={(steps) => setDraft({ ...draft, steps })}
            skills={enabledSkills}
            projects={projects}
            clis={clis}
            models={models}
            {...(draft.watch ? { addHint: "— runs on each new item, in order" } : {})}
          />
        </div>
        </>
        )}

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
          {selected && !notifyOnly ? (
            <>
              <button
                type="button"
                class="bean-btn bean-btn--ghost"
                disabled={isRunningSelected || checking || (emptyTodoQueue && !(checkInsteadOfRun && savedRoutine?.enabled))}
                onClick={() => void (checkInsteadOfRun ? checkNow() : runNow())}
              >
                {checking ? "Checking…" : isRunningSelected ? "Running…" : "Run now"}
              </button>
              {runNowNote ? <span class="bean-routines-section-note">{runNowNote}</span> : null}
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
            {selectedState.history.slice(0, HISTORY_SHOWN).map((h, i) => (
              <details key={i} class="bean-routines-history-entry">
                <summary>{h.status} · {new Date(h.finishedAt).toLocaleString()}</summary>
                <pre class="bean-routines-history-digest">{h.digest}</pre>
              </details>
            ))}
            {selectedState.history.length > HISTORY_SHOWN ? (
              <span class="bean-routines-section-note">
                {selectedState.history.length - HISTORY_SHOWN === 1
                  ? "1 older run — read it in the Dashboard."
                  : `${selectedState.history.length - HISTORY_SHOWN} older runs — read them in the Dashboard.`}
              </span>
            ) : null}
          </div>
        ) : null}
        </>
        )}
      </div>
    </div>
  );
}
