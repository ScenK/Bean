import { STOPPING_LINE, type TaskJob } from "@bean/host/task-status";
import type { DashboardTarget } from "../channels.js";

// Design 2a "speech bubble": one bubble per running job or failure, stacked above the bean, newest
// nearest the bean and the only one with a tail. Click a bubble to expand its detail (read-only);
// clicking an expanded failure dismisses it — failures stay until then. A memory bubble is the
// exception: its click opens Persona's "Just remembered" (where Undo lives) — never an undo itself,
// so a misclick can't lose data. A finished routine likewise: one click dismisses it and opens that
// run in the Dashboard, whose card is the lasting record of a failure. A chat's delegate or live
// session opens that chat (dismissing it once finished) — the chat shows its detail and output.
// The Home bubble (#961) opens Home and never dismisses: only draining the posts clears it.
// A running sprout's expanded detail carries the one control: Stop. It sits beside the bubble's
// <button> (a button can't nest one), overlaid on room reserved in the detail.
// While the pointer is over the stack, a change that adds, removes or reorders bubbles waits until
// it leaves: a 10s-lingering bubble vanishing under the cursor would slide its neighbour into the
// spot, and the click would land there (a memory bubble's click opening a delegate's chat). The
// shown bubbles' content and the Stop count still follow the latest list, so Stop never undersells.
// While a button is pressed on the stack, pushes don't touch the DOM at all (#1093): a click fires
// only when pointerdown and pointerup hit the same node, and a render in between detaches it, so
// Stop / open / expand would silently do nothing. They catch up right after the click.
const ICONS = {
  delegate: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  routine: '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v5h-5"/><path d="M12 7v5l3 3"/>',
  chat: '<path d="M7 12h.01"/><path d="M12 12h.01"/><path d="M17 12h.01"/>',
  bot: '<rect x="4" y="4" width="16" height="6" rx="1.5"/><rect x="4" y="14" width="16" height="6" rx="1.5"/><path d="M8 7h.01"/><path d="M8 17h.01"/>',
  reminder: '<path d="M6 16v-5a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 21h4"/>',
  live: '<path d="m5 8 4 4-4 4"/><path d="M12 17h7"/>',
  home: '<path d="M4 11l8-7 8 7"/><path d="M6 10v10h12V10"/>',
  memory: '<path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 3 5 3 3 0 0 0 5 1V5a3 3 0 0 0-3-1z"/><path d="M15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-3 5 3 3 0 0 1-5 1"/>',
  done: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  failed: '<path d="M12 7v6"/><path d="M12 17h.01"/>',
};

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const clock = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

const meta = (j: TaskJob, now: number): string => {
  if (j.kind === "home") return "";
  if (j.state !== "running") return j.count && j.count > 1 ? `${j.state} ×${j.count}` : j.state;
  const elapsed = clock(now - j.startedAt);
  return j.steps && j.step !== undefined ? `${j.step + 1}/${j.steps.length} · ${elapsed}` : elapsed;
};

/** The agent whose badge the pet wears: the newest still-running desktop live session's. */
export function liveBadgeAgent(jobs: readonly TaskJob[]): TaskJob["agent"] {
  let best: TaskJob | undefined;
  for (const j of jobs) {
    if (j.kind === "live" && j.state === "running" && j.agent && (!best || j.startedAt >= best.startedAt)) best = j;
  }
  return best?.agent;
}

const iconKey = (j: TaskJob): keyof typeof ICONS => (j.state === "running" || j.kind === "home" ? j.kind : j.state);

const opensRun = (j: TaskJob): boolean => j.kind === "routine" && j.state !== "running";
// A chat's delegate or live session: the chat is where you answer it ("Waiting for you").
const opensChat = (j: TaskJob): boolean => (j.kind === "live" || j.kind === "delegate") && j.mountId !== undefined;

function bubble(j: TaskJob, open: boolean, quiet: boolean, tail: boolean, fresh: boolean, now: number, stop?: string): string {
  const running = j.state === "running";
  const steps = j.steps ?? [];
  const bar = running && steps.length > 0 && j.step !== undefined
    ? `<div class="bean-bubble-bar"><div style="width:${Math.round(((j.step + 0.5) / steps.length) * 100)}%"></div></div>`
    : "";
  const stepRows = steps.map((label, i) => {
    const cls = !running || i < (j.step ?? 0) ? "done" : i === j.step ? "now" : "";
    const mark = cls === "now" ? "now" : cls === "done" && running ? "done" : "";
    return `<div class="bean-bubble-step bean-bubble-step--${cls || "todo"}"><span></span><span>${esc(label)}</span><span>${mark}</span></div>`;
  }).join("");
  const failed = j.state === "failed";
  const hint = failed ? '<div class="bean-bubble-hint">Click again to dismiss</div>' : "";
  const room = stop ? '<div class="bean-bubble-stop-room"></div>' : "";
  const detail = open && (j.detail || steps.length || failed || stop)
    ? `<div class="bean-bubble-detail">${j.detail ? `<div class="bean-bubble-note">${esc(j.detail)}</div>` : ""}${stepRows ? `<div class="bean-bubble-steps">${stepRows}</div>` : ""}${hint}${room}</div>`
    : "";
  const caret = running && (j.kind === "delegate" || j.kind === "live") ? '<span class="bean-bubble-caret"></span>' : "";
  // A finished routine doesn't expand, it navigates — the label keeps its name and result audible.
  const action = opensRun(j)
    ? `title="Open in Dashboard" aria-label="${esc(`${j.name} — ${j.line}. Open in Dashboard`)}"`
    : opensChat(j)
      ? `title="Open chat" aria-label="${esc(`${j.name} — ${j.line}. Open chat`)}"`
      : j.kind === "home"
        ? `title="${esc(`Open your chat with ${j.name}`)}" aria-label="${esc(`${j.line}. Open your chat with ${j.name}`)}"`
      : `aria-expanded="${open}"`;
  const html = `
    <button type="button" class="bean-bubble bean-bubble--${j.state}${tail ? " bean-bubble--tail" : ""}${fresh ? " bean-bubble--new" : ""}" data-id="${esc(j.id)}" ${action}>
      <span class="bean-bubble-head">
        <span class="bean-bubble-icon bean-bubble-icon--${iconKey(j)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${ICONS[iconKey(j)]}</svg></span>
        <span class="bean-bubble-name">${esc(j.name)}</span>
        <span class="bean-bubble-meta" data-started="${j.startedAt}">${esc(meta(j, now))}</span>
      </span>
      ${quiet ? "" : `<span class="bean-bubble-line">${esc(j.line)}${caret}</span>`}
      ${bar}${detail}
    </button>`;
  if (!stop || !j.routine) return html;
  const stopping = j.line === STOPPING_LINE;
  return `<div class="bean-bubble-item">${html}<button type="button" class="bean-bubble-stop" data-routine="${esc(j.routine)}"${stopping ? " disabled" : ""}>${stopping ? "Stopping…" : esc(stop)}</button></div>`;
}

/** The Stop label for an expanded bubble, or undefined when it gets none (only running sprouts do).
 * Stop ends every live run of the sprout, so say so when there's more than one. */
function stopLabel(j: TaskJob, jobs: readonly TaskJob[]): string | undefined {
  if (j.kind !== "routine" || j.state !== "running" || !j.routine) return undefined;
  const n = jobs.filter((x) => x.kind === "routine" && x.state === "running" && x.routine === j.routine).length;
  return n > 1 ? `Stop all ${n} runs` : "Stop";
}

// A busy Discord channel can stack many turns at once; past this, the oldest fold into a
// "+N more" pill (which says how many of those failed, so a sticky error never hides silently).
export const MAX_VISIBLE = 4;
/** How long the stack stays held after the pointer's last move over it. */
export const HOLD_MS = 10_000;

export function createTaskBubbles(
  container: HTMLElement, onHeight: (h: number) => void, onDismiss: (id: string) => void, onOpenMemory: () => void = () => {},
  onOpenRun: (target: DashboardTarget) => void = () => {},
  onOpenChat: (mountId: string) => void = () => {},
  onStop: (routine: string) => void = () => {},
  onOpenHome: () => void = () => {},
) {
  let jobs: TaskJob[] = []; // what's rendered
  let latest: TaskJob[] = []; // what main last sent
  let hovered = false;
  let openId: string | undefined;
  let showAll = false;
  // Pop-in plays once per job — every streamed output line re-renders the stack.
  let seen = new Set<string>();
  const stack = document.createElement("div");
  stack.className = "bean-bubble-stack";
  container.replaceChildren(stack);

  // Flipped below the bean, the DOM order reverses so the newest (tailed) bubble is still nearest
  // it — and is the first thing a scrolled stack shows.
  let below = false;

  const render = (): void => {
    const now = Date.now();
    // Streamed output re-renders every bubble; keep keyboard focus on the same job (or the pill).
    const active = document.activeElement as HTMLElement | null;
    const focused = active?.closest<HTMLElement>(".bean-bubble")?.dataset.id;
    const pillFocused = active?.classList.contains("bean-bubble-more") ?? false;
    // A focused Stop sits beside its bubble: keep focus on it (or on its bubble once it's disabled).
    const stopOf = active?.classList.contains("bean-bubble-stop")
      ? active.closest<HTMLElement>(".bean-bubble-item")?.querySelector<HTMLElement>(".bean-bubble")?.dataset.id : undefined;
    if (jobs.length <= MAX_VISIBLE) showAll = false;
    const fold = showAll ? 0 : Math.max(0, jobs.length - MAX_VISIBLE);
    let hidden = jobs.slice(0, fold);
    let shown = jobs.slice(fold);
    // The open bubble never folds (its Stop would vanish under the pointer): the oldest shown one
    // folds in its place, so the cap holds.
    const pinned = hidden.find((j) => j.id === openId);
    if (pinned) {
      hidden = [...hidden.filter((j) => j !== pinned), shown[0]!];
      shown = [pinned, ...shown.slice(1)];
    }
    // An open job that left (or folded into the pill) would otherwise keep every visible one quiet.
    if (openId && !shown.some((j) => j.id === openId)) openId = undefined;
    const html = shown.map((j, i) =>
      bubble(j, j.id === openId, openId !== undefined && j.id !== openId, i === shown.length - 1, !seen.has(j.id), now,
        j.id === openId ? stopLabel(j, latest) : undefined));
    const failed = hidden.filter((j) => j.state === "failed" && j.kind !== "home").length;
    const posts = hidden.find((j) => j.kind === "home")?.count ?? 0;
    // Oldest end of the stack (farthest from the bean), so it lands there in either direction.
    if (hidden.length) {
      html.unshift(`<button type="button" class="bean-bubble-more" aria-expanded="false">+${hidden.length} more${failed ? ` · ${failed} failed` : ""}${posts ? ` · ${posts} post${posts === 1 ? "" : "s"}` : ""}</button>`);
    }
    else if (showAll) html.unshift('<button type="button" class="bean-bubble-more" aria-expanded="true">Show fewer</button>');
    stack.innerHTML = (below ? html.reverse() : html).join("");
    seen = new Set(jobs.map((j) => j.id));
    const keep = focused ?? stopOf;
    if (keep || pillFocused) {
      const node = keep ? [...stack.querySelectorAll<HTMLElement>(".bean-bubble")].find((n) => n.dataset.id === keep) : undefined;
      const stop = stopOf ? node?.nextElementSibling as HTMLButtonElement | null | undefined : undefined;
      const target = stop && !stop.disabled ? stop : keep ? node : stack.querySelector<HTMLElement>(".bean-bubble-more");
      // The focused one left or folded away: land on the newest bubble rather than dropping focus.
      (target ?? stack.querySelector<HTMLElement>(".bean-bubble--tail"))?.focus();
    }
  };

  const sameIds = (a: readonly TaskJob[], b: readonly TaskJob[]): boolean =>
    a.length === b.length && a.every((j, i) => j.id === b[i]?.id);
  // A click is the user acting on what they see: drop the dismissed bubble and catch up at once.
  const dismiss = (id: string): void => {
    onDismiss(id);
    latest = latest.filter((j) => j.id !== id);
    jobs = latest;
  };
  let pressed = false; // a button is down on the stack: don't touch the DOM until the click is out
  let pending = false; // a push arrived while pressed
  // Bring the shown stack up to `latest`: the same bubbles in the same spots while hovered.
  const apply = (): void => {
    pending = false;
    if (hovered && !sameIds(jobs, latest)) {
      const byId = new Map(latest.map((j) => [j.id, j]));
      // Same bubbles in the same spots, fresh content; one that's gone stops reading as running.
      jobs = jobs.map((j) => byId.get(j.id) ?? (j.state === "running" ? { ...j, state: "done" as const } : j));
    } else jobs = latest;
    render();
  };
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  const release = (): void => {
    clearTimeout(holdTimer);
    hovered = false;
    pressed = false; // a missed pointerup can't freeze the stack past HOLD_MS or pointerleave
    if (jobs !== latest || pending) apply();
  };
  // Hiding the avatar (Cmd+W) doesn't always send pointerleave, and a stuck hold would hide new
  // bubbles — so a still pointer releases it too. ponytail: fixed HOLD_MS, a hide IPC if 10s bites.
  const hold = (): void => {
    hovered = true;
    clearTimeout(holdTimer);
    holdTimer = setTimeout(release, HOLD_MS);
  };
  // Movement only, not pointerenter: a still pointer that the stack grew (or the window resized)
  // under isn't reaching for a bubble, and holding then would keep new bubbles out (#970).
  stack.addEventListener("pointermove", hold);
  stack.addEventListener("pointerleave", release);
  stack.addEventListener("pointerdown", () => { pressed = true; hold(); });
  // The click dispatches right after pointerup (same task), so catch up on the next one.
  const unpress = (): void => {
    if (!pressed) return;
    pressed = false;
    setTimeout(() => { if (pending && !pressed) apply(); });
  };
  window.addEventListener("pointerup", unpress);
  window.addEventListener("pointercancel", unpress);

  stack.addEventListener("click", (e) => {
    const stop = (e.target as HTMLElement).closest<HTMLButtonElement>(".bean-bubble-stop");
    if (stop) {
      if (!stop.disabled && stop.dataset.routine) onStop(stop.dataset.routine);
      return;
    }
    // A near miss beside Stop lands on its reserved room inside the bubble: don't collapse it.
    if ((e.target as HTMLElement).closest(".bean-bubble-stop-room")) return;
    if ((e.target as HTMLElement).closest(".bean-bubble-more")) {
      showAll = !showAll;
      render();
      return;
    }
    const id = (e.target as HTMLElement).closest<HTMLElement>(".bean-bubble")?.dataset.id;
    if (!id) return;
    const job = jobs.find((j) => j.id === id);
    if (job?.kind === "memory") {
      dismiss(id);
      render();
      onOpenMemory();
      return;
    }
    if (job?.kind === "home") {
      // Only draining the posts clears it on main, so don't dismiss; just stop holding the stack so
      // main's drop of the bubble (posts read) renders at once instead of HOLD_MS later (#970).
      release();
      onOpenHome();
      return;
    }
    if (job && opensRun(job)) {
      dismiss(id);
      render();
      onOpenRun(job.runStartedAt ? { routine: job.name, startedAt: job.runStartedAt } : { routine: job.name });
      return;
    }
    if (job?.mountId && opensChat(job)) {
      if (job.state !== "running") { dismiss(id); render(); } // finished: the chat holds the result now
      onOpenChat(job.mountId);
      return;
    }
    if (openId === id && jobs.find((j) => j.id === id)?.state === "failed") dismiss(id);
    openId = openId === id ? undefined : id;
    render();
  });

  // Only the meta clocks tick; re-rendering whole bubbles every second would reset hover/focus.
  setInterval(() => {
    const now = Date.now();
    stack.querySelectorAll<HTMLElement>(".bean-bubble").forEach((node) => {
      const j = jobs.find((x) => x.id === node.dataset.id);
      const m = node.querySelector(".bean-bubble-meta");
      if (j && m) m.textContent = meta(j, now);
    });
  }, 1000);

  // Report the stack's height (tail included) so main can size the window around it; 0 = no jobs.
  new ResizeObserver(() => onHeight(jobs.length ? stack.offsetHeight : 0)).observe(stack);

  return {
    update(next: TaskJob[]): void {
      latest = next;
      if (pressed) pending = true;
      else apply();
    },
    running: (): boolean => latest.some((j) => j.state === "running"),
    /** From main's layout: which side of the bean, and how tall the stack may get before it scrolls. */
    setLayout(nextBelow: boolean, stackMax: number | undefined): void {
      stack.style.maxHeight = stackMax ? `${stackMax}px` : "";
      if (nextBelow === below) return;
      below = nextBelow;
      if (pressed) pending = true;
      else render();
    },
  };
}
