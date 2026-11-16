// Find in the shown chat (#901): the literal, case-insensitive matches of `query` in a message list.
// Pure DOM walk — the query is never a regex, a selector or markup.

/** Never searched: controls (the Highlight API can't paint inside them), screen-reader-only labels,
 * anything hidden. A closed `<details>` keeps only its `<summary>` (handled in the walk). */
const SKIP = "button, input, textarea, select, script, style, .bean-sr-only, [hidden]";
// ponytail: block boundaries by tag, not computed `display` — a span styled as a block can still
// join the text either side of it; switch to getComputedStyle if that shows up in use.
const BLOCK = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "BR", "DD", "DETAILS", "DIV", "DL", "DT", "FIGCAPTION", "FIGURE",
  "FOOTER", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "OL", "P", "PRE", "SECTION",
  "SUMMARY", "TABLE", "TD", "TH", "TR", "UL",
]);

/** Lowercase and whitespace-fold one code point at a time, keeping the length so offsets map back. */
const fold = (s: string): string => {
  let out = "";
  for (const c of s) {
    const l = c.toLowerCase();
    out += /\s/.test(c) ? " ".repeat(c.length) : l.length === c.length ? l : c;
  }
  return out;
};

export function findRanges(root: Element, query: string): Range[] {
  const needle = fold(query);
  if (!needle) return [];
  let text = "";
  const segs: Array<{ node: Text; at: number }> = [];
  const walk = (el: Element): void => {
    for (const n of el.childNodes) {
      if (n.nodeType === Node.TEXT_NODE) {
        const t = n as Text;
        if (!t.data) continue;
        segs.push({ node: t, at: text.length });
        text += fold(t.data);
        continue;
      }
      if (n.nodeType !== Node.ELEMENT_NODE) continue;
      const child = n as Element;
      if (child.matches(SKIP)) continue;
      const block = BLOCK.has(child.tagName);
      if (block) text += "\n";
      if (child.tagName === "DETAILS" && !(child as HTMLDetailsElement).open) {
        for (const s of child.children) if (s.tagName === "SUMMARY") walk(s);
      } else {
        walk(child);
      }
      if (block) text += "\n";
    }
  };
  walk(root);

  const ranges: Range[] = [];
  let seg = 0;
  // Position `pos` in `text` as a (node, offset); `end` picks the node the match's last char is in.
  const locate = (pos: number, end: boolean): { node: Text; offset: number } => {
    const key = end ? pos - 1 : pos;
    while (seg + 1 < segs.length && segs[seg + 1]!.at <= key) seg++;
    const s = segs[seg]!;
    return { node: s.node, offset: pos - s.at };
  };
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) {
    const start = locate(i, false);
    const end = locate(i + needle.length, true);
    const r = document.createRange();
    r.setStart(start.node, start.offset);
    r.setEnd(end.node, end.offset);
    ranges.push(r);
  }
  return ranges;
}
