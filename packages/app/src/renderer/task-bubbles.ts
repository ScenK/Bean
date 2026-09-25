import type { TaskJob } from "../task-status.js";

// Design 2a "speech bubble": one bubble per running job or failure, stacked above the bean, newest
// nearest the bean and the only one with a tail. Click a bubble to expand its detail (read-only);
// clicking an expanded failure dismisses it — failures stay until then.
const ICONS = {
  delegate: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  routine: '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v5h-5"/><path d="M12 7v5l3 3"/>',
  chat: '<path d="M7 12h.01"/><path d="M12 12h.01"/><path d="M17 12h.01"/>',
  bot: '<rect x="4" y="4" width="16" height="6" rx="1.5"/><rect x="4" y="14" width="16" height="6" rx="1.5"/><path d="M8 7h.01"/><path d="M8 17h.01"/>',
  reminder: '<path d="M6 16v-5a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 21h4"/>',
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
  if (j.state !== "running") return j.count && j.count > 1 ? `${j.state} ×${j.count}` : j.state;
  const elapsed = clock(now - j.startedAt);
  return j.steps && j.step !== undefined ? `${j.step + 1}/${j.steps.length} · ${elapsed}` : elapsed;
};

const iconKey = (j: TaskJob): keyof typeof ICONS => (j.state === "running" ? j.kind : j.state);

function bubble(j: TaskJob, open: boolean, quiet: boolean, tail: boolean, fresh: boolean, now: number): string {
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
  const detail = open && (j.detail || steps.length || failed)
    ? `<div class="bean-bubble-detail">${j.detail ? `<div class="bean-bubble-note">${esc(j.detail)}</div>` : ""}${stepRows ? `<div class="bean-bubble-steps">${stepRows}</div>` : ""}${hint}</div>`
    : "";
  const caret = running && j.kind === "delegate" ? '<span class="bean-bubble-caret"></span>' : "";
  return `
    <button type="button" class="bean-bubble bean-bubble--${j.state}${tail ? " bean-bubble--tail" : ""}${fresh ? " bean-bubble--new" : ""}" data-id="${esc(j.id)}" aria-expanded="${open}">
      <span class="bean-bubble-head">
        <span class="bean-bubble-icon bean-bubble-icon--${iconKey(j)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${ICONS[iconKey(j)]}</svg></span>
        <span class="bean-bubble-name">${esc(j.name)}</span>
        <span class="bean-bubble-meta" data-started="${j.startedAt}">${esc(meta(j, now))}</span>
      </span>
      ${quiet ? "" : `<span class="bean-bubble-line">${esc(j.line)}${caret}</span>`}
      ${bar}${detail}
    </button>`;
}

// A busy Discord channel can stack many turns at once; past this, the oldest fold into a
// "+N more" pill (which says how many of those failed, so a sticky error never hides silently).
export const MAX_VISIBLE = 4;

export function createTaskBubbles(container: HTMLElement, onHeight: (h: number) => void, onDismiss: (id: string) => void) {
  let jobs: TaskJob[] = [];
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
    if (jobs.length <= MAX_VISIBLE) showAll = false;
    const hidden = showAll ? [] : jobs.slice(0, Math.max(0, jobs.length - MAX_VISIBLE));
    const shown = jobs.slice(hidden.length);
    // An open job that left (or folded into the pill) would otherwise keep every visible one quiet.
    if (openId && !shown.some((j) => j.id === openId)) openId = undefined;
    const html = shown.map((j, i) =>
      bubble(j, j.id === openId, openId !== undefined && j.id !== openId, i === shown.length - 1, !seen.has(j.id), now));
    const failed = hidden.filter((j) => j.state === "failed").length;
    // Oldest end of the stack (farthest from the bean), so it lands there in either direction.
    if (hidden.length) html.unshift(`<button type="button" class="bean-bubble-more" aria-expanded="false">+${hidden.length} more${failed ? ` · ${failed} failed` : ""}</button>`);
    else if (showAll) html.unshift('<button type="button" class="bean-bubble-more" aria-expanded="true">Show fewer</button>');
    stack.innerHTML = (below ? html.reverse() : html).join("");
    seen = new Set(jobs.map((j) => j.id));
    if (focused) [...stack.querySelectorAll<HTMLElement>(".bean-bubble")].find((n) => n.dataset.id === focused)?.focus();
    else if (pillFocused) stack.querySelector<HTMLElement>(".bean-bubble-more")?.focus();
  };

  stack.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest(".bean-bubble-more")) {
      showAll = !showAll;
      render();
      return;
    }
    const id = (e.target as HTMLElement).closest<HTMLElement>(".bean-bubble")?.dataset.id;
    if (!id) return;
    if (openId === id && jobs.find((j) => j.id === id)?.state === "failed") onDismiss(id);
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
      jobs = next;
      render();
    },
    running: (): boolean => jobs.some((j) => j.state === "running"),
    /** From main's layout: which side of the bean, and how tall the stack may get before it scrolls. */
    setLayout(nextBelow: boolean, stackMax: number | undefined): void {
      stack.style.maxHeight = stackMax ? `${stackMax}px` : "";
      if (nextBelow === below) return;
      below = nextBelow;
      render();
    },
  };
}
