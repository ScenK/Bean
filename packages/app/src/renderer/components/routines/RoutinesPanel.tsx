import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { Routine, RoutineBrief, RoutineChatopsSink, RoutineWatch, Skill, Project, TodoItem, WatchWindow } from "@bean/core";
import { nextRun, parseCron } from "@bean/core/cron";
import { watchWindowText } from "@bean/core/watch-window";
import { sproutTriggerAction } from "@bean/core/sprout-trigger";
import { PanelEmptyState } from "../../shared/PanelEmptyState.js";
import { ListFoldToggle, useListFold } from "../../shared/ListFold.js";
import { useCliAvailability } from "../../shared/cli-availability.js";
import { useCapabilities } from "../../shared/capabilities.js";
import { usePersonaName } from "../../shared/persona-name.js";
import type { RoutineStateView, RoutineBuildView, DestinationView } from "@bean/host";
import { StepsEditor } from "./StepsEditor.js";
import { chatTargets, cleanChatSinks, isDmSink } from "./chat-sinks.js";
import { DestinationPicker } from "./DestinationPicker.js";
import { stepProblemsText } from "./step-ids.js";
import { BuildPane, DescribePane, ExampleChips, ReviewPane, buildElapsed, ipcErrorMessage } from "./RoutineBuilder.js";
import { ARCHIVED, NEEDS_FIXING, derivedSectionLabel, folderName, isListedUnder, sproutSections, toggleListedUnder, type SproutRow } from "./sprout-sections.js";
import { everyMinutes, failureCount, intervalText, needsReview, WATCH_MINUTES, watchRowSub, watchStatusLine, windowTooShortNote } from "./watch-status.js";

const DOW_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pad2 = (n: number): string => String(n).padStart(2, "0");


// The Ends picker's value: a bare date as is, a date-time (a done ending) as its local day.
const untilDateValue = (until: string | undefined): string => {
  if (!until) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(until)) return until;
  const d = new Date(until);
  return Number.isNaN(d.getTime()) ? "" : `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};

// Which sprouts have ended, and which of those are archived — a change means the definitions moved.
const endedKeyOf = (st: Record<string, RoutineStateView>): string =>
  Object.keys(st).filter((n) => st[n]?.ended).sort().map((n) => `${n}:${st[n]!.ended!.archived}`).join("\n");

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
  const last = state?.history[0]?.status;
  if (state?.missed || (last && last !== "ok")) return "failed"; // needs-attention reds too
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

// Folded list sections by key (project path, "" = Scratch, NEEDS_FIXING) — a renderer view pref
// (pattern: NotesPanel). Absent or unreadable = everything open, except ARCHIVED, which is folded
// by default: its key in the list means *open*.
const FOLDED_SECTIONS_KEY = "bean.routines.foldedSections";
function loadFoldedSections(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(FOLDED_SECTIONS_KEY) ?? "null") as unknown;
    if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === "string");
  } catch { /* fall through to the default */ }
  return [];
}

// 1a "Routine as a recipe": list rail on the left, a recipe-style editor on the right —
// cadence reads as a sentence, the fan-out is a numbered timeline of delegate steps.
export function RoutinesPanel() {
  const beanName = usePersonaName(); // the main conversation's name (#1001)
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
  // Save button feedback, like Settings' Save: "Saving…" while in flight, "Saved ✓" until the next edit.
  const [saving, setSaving] = useState(false);
  const [savedName, setSavedName] = useState<string | undefined>(undefined);
  // Catalogs that back the per-step skill / project / model pickers (same sources the
  // ProposalCard/DelegateCard chips use).
  const [skills, setSkills] = useState<Skill[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  // Named chat destinations for the sink pickers (Settings → ChatOps owns naming them).
  const [chatDestinations, setChatDestinations] = useState<DestinationView[]>([]);
  const reloadDestinations = async (): Promise<void> => {
    setChatDestinations(await window.bean.destinationsList().catch(() => []));
  };
  const { clis, models } = useCliAvailability();
  // A remote core lends this list read-only (its writes stay local), so no Restore there.
  const remoteCore = useCapabilities().host !== undefined;
  const [triggering, setTriggering] = useState(false);
  // The sprout whose Stop was clicked; "Stopping…" until its runs are gone.
  const [stopping, setStopping] = useState<string | undefined>(undefined);
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
  const [foldedSections, setFoldedSections] = useState<string[]>(loadFoldedSections);
  // "Pick projects…" on a Needs fixing row: once that sprout's editor is up, scroll to Listed under.
  const [pickFor, setPickFor] = useState<string | undefined>(undefined);
  // Restore on an ended sprout: once its editor is up, the draft turns back on with no end date.
  const [restoreFor, setRestoreFor] = useState<string | undefined>(undefined);

  const endedKey = useRef("");
  const refresh = async (): Promise<void> => {
    const [list, st, bs] = await Promise.all([window.bean.routinesList(), window.bean.routinesState(), window.bean.routinesBuilds()]);
    setRoutines(list);
    endedKey.current = endedKeyOf(st);
    setStates(st);
    setBuilds(bs);
  };

  const refreshTodos = async (): Promise<void> => {
    setTodos(selected && draft.todoDriven ? await window.bean.todosList(selected) : []);
  };

  useEffect(() => { void refresh(); void reloadDestinations(); }, []);
  useEffect(() => {
    void Promise.all([window.bean.listSkills(), window.bean.listProjects()])
      .then(([sk, pr]) => { setSkills(sk); setProjects(pr); });
  }, []);
  useEffect(() => {
    // Piggyback on the same 5s poll so "running now" chips update live while a todo-driven
    // routine is open.
    const t = setInterval(() => {
      void window.bean.routinesState().then((st) => {
        setStates(st);
        // A sprout that ended (or came back) since the last read: re-read the definitions too, so an
        // open editor isn't holding the pre-ending copy (Save would send its old `enabled`/`until`).
        const key = endedKeyOf(st);
        if (key !== endedKey.current) { endedKey.current = key; void refresh(); }
      });
      void refreshTodos();
    }, 5000);
    return () => clearInterval(t);
  }, [selected, draft.todoDriven]);
  // A Stop's "Stopping…" ends once that sprout has no live runs left.
  useEffect(() => {
    if (stopping && !states[stopping]?.runningCount) setStopping(undefined);
  }, [states, stopping]);
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
  // The draft's baseline: the copy it was loaded from, or what this panel itself just saved — so the
  // refresh after an own save takes the saved copy whole, while edits made since still count.
  const loaded = useRef<{ name?: string; json: string }>({ json: "" });
  const markSaved = (d: Routine): void => { loaded.current = { name: d.name, json: JSON.stringify(d) }; };
  useEffect(() => {
    if (!selected) return;
    const saved = routines.find((r) => r.name === selected);
    const prev = loaded.current;
    loaded.current = { name: selected, json: savedJson };
    // Unsaved edits when the core moves this sprout (an ending, a flip elsewhere): keep them and
    // take only its switch and end, so Save can't send the pre-ending ones.
    if (saved && prev.name === selected && JSON.stringify(draft) !== prev.json) {
      const { until: _until, ...rest } = draft;
      setDraft({ ...rest, ...(saved.until !== undefined ? { until: saved.until } : {}), enabled: saved.enabled });
      return;
    }
    setDraft(saved ?? emptyRoutine());
    setError("");
    setNotice("");
    setCustomCron(false);
  }, [selected, savedJson]);
  // After the reset just above, so the restored draft wins. Saving it re-enables through the host's
  // restore path (a watch re-seeds from now, a schedule restarts from now).
  useEffect(() => {
    if (!restoreFor || restoreFor !== selected) return;
    setRestoreFor(undefined);
    const saved = routines.find((r) => r.name === selected);
    if (!saved) return;
    // From this sprout's own editor: keep its unsaved edits. From another row: its saved copy.
    const { until: _until, ...rest } = draft.name === selected ? draft : saved;
    setDraft({ ...rest, enabled: true });
  }, [restoreFor, selected, savedJson]);
  useEffect(() => { void refreshTodos(); }, [selected, draft.todoDriven]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? routines.filter((r) => r.name.toLowerCase().includes(q) || (r.description ?? "").toLowerCase().includes(q))
      : routines;
    // Enabled routines first, paused sink to the bottom (dimmed), original order otherwise.
    return [...list].sort((a, b) => Number(b.enabled) - Number(a.enabled));
  }, [routines, query]);
  // `listSkills` omits hidden skills, so a step naming one reads as missing here (as in the steps editor).
  // Archived is the core's call (core time), so a remote shell lists exactly what the core does.
  const archivedKey = Object.keys(states).filter((n) => states[n]?.ended?.archived).sort().join("\n");
  const sections = useMemo(
    () => sproutSections(
      filtered, projects, new Set(skills.map((s) => s.name)), new Set(archivedKey ? archivedKey.split("\n") : []),
      new Set(skills.filter((s) => s.enabled === false).map((s) => s.name)),
    ),
    [filtered, projects, skills, archivedKey],
  );
  const setSectionFolded = (key: string, folded: boolean): void => {
    setFoldedSections((prev) => {
      if (prev.includes(key) === folded) return prev;
      const next = folded ? [...prev, key] : prev.filter((k) => k !== key);
      try { localStorage.setItem(FOLDED_SECTIONS_KEY, JSON.stringify(next)); } catch { /* private mode / quota: fold still works this session */ }
      return next;
    });
  };
  useEffect(() => {
    if (!pickFor || pickFor !== selected) return;
    setPickFor(undefined);
    document.querySelector(".bean-routines-listed")?.scrollIntoView({ block: "center" });
  }, [pickFor, selected]);

  const select = (name: string): void => {
    setSelected(name); setCreating(false); setDescribing(false); setSelectedBuild(undefined); setEditorFor(undefined); setError("");
  };
  // Listed under lives in the editor, so a needs-review sprout skips its review card here.
  const pickProjects = (name: string): void => { select(name); setEditorFor(name); setPickFor(name); };
  const restore = (name: string): void => { select(name); setEditorFor(name); setRestoreFor(name); };
  // Re-read the registry right before appending, so a project added elsewhere since this window
  // loaded isn't overwritten.
  const registerFolder = async (folder: string): Promise<void> => {
    if (!confirm(`Register ${folder} as a project?\n\nChat members who can start runs will be able to start runs in this folder.`)) return;
    try {
      const fresh = await window.bean.listProjects();
      const next = fresh.some((p) => p.path === folder) ? fresh : [...fresh, { name: folderName(folder), path: folder }];
      if (next !== fresh) await window.bean.saveProjects(next);
      setProjects(next);
    } catch (e) {
      setError(ipcErrorMessage(e) ?? "couldn't register the folder");
    }
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

  // maxParallel only means something on a todo-driven sprout — it goes when todo-driven does.
  const dropParallel = ({ maxParallel: _mp, ...rest }: Routine): Routine => rest;

  // Trigger: Schedule XOR Watch (cron and watch are mutually exclusive in the saved JSON).
  const setTrigger = (kind: "schedule" | "watch"): void => {
    if (kind === "watch" && !draft.watch) {
      const { cron: _cron, ...rest } = draft.steps.length > 0 ? draft : dropParallel(draft);
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
      ? { ...dropParallel(draft), steps: [], todoDriven: undefined }
      : { ...draft, steps: draft.steps.length > 0 ? draft.steps : [{ kind: "chat", instruction: "" }], todoDriven: true });

  // The editor holds a Restore (an ended sprout's draft switched back on) until Save sprout.
  const restoring = Boolean(selected && states[selected]?.ended && draft.enabled);

  const toggleEnabled = async (r: Routine): Promise<void> => {
    try {
      await window.bean.routinesSave({ ...r, enabled: !r.enabled });
    } catch (e) {
      // An ended sprout refuses a bare flip — it needs a later end date (Restore).
      select(r.name);
      setError(ipcErrorMessage(e) ?? "couldn't change it");
    }
    await refresh();
  };

  // The detail header's toggle mirrors the list-row pill, but for an existing routine it must
  // persist right away too — otherwise the next poll's refresh() overwrites the local draft
  // with the still-disabled saved copy and the flip silently reverts.
  const toggleDraftEnabled = async (): Promise<void> => {
    // Switching off a Restore in progress just drops it: the saved sprout is still ended.
    const saved = routines.find((r) => r.name === selected);
    if (saved && restoring) { setDraft(saved); return; }
    const next = { ...draft, enabled: !draft.enabled };
    setDraft(next);
    if (selected) {
      try {
        await window.bean.routinesSave({ ...next, sinks: cleanChatSinks(next.sinks) });
        markSaved(next);
      } catch (e) {
        setDraft(draft);
        setError(ipcErrorMessage(e) ?? "couldn't change it");
      }
      await refresh();
    }
  };

  // Same reasoning as toggleDraftEnabled just above: for an already-saved routine, flipping
  // TYPE must persist right away. The Queue section (and its add/edit/reorder calls) is gated
  // on the local draft's todoDriven, but the backend validates todo actions against the
  // on-disk routine — so without this, the queue appears to work but every action against it
  // fails silently until "Save routine" is clicked.
  const setTodoDriven = async (on: boolean): Promise<void> => {
    const next = on ? { ...draft, todoDriven: true } : { ...dropParallel(draft), todoDriven: undefined };
    setDraft(next);
    // A Restore in progress saves with Save sprout, not here (that would turn it back on early).
    if (selected && !restoring) {
      try {
        await window.bean.routinesSave({ ...next, sinks: cleanChatSinks(next.sinks) });
        markSaved(next);
        await refresh();
      } catch (e) {
        setError(ipcErrorMessage(e) ?? "couldn't save the type change");
      }
    }
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    setSavedName(undefined);
    try {
      await window.bean.routinesSave({ ...draft, sinks: cleanChatSinks(draft.sinks) });
      markSaved(draft);
      setError("");
      await refresh();
      setSelected(draft.name);
      setCreating(false);
      setSavedName(draft.name);
    } catch (e) {
      setError(ipcErrorMessage(e) ?? "save failed — check name, cadence, and steps");
    } finally {
      setSaving(false);
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

  const stopRuns = async (): Promise<void> => {
    if (!selected) return;
    setStopping(selected);
    await window.bean.routineStop(selected);
    await refresh();
  };

  const remove = async (): Promise<void> => {
    if (!selected) return;
    if (!confirm(`${needsReview(draft, states[selected]) ? "Discard" : "Delete"} sprout "${selected}"?`)) return;
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
  const chatTargetList = chatTargets(draft.sinks.chatops);
  const stepless = draft.steps.length === 0;
  // Inert on a notify-only watch (deliverDigest ignores it there), so the footer doesn't claim it.
  const quiet = chatTargetList.length > 0 && draft.sinks.chatopsOnlyOnProblems === true && !(draft.watch && stepless);
  // The chat brief sums up only ok runs with steps: never under only-on-problems, never stepless.
  const brief = chatTargetList.length > 0 && !draft.sinks.chatopsVerbatim && !quiet && !stepless;
  if (quiet) sinkTargets.push(`${chatTargetList.join(" and ")} only when a run needs you`);
  else if (!brief) sinkTargets.push(...chatTargetList);
  // No chat sink left = the only-on-problems and verbatim rules have nothing to govern; drop them.
  const setChatops = (chatops: RoutineChatopsSink[]): void => {
    const { chatops: _c, chatopsOnlyOnProblems: _q, chatopsVerbatim: _v, ...rest } = draft.sinks;
    setDraft({ ...draft, sinks: chatops.length > 0 ? { ...draft.sinks, chatops } : rest });
  };
  if (draft.sinks.notify) sinkTargets.push("a desktop notification");
  // Home always gets the brief (chatopsVerbatim and only-on-problems are chatops-only), except a
  // stepless run, which has nothing to brief and posts the digest.
  const briefTargets = brief ? [...chatTargetList] : [];
  if (draft.sinks.home) (stepless ? sinkTargets : briefTargets).push(`your chat with ${beanName}`);

  const routineRow = (sectionKey: string, { routine: r, also, problems }: SproutRow) => sectionKey === ARCHIVED ? (
    <div
      key={`${sectionKey}:${r.name}`}
      class={`bean-skills-row bean-routines-row bean-routines-row--off${selected === r.name ? " bean-skills-row--selected" : ""}`}
      onClick={() => select(r.name)}
    >
      <div class="bean-skills-row-main">
        <div class="bean-skills-row-name">{r.name}</div>
        {r.description ? <div class="bean-routines-row-sub" title={r.description}>{r.description}</div> : null}
        <div class="bean-routines-row-sub">{states[r.name]?.ended?.text}</div>
        {remoteCore ? null : (
          <div class="bean-routines-fix">
            <button type="button" class="bean-routines-todo-link bean-routines-fix-btn" onClick={(e) => { e.stopPropagation(); restore(r.name); }}>Restore</button>
          </div>
        )}
      </div>
    </div>
  ) : (
    <div
      key={`${sectionKey}:${r.name}`}
      class={`bean-skills-row bean-routines-row${r.enabled ? "" : " bean-routines-row--off"}${needsReview(r, states[r.name]) ? " bean-routines-row--review" : ""}${selected === r.name ? " bean-skills-row--selected" : ""}`}
      onClick={() => select(r.name)}
    >
      <button
        type="button"
        class={`bean-skills-pill${r.enabled ? " bean-skills-pill--on" : ""}`}
        title={r.enabled ? "Runs automatically — click to pause" : r.watch ? "Paused — click to enable" : "On demand — click to run on its schedule"}
        // A needs-review watch enables from its review card (re-check + seed), not a bare flip.
        onClick={(e) => { e.stopPropagation(); if (needsReview(r, states[r.name])) select(r.name); else void toggleEnabled(r); }}
      >
        <span class="bean-skills-pill-knob" />
      </button>
      <div class="bean-skills-row-main">
        <div class="bean-skills-row-name">{r.name}</div>
        <div class="bean-routines-row-sub">
          {states[r.name]?.ended ? (
            <span>{states[r.name]!.ended!.text}</span>
          ) : r.watch ? (
            <span class={watchRowSub(r, states[r.name]).bad ? "bean-routines-row-sub--bad" : undefined}>{watchRowSub(r, states[r.name]).text}</span>
          ) : (
            <>
              {/* A disabled schedule sprout runs only when started (chat card, Run now): on demand. */}
              {r.enabled ? humanCadence(r.cron ?? "") : "On demand"} · {r.steps.length} step{r.steps.length === 1 ? "" : "s"}
              {r.todoDriven ? " · ⚡ todo-driven" : ""}
            </>
          )}
          {problems.filter((p) => p.kind === "missing-skill").map((p) => (
            <span key={`skill${p.step}`} class="bean-routines-row-note"> · step {p.step} skill not found</span>
          ))}
          {problems.filter((p) => p.kind === "disabled-skill").map((p) => (
            <span key={`off${p.step}`} class="bean-routines-row-note"> · step {p.step} skill switched off</span>
          ))}
        </div>
        {also.length > 0 ? <div class="bean-routines-row-sub bean-routines-row-note">also: {also.join(", ")}</div> : null}
        {sectionKey === NEEDS_FIXING ? (
          <div class="bean-routines-fix">
            {[...new Map(problems.flatMap((p) => (p.kind === "unregistered-folder" || p.kind === "ancestor-folder" ? [[p.folder, p] as const] : []))).values()].map((p) => (
              <div key={p.folder} class="bean-routines-fix-line">
                <span class="bean-routines-fix-text">Starts in <code>{p.folder}</code> — not a project</span>
                {p.kind === "unregistered-folder" ? (
                  <button type="button" class="bean-routines-todo-link bean-routines-fix-btn" onClick={(e) => { e.stopPropagation(); void registerFolder(p.folder); }}>Register folder</button>
                ) : null}
              </div>
            ))}
            <button type="button" class="bean-routines-todo-link bean-routines-fix-btn" onClick={(e) => { e.stopPropagation(); pickProjects(r.name); }}>Pick projects…</button>
          </div>
        ) : null}
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
  const ended = selectedState?.ended;
  const savedRoutine = selected ? routines.find((r) => r.name === selected) : undefined;
  // Any edit after the save makes the draft differ from disk, so the button reverts by itself.
  const justSaved = savedName !== undefined && savedName === selected && JSON.stringify(draft) === savedJson;
  const reviewing = Boolean(savedRoutine && needsReview(savedRoutine, selectedState) && editorFor !== selected);
  const buildView = selectedBuild ? builds.find((b) => b.name === selectedBuild) : undefined;
  const notifyOnly = Boolean(draft.watch) && draft.steps.length === 0;
  // Enable warns: a pinned harness/model this Mac can't run fails the unattended run.
  const stepProblems = stepProblemsText(draft.steps, clis, models);
  const status = draft.watch ? watchStatusLine(savedRoutine?.watch ? savedRoutine : draft, selectedState, new Date()) : undefined;
  // Slots come from the saved definition — that's what the scheduler runs.
  const slots = savedRoutine?.todoDriven ? savedRoutine.maxParallel ?? 1 : 1;
  const runningCount = selectedState?.runningCount ?? 0;
  // Parallel sprouts take Run now until every slot is busy; one-at-a-time ones while anything runs.
  // Not `triggering` for parallel: routinesRunNow resolves only when its drain ends, and a click
  // at full just comes back "N/N running".
  const isRunningSelected = slots > 1 ? runningCount >= slots : triggering || Boolean(selectedState?.running);
  const slotsText = `${runningCount}/${slots} running`;
  const isStopping = stopping !== undefined && stopping === selected && runningCount > 0;
  const pendingCount = todos.filter((t) => t.status === "pending").length;
  const emptyTodoQueue = Boolean(draft.todoDriven) && pendingCount === 0;
  // A saved watch with steps and nothing queued: Run now checks the watch instead (ignoring
  // its window), and anything new drains through the queue.
  // Keyed on the saved definition: Check now runs against it, not the unsaved draft.
  // The shared run-vs-check rule (sproutTriggerAction); notify-only watches have no Run now button.
  const checkInsteadOfRun = emptyTodoQueue && Boolean(savedRoutine && savedRoutine.steps.length > 0
    && sproutTriggerAction(savedRoutine, pendingCount) === "check");
  const savedWindow = savedRoutine?.watch?.window;
  const runNowNote = slots > 1 && runningCount >= slots ? slotsText
    : !emptyTodoQueue ? undefined
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
            placeholder="Search sprouts"
            value={query}
            onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
          />
        </div>
        <div class="bean-skills-list-label">Your sprouts · {routines.length}</div>
        {describing ? (
          <div class="bean-skills-row bean-routines-row bean-routines-row--build bean-skills-row--selected">
            <span class="bean-skills-pill"><span class="bean-skills-pill-knob" /></span>
            <div class="bean-skills-row-main">
              <div class="bean-skills-row-name">New sprout</div>
              <div class="bean-routines-row-sub">{drafting ? "drafting…" : "describe it"}</div>
            </div>
          </div>
        ) : null}
        {builds.map(buildRow)}
        {routines.length === 0 && builds.length === 0 && !describing ? (
          <div class="bean-panel-empty">No sprouts yet — set up something Bean should run on its own.</div>
        ) : filtered.length === 0 ? (
          <div class="bean-panel-empty">No sprouts match "{query}".</div>
        ) : (
          sections.map((sec) => {
            // A live query opens every section with a hit (empty ones are already gone) and locks
            // folding meanwhile; the stored state returns when the query clears.
            const searching = query.trim() !== "";
            const open = searching || (sec.key === ARCHIVED) === foldedSections.includes(sec.key);
            return (
              <div key={sec.key} class="bean-routines-section" data-section={sec.key}>
                <button
                  type="button"
                  class="bean-skills-list-label bean-skills-list-label--toggle bean-notes-group"
                  aria-expanded={open}
                  disabled={searching}
                  title={searching ? "Clear the search to fold sections" : undefined}
                  onClick={() => setSectionFolded(sec.key, sec.key === ARCHIVED ? !open : open)}
                >
                  <span class="bean-notes-group-caret">{open ? "\u25be" : "\u25b8"}</span>
                  {sec.label}
                  <span class="bean-notes-group-count">{sec.rows.length}</span>
                </button>
                {open ? sec.rows.map((row) => routineRow(sec.key, row)) : null}
              </div>
            );
          })
        )}
        <span class="bean-skills-spacer" />
        <button type="button" class="bean-routines-new" onClick={startNew}>＋ New sprout</button>
        <div class="bean-skills-path">Saved as ~/.bean/routines/*.json · runs via the scheduler</div>
      </div>

      <div class="bean-skills-detail">
        {describing ? (
          <DescribePane
            initial={briefSeed}
            taken={routines.map((r) => r.name)}
            skills={skills}
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
            clis={clis}
            models={models}
            projects={projects}
            onDiscard={() => void remove()}
            onOpenEditor={() => setEditorFor(savedRoutine.name)}
            onEnabled={(note) => { void refresh().then(() => { setEditorFor(savedRoutine.name); setNotice(note); }); }}
          />
        ) : !selected && !creating ? (
          <PanelEmptyState message="Select a sprout to view it, or set up a new one.">
            <ExampleChips taken={routines.map((r) => r.name)} onPick={openDraftInEditor} onBlank={startBlank} />
          </PanelEmptyState>
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
                    placeholder="sprout-name"
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
            {projects.length > 0 ? (
              <div class="bean-routines-listed">
                <div class="bean-field-label">LISTED UNDER</div>
                <div class="bean-routines-listed-chips">
                  {projects.map((p) => {
                    const on = isListedUnder(draft, p.path);
                    return (
                      <button key={p.path} type="button" class={`bean-rb-chip${on ? " bean-rb-chip--on" : ""}`} aria-pressed={on} title={p.path}
                        onClick={() => setDraft(toggleListedUnder(draft, p.path))}>{p.name}</button>
                    );
                  })}
                  {projects.some((p) => isListedUnder(draft, p.path)) ? null : (
                    <span class="bean-routines-section-note">Follows its steps → {derivedSectionLabel(draft, projects)}</span>
                  )}
                </div>
                <span class="bean-routines-section-note">Only where this sprout appears in lists. Each step still starts in the folder set on that step.</span>
              </div>
            ) : null}
            <div class="bean-routines-listed bean-routines-ends">
              <div class="bean-field-label">ENDS</div>
              <div class="bean-routines-listed-chips">
                <input
                  class="bean-input bean-input--boxed"
                  type="date"
                  aria-label="End date"
                  disabled={Boolean(ended) && !draft.enabled}
                  title={ended && !draft.enabled ? "Restore it to give it a later end date" : undefined}
                  value={untilDateValue(draft.until)}
                  onChange={(e) => {
                    const v = (e.target as HTMLInputElement).value;
                    const { until: _until, ...rest } = draft;
                    setDraft(v ? { ...rest, until: v } : rest);
                  }}
                />
                {ended && savedRoutine && !draft.enabled ? (
                  <>
                    <span class="bean-routines-section-note">{ended.text}</span>
                    {remoteCore ? null : <button type="button" class="bean-routines-todo-link bean-routines-fix-btn" onClick={() => restore(savedRoutine.name)}>Restore</button>}
                  </>
                ) : (
                  <span class="bean-routines-section-note">
                    {ended && draft.enabled ? "Save to turn it back on — it starts again from now." : draft.until ? "Stops after this day." : "Blank = runs until you turn it off."}
                  </span>
                )}
              </div>
            </div>
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
            <span class="bean-skills-toggle-label">{draft.enabled ? "Runs automatically" : draft.watch ? "Paused" : "On demand — runs only when you start it"}</span>
            {draft.enabled && stepProblems ? (
              <span class="bean-routines-step-missing" role="alert">⚠ {stepProblems}</span>
            ) : null}
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
          {draft.todoDriven ? (
            <div class="bean-routines-type-row">
              <div class="bean-routines-sentence">
                Run up to{" "}
                <select
                  class="bean-routines-chip-select"
                  value={String(draft.maxParallel ?? 1)}
                  onChange={(e) => {
                    const n = Number((e.target as HTMLSelectElement).value);
                    setDraft(n > 1 ? { ...draft, maxParallel: n } : dropParallel(draft));
                  }}
                >
                  {/* 1–4 = core's MAX_PARALLEL */}
                  {[1, 2, 3, 4].map((n) => <option key={n} value={String(n)}>{n}</option>)}
                </select>{" "}
                at once
              </div>
              <span class="bean-routines-section-note">
                Each queued item runs and reports on its own. The skill must work in its own worktree. 2–3 keeps CLI usage limits in reach.
              </span>
            </div>
          ) : null}
        </div>

        {draft.todoDriven && !selected ? (
          // Queue needs a saved routine name to attach todos to (Task 8's original design) —
          // but showing nothing here is indistinguishable from the feature being missing
          // (reported: "there isn't a place I can add any todo items"). Say why instead.
          <div class="bean-skills-projects">
            <div class="bean-routines-section-head">
              <div class="bean-field-label">QUEUE</div>
            </div>
            <span class="bean-routines-section-note">Save this sprout to start queuing todos.</span>
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
              {pendingCount} pending{runningCount > 0 ? ` · ${slotsText}` : ""}{draft.watch ? "" : " · gates this sprout"}
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
              {draft.watch ? " · run in order on each new item" : (draft.maxParallel ?? 1) > 1 ? ` · run on up to ${draft.maxParallel} queued todos at once · one digest each`
                : draft.todoDriven ? " · run in order on each queued todo · one digest at the end" : " · run in order · one digest at the end"}
            </span>
          </div>
          <StepsEditor
            steps={draft.steps}
            onSteps={(steps) => setDraft({ ...draft, steps })}
            skills={skills}
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
          <label class="bean-routines-sink-row">
            <input
              type="checkbox"
              checked={draft.sinks.home !== undefined}
              onChange={(e) => {
                const { home: _h, ...rest } = draft.sinks;
                setDraft({ ...draft, sinks: (e.target as HTMLInputElement).checked ? { ...rest, home: {} } : rest });
              }}
            />
            <span class="bean-routines-sink-name">Post to your chat with {beanName}</span>
          </label>
          {draft.sinks.home ? (
            <label class="bean-routines-sink-row bean-routines-sink-suboption bean-routines-home-ttl">
              Drop if unread after
              {/* An invalid number stays in the draft so the save is refused with core's message
                  (describeRoutineError), never silently replaced by the last valid value. */}
              <input
                type="number"
                min={1}
                step={1}
                class="bean-routines-pill-input"
                aria-label={`Drop the post to your chat with ${beanName} if unread after this many minutes`}
                // NaN = malformed text the user is still typing: leave the field's text alone.
                value={Number.isNaN(draft.sinks.home.ttlMinutes) ? undefined : draft.sinks.home.ttlMinutes ?? ""}
                onInput={(e) => {
                  const input = e.target as HTMLInputElement;
                  const v = input.value.trim();
                  // Malformed text ("-", "1e") reads as "" with badInput set: keep it invalid (NaN),
                  // never as blank, or it would silently drop the expiry.
                  const ttlMinutes = input.validity.badInput ? Number.NaN : v === "" ? undefined : Number(v);
                  setDraft({ ...draft, sinks: { ...draft.sinks, home: ttlMinutes === undefined ? {} : { ttlMinutes } } });
                }}
              />
              min
              <span class="bean-routines-sink-hint">blank = keep until read</span>
            </label>
          ) : null}
          {(["discord", "teams"] as const).map((transport) => {
            const label = transport === "discord" ? "Discord" : "Teams";
            const room = transport === "discord" ? "channel" : "conversation";
            // Rows index the full list, so each row edits/removes only its own entry.
            const all = draft.sinks.chatops ?? [];
            const rows = all.map((c, i) => ({ c, i })).filter(({ c }) => c.transport === transport);
            const dm = rows.some(({ c }) => isDmSink(c));
            return (
              <div key={transport} class="bean-routines-sink-group">
                <label class="bean-routines-sink-row">
                  <input
                    type="checkbox"
                    checked={dm}
                    onChange={(e) => setChatops((e.target as HTMLInputElement).checked
                      ? [...all, { transport }]
                      : all.filter((c) => !(c.transport === transport && isDmSink(c))))}
                  />
                  Post to {label} (DM)
                </label>
                {rows.map(({ c, i }) => isDmSink(c) ? null : c.user !== undefined ? (
                  <div key={i} class="bean-routines-sink-row bean-routines-sink-suboption">
                    <span>DM to user {c.user}</span>
                    <button
                      type="button"
                      class="bean-skills-delete-link"
                      aria-label={`Remove ${label} DM to user ${c.user}`}
                      title="Remove"
                      onClick={() => setChatops(all.filter((_, j) => j !== i))}
                    >×</button>
                  </div>
                ) : (
                  <DestinationPicker
                    // Per sprout: naming state must never follow the row index into another draft.
                    key={`${creating ? "new" : selected ?? ""}:${i}`}
                    sink={c}
                    label={label}
                    room={room}
                    destinations={chatDestinations}
                    routines={routines}
                    onChange={(next) => setChatops(all.map((x, j) => (j === i ? next : x)))}
                    onRemove={() => setChatops(all.filter((_, j) => j !== i))}
                    onNamedRaw={(id, alias) => {
                      setChatops(all.map((x) => (x.transport === transport && x.channel?.trim() === id ? { transport, alias } : x)));
                      void refresh();
                      void reloadDestinations();
                    }}
                    reloadDestinations={reloadDestinations}
                  />
                ))}
                <button
                  type="button"
                  class="bean-routines-sink-add bean-routines-sink-suboption"
                  onClick={() => setChatops([...all, { transport, channel: "" }])}
                >+ Add {label} {room}</button>
              </div>
            );
          })}
          {draft.sinks.chatops?.some((c) => c.channel !== undefined) ? (
            <div class="bean-routines-section-note">
              A new Teams conversation needs one @mention of the bot before Bean can post there. A bad id shows up as a DM notice to you after retries.
            </div>
          ) : null}
          {/* Hidden for notify-only watches: their fires are always "ok", so the rule would mute them. */}
          {(draft.sinks.chatops?.length ?? 0) > 0 && !notifyOnly ? (
            <label class="bean-routines-sink-row bean-routines-only-on-problems">
              <input
                type="checkbox"
                checked={draft.sinks.chatopsOnlyOnProblems === true}
                onChange={(e) => setDraft({ ...draft, sinks: { ...draft.sinks, chatopsOnlyOnProblems: (e.target as HTMLInputElement).checked || undefined } })}
              />
              Only post when a run needs me
            </label>
          ) : null}
          {(draft.sinks.chatops?.length ?? 0) > 0 && !notifyOnly ? (
            <label class="bean-routines-sink-row bean-routines-chat-brief">
              <input
                type="checkbox"
                checked={draft.sinks.chatopsVerbatim !== true}
                onChange={(e) => {
                  const { chatopsVerbatim: _v, ...rest } = draft.sinks;
                  setDraft({ ...draft, sinks: (e.target as HTMLInputElement).checked ? rest : { ...rest, chatopsVerbatim: true } });
                }}
              />
              Sum up as a short brief
              <span class="bean-routines-sink-hint">Off = post the full digest word for word</span>
            </label>
          ) : null}
        </div>

        {error ? <div class="bean-status bean-status--error">{error}</div> : null}

        <div class="bean-routines-divider" />
        <div class="bean-routines-footer">
          <span class="bean-routines-digest-line">
            <span class="bean-routines-bean-chip" />
            {briefTargets.length > 0
              ? <span>Posts a brief to <b>{briefTargets.join(", ")}</b>{sinkTargets.length > 0 ? <> and a digest to <b>{sinkTargets.join(", ")}</b></> : null}</span>
              : sinkTargets.length > 0
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
              {runningCount > 0 ? (
                <button type="button" class="bean-btn bean-btn--ghost bean-routines-stop" disabled={isStopping} onClick={() => void stopRuns()}>
                  {isStopping ? "Stopping…" : runningCount > 1 ? `Stop all ${runningCount} runs` : "Stop"}
                </button>
              ) : null}
              {runNowNote ? <span class="bean-routines-section-note">{runNowNote}</span> : null}
            </>
          ) : null}
          <button type="button" class="bean-btn" disabled={saving} onClick={() => void save()}>
            {saving ? "Saving…" : justSaved ? "Saved ✓" : "Save sprout"}
          </button>
        </div>
        {selected ? (
          <button type="button" class="bean-skills-delete-link bean-routines-delete" onClick={() => void remove()}>Delete sprout…</button>
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
