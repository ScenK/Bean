import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import type { Routine } from "@bean/core";
import { nextRun } from "@bean/core/cron";
import { Markdown } from "../../shared/Markdown.js";
import { PanelEmptyState } from "../../shared/PanelEmptyState.js";
import { ListFoldToggle, useListFold } from "../../shared/ListFold.js";
import { StepFlow } from "../../shared/StepFlow.js";
import {
  attemptSessions, attentionOf, bucketKeyFor, executedPath, flattenRuns, groupRuns, observedLanes, pathName, reviewRuns, runFlowOverlay, sessionSummary,
  splitSteps, stepLabel, stepPassed, unreadRuns,
  type DashRun, type DashStep, type RunBucket,
} from "./runs.js";
import type { RoutineStateView, StepAttemptView } from "../../../ipc.js";
import type { DashboardTarget } from "../../../channels.js";
import { watchDashboardText } from "../routines/watch-status.js";

// Renderer-only view prefs (see .memory/convention-renderer-view-prefs-in-localstorage.md):
// which runs you've marked reviewed, and which day headers are folded. Nothing in main or
// another surface needs either.
const REVIEWED_KEY = "bean.dashboard.reviewedRuns";
// Days open by default except older ones (see dayOpenByDefault), so what's stored is the set of
// headers you've *flipped* away from that default — one list instead of a collapsed list plus
// an expanded one.
const FLIPPED_KEY = "bean.dashboard.flippedDays";

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

// Only the newest day starts open — older days are history you go looking for, not something
// to scroll past every morning.
const dayOpenByDefault = (dayIndex: number): boolean => dayIndex === 0;

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

const attemptName = (a: StepAttemptView): string => pathName({ kind: a.kind, id: a.stepId ?? `step-${a.stepIndex + 1}`, round: a.round });

const stepTitle = (step: DashStep): string => {
  if (step.todo === undefined) return `Step ${step.index + 1} failed`;
  return step.todo ? `Failed on todo: ${step.todo}` : "Failed on a queued todo";
};

function nextRunText(routine: Routine | undefined, state: RoutineStateView | undefined): string {
  if (!routine) return "sprout deleted — history kept";
  if (!routine.enabled) return "paused — won't run again until you enable it";
  // A watch has no "next run" — say what it's waiting for instead.
  if (routine.watch) return watchDashboardText(routine, state, new Date());
  try {
    return `next run ${clock(nextRun(routine.cron ?? "", new Date()).toISOString())}`;
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
  const [listFolded, toggleListFold] = useListFold("bean.dashboard.listFolded");
  const [states, setStates] = useState<Record<string, RoutineStateView>>({});
  const [selectedKey, setSelectedKey] = useState<string | undefined>(undefined);
  const [openResolved, setOpenResolved] = useState<string[]>([]);
  // The latest run's digest is the one you came to read, so it starts open and the rest stay
  // shut; this list holds the runs flipped away from that default. Runs are newest-first, so
  // that's index 0.
  const [flippedDigests, setFlippedDigests] = useState<string[]>([]);
  // Same default for each run's flow diagram: the latest open, the rest behind "Show flow ▾".
  const [flippedFlows, setFlippedFlows] = useState<string[]>([]);
  const [reviewed, setReviewed] = useState<string[]>(() => readList(REVIEWED_KEY));
  const [flipped, setFlipped] = useState<string[]>(() => readList(FLIPPED_KEY));
  const [rerunning, setRerunning] = useState(false);
  const [notice, setNotice] = useState("");
  // Full step outputs live in bean.db, not the run record — fetched when a run's steps are opened,
  // or its flow is (for the shared-session badges). Keyed by recordId; `openOutputs` is which show.
  const [attempts, setAttempts] = useState<Record<string, StepAttemptView[]>>({});
  const [openOutputs, setOpenOutputs] = useState<string[]>([]);
  const loading = useRef(new Set<string>());
  const [copied, setCopied] = useState("");
  const [loaded, setLoaded] = useState(false);
  // A run Bean was asked to open (notification / avatar bubble click), held until it shows up in
  // the history: the bubble finishes before the scheduler writes the record, so a fast click can
  // arrive first. Its notice is separate from `notice`, which every selection change clears.
  const [pending, setPending] = useState<DashboardTarget | undefined>(undefined);
  const misses = useRef(0);
  const [deepNotice, setDeepNotice] = useState("");

  const refresh = async (): Promise<void> => {
    const [list, st] = await Promise.all([window.bean.routinesList(), window.bean.routinesState()]);
    setRoutines(list);
    setStates(st);
    setLoaded(true);
  };

  const openTarget = (target: DashboardTarget): void => {
    misses.current = 0;
    setDeepNotice("");
    setPending(target);
    void refresh();
  };

  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    window.bean.onDashboardTarget(openTarget);
    void window.bean.getPendingDashboardTarget().then((t) => { if (t) openTarget(t); });
  }, []);
  useEffect(() => {
    // Same 5s cadence as the Routines panel — a run that lands while the dashboard is open
    // should show up without a reopen.
    const t = setInterval(() => { void refresh(); }, 5000);
    return () => clearInterval(t);
  }, []);

  const runs = useMemo(() => flattenRuns(states), [states]);
  const days = useMemo(() => groupRuns(runs), [runs]);
  const buckets = useMemo(() => days.flatMap((d) => d.buckets), [days]);
  const reviewedSet = useMemo(() => new Set(reviewed), [reviewed]);
  const unreadIds = useMemo(
    () => new Set(unreadRuns(runs, reviewedSet).map((r) => r.id)),
    [runs, reviewedSet],
  );

  // The newest day's first routine is the default read — the dashboard opens on "what happened
  // last night". History is capped, so the selection can also roll out from under us on a poll;
  // fall back to the newest rather than leaving the detail pane blank.
  useEffect(() => {
    if (!pending && buckets[0] && !buckets.some((b) => b.key === selectedKey)) setSelectedKey(buckets[0].key);
  }, [buckets, selectedKey, pending]);
  useEffect(() => { setOpenResolved([]); setFlippedDigests([]); setNotice(""); setAttempts({}); setOpenOutputs([]); }, [selectedKey]);

  // Bucket-level landing: the target's day for that routine, whose newest run reads on top with its
  // digest open. No startedAt means the run itself wasn't recorded — show the routine's latest.
  useEffect(() => {
    if (!pending || !loaded) return;
    const key = pending.startedAt
      ? bucketKeyFor(pending.routine, pending.startedAt)
      : buckets.find((b) => b.routine === pending.routine)?.key;
    const hit = buckets.find((b) => b.key === key);
    if (hit) {
      setPending(undefined);
      setSelectedKey(hit.key);
      setFlippedDigests([]); // the same bucket again: still land with the newest digest open
      const i = days.findIndex((d) => d.date === hit.date);
      if (i >= 0 && dayOpenByDefault(i) === flipped.includes(hit.date)) toggleDay(hit.date); // folded: unfold
      if (!pending.startedAt) setDeepNotice("That run wasn't recorded — showing the latest recorded one.");
      return;
    }
    // Each refresh is a look: the immediate one plus a couple of polls covers the record landing.
    misses.current += 1;
    if (misses.current > 2) {
      setPending(undefined);
      setDeepNotice("That run isn't in the history anymore.");
    }
  }, [buckets, pending, loaded]);

  // A click in the rail is the user taking over: drop any target still waiting.
  const pick = (key: string): void => {
    setPending(undefined);
    setDeepNotice("");
    setSelectedKey(key);
  };

  const bucket: RunBucket | undefined = buckets.find((b) => b.key === selectedKey);
  const routine = routines.find((r) => r.name === bucket?.routine);
  const now = new Date();

  // Every run of the selected day, split into what needs you and what resolved. The NEEDS YOU
  // cards are numbered across the whole bucket so the morning has one end, not one per run.
  const runViews = useMemo(
    () => (bucket?.runs ?? []).map((run) => ({ run, ...splitSteps(run) })),
    [bucket],
  );
  const flowOpenAt = (run: DashRun, index: number): boolean => (index === 0) !== flippedFlows.includes(run.id);
  // An open flow badges the sessions its run's attempts shared — only delegate steps have one.
  useEffect(() => {
    if (!routine?.steps.some((s) => s.kind === "delegate")) return;
    runViews.forEach(({ run }, i) => { if (run.recordId && flowOpenAt(run, i)) void loadAttempts(run.recordId); });
  }, [runViews, flippedFlows, routine]);
  const unreadHere = (bucket?.runs ?? []).filter((r) => unreadIds.has(r.id)).length;
  const needsTotal = runViews.reduce((n, v) => n + v.needs.length, 0);
  const attentionTotal = runViews.filter((v) => v.run.status === "needs-attention").length;
  const resolvedTotal = runViews.reduce((n, v) => n + v.resolved.length, 0);
  const isNewest = bucket !== undefined && buckets[0]?.key === bucket.key;

  const toggle = (list: string[], set: (v: string[]) => void, key: string): void =>
    set(list.includes(key) ? list.filter((k) => k !== key) : [...list, key]);

  const toggleDay = (date: string): void => {
    setFlipped((prev) => {
      const next = prev.includes(date) ? prev.filter((k) => k !== date) : [...prev, date];
      writeList(FLIPPED_KEY, next);
      return next;
    });
  };

  // Reviewing is scoped to what's on screen — the day you just read, not every older day
  // still sitting unread in the rail.
  const markDayReviewed = (): void => {
    if (!bucket) return;
    const next = reviewRuns(reviewedSet, bucket.runs.map((r) => r.id), runs);
    writeList(REVIEWED_KEY, next);
    setReviewed(next);
  };

  const askBean = (run: DashRun, step: DashStep): void => {
    window.bean.runInChat(
      `${stepTitle(step)} in my sprout "${run.routine}" on its ${clock(run.startedAt)} run:\n\n` +
        `${step.summary}\n\nWhat happened, and what should I do about it?`,
      `Sprout: ${run.routine}`,
    );
  };

  const loadAttempts = async (runId: string): Promise<void> => {
    if (attempts[runId] || loading.current.has(runId)) return;
    loading.current.add(runId);
    const list = await window.bean.routinesAttempts(runId).catch(() => []);
    loading.current.delete(runId);
    setAttempts((prev) => ({ ...prev, [runId]: list }));
  };

  const toggleAttempts = (runId: string): void => {
    setOpenOutputs((open) => (open.includes(runId) ? open.filter((id) => id !== runId) : [...open, runId]));
    void loadAttempts(runId);
  };

  const copyResume = (command: string): void => {
    navigator.clipboard.writeText(command).then(() => setCopied(command), () => {});
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
    const last = b.runs[b.runs.length - 1]!; // oldest — runs are newest-first
    return (
      <div
        key={b.key}
        role="button"
        tabIndex={0}
        aria-pressed={selectedKey === b.key}
        class={`bean-skills-row bean-dash-row bean-dash-row--nested${selectedKey === b.key ? " bean-skills-row--selected" : ""}`}
        onClick={() => pick(b.key)}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          pick(b.key);
        }}
      >
        <span class={`bean-dash-dot bean-dash-dot--${b.needs > 0 ? "failed" : b.attention > 0 ? "needs-attention" : "ok"}`} />
        <div class="bean-skills-row-main">
          <div class="bean-skills-row-name">{b.routine}</div>
          <div class="bean-dash-row-sub">
            {plural(b.runs.length, "run")} · {clock(last.startedAt)}
            {b.runs.length > 1 ? ` → ${clock(b.runs[0]!.startedAt)}` : ""}
          </div>
        </div>
        {b.needs + b.attention > 0 ? <span class="bean-dash-row-badge">{b.needs + b.attention}</span> : null}
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
  // its digest. `index` is its position in the spine (0 = latest, read first); `ordinal` is its
  // chronological place in the day, so RUN 2 sits above RUN 1 rather than the top row claiming
  // to be the day's first. `firstNeed` is where this run's cards continue the day's count.
  const runSection = (view: (typeof runViews)[number], index: number, firstNeed: number) => {
    const { run, needs, resolved } = view;
    const attention = attentionOf(run);
    const loaded = run.recordId ? attempts[run.recordId] : undefined;
    const runAttempts = run.recordId && openOutputs.includes(run.recordId) ? loaded : undefined;
    const sessions = runAttempts ? attemptSessions(runAttempts, routine?.steps) : [];
    const sessionLine = runAttempts ? sessionSummary(runAttempts) : undefined;
    const ordinal = runViews.length - index;
    const resolvedOpen = openResolved.includes(run.id);
    const digestOpen = (index === 0) !== flippedDigests.includes(run.id);
    const flowOpen = flowOpenAt(run, index);
    const overlay = flowOpen && routine ? runFlowOverlay(run, routine.steps) : undefined;
    // Lanes from what this run's attempts shared, never today's `continues` — and none on a drifted run.
    const lanes = routine && loaded && overlay && overlay !== "drift" ? observedLanes(loaded, routine.steps.length) : undefined;
    return [
      spineRow(`${run.id}-head`, `run ${ordinal}`, "run", (
        <div class="bean-dash-run-head">
          <span class="bean-dash-run-time">{clock(run.startedAt)} → {clock(run.finishedAt)}</span>
          <span class="bean-dash-meta">
            {plural(run.steps.length, "step")} · {run.status === "ok" ? "healthy" : run.status === "needs-attention" ? "needs attention" : "failed"}
          </span>
          {run.steps.length > 0 ? <span class="bean-dash-path">{executedPath(run, routine?.steps)}</span> : null}
        </div>
      )),

      // The executed path above stays the text equivalent; the diagram adds what didn't run.
      ...(routine && routine.steps.length > 0 && run.steps.length > 0
        ? [spineRow(`${run.id}-flow`, "", "plain", (
            <div class="bean-dash-digest bean-dash-flow">
              <button
                type="button"
                class="bean-dash-digest-head"
                aria-expanded={flowOpen}
                onClick={() => toggle(flippedFlows, setFlippedFlows, run.id)}
              >
                <span class="bean-field-label">FLOW · RUN {ordinal}</span>
                <span class="bean-dash-resolved-toggle">{flowOpen ? "Hide ▴" : "Show flow ▾"}</span>
              </button>
              {overlay === "drift" ? <div class="bean-dash-flow-note">This sprout changed since this run</div> : null}
              {flowOpen ? <StepFlow steps={routine.steps} overlay={overlay === "drift" ? undefined : overlay} {...(lanes ? { lanes } : {})} /> : null}
            </div>
          ))]
        : []),

      ...(attention
        ? [spineRow(`${run.id}-attention`, "gate", "call", (
            <div class="bean-dash-card bean-dash-card--attention">
              <div class="bean-dash-card-tags">
                <span class="bean-dash-tag">NEEDS ATTENTION</span>
                <span class="bean-dash-meta">{run.routine} · run {ordinal}</span>
              </div>
              <div class="bean-dash-card-title">Stopped at {attention.at}{attention.verdict ? ` · VERDICT: ${attention.verdict}` : ""}</div>
              {attention.summary ? <div class="bean-dash-card-text">{attention.summary}</div> : null}
              <div class="bean-dash-card-actions">
                <button type="button" class="bean-btn" disabled={rerunning} onClick={() => void rerun()}>
                  {rerunning ? "Starting…" : "Retry"}
                </button>
                {notice ? <span class="bean-dash-notice">{notice}</span> : null}
              </div>
            </div>
          ))]
        : []),

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
                      <span class="bean-dash-meta">
                        {s.id ? pathName(s) : stepLabel(s)} · {s.kind}{s.cli ? ` · ${s.cli}` : ""}
                        {s.verdict ? ` · ${stepPassed(s) ? "✓" : "✗"} ${s.verdict}` : ""}
                      </span>
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
                disabled={rerunning}
                onClick={() => void rerun()}
              >
                {rerunning ? "Starting…" : "Run sprout again"}
              </button>
              {notice ? <span class="bean-dash-notice">{notice}</span> : null}
            </div>
          </div>
        )),
      ),

      ...(run.recordId
        ? [spineRow(`${run.id}-steps`, "", "plain", (
            <div class="bean-dash-digest">
              <button
                type="button"
                class="bean-dash-digest-head"
                aria-expanded={Boolean(runAttempts)}
                onClick={() => void toggleAttempts(run.recordId!)}
              >
                <span class="bean-field-label">FULL OUTPUT · RUN {ordinal}</span>
                <span class="bean-dash-resolved-toggle">{runAttempts ? "Hide ▴" : "Open ▾"}</span>
              </button>
              {runAttempts ? (
                runAttempts.length === 0 ? <div class="bean-dash-meta">No step output was kept for this run.</div>
                : (
                  <>
                    {sessionLine ? <div class="bean-dash-meta bean-dash-sessions">{sessionLine}</div> : null}
                    {runAttempts.map((a, k) => {
                      const { session, last, next, fresh } = sessions[k]!;
                      const following = next === undefined ? undefined : runAttempts[next];
                      const marks = [session === undefined ? "" : `session ${session}`, fresh ? "started fresh" : ""].filter(Boolean);
                      return (
                        <div key={k} class="bean-dash-attempt">
                          <span class="bean-dash-meta">
                            {attemptName(a)} · {a.kind}
                            {a.cli ? ` · ${a.cli}` : ""} · {stepPassed(a) ? "✓" : "✗"}{a.verdict ? ` ${a.verdict}` : ""}
                            {marks.length ? ` · ↻ ${marks.join(", ")}` : ""}
                          </span>
                          <pre class="bean-dash-attempt-out">{a.output}</pre>
                          {following ? <div class="bean-dash-meta">↻ continued in {attemptName(following)}</div> : null}
                          {/* One resume block per session: on its last attempt, where it carries on from. */}
                          {a.resume && last ? (
                            <div class="bean-dash-resume">
                              <code>{a.resume}</code>
                              <button type="button" class="bean-btn bean-btn--ghost" onClick={() => copyResume(a.resume!)}>
                                {copied === a.resume ? "Copied" : "Copy"}
                              </button>
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </>
                )
              ) : null}
            </div>
          ))]
        : []),

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
              {digestOpen ? <div class="bean-dash-digest-body"><Markdown text={run.digest} /></div> : null}
            </div>
          ))]
        : []),
    ];
  };

  let needCursor = 0;

  return (
    <div class={listFolded ? "bean-skills bean-skills--folded" : "bean-skills"}>
      <ListFoldToggle folded={listFolded} onToggle={toggleListFold} listId="bean-dashboard-list" />
      <div class="bean-skills-list" id="bean-dashboard-list">
        <div class="bean-skills-list-label">Runs · {runs.length}</div>
        {runs.length === 0 ? (
          <div class="bean-panel-empty">Nothing has run yet — sprouts report here once they finish.</div>
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
              {health.some((h) => h.status === "needs-attention") ? `, ${health.filter((h) => h.status === "needs-attention").length} need attention` : ""}
              {" · "}{nextRunText(routine, routine ? states[routine.name] : undefined)}
            </div>
            <button type="button" class="bean-dash-link" onClick={() => void window.bean.openComponent("routines")}>
              Open sprouts →
            </button>
          </div>
        ) : null}
      </div>

      <div class="bean-skills-detail">
        {deepNotice ? <div class="bean-dash-meta" role="status">{deepNotice}</div> : null}
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
                  {needsTotal + attentionTotal > 0
                    ? <b class="bean-dash-accent">{needsTotal + attentionTotal} need{needsTotal + attentionTotal === 1 ? "s" : ""} your call</b>
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

              {runViews.map((view, i) => {
                const rows = runSection(view, i, needCursor);
                needCursor += view.needs.length;
                return rows;
              })}
            </div>

            <div class="bean-dash-footer">
              <span>{nextRunText(routine, routine ? states[routine.name] : undefined)} — anything here stays until the history rolls over.</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
