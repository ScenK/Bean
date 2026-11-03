import { useEffect, useRef, useState } from "preact/hooks";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import type { Project } from "@bean/core";
import type { TerminalEvent } from "../../../terminal-tasks.js";

// The chat's own terminal (#663): the shell lives in main (terminal-tasks.ts), this pane is its
// xterm view under the composer. Folded by default; Control+` (ChatWindow) toggles the shown chat's.

/** main's WRITE_LIMIT — a value import would pull terminal-tasks' node deps into the renderer. */
const WRITE_CHUNK = 64 * 1024;
export const TERMINAL_MIN = 120;
const STEP = 16;
const HEIGHT_KEY = "bean.chat.terminalHeight";

/** Control+` (US) or the ISO key in that spot, either Control, no other modifier. */
export function isTerminalToggle(e: KeyboardEvent): boolean {
  return e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && (e.code === "Backquote" || e.code === "IntlBackslash");
}

// The preload's onTerminalEvent can't unsubscribe: one subscription, routed by mount id.
const panes = new Map<string, (e: TerminalEvent) => void>();
let subscribed = false;
const listen = (mountId: string, cb: (e: TerminalEvent) => void): (() => void) => {
  if (!subscribed) {
    subscribed = true;
    window.bean.onTerminalEvent((e) => panes.get(e.mountId)?.(e));
  }
  panes.set(mountId, cb);
  return () => { panes.delete(mountId); };
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

type Strip = { kind: "exit"; text: string } | { kind: "error"; text: string };

export function TerminalPane({ mountId, open, projectPath, projects }: {
  mountId: string;
  /** Unfolded. Fold state is per chat and never persisted. */
  open: boolean;
  /** Where the shell starts ("" = scratch); read at each (re)start. */
  projectPath: string;
  projects: Project[];
}) {
  const paneRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<{ term: Terminal; fit: FitAddon } | null>(null);
  const bootRef = useRef<Promise<void> | null>(null);
  const startedRef = useRef(false);
  const animatingRef = useRef(false);
  const openRef = useRef(open);
  openRef.current = open;
  const projectRef = useRef(projectPath);
  projectRef.current = projectPath;
  const [visible, setVisible] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [height, setHeight] = useState<number | undefined>(savedHeight);
  const [dragging, setDragging] = useState(false);
  const [strip, setStrip] = useState<Strip | null>(null);
  const [startedIn, setStartedIn] = useState<string | undefined>(undefined);

  const shownPath = startedIn ?? projectPath;
  const name = shownPath ? projects.find((p) => p.path === shownPath)?.name ?? shownPath.split("/").pop() ?? shownPath : "Scratch";

  const fitNow = (): void => {
    const host = hostRef.current;
    const t = termRef.current;
    // Never at zero size (folded, hidden chat) or mid-fold: xterm would reflow to 1 column.
    if (!t || !host || animatingRef.current || host.clientWidth === 0 || host.clientHeight === 0) return;
    t.fit.fit();
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

  const boot = (): Promise<void> => bootRef.current ??= (async () => {
    await document.fonts.ready;
    const host = hostRef.current;
    if (!host) return;
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
      // OSC 8 hyperlinks go the same Cmd+click route; xterm's default would window.open them.
      linkHandler: { activate: openLink },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon(openLink));
    // OSC 52: no clipboard writes from whatever runs in the shell.
    term.parser.registerOscHandler(52, () => true);
    // ChatWindow's capture listener owns Control+`; this only keeps xterm from sending NUL.
    term.attachCustomKeyEventHandler((e) => !isTerminalToggle(e));
    term.onData((data) => {
      for (let i = 0; i < data.length; i += WRITE_CHUNK) window.bean.terminalWrite(data.slice(i, i + WRITE_CHUNK), mountId);
    });
    term.onResize(({ cols, rows }) => window.bean.terminalResize(cols, rows, mountId));
    term.open(host);
    termRef.current = { term, fit };
  })();

  const start = async (): Promise<void> => {
    const t = termRef.current;
    if (!t) return;
    setStrip(null);
    const path = projectRef.current;
    const res = await window.bean.terminalStart(path, t.term.cols, t.term.rows, mountId)
      .catch((err: unknown) => ({ error: `The terminal couldn't start: ${err instanceof Error ? err.message : String(err)}` }));
    if ("error" in res) setStrip({ kind: "error", text: res.error });
    else setStartedIn(path);
  };

  /** The pane reached its open size: fit once, start the shell the first time, take focus. */
  const settleOpen = async (): Promise<void> => {
    await boot();
    if (!openRef.current) return;
    fitNow();
    if (!startedRef.current) { startedRef.current = true; void start(); }
    termRef.current?.term.focus();
  };

  // Shell output and exit, theme flips (hidden panes too), size changes, teardown.
  useEffect(() => {
    const off = listen(mountId, (e) => {
      const t = termRef.current?.term;
      if (e.type === "data") {
        if (t) t.write(e.data, () => window.bean.terminalAck(e.data.length, mountId));
        else window.bean.terminalAck(e.data.length, mountId);
      } else if (e.type === "exit") {
        setStrip({ kind: "exit", text: `Shell exited (code ${e.code})` });
      }
    });
    const themeWatch = new MutationObserver(() => { if (termRef.current) termRef.current.term.options.theme = terminalTheme(); });
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    let frame = 0;
    // Pane drags, window resizes, the sidebar opening. (jsdom, in unit tests, has no ResizeObserver.)
    const sizeWatch = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fitNow);
    });
    if (hostRef.current) sizeWatch?.observe(hostRef.current);
    return () => {
      off();
      themeWatch.disconnect();
      sizeWatch?.disconnect();
      cancelAnimationFrame(frame);
      termRef.current?.term.dispose();
    };
  }, []);

  // Fold/unfold: ~160ms height animation (none under reduced motion); the folded pane is `hidden`.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; if (!open) return; }
    const reduced = reducedMotion();
    if (open) {
      if (height === undefined) setHeight(defaultHeight());
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

  const restart = (): void => {
    termRef.current?.term.reset();
    void start().then(() => termRef.current?.term.focus());
  };

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
      <div class="bean-term-head">{name}</div>
      <div class="bean-term-host" ref={hostRef} />
      {strip ? (
        <div class={`bean-term-strip${strip.kind === "error" ? " bean-term-strip--error" : ""}`}>
          <span class="bean-term-strip-text">{strip.text}</span>
          <button type="button" class="bean-btn bean-btn--ghost bean-term-strip-btn" onClick={restart}>
            {strip.kind === "error" ? "Retry" : "Restart"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
