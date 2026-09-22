import { useEffect, useMemo, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import type { Routine } from "@bean/core";
import { nextRun } from "@bean/core/cron";
import { Markdown } from "../../shared/Markdown.js";
import { PanelEmptyState } from "../../shared/PanelEmptyState.js";
import { flattenRuns, splitSteps, unreadRuns, type DashRun, type DashStep } from "./runs.js";
import type { RoutineStateView } from "../../../ipc.js";

// Renderer-only view pref (see .memory/convention-renderer-view-prefs-in-localstorage.md):
// "I've seen everything up to here". Nothing in main or another surface needs it.
const REVIEWED_KEY = "bean.dashboard.reviewedAt";
const readReviewed = (): string | null => {
  try { return localStorage.getItem(REVIEWED_KEY); } catch { return null; }
};

const pad2 = (n: number): string => String(n).padStart(2, "0");
const clock = (iso: string): string => {
  const d = new Date(iso);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
const dayLabel = (iso: string, now: Date): string => {
  const d = new Date(iso);
  const startOfDay = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Last night";
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
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

// 4a "Night-shift ledger, panel form": rail of runs on the left, one time spine on the right.
// The only thing a run can genuinely ask of you is a failed step, so failures become the
// numbered "needs you" cards and every step that passed collapses into one resolved line.
export function DashboardPanel() {
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [states, setStates] = useState<Record<string, RoutineStateView>>({});
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [resolvedOpen, setResolvedOpen] = useState(false);
  const [digestOpen, setDigestOpen] = useState(false);
  const [reviewedAt, setReviewedAt] = useState<string | null>(readReviewed());

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
  const unread = useMemo(() => unreadRuns(runs, reviewedAt), [runs, reviewedAt]);
  const unreadIds = useMemo(() => new Set(unread.map((r) => r.id)), [unread]);

  // Newest run is the default read — the dashboard opens on "what happened last night".
  useEffect(() => {
    if (!selectedId && runs[0]) setSelectedId(runs[0].id);
  }, [runs, selectedId]);
  useEffect(() => { setResolvedOpen(false); setDigestOpen(false); }, [selectedId]);

  const run: DashRun | undefined = runs.find((r) => r.id === selectedId);
  const { needs, resolved } = splitSteps(run);
  const routine = routines.find((r) => r.name === run?.routine);
  const isNewest = run !== undefined && runs[0]?.id === run.id;
  const now = new Date();

  const markAllReviewed = (): void => {
    const stamp = new Date().toISOString();
    try { localStorage.setItem(REVIEWED_KEY, stamp); } catch { /* private mode — badge just stays */ }
    setReviewedAt(stamp);
  };

  const askBean = (step: DashStep): void => {
    if (!run) return;
    window.bean.runInChat(
      `Step ${step.index + 1} of my routine "${run.routine}" failed on its ${clock(run.startedAt)} run:\n\n` +
        `${step.summary}\n\nWhat happened, and what should I do about it?`,
      `Routine: ${run.routine}`,
    );
  };

  const rerun = async (): Promise<void> => {
    if (run) await window.bean.routinesRunNow(run.routine);
    await refresh();
  };

  const runRow = (r: DashRun) => {
    const failed = r.steps.filter((s) => !s.ok).length;
    return (
      <div
        key={r.id}
        class={`bean-skills-row bean-dash-row${selectedId === r.id ? " bean-skills-row--selected" : ""}`}
        onClick={() => setSelectedId(r.id)}
      >
        <span class={`bean-dash-dot bean-dash-dot--${r.status}`} />
        <div class="bean-skills-row-main">
          <div class="bean-skills-row-name">{dayLabel(r.startedAt, now)} · {r.routine}</div>
          <div class="bean-dash-row-sub">
            {clock(r.startedAt)} → {clock(r.finishedAt)} · {r.steps.length} step{r.steps.length === 1 ? "" : "s"}
          </div>
        </div>
        {failed > 0 ? <span class="bean-dash-row-badge">{failed}</span> : null}
        {unreadIds.has(r.id) ? <span class="bean-dash-row-unread" title="Not reviewed yet" /> : null}
      </div>
    );
  };

  // Routine health: the selected routine's last runs, oldest-left, as one ok/failed bar each.
  const health = [...(run ? (states[run.routine]?.history ?? []) : [])].reverse();

  const spineRow = (time: string, kind: "plain" | "call" | "end", body: ComponentChildren) => (
    <>
      <div class={`bean-dash-time bean-dash-time--${kind}`}>{time}</div>
      <div class="bean-dash-rail">
        <span class={`bean-dash-node bean-dash-node--${kind}`} />
        <span class="bean-dash-line" />
      </div>
      <div class="bean-dash-body">{body}</div>
    </>
  );

  return (
    <div class="bean-skills">
      <div class="bean-skills-list">
        <div class="bean-skills-list-label">Runs · {runs.length}</div>
        {runs.length === 0 ? (
          <div class="bean-panel-empty">Nothing has run yet — routines report here once they finish.</div>
        ) : (
          runs.map(runRow)
        )}
        <span class="bean-skills-spacer" />
        {run ? (
          <div class="bean-dash-health">
            <div class="bean-field-label">ROUTINE HEALTH</div>
            <div class="bean-dash-health-bars">
              {health.map((h) => (
                <span key={h.startedAt} class={`bean-dash-health-bar bean-dash-health-bar--${h.status}`} />
              ))}
            </div>
            <div class="bean-dash-health-text">
              {health.length} run{health.length === 1 ? "" : "s"}, {health.filter((h) => h.status === "failed").length} failed
              {" · "}{nextRunText(routine)}
            </div>
            <button type="button" class="bean-dash-link" onClick={() => void window.bean.openComponent("routines")}>
              Open routines →
            </button>
          </div>
        ) : null}
      </div>

      <div class="bean-skills-detail">
        {!run ? (
          <PanelEmptyState message="Pick a run to read what Bean did while you were away." />
        ) : (
          <>
            <div class="bean-dash-header">
              <span class="bean-dash-orb" />
              <div class="bean-dash-header-main">
                <h2 class="bean-dash-title">
                  {dayLabel(run.startedAt, now)}, {clock(run.startedAt)} → {clock(run.finishedAt)}
                </h2>
                <div class="bean-dash-header-sub">
                  {needs.length > 0
                    ? <b class="bean-dash-accent">{needs.length} need{needs.length === 1 ? "s" : ""} your call</b>
                    : "nothing needs you"}
                  {" · "}{resolved.length} resolved without you
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
              {spineRow(clock(run.startedAt), "plain", (
                <div class="bean-dash-plain">
                  <span>Routine started · {run.steps.length} step{run.steps.length === 1 ? "" : "s"} in scope</span>
                  <span class="bean-dash-meta">{run.routine}</span>
                </div>
              ))}

              {resolved.length > 0
                ? spineRow("", "plain", (
                    <div class="bean-dash-resolved">
                      <button
                        type="button"
                        class="bean-dash-resolved-head"
                        aria-expanded={resolvedOpen}
                        onClick={() => setResolvedOpen(!resolvedOpen)}
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
                              <span class="bean-dash-meta">step {s.index + 1} · {s.kind}</span>
                              <span>{s.summary}</span>
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ))
                : null}

              {needs.map((s, i) =>
                spineRow(`step ${s.index + 1}`, "call", (
                  <div class="bean-dash-card">
                    <div class="bean-dash-card-tags">
                      <span class="bean-dash-tag">NEEDS YOU · {i + 1} OF {needs.length}</span>
                      <span class="bean-dash-meta">{run.routine} · {s.kind} step</span>
                    </div>
                    <div class="bean-dash-card-title">Step {s.index + 1} failed</div>
                    <div class="bean-dash-card-text">{s.summary}</div>
                    <div class="bean-dash-card-actions">
                      <button type="button" class="bean-btn" onClick={() => askBean(s)}>
                        Ask Bean
                      </button>
                      <button type="button" class="bean-btn bean-btn--ghost" onClick={() => void rerun()}>
                        Run routine again
                      </button>
                    </div>
                  </div>
                )),
              )}

              {spineRow(clock(run.finishedAt), "end", (
                <div class="bean-dash-plain">
                  <span>
                    Routine finished · {run.steps.filter((s) => s.ok).length} of {run.steps.length} steps ok
                  </span>
                  <span class="bean-dash-meta">{run.status === "ok" ? "healthy" : "failed"}</span>
                </div>
              ))}

              {isNewest
                ? spineRow("now", "end", (
                    <div class="bean-dash-here">
                      <span class="bean-dash-here-text">YOU ARE HERE · {clock(now.toISOString())}</span>
                      <span class="bean-dash-here-line" />
                    </div>
                  ))
                : null}
            </div>

            {run.digest ? (
              <div class="bean-dash-digest">
                <button
                  type="button"
                  class="bean-dash-digest-head"
                  aria-expanded={digestOpen}
                  onClick={() => setDigestOpen(!digestOpen)}
                >
                  <span class="bean-field-label">FULL DIGEST</span>
                  <span class="bean-dash-resolved-toggle">{digestOpen ? "Hide ▴" : "Read ▾"}</span>
                </button>
                {digestOpen ? <Markdown text={run.digest} /> : null}
              </div>
            ) : null}

            <div class="bean-dash-footer">
              <span>{nextRunText(routine)} — anything here stays until the history rolls over.</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
