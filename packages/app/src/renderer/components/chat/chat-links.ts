import { useEffect } from "preact/hooks";

// Cmd+click on a URL or a local path printed in the chat log (#779). The token is found at click
// time from the text under the pointer — the Markdown is never rewritten. URLs go to the browser
// (terminalOpenLink), paths to main's chatOpenPath, which validates and resolves them.

export type LinkKind = "url" | "path";
export interface LinkToken { start: number; end: number; kind: LinkKind; value: string }

const URL_RE = /^https?:\/\/[^\s<>"'`]+$/i;
const LINE = "(?::\\d+(?::\\d+)?)?";
// Absolute, ~/, ./ or ../ — at least one name after the slash. `SPACED` = an inline code span's
// whole text, where the backticks delimit the path, so a space is part of it (My Project/out.md).
const ROOTED_RE = new RegExp(`^(?:~|\\.{1,2})?/[\\w.@+~%,=-]+(?:/[\\w.@+~%,=-]*)*${LINE}$`);
const SPACED_ROOTED_RE = new RegExp(`^(?:~|\\.{1,2})?/[\\w.@+~%,= -]*[\\w.@+~%,=-](?:/[\\w.@+~%,= -]*)*${LINE}$`);
// Bare relative: needs a slash and a file extension with a letter, so 1/2, 2026/11/10 and and/or stay text.
const RELATIVE_RE = new RegExp(`^[\\w.@+-]+(?:/[\\w.@+-]+)*/[\\w@+-][\\w.@+-]*\\.(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{1,10}${LINE}$`);

export function classifyLink(s: string, spaced = false): LinkKind | undefined {
  if (URL_RE.test(s)) return "url";
  return (spaced ? SPACED_ROOTED_RE : ROOTED_RE).test(s) || RELATIVE_RE.test(s) ? "path" : undefined;
}

const LEAD = new Set([..."([{<\"'`"]);
const TRAIL = new Set([...".,;:!?]}>\"'`"]);

/** `[start, end)` of a word with its surrounding punctuation trimmed. */
function trim(text: string, start: number, end: number): [number, number] {
  while (start < end && LEAD.has(text[start]!)) start++;
  for (;;) {
    const last = text[end - 1];
    if (end > start && last !== undefined && (TRAIL.has(last) || (last === ")" && !text.slice(start, end).includes("(")))) end--;
    else break;
  }
  return [start, end];
}

/** The absolute and `~/` paths in one terminal row (#780). Relative ones are never linked: the
 * shell's directory after a `cd` isn't tracked, so they can't be resolved safely. */
export function rootedPaths(text: string): LinkToken[] {
  const out: LinkToken[] = [];
  for (const m of text.matchAll(/\S+/g)) {
    const [start, end] = trim(text, m.index, m.index + m[0].length);
    const value = text.slice(start, end);
    if (/^~?\//.test(value) && classifyLink(value) === "path") out.push({ start, end, kind: "path", value });
  }
  return out;
}

/** The URL or path token around `offset` in `text`, trimmed of surrounding punctuation. */
export function linkAt(text: string, offset: number): LinkToken | undefined {
  const ws = (c: string | undefined): boolean => c === undefined || /\s/.test(c);
  let start = offset;
  let end = offset;
  while (start > 0 && !ws(text[start - 1])) start--;
  while (end < text.length && !ws(text[end])) end++;
  [start, end] = trim(text, start, end);
  if (offset < start || offset > end || start === end) return undefined;
  const value = text.slice(start, end);
  const kind = classifyLink(value);
  return kind ? { start, end, kind, value } : undefined;
}

// Never a link target: controls, anchors (handled by href), and the user's own messages.
const EXCLUDED = "a, button, input, textarea, select, summary, .bean-bubble--user";

interface Hit { range: Range; kind: LinkKind; value: string }

const inside = (rects: DOMRectList, x: number, y: number): boolean =>
  Array.from(rects).some((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);

/** The link under the point: an inline `<code>`'s whole text when it is one, else the word under
 * the caret. Only a point inside the token's own rectangles counts. */
export function hitAt(root: HTMLElement, x: number, y: number): Hit | undefined {
  const caret = document.caretRangeFromPoint?.(x, y);
  const node = caret?.startContainer;
  if (!caret || !node || node.nodeType !== Node.TEXT_NODE || !root.contains(node)) return undefined;
  const el = node.parentElement;
  if (!el || el.closest(EXCLUDED)) return undefined;
  const range = document.createRange();
  let hit: Hit | undefined;
  const code = el.closest("code");
  const whole = code && !code.closest("pre") ? (code.textContent ?? "").trim() : "";
  const wholeKind = whole ? classifyLink(whole, true) : undefined;
  if (code && wholeKind) {
    range.selectNodeContents(code);
    hit = { range, kind: wholeKind, value: whole };
  } else {
    const t = linkAt((node as Text).data, caret.startOffset);
    if (!t) return undefined;
    range.setStart(node, t.start);
    range.setEnd(node, t.end);
    hit = { range, kind: t.kind, value: t.value };
  }
  return inside(range.getClientRects(), x, y) ? hit : undefined;
}

const decode = (s: string): string => { try { return decodeURI(s); } catch { return s; } };
const HIGHLIGHT = "bean-link";

/** Cmd+click opens the hovered URL/path; while Cmd is held the hovered token is underlined (CSS
 * Custom Highlight API) and the cursor is a pointer. A non-http(s) anchor never navigates the window.
 * `allow` follows the core's capabilities (#812): a remote core opens neither paths nor (no pty) URLs. */
export function useCmdLinks(ref: { current: HTMLElement | null }, mountId: string, allow = { paths: true, urls: true }): void {
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const allowedAt = (x: number, y: number): Hit | undefined => {
      const hit = hitAt(root, x, y);
      return hit && (hit.kind === "url" ? allow.urls : allow.paths) ? hit : undefined;
    };
    const highlights = typeof Highlight === "function" ? CSS.highlights : undefined;
    let pointer: { x: number; y: number } | undefined;
    let owned = false; // several chats share the document's highlight registry
    const clear = (): void => {
      if (!owned) return;
      owned = false;
      highlights?.delete(HIGHLIGHT);
      root.classList.remove("bean-chat-scroll--link");
    };
    const show = (meta: boolean): void => {
      const hit = meta && pointer ? allowedAt(pointer.x, pointer.y) : undefined;
      if (!hit) { clear(); return; }
      highlights?.set(HIGHLIGHT, new Highlight(hit.range));
      root.classList.add("bean-chat-scroll--link");
      owned = true;
    };
    const onMove = (e: MouseEvent): void => { pointer = { x: e.clientX, y: e.clientY }; show(e.metaKey); };
    const onLeave = (): void => { pointer = undefined; clear(); };
    const onKey = (e: KeyboardEvent): void => { if (e.key === "Meta") show(e.type === "keydown"); };
    const onClick = (e: MouseEvent): void => {
      const a = (e.target as Element | null)?.closest?.("a[href]");
      if (a && root.contains(a)) {
        const href = a.getAttribute("href") ?? "";
        if (/^https?:\/\//i.test(href)) return; // main hands these to the browser
        e.preventDefault();
        if (e.metaKey && allow.paths) window.bean.chatOpenPath(decode(href), mountId);
        return;
      }
      if (!e.metaKey) return;
      const hit = allowedAt(e.clientX, e.clientY);
      if (!hit) return;
      e.preventDefault();
      if (hit.kind === "url") window.bean.terminalOpenLink(hit.value, mountId);
      else window.bean.chatOpenPath(hit.value, mountId);
    };
    root.addEventListener("mousemove", onMove);
    root.addEventListener("mouseleave", onLeave);
    root.addEventListener("scroll", clear);
    root.addEventListener("click", onClick);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    window.addEventListener("blur", clear);
    return () => {
      root.removeEventListener("mousemove", onMove);
      root.removeEventListener("mouseleave", onLeave);
      root.removeEventListener("scroll", clear);
      root.removeEventListener("click", onClick);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      window.removeEventListener("blur", clear);
      clear();
    };
  }, [mountId, allow.paths, allow.urls]);
}
