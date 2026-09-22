import { useEffect, useMemo, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import type { Routine } from "@bean/core";
import { nextRun } from "@bean/core/cron";
import { Markdown } from "../../shared/Markdown.js";
import { PanelEmptyState } from "../../shared/PanelEmptyState.js";
import {
  flattenRuns, groupRuns, splitSteps, stepLabel, unreadRuns,
  type DashRun, type DashStep, type RunBucket,
} from "./runs.js";
import type { RoutineStateView } from "../../../ipc.js";

// Renderer-only view prefs (see .memory/convention-renderer-view-prefs-in-localstorage.md):
// "I've seen everything up to here", and which day headers are folded. Nothing in main or
// another surface needs either.
const REVIEWED_KEY = "bean.dashboard.reviewedAt";
const readReviewed = (): string | null => {
  try { return localStorage.getItem(REVIEWED_KEY); } catch { return null; }
};

// Days open by default except older ones (see dayOpenByDefault), so what's stored is the set of
// headers you've *flipped* away from that default — one list instead of a collapsed list plus
// an expanded one.
const FLIPPED_KEY = "bean.dashboard.flippedDays";
function readFlipped(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(FLIPPED_KEY) ?? "[]") as unknown;
    return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

const pad2 = (n: number): string => String(n).padStart(2, "0");
const clock = (iso: string): string => {
  const d = new Date(iso);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

// `date` is a local `YYYY-MM-DD` out of groupRuns; the Date(y, m, d) form keeps it local
// (Date.parse of a bare ISO date is UTC, which shifts the label a day either side of midnight).
const dayLabel = (date: string, now: Date): string => {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const then = new Date(y, m - 1, d);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const days = Math.round((startOfToday - then.getTime()) / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return then.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
};

// Only the newest day starts open — older days are history you go looking for, not something
// to scroll past every morning.
const dayOpenByDefault = (dayIndex: number): boolean => dayIndex === 0;

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

const stepTitle = (step: DashStep): string => {
  if (step.todo === undefined) return `Step ${step.index + 1} failed`;
  return step.todo ? `Failed on todo: ${step.todo}` : "Failed on a queued todo";
};

function nextRunText(routine: Routine | undefined): string {
  if (!routine) return "routine deleted — history kept";
  if (!routine.enabled) return "paused — won't run again until you enable it";
  try {
    return `next run ${clock(nextRun(routine.cron, new Date()).toISOString())}`;
  } catch {
    return "invalid cron — won't be scheduled";
  }
}

// 4a "Night-shift ledger, panel form": rail of days on the left, one time spine on the right.
// The unit of reading is a routine's whole day — a routine that fires several times a day is one
// rail row whose runs the spine reads in order — and the only thing a run can genuinely ask of
// you is a failed step, so failures become the numbered NEEDS YOU cards (numbered across the
// day, not per run) and every step that passed collapses into its run's RESOLVED line.
export function DashboardPanel() {
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [states, setStates] = useState<Record<string, RoutineStateView>>({});
  const [selectedKey, setSelectedKey] = useState<string | undefined>(undefined);
  const [openResolved, setOpenResolved] = useState<string[]>([]);
  const [openDigests, setOpenDigests] = useState<string[]>([]);
  const [reviewedAt, setReviewedAt] = useState<string | null>(readReviewed());
  const [flipped, setFlipped] = useState<string[]>(readFlipped);
  const [rerunning, setRerunning] = useState(false);
  const [notice, setNotice] = useState("");

  const refresh = async (): Promise<void> => {
    const [list, st] = await Promise.all([window.bean.routinesList(), window.bean.routinesState()]);
    setRoutines(list);
    setStates(st);
  };

  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    // Same 5s cadence as the Routines panel — a run that lands while the dashboard is open
    // should show up without a reopen.
    const t = setInterval(() => { void refresh(); }, 5000);
    return () => clearInterval(t);
  }, []);

  const runs = useMemo(() => flattenRuns(states), [states]);
  const days = useMemo(() => groupRuns(runs), [runs]);
  const buckets = useMemo(() => days.flatMap((d) => d.buckets), [days]);
  const unread = useMemo(() => unreadRuns(runs, reviewedAt), [runs, reviewedAt]);
  const unreadIds = useMemo(() => new Set(unread.map((r) => r.id)), [unread]);

  // The newest day's first routine is the default read — the dashboard opens on "what happened
  // last night". History is capped, so the selection can also roll out from under us on a poll;
  // fall back to the newest rather than leaving the detail pane blank.
  useEffect(() => {
    if (buckets[0] && !buckets.some((b) => b.key === selectedKey)) setSelectedKey(buckets[0].key);
  }, [buckets, selectedKey]);
  useEffect(() => { setOpenResolved([]); setOpenDigests([]); setNotice(""); }, [selectedKey]);

  const bucket: RunBucket | undefined = buckets.find((b) => b.key === selectedKey);
  const routine = routines.find((r) => r.name === bucket?.routine);
  const now = new Date();

  // Every run of the selected day, split into what needs you and what resolved. The NEEDS YOU
  // cards are numbered across the whole bucket so the morning has one end, not one per run.
  const runViews = useMemo(
    () => (bucket?.runs ?? []).map((run) => ({ run, ...splitSteps(run) })),
    [bucket],
  );
  const needsTotal = runViews.reduce((n, v) => n + v.needs.length, 0);
  const resolvedTotal = runViews.reduce((n, v) => n + v.resolved.length, 0);
  const isNewest = bucket !== undefined && buckets[0]?.key === bucket.key;

  const toggle = (list: string[], set: (v: string[]) => void, key: string): void =>
    set(list.includes(key) ? list.filter((k) => k !== key) : [...list, key]);

  const toggleDay = (date: string): void => {
    setFlipped((prev) => {
      const next = prev.includes(date) ? prev.filter((k) => k !== date) : [...prev, date];
      try { localStorage.setItem(FLIPPED_KEY, JSON.stringify(next)); } catch { /* private mode: fold still works this session */ }
      return next;
    });
  };

  const markAllReviewed = (): void => {
    const stamp = new Date().toISOString();
    try { localStorage.setItem(REVIEWED_KEY, stamp); } catch { /* private mode — badge just stays */ }
    setReviewedAt(stamp);
  };

  const askBean = (run: DashRun, step: DashStep): void => {
    window.bean.runInChat(
      `${stepTitle(step)} in my routine "${run.routine}" on its ${clock(run.startedAt)} run:\n\n` +
        `${step.summary}\n\nWhat happened, and what should I do about it?`,
      `Routine: ${run.routine}`,
    );
  };

  const rerun = async (): Promise<void> => {
    if (!bucket) return;
    setRerunning(true);
    setNotice("");
    try {
      const { started, reason } = await window.bean.routinesRunNow(bucket.routine);
      setNotice(started ? "" : (reason ?? "couldn't start the run"));
      await refresh();
    } finally {
      setRerunning(false);
    }
  };

  const bucketRow = (b: RunBucket) => {
    const unreadHere = b.runs.some((r) => unreadIds.has(r.id));
    const last = b.runs[b.runs.length - 1]!;
    return (
      <div
        key={b.key}
        role="button"
        tabIndex={0}
        aria-pressed={selectedKey === b.key}
        class={`bean-skills-row bean-dash-row bean-dash-row--nested${selectedKey === b.key ? " bean-skills-row--selected" : ""}`}
        onClick={() => setSelectedKey(b.key)}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          setSelectedKey(b.key);
        }}
      >
        <span class={`bean-dash-dot bean-dash-dot--${b.needs > 0 ? "failed" : "ok"}`} />
        <div class="bean-skills-row-main">
          <div class="bean-skills-row-name">{b.routine}</div>
          <div class="bean-dash-row-sub">
            {plural(b.runs.length, "run")} · {clock(b.runs[0]!.startedAt)}
            {b.runs.length > 1 ? ` → ${clock(last.startedAt)}` : ""}
          </div>
        </div>
        {b.needs > 0 ? <span class="bean-dash-row-badge">{b.needs}</span> : null}
        {unreadHere ? <span class="bean-dash-row-unread" title="Not reviewed yet" /> : null}
      </div>
    );
  };

  // Routine health: the selected routine's last runs, oldest-left, as one ok/failed bar each.
  const health = [...(bucket ? (states[bucket.routine]?.history ?? []) : [])].reverse();

  const spineRow = (key: string, time: string, kind: "plain" | "call" | "end" | "run", body: ComponentChildren) => (
    <div class="bean-dash-spine-row" key={key}>
      <div class={`bean-dash-time bean-dash-time--${kind}`}>{time}</div>
      <div class="bean-dash-rail">
        <span class={`bean-dash-node bean-dash-node--${kind}`} />
        <span class="bean-dash-line" />
      </div>
      <div class="bean-dash-body">{body}</div>
    </div>
  );

  // One run's slice of the day's spine: its header, its resolved line, its failed-step cards and
  // its digest. `firstNeed` is where this run's cards continue the day's running count.
  const runSection = (view: (typeof runViews)[number], index: number, firstNeed: number) => {
    const { run, needs, resolved } = view;
    const resolvedOpen = openResolved.includes(run.id);
    const digestOpen = openDigests.includes(run.id);
    return [
      spineRow(`${run.id}-head`, `run ${index + 1}`, "run", (
        <div class="bean-dash-run-head">
          <span class="bean-dash-run-time">{clock(run.startedAt)} → {clock(run.finishedAt)}</span>
          <span class="bean-dash-meta">
            {plural(run.steps.length, "step")} · {run.status === "ok" ? "healthy" : "failed"}
          </span>
        </div>
      )),

      ...(resolved.length > 0
        ? [spineRow(`${run.id}-resolved`, "", "plain", (
            <div class="bean-dash-resolved">
              <button
                type="button"
                class="bean-dash-resolved-head"
                aria-expanded={resolvedOpen}
                onClick={() => toggle(openResolved, setOpenResolved, run.id)}
              >
                <span class="bean-dash-resolved-count">{resolved.length} RESOLVED</span>
                <span class="bean-dash-resolved-preview">
                  {resolved.map((s) => s.summary.split("\n")[0]).join(" · ")}
                </span>
                <span class="bean-dash-resolved-toggle">{resolvedOpen ? "Collapse ▴" : "Expand ▾"}</span>
              </button>
              {resolvedOpen ? (
                <div class="bean-dash-resolved-list">
                  {resolved.map((s) => (
                    <div key={s.index} class="bean-dash-resolved-item">
                      <span class="bean-dash-meta">{stepLabel(s)} · {s.kind}</span>
                      <span>{s.summary}</span>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ))]
        : []),

      ...needs.map((s, i) =>
        spineRow(`${run.id}-need-${s.index}`, stepLabel(s), "call", (
          <div class="bean-dash-card">
            <div class="bean-dash-card-tags">
              <span class="bean-dash-tag">NEEDS YOU · {firstNeed + i + 1} OF {needsTotal}</span>
              <span class="bean-dash-meta">{run.routine} · {s.kind} step · run {index + 1}</span>
            </div>
            <div class="bean-dash-card-title">{stepTitle(s)}</div>
            <div class="bean-dash-card-text">{s.summary}</div>
            <div class="bean-dash-card-actions">
              <button type="button" class="bean-btn" onClick={() => askBean(run, s)}>Ask Bean</button>
              <button
                type="button"
                class="bean-btn bean-btn--ghost"
                disabled={rerunning}
                onClick={() => void rerun()}
              >
                {rerunning ? "Starting…" : "Run routine again"}
              </button>
              {notice ? <span class="bean-dash-notice">{notice}</span> : null}
            </div>
          </div>
        )),
      ),

      ...(run.digest
        ? [spineRow(`${run.id}-digest`, "", "plain", (
            <div class="bean-dash-digest">
              <button
                type="button"
                class="bean-dash-digest-head"
                aria-expanded={digestOpen}
                onClick={() => toggle(openDigests, setOpenDigests, run.id)}
              >
                <span class="bean-field-label">DIGEST · RUN {index + 1}</span>
                <span class="bean-dash-resolved-toggle">{digestOpen ? "Hide ▴" : "Read ▾"}</span>
              </button>
              {digestOpen ? <Markdown text={run.digest} /> : null}
            </div>
          ))]
        : []),
    ];
  };

  let needCursor = 0;

  return (
    <div class="bean-skills">
      <div class="bean-skills-list">
        <div class="bean-skills-list-label">Runs · {runs.length}</div>
        {runs.length === 0 ? (
          <div class="bean-panel-empty">Nothing has run yet — routines report here once they finish.</div>
        ) : (
          days.map((day, i) => {
            const open = dayOpenByDefault(i) !== flipped.includes(day.date);
            return (
              <div key={day.date}>
                <button
                  type="button"
                  class="bean-skills-list-label bean-skills-list-label--toggle bean-notes-group"
                  aria-expanded={open}
                  onClick={() => toggleDay(day.date)}
                >
                  <span class="bean-notes-group-caret">{open ? "▾" : "▸"}</span>
                  {dayLabel(day.date, now)}
                  <span class="bean-notes-group-count">{day.runCount}</span>
                </button>
                {open ? day.buckets.map(bucketRow) : null}
              </div>
            );
          })
        )}
        <span class="bean-skills-spacer" />
        {bucket ? (
          <div class="bean-dash-health">
            <div class="bean-field-label">ROUTINE HEALTH</div>
            <div class="bean-dash-health-bars">
              {health.map((h) => (
                <span key={h.startedAt} class={`bean-dash-health-bar bean-dash-health-bar--${h.status}`} />
              ))}
            </div>
            <div class="bean-dash-health-text">
              {plural(health.length, "run")}, {health.filter((h) => h.status === "failed").length} failed
              {" · "}{nextRunText(routine)}
            </div>
            <button type="button" class="bean-dash-link" onClick={() => void window.bean.openComponent("routines")}>
              Open routines →
            </button>
          </div>
        ) : null}
      </div>

      <div class="bean-skills-detail">
        {!bucket ? (
          <PanelEmptyState message="Pick a day to read what Bean did while you were away." />
        ) : (
          <>
            <div class="bean-dash-header">
              <span class="bean-dash-orb" />
              <div class="bean-dash-header-main">
                <h2 class="bean-dash-title">{dayLabel(bucket.date, now)} · {bucket.routine}</h2>
                <div class="bean-dash-header-sub">
                  {plural(bucket.runs.length, "run")}{" · "}
                  {needsTotal > 0
                    ? <b class="bean-dash-accent">{needsTotal} need{needsTotal === 1 ? "s" : ""} your call</b>
                    : "nothing needs you"}
                  {" · "}{resolvedTotal} resolved without you
                </div>
              </div>
              <button
                type="button"
                class="bean-btn bean-btn--ghost"
                disabled={unread.length === 0}
                onClick={markAllReviewed}
              >
                {unread.length > 0 ? `Mark all reviewed (${unread.length})` : "All reviewed"}
              </button>
            </div>

            <div class="bean-dash-spine">
              {runViews.map((view, i) => {
                const rows = runSection(view, i, needCursor);
                needCursor += view.needs.length;
                return rows;
              })}

              {isNewest
                ? spineRow("here", "now", "end", (
                    <div class="bean-dash-here">
                      <span class="bean-dash-here-text">YOU ARE HERE · {clock(now.toISOString())}</span>
                      <span class="bean-dash-here-line" />
                    </div>
                  ))
                : null}
            </div>

            <div class="bean-dash-footer">
              <span>{nextRunText(routine)} — anything here stays until the history rolls over.</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
