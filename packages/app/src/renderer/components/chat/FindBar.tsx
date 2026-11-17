import { useEffect, useRef, useState } from "preact/hooks";
import { findRanges } from "./chat-find.js";

const ALL = "bean-find";
const CURRENT = "bean-find-current";
/** The message list of the chat on screen — a desktop chat or a synced one (only one is unhidden). */
const ROOT = ".bean-chat:not([hidden]) .bean-chat-scroll";

/** Cmd/Ctrl+F's find bar (#901) over the shown chat's messages. `seq` changes on every press, which
 * refocuses and selects the query. Highlights use the CSS Custom Highlight API under their own names
 * (chat-links.ts owns `bean-link`). */
export function FindBar({ seq, onClose }: { seq: number; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [count, setCount] = useState(0);
  const [current, setCurrent] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const rangesRef = useRef<Range[]>([]);
  const currentRef = useRef(0);
  const queryRef = useRef("");
  const backTo = useRef(document.activeElement).current; // focus to restore on close

  const root = (): Element | null => document.querySelector(ROOT);
  const unpaint = (): void => {
    if (typeof Highlight === "function") { CSS.highlights.delete(ALL); CSS.highlights.delete(CURRENT); }
  };
  const paint = (): void => {
    if (typeof Highlight !== "function") return;
    const ranges = rangesRef.current;
    const cur = ranges[currentRef.current];
    CSS.highlights.set(ALL, new Highlight(...ranges.filter((r) => r !== cur)));
    const hl = new Highlight(...(cur ? [cur] : []));
    hl.priority = 1;
    CSS.highlights.set(CURRENT, hl);
  };
  const reveal = (): void => {
    const r = rangesRef.current[currentRef.current];
    const list = root();
    if (!r || !list) return;
    const box = list.getBoundingClientRect();
    const at = r.getBoundingClientRect();
    if (at.top >= box.top && at.bottom <= box.bottom) return; // already on screen — no jump
    // Scroll the list only (clamped by the browser). scrollIntoView also scrolls every ancestor,
    // overflow:hidden included: a match near the end shoved the whole window up, blank below.
    list.scrollTop += at.top + at.height / 2 - (box.top + box.height / 2);
  };
  const select = (i: number, scroll: boolean): void => {
    currentRef.current = i;
    setCurrent(i);
    paint();
    if (scroll) reveal();
  };
  // `fresh`: a new query starts at the last match at or above the viewport's bottom; a live update
  // keeps the current index (clamped) and never scrolls.
  const search = (fresh: boolean): void => {
    const el = root();
    const ranges = el ? findRanges(el, queryRef.current) : [];
    rangesRef.current = ranges;
    setCount(ranges.length);
    if (!fresh) { select(Math.min(currentRef.current, Math.max(0, ranges.length - 1)), false); return; }
    const bottom = el?.getBoundingClientRect().bottom ?? 0;
    let i = 0;
    ranges.forEach((r, k) => { if (r.getBoundingClientRect().top < bottom) i = k; });
    select(i, true);
  };
  const step = (by: number): void => {
    const n = rangesRef.current.length;
    if (n) select((currentRef.current + by + n) % n, true);
  };

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [seq]);
  // Streaming output, an opened <details>, a new message: re-run, one pass per frame.
  useEffect(() => {
    const el = root();
    let frame = 0;
    const obs = new MutationObserver(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; search(false); });
    });
    if (el) obs.observe(el, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ["open"] });
    return () => {
      obs.disconnect();
      cancelAnimationFrame(frame);
      unpaint();
    };
  }, []);

  // Clears at once: Preact can run the unmount cleanup after the bar has left the DOM.
  const close = (): void => {
    unpaint();
    onClose();
    if (backTo instanceof HTMLElement && backTo.isConnected) backTo.focus();
  };
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.isComposing) return;
    if (e.key === "Escape") {
      e.preventDefault(); // the narrow window's sidebar overlay closes on an un-prevented Escape
      close();
    } else if (e.key === "Enter" && e.target === inputRef.current) {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    }
  };

  return (
    <div class="bean-find" role="search" onKeyDown={onKeyDown}>
      <input
        ref={inputRef}
        type="text"
        class="bean-find-input"
        aria-label="Find in chat"
        placeholder="Find in chat"
        value={query}
        onInput={(e) => {
          const v = (e.target as HTMLInputElement).value;
          setQuery(v);
          queryRef.current = v;
          search(true);
        }}
      />
      <span class="bean-find-count" role="status">
        {!query ? "" : count ? `${current + 1} of ${count}` : "No matches"}
      </span>
      <button type="button" class="bean-find-btn" aria-label="Previous match" title="Previous (⇧↩)" disabled={!count} onClick={() => step(-1)}>↑</button>
      <button type="button" class="bean-find-btn" aria-label="Next match" title="Next (↩)" disabled={!count} onClick={() => step(1)}>↓</button>
      <button type="button" class="bean-find-btn" aria-label="Close find" title="Close (Esc)" onClick={close}>✕</button>
    </div>
  );
}
