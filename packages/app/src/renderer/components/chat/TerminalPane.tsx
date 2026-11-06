import { useEffect, useRef, useState } from "preact/hooks";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import type { Project } from "@bean/core";
import type { TerminalEvent } from "../../../terminal-tasks.js";

// The chat's own terminals (#663, tabs #674): each shell lives in main (terminal-tasks.ts), this pane
// is their xterm views under the composer, one per tab. Folded by default; Control+` (ChatWindow)
// toggles the shown chat's, Cmd+T / Cmd+1…4 / Cmd+Shift+[ ] drive its tabs.

/** main's WRITE_LIMIT — a value import would pull terminal-tasks' node deps into the renderer. */
const WRITE_CHUNK = 64 * 1024;
export const TERMINAL_MIN = 120;
const STEP = 16;
const HEIGHT_KEY = "bean.chat.terminalHeight";
/** main's MAX_TABS. */
export const MAX_TABS = 4;

/** Control+` (US) or the ISO key in that spot, either Control, no other modifier. */
export function isTerminalToggle(e: KeyboardEvent): boolean {
  return e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && (e.code === "Backquote" || e.code === "IntlBackslash");
}

export type TabShortcut = { kind: "new" } | { kind: "select"; index: number } | { kind: "step"; by: 1 | -1 };
/** Cmd+T new tab, Cmd+1…4 jump, Cmd+Shift+[ / ] previous / next (key codes, so any layout). */
export function tabShortcut(e: KeyboardEvent): TabShortcut | undefined {
  if (!e.metaKey || e.ctrlKey || e.altKey) return undefined;
  if (e.shiftKey) {
    return e.code === "BracketLeft" ? { kind: "step", by: -1 } : e.code === "BracketRight" ? { kind: "step", by: 1 } : undefined;
  }
  if (e.code === "KeyT") return { kind: "new" };
  const digit = /^Digit([1-4])$/.exec(e.code);
  return digit ? { kind: "select", index: Number(digit[1]) - 1 } : undefined;
}

// The preload's onTerminalEvent can't unsubscribe: one subscription, routed by mount + tab id.
const panes = new Map<string, (e: TerminalEvent) => void>();
let subscribed = false;
const paneKey = (mountId: string, tabId: string): string => `${mountId} ${tabId}`;
const listen = (mountId: string, tabId: string, cb: (e: TerminalEvent) => void): (() => void) => {
  if (!subscribed) {
    subscribed = true;
    window.bean.onTerminalEvent((e) => panes.get(paneKey(e.mountId, e.tabId))?.(e));
  }
  const key = paneKey(mountId, tabId);
  panes.set(key, cb);
  return () => { panes.delete(key); };
};

// Theme tokens are oklch(); getComputedStyle returns them verbatim, xterm wants RGB — resolve
// through a 1×1 canvas (the same trick contrast.e2e.ts uses).
let ctx: CanvasRenderingContext2D | null = null;
function tokenHex(name: string, alpha = 1): string {
  if (!ctx) {
    const cv = document.createElement("canvas");
    cv.width = cv.height = 1;
    ctx = cv.getContext("2d", { willReadFrequently: true });
  }
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (!ctx || !value) return "#000000";
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = value;
  ctx.fillRect(0, 0, 1, 1);
  const d = ctx.getImageData(0, 0, 1, 1).data;
  const hex = (n: number): string => n.toString(16).padStart(2, "0");
  return `#${hex(d[0]!)}${hex(d[1]!)}${hex(d[2]!)}${alpha < 1 ? hex(Math.round(alpha * 255)) : ""}`;
}

const ANSI = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"] as const;
export function terminalTheme(): ITheme {
  const theme: Record<string, string> = {
    background: tokenHex("--bean-surface"),
    foreground: tokenHex("--bean-text"),
    cursor: tokenHex("--bean-accent-text"),
    cursorAccent: tokenHex("--bean-surface"),
    selectionBackground: tokenHex("--bean-accent", 0.3),
    selectionInactiveBackground: tokenHex("--bean-accent", 0.18),
    // The hover-only panel scrollbars (#643, shared.css): the same text-tinted thumb.
    scrollbarSliderBackground: tokenHex("--bean-text", 0.22),
    scrollbarSliderHoverBackground: tokenHex("--bean-text", 0.4),
    scrollbarSliderActiveBackground: tokenHex("--bean-text", 0.4),
  };
  for (const c of ANSI) {
    theme[c] = tokenHex(`--bean-ansi-${c}`);
    theme[`bright${c[0]!.toUpperCase()}${c.slice(1)}`] = tokenHex(`--bean-ansi-bright-${c}`);
  }
  return theme as ITheme;
}

const reducedMotion = (): boolean => matchMedia("(prefers-reduced-motion: reduce)").matches;
const savedHeight = (): number | undefined => {
  try {
    const n = Number(localStorage.getItem(HEIGHT_KEY));
    return Number.isFinite(n) && n >= TERMINAL_MIN ? n : undefined;
  } catch {
    return undefined;
  }
};

type Strip = { kind: "exit" | "error"; text: string } | { kind: "confirm"; text: string };
type Tab = {
  id: string;
  /** The foreground command (main's busy poll); none while the shell has the terminal. */
  command?: string;
  /** The shell's name, from its start: the idle title. */
  shell?: string;
  startedIn?: string;
  /** The shell is running (it counts toward keeping the chat mounted). */
  alive: boolean;
  /** Exited non-zero or by a signal: kept with Restart, dimmed, error dot. */
  failed: boolean;
  strip: Strip | null;
};
type View = { term: Terminal; fit: FitAddon; off: () => void; booted?: Promise<void>; started: boolean };

const tabTitle = (t: Tab): string => t.command ?? t.shell ?? "shell";

export function TerminalPane({ mountId, open, projectPath, projects, onOpenChange, onShells, shortcutRef }: {
  mountId: string;
  /** Unfolded. Fold state is per chat and never persisted. */
  open: boolean;
  /** Where a new shell starts ("" = scratch); read at each (re)start. */
  projectPath: string;
  projects: Project[];
  /** Fold (the last tab closed) or unfold (a tab shortcut while folded). */
  onOpenChange: (open: boolean) => void;
  /** How many tabs hold a running shell: any keeps the chat mounted. */
  onShells: (count: number) => void;
  /** Filled with this pane's tab-shortcut handler (ChatWindow → ChatSession → here). */
  shortcutRef: { current: ((s: TabShortcut) => void) | null };
}) {
  const paneRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const hosts = useRef(new Map<string, HTMLDivElement>()).current;
  const views = useRef(new Map<string, View>()).current;
  const [tabs, setTabsState] = useState<Tab[]>([]);
  const tabsRef = useRef<Tab[]>([]);
  const setTabs = (f: (prev: Tab[]) => Tab[]): void => { tabsRef.current = f(tabsRef.current); setTabsState(tabsRef.current); };
  const patchTab = (id: string, patch: Partial<Tab>): void => setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  const [active, setActiveState] = useState<string | undefined>(undefined);
  const activeRef = useRef<string | undefined>(undefined);
  /** The next activation focuses its shell (false: arrow keys keep focus in the tab list). */
  const focusShellRef = useRef(true);
  const setActive = (id: string | undefined, focusShell = true): void => {
    focusShellRef.current = focusShell;
    activeRef.current = id;
    setActiveState(id);
  };
  /** A Cmd+T while folded with tabs: add one once the pane is open. */
  const pendingNewRef = useRef(false);
  const animatingRef = useRef(false);
  const openRef = useRef(open);
  openRef.current = open;
  const onShellsRef = useRef(onShells);
  onShellsRef.current = onShells;
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;
  const projectRef = useRef(projectPath);
  projectRef.current = projectPath;
  const [visible, setVisible] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [height, setHeight] = useState<number | undefined>(savedHeight);
  const [dragging, setDragging] = useState(false);

  const current = tabs.find((t) => t.id === active);
  const shownPath = current?.startedIn ?? projectPath;
  const name = shownPath ? projects.find((p) => p.path === shownPath)?.name ?? shownPath.split("/").pop() ?? shownPath : "Scratch";
  const live = tabs.filter((t) => t.alive).length;
  const liveSent = useRef(0);
  useEffect(() => {
    if (live === liveSent.current) return;
    liveSent.current = live;
    onShellsRef.current(live);
  }, [live]);

  /** Fit the shown tab — never at zero size (folded, hidden chat) or mid-fold: xterm would reflow to 1 column. */
  const fitNow = (): void => {
    const id = activeRef.current;
    const host = id ? hosts.get(id) : undefined;
    const v = id ? views.get(id) : undefined;
    if (!v || !host || animatingRef.current || host.clientWidth === 0 || host.clientHeight === 0) return;
    v.fit.fit();
  };

  const defaultHeight = (): number => Math.round((paneRef.current?.parentElement?.clientHeight ?? 500) * 0.4);
  /** The tallest the pane may get while the chat log keeps TERMINAL_MIN. */
  const maxHeight = (): number => {
    const pane = paneRef.current;
    const log = pane?.parentElement?.querySelector<HTMLElement>(".bean-chat-scroll");
    return pane && log ? Math.max(TERMINAL_MIN, pane.offsetHeight + log.offsetHeight - TERMINAL_MIN) : TERMINAL_MIN;
  };
  const clamp = (h: number): number => Math.round(Math.min(Math.max(h, TERMINAL_MIN), maxHeight()));
  const persist = (h: number): void => { try { localStorage.setItem(HEIGHT_KEY, String(h)); } catch { /* unsaved */ } };

  /** A tab's xterm, opened into its host the first time the tab is shown (it needs a real size). */
  const boot = (id: string): Promise<void> | undefined => {
    const v = views.get(id);
    if (!v) return undefined;
    return v.booted ??= (async () => {
      await document.fonts.ready;
      const host = hosts.get(id);
      if (host && views.get(id) === v) v.term.open(host);
    })();
  };

  const makeView = (id: string): View => {
    const reduced = reducedMotion();
    const openLink = (e: MouseEvent, uri: string): void => { if (e.metaKey) window.bean.terminalOpenLink(uri, mountId); };
    const term = new Terminal({
      fontFamily: "ui-monospace, Menlo, monospace",
      fontSize: 12,
      lineHeight: 1.2,
      cursorStyle: "bar",
      cursorBlink: !reduced,
      minimumContrastRatio: 4.5,
      macOptionClickForcesSelection: true,
      allowProposedApi: false,
      theme: terminalTheme(),
      // xterm draws its own scrollbar, sized by the ruler width (default 14px): match the sidebar
      // list's 6px gutter (shared.css .bean-term-host hides the ruler itself and pills the thumb).
      overviewRuler: { width: 6 },
      // OSC 8 hyperlinks go the same Cmd+click route; xterm's default would window.open them.
      linkHandler: { activate: openLink },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon(openLink));
    // OSC 52: no clipboard writes from whatever runs in the shell.
    term.parser.registerOscHandler(52, () => true);
    // ChatWindow's capture listener owns Control+` and the tab shortcuts; this only keeps xterm off them.
    term.attachCustomKeyEventHandler((e) => !isTerminalToggle(e) && !tabShortcut(e));
    term.onData((data) => {
      for (let i = 0; i < data.length; i += WRITE_CHUNK) window.bean.terminalWrite(data.slice(i, i + WRITE_CHUNK), mountId, id);
    });
    term.onResize(({ cols, rows }) => window.bean.terminalResize(cols, rows, mountId, id));
    // Output of every tab, shown or not, is written and acked: a background dev server never stalls.
    const off = listen(mountId, id, (e) => {
      if (e.type === "data") term.write(e.data, () => window.bean.terminalAck(e.data.length, mountId, id));
      else if (e.type === "busy") patchTab(id, { command: e.command });
      else if (e.code === 0 && !e.signal) removeTab(id);
      else {
        const why = e.signal ? `signal ${e.signal}` : `code ${e.code}`;
        patchTab(id, { alive: false, failed: true, command: undefined, strip: { kind: "exit", text: `Shell exited (${why})` } });
      }
    });
    return { term, fit, off, started: false };
  };

  const addTab = (): void => {
    if (tabsRef.current.length >= MAX_TABS) return;
    const id = crypto.randomUUID();
    views.set(id, makeView(id));
    setTabs((prev) => [...prev, { id, alive: false, failed: false, strip: null }]);
    setActive(id);
  };

  /** Drop a tab from the view (its shell is gone or being stopped); the last one folds the pane. */
  function removeTab(id: string): void {
    const v = views.get(id);
    views.delete(id);
    v?.off();
    v?.term.dispose();
    const prev = tabsRef.current;
    const i = prev.findIndex((t) => t.id === id);
    if (i < 0) return;
    const rest = prev.filter((t) => t.id !== id);
    setTabs(() => rest);
    if (activeRef.current === id) setActive((rest[i] ?? rest[i - 1])?.id);
    if (rest.length === 0 && openRef.current) onOpenChangeRef.current(false);
  }

  const start = async (id: string): Promise<void> => {
    const v = views.get(id);
    if (!v) return;
    v.started = true;
    patchTab(id, { strip: null });
    const path = projectRef.current;
    const res = await window.bean.terminalStart(path, v.term.cols, v.term.rows, mountId, id)
      .catch((err: unknown) => ({ error: `The terminal couldn't start: ${err instanceof Error ? err.message : String(err)}` }));
    if (views.get(id) !== v) return; // closed meanwhile (its stop already dropped the start)
    if ("error" in res) patchTab(id, { strip: { kind: "error", text: res.error } });
    else patchTab(id, { alive: true, failed: false, startedIn: path, shell: res.shell });
  };

  /** The pane is at its open size (or the shown tab changed): fit, start the tab's shell the first time, focus it. */
  const settleOpen = async (): Promise<void> => {
    if (!openRef.current || animatingRef.current) return;
    if (pendingNewRef.current || tabsRef.current.length === 0) {
      pendingNewRef.current = false;
      addTab(); // re-enters through the activation effect
      return;
    }
    const id = activeRef.current;
    if (!id) return;
    await boot(id);
    const v = views.get(id);
    if (!openRef.current || activeRef.current !== id || !v) return;
    fitNow();
    // Focus once the shell is up: keys typed before main has the tab are dropped.
    if (!v.started) await start(id);
    if (focusShellRef.current && activeRef.current === id && views.get(id) === v) v.term.focus();
  };

  // A tab shown: fit it (inactive tabs were hidden), start it if new, take focus.
  useEffect(() => { if (active) void settleOpen(); }, [active]);

  const select = (index: number, focusShell = true): void => {
    const t = tabsRef.current[index];
    if (!t) return;
    if (t.id === activeRef.current) { if (focusShell) views.get(t.id)?.term.focus(); return; }
    setActive(t.id, focusShell);
  };
  const shortcut = (s: TabShortcut): void => {
    if (!openRef.current) {
      // Folded: unfold first. Cmd+T with no tabs needs nothing more — the unfold opens one.
      if (s.kind === "new" && tabsRef.current.length > 0 && tabsRef.current.length < MAX_TABS) pendingNewRef.current = true;
      if (s.kind === "select") { const t = tabsRef.current[s.index]; if (t) setActive(t.id); }
      onOpenChangeRef.current(true);
      return;
    }
    const n = tabsRef.current.length;
    if (s.kind === "new") addTab();
    else if (s.kind === "select") select(s.index);
    else if (n > 0) {
      const i = tabsRef.current.findIndex((t) => t.id === activeRef.current);
      select((i + s.by + n) % n);
    }
  };
  shortcutRef.current = shortcut;

  /** ×: an idle (or exited) tab closes at once; a busy one asks first on its strip. */
  const closeTab = async (id: string): Promise<void> => {
    const t = tabsRef.current.find((x) => x.id === id);
    if (!t) return;
    const [running] = t.alive ? await window.bean.terminalRunning(mountId, id).catch(() => []) : [];
    if (running) {
      setActive(id);
      patchTab(id, { strip: { kind: "confirm", text: `${running} is running — closing stops it.` } });
      return;
    }
    stopTab(id);
  };
  const stopTab = (id: string): void => {
    removeTab(id);
    void window.bean.terminalStop(mountId, id).catch(() => undefined);
  };

  // Theme flips (hidden panes too), size changes, teardown.
  useEffect(() => {
    const themeWatch = new MutationObserver(() => {
      const theme = terminalTheme();
      for (const v of views.values()) v.term.options.theme = theme;
    });
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    let frame = 0;
    // Pane drags, window resizes, the sidebar opening. (jsdom, in unit tests, has no ResizeObserver.)
    const sizeWatch = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fitNow);
    });
    if (bodyRef.current) sizeWatch?.observe(bodyRef.current);
    return () => {
      themeWatch.disconnect();
      sizeWatch?.disconnect();
      cancelAnimationFrame(frame);
      for (const v of views.values()) { v.off(); v.term.dispose(); }
      views.clear();
    };
  }, []);

  // Fold/unfold: ~160ms height animation (none under reduced motion); the folded pane is `hidden`.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; if (!open) return; }
    const reduced = reducedMotion();
    if (open) {
      if (height === undefined) setHeight(defaultHeight());
      focusShellRef.current = true;
      // xterm opens at settleOpen, once the pane has its size; the surface is painted meanwhile.
      setVisible(true);
      if (reduced) {
        animatingRef.current = false;
        setExpanded(true);
        requestAnimationFrame(() => void settleOpen());
      } else {
        animatingRef.current = true;
        // Two frames: the unhidden pane lays out at 0 before the height change can transition.
        requestAnimationFrame(() => requestAnimationFrame(() => setExpanded(true)));
      }
    } else {
      pendingNewRef.current = false;
      setExpanded(false);
      if (reduced || !visible) { animatingRef.current = false; setVisible(false); }
      else animatingRef.current = true;
    }
  }, [open]);

  const onTransitionEnd = (e: TransitionEvent): void => {
    if (e.target !== paneRef.current || e.propertyName !== "height") return;
    animatingRef.current = false;
    if (openRef.current) void settleOpen();
    else setVisible(false);
  };
  const resizeTo = (h: number, save: boolean): void => {
    const next = clamp(h);
    setHeight(next);
    if (save) persist(next);
  };
  const onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const startH = paneRef.current?.offsetHeight ?? height ?? defaultHeight();
    setDragging(true);
    const move = (ev: PointerEvent): void => resizeTo(startH + (startY - ev.clientY), false);
    const up = (ev: PointerEvent): void => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      setDragging(false);
      resizeTo(startH + (startY - ev.clientY), true);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };
  const onHandleKey = (e: KeyboardEvent): void => {
    const cur = paneRef.current?.offsetHeight ?? height ?? defaultHeight();
    if (e.key === "ArrowUp") resizeTo(cur + STEP, true);
    else if (e.key === "ArrowDown") resizeTo(cur - STEP, true);
    else return;
    e.preventDefault();
  };
  const resetHeight = (): void => {
    try { localStorage.removeItem(HEIGHT_KEY); } catch { /* nothing saved */ }
    setHeight(clamp(defaultHeight()));
  };

  const restart = (id: string): void => {
    views.get(id)?.term.reset();
    focusShellRef.current = true;
    void start(id).then(() => { if (activeRef.current === id) views.get(id)?.term.focus(); });
  };

  // Arrow keys move along the tab list (focus stays there), Delete closes the focused tab.
  const onTabKey = (e: KeyboardEvent, index: number): void => {
    const n = tabsRef.current.length;
    let to: number | undefined;
    if (e.key === "ArrowRight") to = (index + 1) % n;
    else if (e.key === "ArrowLeft") to = (index - 1 + n) % n;
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = n - 1;
    else if (e.key === "Delete") { const t = tabsRef.current[index]; if (t) void closeTab(t.id); }
    else return;
    e.preventDefault();
    if (to === undefined) return;
    select(to, false);
    const id = tabsRef.current[to]?.id;
    requestAnimationFrame(() => paneRef.current?.querySelector<HTMLElement>(`[data-tab="${id}"]`)?.focus());
  };

  const full = tabs.length >= MAX_TABS;
  const strip = current?.strip;
  return (
    <div
      ref={paneRef}
      class={`bean-term${dragging ? " bean-term--drag" : ""}`}
      hidden={!visible}
      style={{ height: expanded ? `${height ?? TERMINAL_MIN}px` : "0px" }}
      onTransitionEnd={onTransitionEnd}
    >
      <div
        class="bean-term-handle"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize terminal"
        aria-valuemin={TERMINAL_MIN}
        aria-valuenow={height}
        tabIndex={0}
        title="Drag to resize · double-click to reset"
        onPointerDown={onPointerDown}
        onDblClick={resetHeight}
        onKeyDown={onHandleKey}
      />
      <div class="bean-term-head">
        <div class="bean-term-tabs" role="tablist" aria-label="Terminals">
          {tabs.map((t, i) => {
            const on = t.id === active;
            const title = tabTitle(t);
            const state = t.command ? ", running" : t.failed ? ", exited" : "";
            return (
              <div key={t.id} role="presentation" class={`bean-term-tab${on ? " bean-term-tab--on" : ""}${t.failed ? " bean-term-tab--failed" : ""}`}>
                <button
                  type="button"
                  role="tab"
                  id={`bean-term-tab-${t.id}`}
                  data-tab={t.id}
                  class="bean-term-tab-btn"
                  aria-selected={on}
                  aria-controls={`bean-term-panel-${t.id}`}
                  aria-label={`${title}${state}`}
                  tabIndex={on ? 0 : -1}
                  title={title}
                  onClick={() => select(i)}
                  onKeyDown={(e) => onTabKey(e, i)}
                >
                  <span class="bean-term-tab-num" aria-hidden="true">{i + 1}</span>
                  <span class="bean-term-tab-title" aria-hidden="true">{title}</span>
                  {t.command || t.failed ? <span class="bean-term-tab-dot" aria-hidden="true" /> : null}
                </button>
                <button
                  type="button"
                  class="bean-term-tab-close"
                  tabIndex={-1}
                  aria-label={`Close terminal ${i + 1}`}
                  title="Close terminal"
                  onClick={() => void closeTab(t.id)}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
        <button
          type="button"
          class="bean-term-new"
          aria-label="New terminal"
          aria-disabled={full}
          title={full ? `${MAX_TABS} terminals per chat` : "New terminal (⌘T)"}
          onClick={() => { if (!full) addTab(); }}
        >
          +
        </button>
        <span class="bean-term-project" title={shownPath || undefined}>{name}</span>
      </div>
      <div class="bean-term-body" ref={bodyRef}>
        {tabs.map((t) => (
          <div
            key={t.id}
            id={`bean-term-panel-${t.id}`}
            class="bean-term-host"
            role="tabpanel"
            aria-labelledby={`bean-term-tab-${t.id}`}
            hidden={t.id !== active}
            ref={(el) => { if (el) hosts.set(t.id, el); else hosts.delete(t.id); }}
          />
        ))}
      </div>
      {strip && current ? (
        <div class={`bean-term-strip${strip.kind === "error" ? " bean-term-strip--error" : ""}`}>
          <span class="bean-term-strip-text">{strip.text}</span>
          {strip.kind === "confirm" ? (
            <>
              <button type="button" class="bean-btn bean-term-strip-btn" onClick={() => stopTab(current.id)}>Stop & close</button>
              <button type="button" class="bean-btn bean-btn--ghost bean-term-strip-btn" onClick={() => patchTab(current.id, { strip: null })}>Cancel</button>
            </>
          ) : (
            <button type="button" class="bean-btn bean-btn--ghost bean-term-strip-btn" onClick={() => restart(current.id)}>
              {strip.kind === "error" ? "Retry" : "Restart"}
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}
