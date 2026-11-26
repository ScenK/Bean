// Shell-style ↑/↓ recall of what you sent, shared by every chat window on this machine. Kept in
// localStorage (see .memory/convention-renderer-view-prefs-in-localstorage.md): a failed read is
// an empty history, a failed write just isn't remembered.
export const INPUT_HISTORY_KEY = "bean.inputHistory";
export const INPUT_HISTORY_MAX = 100;

/** Oldest first. */
export function readInputHistory(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(INPUT_HISTORY_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

/** Appends `text`, moving an earlier copy of it to the end. */
export function pushInputHistory(text: string): void {
  if (!text.trim()) return;
  const next = [...readInputHistory().filter((s) => s !== text), text].slice(-INPUT_HISTORY_MAX);
  try { localStorage.setItem(INPUT_HISTORY_KEY, JSON.stringify(next)); } catch { /* not remembered */ }
}

/** `at` = how many entries back (0 = your unsent draft). */
export interface Recall { at: number; draft: string }

/** One ↑/↓ press: undefined when the key should just move the caret (not on the first/last line,
 * a selection, or nothing further to recall). Up lands the caret at the start so another ↑ keeps
 * going back through multi-line entries; down lands it at the end. */
export function recallStep(
  el: { value: string; selectionStart: number; selectionEnd: number },
  up: boolean,
  state: Recall | null,
  list: string[],
): { state: Recall; value: string; caret: number } | undefined {
  if (el.selectionStart !== el.selectionEnd) return undefined;
  const onEdge = up ? !el.value.slice(0, el.selectionStart).includes("\n") : !el.value.slice(el.selectionEnd).includes("\n");
  if (!onEdge) return undefined;
  const cur = state ?? { at: 0, draft: el.value };
  const at = Math.max(0, Math.min(list.length, cur.at + (up ? 1 : -1)));
  if (at === cur.at) return undefined;
  const value = at === 0 ? cur.draft : list[list.length - at] ?? "";
  return { state: { at, draft: cur.draft }, value, caret: up ? 0 : value.length };
}
