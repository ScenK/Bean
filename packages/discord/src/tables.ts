/** Discord has no table syntax: a GFM table posts as raw pipes that wrap into noise on a phone.
 * `renderTables` rewrites each table at send time — an aligned monospace grid when it fits a phone
 * code-block line, per-row records otherwise. Stored history keeps the original markdown. */

/** Monospace columns on the first line of a code block on the owner's phone (measured). */
export const PHONE_COLS = 33;

export interface Fence {
  /** The opening line, verbatim (reopens the block in the next chunk). */
  line: string;
  /** Its run of backticks or tildes (closes the block). */
  marker: string;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** The fence open after `line`, given the one open before it (CommonMark rules, line level). */
export function fenceAfter(line: string, open: Fence | undefined): Fence | undefined {
  const m = FENCE.exec(line);
  if (!m) return open;
  const marker = m[1] ?? "";
  const rest = m[2] ?? "";
  if (open) {
    const closes = marker[0] === open.marker[0] && marker.length >= open.marker.length && !rest.trim();
    return closes ? undefined : open;
  }
  // A backtick in a backtick fence's info string makes it inline code, not a fence.
  return marker[0] === "`" && rest.includes("`") ? undefined : { line, marker };
}

/** Index of the next run of exactly `len` backticks at or after `from`, or -1. */
function closingRun(s: string, from: number, len: number): number {
  for (let i = from; i < s.length; ) {
    if (s[i] !== "`") { i++; continue; }
    let j = i;
    while (s[j] === "`") j++;
    if (j - i === len) return i;
    i = j;
  }
  return -1;
}

/** A row's trimmed cells, or undefined when the line has no pipe outside inline code. `\|` stays
 * escaped (records keep cell markdown); a pipe inside a code span doesn't split. */
function splitRow(line: string): string[] | undefined {
  const s = line.trim();
  const cells: string[] = [];
  let cell = "";
  let pipes = 0;
  for (let i = 0; i < s.length; ) {
    const ch = s[i] ?? "";
    if (ch === "\\" && s[i + 1] === "|") {
      cell += "\\|";
      i += 2;
    } else if (ch === "`") {
      let j = i;
      while (s[j] === "`") j++;
      const close = closingRun(s, j, j - i);
      const end = close < 0 ? j : close + (j - i);
      cell += s.slice(i, end);
      i = end;
    } else if (ch === "|") {
      cells.push(cell);
      cell = "";
      pipes++;
      i++;
    } else {
      cell += ch;
      i++;
    }
  }
  cells.push(cell);
  if (pipes === 0) return undefined;
  // Leading and trailing pipes frame the row; they don't add empty cells.
  if (s.startsWith("|")) cells.shift();
  if (s.endsWith("|") && cells.at(-1) === "") cells.pop();
  return cells.length ? cells.map((c) => c.trim().replaceAll("\t", "    ")) : undefined;
}

const DELIMITER = /^:?-+:?$/;
// Markdown links, URLs, and Discord mentions/custom emoji: unreadable as raw text in a grid.
const LINK = /\]\(|[a-z][a-z0-9+.-]*:\/\/|<(?:@|#|a?:)/i;
const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });
// ponytail: CJK, Hangul, kana and fullwidth blocks only, not the full East Asian Width table;
// a wide script missing here is measured narrow and its grid misaligns — add its range.
const WIDE: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff],
  [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1b000, 0x1b2ff], [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
];

interface Width {
  /** Narrow (one-cell) graphemes. */
  a: number;
  /** Wide (East Asian Wide/Fullwidth) graphemes. */
  c: number;
  /** Holds an emoji, orphan mark or other cluster whose rendered width is uncertain. */
  unsafe: boolean;
}

function measure(s: string): Width {
  const w: Width = { a: 0, c: 0, unsafe: false };
  for (const { segment } of SEGMENTER.segment(s)) {
    const [base = "", ...marks] = segment;
    const certain =
      !/[\p{M}\p{C}\p{Extended_Pictographic}\p{Regional_Indicator}]/u.test(base) &&
      marks.every((m) => /\p{Mn}/u.test(m) && !/[︀-️\u{E0100}-\u{E01EF}]/u.test(m));
    const cp = base.codePointAt(0) ?? 0;
    if (!certain) {
      w.unsafe = true;
      w.a += 2; // only reachable in the last column; count it wide so the fit check stays honest
    } else if (WIDE.some(([lo, hi]) => cp >= lo && cp <= hi)) w.c++;
    else w.a++;
  }
  return w;
}

/** A grid in a code block, or undefined when the table doesn't fit `cols` or a cell can't sit in
 * one. Only the last column may hold links, backticks or uncertain clusters (nothing follows it
 * to misalign); no cell may hold a fence marker, which would end the code block. */
function grid(table: string[][], cols: number): string[] | undefined {
  const n = table[0]?.length ?? 0;
  const shown = table.map((row) => row.map((cell) => cell.replaceAll("\\|", "|")));
  const widths = shown.map((row) => row.map(measure));
  for (const [r, row] of shown.entries()) {
    for (const [k, cell] of row.entries()) {
      if (cell.includes("```")) return undefined;
      if (k < n - 1 && (cell.includes("`") || LINK.test(cell) || widths[r]?.[k]?.unsafe)) return undefined;
    }
  }
  const A = Array.from({ length: n }, (_, k) => Math.max(...widths.map((row) => row[k]?.a ?? 0)));
  const C = Array.from({ length: n }, (_, k) => Math.max(...widths.map((row) => row[k]?.c ?? 0)));
  const total = A.reduce((sum, a, k) => sum + a + 2 * (C[k] ?? 0), 0) + 2 * (n - 1);
  if (total > cols) return undefined;
  // U+3000 pads wide space (two cells on the phone, unlike two ASCII spaces); trailing pad trimmed.
  const line = (cells: string[]): string => cells.join("  ").replace(/[ 　]+$/, "");
  const pad = (row: string[], r: number): string[] =>
    row.map((cell, k) => {
      const w = widths[r]?.[k] ?? { a: 0, c: 0 };
      return cell + "　".repeat((C[k] ?? 0) - w.c) + " ".repeat((A[k] ?? 0) - w.a);
    });
  const [head = [], ...body] = shown;
  const rule = A.map((a, k) => "-".repeat(a) + "－".repeat(C[k] ?? 0));
  return ["```", line(pad(head, 0)), line(rule), ...body.map((row, i) => line(pad(row, i + 1))), "```"];
}

/** One line per body row: `**<col 1>** · <Header 2>: <value> · …`, cell markdown kept (links stay
 * tappable), every non-empty cell kept untruncated. */
function records(header: string[], rows: string[][]): string[] {
  return rows
    .map(([first = "", ...rest]) => {
      const parts = first ? [`**${first.replace(/^\*\*(.*)\*\*$/, "$1")}**`] : [];
      rest.forEach((value, k) => {
        const name = header[k + 1];
        if (value) parts.push(name ? `${name}: ${value}` : value);
      });
      return parts.join(" · ");
    })
    .filter(Boolean);
}

/** Rewrites every GFM table outside fenced code as a grid (fits `cols`) or records. */
export function renderTables(text: string, cols = PHONE_COLS): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let fence: Fence | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const header = fence || FENCE.test(line) ? undefined : splitRow(line);
    const delimiter = header && splitRow(lines[i + 1] ?? "");
    if (header && delimiter?.length === header.length && delimiter.every((c) => DELIMITER.test(c))) {
      const rows: string[][] = [];
      let j = i + 2;
      for (; j < lines.length; j++) {
        const next = lines[j] ?? "";
        const row = next.trim() && !FENCE.test(next) ? splitRow(next) : undefined;
        if (!row) break;
        rows.push(header.map((_, k) => row[k] ?? ""));
      }
      if (rows.length) {
        out.push(...(grid([header, ...rows], cols) ?? records(header, rows)));
        i = j - 1;
        continue;
      }
    }
    fence = fenceAfter(line, fence);
    out.push(line);
  }
  return out.join("\n");
}
