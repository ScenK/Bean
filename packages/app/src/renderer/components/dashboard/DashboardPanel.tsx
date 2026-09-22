import { useEffect, useMemo, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import type { Routine } from "@bean/core";
import { nextRun } from "@bean/core/cron";
import { Markdown } from "../../shared/Markdown.js";
import { PanelEmptyState } from "../../shared/PanelEmptyState.js";
import {
  flattenRuns, groupRuns, reviewRuns, splitSteps, stepLabel, unreadRuns,
  type DashRun, type DashStep, type DayGroup, type RunBucket,
} from "./runs.js";
import type { RoutineStateView } from "../../../ipc.js";

// Renderer-only view pref (see .memory/convention-renderer-view-prefs-in-localstorage.md):
// which runs you've marked reviewed. Nothing in main or another surface needs it.
const REVIEWED_KEY = "bean.dashboard.reviewedRuns";

function readList(key: string): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? "[]") as unknown;
    return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function writeList(key: string, value: string[]): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode: still works this session */ }
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

type RunView = { run: DashRun; needs: DashStep[]; resolved: DashStep[] };

// 4a "Night-shift ledger, panel form": rail of days on the left, one time spine on the right.
// The unit of reading is a whole day — every routine that ran, each a section of its runs — so
// the morning is one pass down one column. The spine reads newest-first at every level, the
// "you are here" marker at the top, so the latest thing Bean did is the first thing you see.
// The only thing a run can genuinely ask of you is a failed step, so failures become the NEEDS
// YOU cards, numbered across the whole day rather than per run, and every step that passed
// collapses into its run's RESOLVED line.
export function DashboardPanel() {
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [states, setStates] = useState<Record<string, RoutineStateView>>({});
  const [selectedDate, setSelectedDate] = useState<string | undefined>(undefined);
  const [openResolved, setOpenResolved] = useState<string[]>([]);
  // Each routine's latest digest is what you came to read, so it starts open and the rest stay
  // shut; this list holds the runs flipped away from that default.
  const [flippedDigests, setFlippedDigests] = useState<string[]>([]);
  const [reviewed, setReviewed] = useState<string[]>(() => readList(REVIEWED_KEY));
  // The routine whose run is being started, "" when none — the button that started it is the
  // one that says so.
  const [rerunning, setRerunning] = useState("");
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
  const reviewedSet = useMemo(() => new Set(reviewed), [reviewed]);
  const unreadIds = useMemo(
    () => new Set(unreadRuns(runs, reviewedSet).map((r) => r.id)),
    [runs, reviewedSet],
  );

  // The newest day is the default read — the dashboard opens on "what happened last night".
  // History is capped, so the selection can also roll out from under us on a poll; fall back to
  // the newest rather than leaving the detail pane blank.
  useEffect(() => {
    if (days[0] && !days.some((d) => d.date === selectedDate)) setSelectedDate(days[0].date);
  }, [days, selectedDate]);
  useEffect(() => { setOpenResolved([]); setFlippedDigests([]); setNotice(""); }, [selectedDate]);

  const day: DayGroup | undefined = days.find((d) => d.date === selectedDate);
  const now = new Date();

  // Every run of the selected day, split into what needs you and what resolved, kept under its
  // routine. NEEDS YOU cards are numbered across the whole day so the morning has one end.
  const sections = useMemo(
    () => (day?.buckets ?? []).map((bucket) => ({
      bucket,
      views: bucket.runs.map((run): RunView => ({ run, ...splitSteps(run) })),
    })),
    [day],
  );
  const needsTotal = day?.needs ?? 0;
  const resolvedTotal = sections.reduce(
    (n, s) => n + s.views.reduce((m, v) => m + v.resolved.length, 0),
    0,
  );
  const unreadHere = (day?.buckets ?? []).reduce(
    (n, b) => n + b.runs.filter((r) => unreadIds.has(r.id)).length,
    0,
  );
  const isNewest = day !== undefined && days[0]?.date === day.date;

  const toggle = (list: string[], set: (v: string[]) => void, key: string): void =>
    set(list.includes(key) ? list.filter((k) => k !== key) : [...list, key]);

  // Reviewing is scoped to what's on screen — the day you just read, not every older day
  // still sitting unread in the rail.
  const markDayReviewed = (): void => {
    if (!day) return;
    const ids = day.buckets.flatMap((b) => b.runs.map((r) => r.id));
    const next = reviewRuns(reviewedSet, ids, runs);
    writeList(REVIEWED_KEY, next);
    setReviewed(next);
  };

  const askBean = (run: DashRun, step: DashStep): void => {
    window.bean.runInChat(
      `${stepTitle(step)} in my routine "${run.routine}" on its ${clock(run.startedAt)} run:\n\n` +
        `${step.summary}\n\nWhat happened, and what should I do about it?`,
      `Routine: ${run.routine}`,
    );
  };

  const rerun = async (name: string): Promise<void> => {
    setRerunning(name);
    setNotice("");
    try {
      const { started, reason } = await window.bean.routinesRunNow(name);
      setNotice(started ? "" : (reason ?? "couldn't start the run"));
      await refresh();
    } finally {
      setRerunning("");
    }
  };

  const dayRow = (d: DayGroup) => {
    const unreadThere = d.buckets.some((b) => b.runs.some((r) => unreadIds.has(r.id)));
    return (
      <div
        key={d.date}
        role="button"
        tabIndex={0}
        aria-pressed={selectedDate === d.date}
        class={`bean-skills-row bean-dash-row${selectedDate === d.date ? " bean-skills-row--selected" : ""}`}
        onClick={() => setSelectedDate(d.date)}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          setSelectedDate(d.date);
        }}
      >
        <span class={`bean-dash-dot bean-dash-dot--${d.needs > 0 ? "failed" : "ok"}`} />
        <div class="bean-skills-row-main">
          <div class="bean-skills-row-name">{dayLabel(d.date, now)}</div>
          <div class="bean-dash-row-sub">
            {plural(d.buckets.length, "routine")} · {plural(d.runCount, "run")}
          </div>
        </div>
        {d.needs > 0 ? <span class="bean-dash-row-badge">{d.needs}</span> : null}
        {unreadThere ? <span class="bean-dash-row-unread" title="Not reviewed yet" /> : null}
      </div>
    );
  };

  const spineRow = (
    key: string,
    time: string,
    kind: "plain" | "call" | "end" | "run" | "routine",
    body: ComponentChildren,
  ) => (
    <div class="bean-dash-spine-row" key={key}>
      <div class={`bean-dash-time bean-dash-time--${kind}`}>{time}</div>
      <div class="bean-dash-rail">
        <span class={`bean-dash-node bean-dash-node--${kind}`} />
        <span class="bean-dash-line" />
      </div>
      <div class="bean-dash-body">{body}</div>
    </div>
  );

  // One run's slice of the day: its header, its resolved line, its failed-step cards and its
  // digest. `ordinal` is the run's chronological place in its routine's day (the spine shows
  // them newest-first, so it counts down); `firstNeed` is where this run's cards continue the
  // day's running count; `latest` is its routine's newest run of the day, whose digest is open.
  const runSection = (view: RunView, ordinal: number, firstNeed: number, latest: boolean) => {
    const { run, needs, resolved } = view;
    const resolvedOpen = openResolved.includes(run.id);
    const digestOpen = latest !== flippedDigests.includes(run.id);
    return [
      spineRow(`${run.id}-head`, `run ${ordinal}`, "run", (
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
              <span class="bean-dash-meta">{run.routine} · {s.kind} step · run {ordinal}</span>
            </div>
            <div class="bean-dash-card-title">{stepTitle(s)}</div>
            <div class="bean-dash-card-text">{s.summary}</div>
            <div class="bean-dash-card-actions">
              <button type="button" class="bean-btn" onClick={() => askBean(run, s)}>Ask Bean</button>
              <button
                type="button"
                class="bean-btn bean-btn--ghost"
                disabled={rerunning !== ""}
                onClick={() => void rerun(run.routine)}
              >
                {rerunning === run.routine ? "Starting…" : "Run routine again"}
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
                onClick={() => toggle(flippedDigests, setFlippedDigests, run.id)}
              >
                <span class="bean-field-label">DIGEST · RUN {ordinal}</span>
                <span class="bean-dash-resolved-toggle">{digestOpen ? "Hide ▴" : "Read ▾"}</span>
              </button>
              {digestOpen ? (
                <div class="bean-dash-digest-body"><Markdown text={run.digest} /></div>
              ) : null}
            </div>
          ))]
        : []),
    ];
  };

  // A routine's whole slice of the day, headed by which routine it is, when it runs next, and
  // its recent pass/fail history.
  const routineSection = (bucket: RunBucket, views: RunView[], firstNeed: number) => {
    const routine = routines.find((r) => r.name === bucket.routine);
    const health = [...(states[bucket.routine]?.history ?? [])].reverse();
    let cursor = firstNeed;
    return [
      spineRow(`${bucket.key}-routine`, "", "routine", (
        <div class="bean-dash-routine-head">
          <div class="bean-dash-routine-main">
            <span class="bean-dash-routine-name">{bucket.routine}</span>
            <span class="bean-dash-meta">
              {plural(bucket.runs.length, "run")} · {nextRunText(routine)}
            </span>
          </div>
          <div
            class="bean-dash-health-bars bean-dash-health-bars--inline"
            title={`${plural(health.length, "run")} in history, ${health.filter((h) => h.status === "failed").length} failed`}
          >
            {health.map((h) => (
              <span key={h.startedAt} class={`bean-dash-health-bar bean-dash-health-bar--${h.status}`} />
            ))}
          </div>
        </div>
      )),
      // views are newest-first, so the first one is the latest run and carries the day's
      // highest ordinal.
      ...views.flatMap((view, i) => {
        const rows = runSection(view, views.length - i, cursor, i === 0);
        cursor += view.needs.length;
        return rows;
      }),
    ];
  };

  let needCursor = 0;

  return (
    <div class="bean-skills">
      <div class="bean-skills-list">
        <div class="bean-skills-list-label">Days · {days.length}</div>
        {days.length === 0 ? (
          <div class="bean-panel-empty">Nothing has run yet — routines report here once they finish.</div>
        ) : (
          days.map(dayRow)
        )}
        <span class="bean-skills-spacer" />
        <button type="button" class="bean-dash-link" onClick={() => void window.bean.openComponent("routines")}>
          Open routines →
        </button>
        <div class="bean-skills-path">{plural(runs.length, "run")} kept · older ones roll off</div>
      </div>

      <div class="bean-skills-detail">
        {!day ? (
          <PanelEmptyState message="Pick a day to read what Bean did while you were away." />
        ) : (
          <>
            <div class="bean-dash-header">
              <span class="bean-dash-orb" />
              <div class="bean-dash-header-main">
                <h2 class="bean-dash-title">{dayLabel(day.date, now)}</h2>
                <div class="bean-dash-header-sub">
                  {plural(day.buckets.length, "routine")}{" · "}{plural(day.runCount, "run")}{" · "}
                  {needsTotal > 0
                    ? <b class="bean-dash-accent">{needsTotal} need{needsTotal === 1 ? "s" : ""} your call</b>
                    : "nothing needs you"}
                  {" · "}{resolvedTotal} resolved without you
                </div>
              </div>
              <button
                type="button"
                class="bean-btn bean-btn--ghost"
                disabled={unreadHere === 0}
                onClick={markDayReviewed}
              >
                {unreadHere > 0 ? `Mark this day reviewed (${unreadHere})` : "Day reviewed"}
              </button>
            </div>

            <div class="bean-dash-spine">
              {isNewest
                ? spineRow("here", "now", "end", (
                    <div class="bean-dash-here">
                      <span class="bean-dash-here-text">YOU ARE HERE · {clock(now.toISOString())}</span>
                      <span class="bean-dash-here-line" />
                    </div>
                  ))
                : null}

              {sections.map(({ bucket, views }) => {
                const rows = routineSection(bucket, views, needCursor);
                needCursor += views.reduce((n, v) => n + v.needs.length, 0);
                return rows;
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
