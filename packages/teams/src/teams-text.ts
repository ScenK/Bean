// Teams renders bot text as markdown, where a lone "\n" inside a paragraph is a soft break
// (shown as a space) — so line-per-item replies like `routines` collapse into one run-on
// paragraph. teamsText() doubles a lone "\n" outside fenced code unless the next line starts a
// markdown block (list, heading, quote, table, fence), which already breaks the line. Applied
// only at Teams send time: history and the model keep the raw text. Not a sanitizer — it only
// inserts "\n"; line-by-line scan, no backtracking regexes over untrusted text.

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
// `•` is deliberately not a marker: it's prose to markdown, which is the bug being fixed.
const BLOCK_START = /^ {0,3}(?:[-*+][ \t]|\d{1,9}[.)][ \t]|#{1,6}(?:[ \t]|$)|>|\||`{3}|~{3})/;

export function teamsText(s: string): string {
  const lines = s.replace(/\r\n?/g, "\n").split("\n");
  let fence: { char: string; len: number } | null = null;
  let out = lines[0] ?? "";
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i] ?? "";
    const next = lines[i + 1] ?? "";
    const marker = FENCE.exec(line)?.[1];
    if (fence) {
      // A closer: same char, at least as long, nothing after it but whitespace.
      if (marker && marker[0] === fence.char && marker.length >= fence.len
        && line.slice(line.indexOf(marker) + marker.length).trim() === "") fence = null;
    } else if (marker) {
      fence = { char: marker[0] ?? "`", len: marker.length };
    }
    const soft = !fence && line.trim() !== "" && next.trim() !== "" && !BLOCK_START.test(next);
    out += (soft ? "\n\n" : "\n") + next;
  }
  return out;
}
