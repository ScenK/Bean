// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import {
  INPUT_HISTORY_KEY, INPUT_HISTORY_MAX, pushInputHistory, readInputHistory, recallStep, type Recall,
} from "../src/renderer/components/chat/input-history.js";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

test("push dedupes to the end, skips blanks, and caps the list", () => {
  pushInputHistory("a");
  pushInputHistory("b");
  pushInputHistory("a");
  pushInputHistory("  ");
  expect(readInputHistory()).toEqual(["b", "a"]);
  for (let i = 0; i < INPUT_HISTORY_MAX + 5; i++) pushInputHistory(`m${i}`);
  const list = readInputHistory();
  expect(list).toHaveLength(INPUT_HISTORY_MAX);
  expect(list.at(-1)).toBe(`m${INPUT_HISTORY_MAX + 4}`);
});

test("corrupt or unreadable storage reads as empty", () => {
  localStorage.setItem(INPUT_HISTORY_KEY, "{not json");
  expect(readInputHistory()).toEqual([]);
  localStorage.setItem(INPUT_HISTORY_KEY, JSON.stringify(["ok", 3, null]));
  expect(readInputHistory()).toEqual(["ok"]);
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
  expect(readInputHistory()).toEqual([]);
});

const at = (value: string, caret = value.length) => ({ value, selectionStart: caret, selectionEnd: caret });

test("up walks back from the draft, down walks forward and restores it", () => {
  const list = ["old", "line1\nline2", "new"];
  let state: Recall | null = null;
  let r = recallStep(at("draft"), true, state, list)!;
  expect(r.value).toBe("new");
  state = r.state;
  r = recallStep(at(r.value, r.caret), true, state, list)!;
  expect(r).toMatchObject({ value: "line1\nline2", caret: 0 });
  state = r.state;
  // Caret on the first line of a multi-line entry: ↑ keeps going back.
  r = recallStep(at(r.value, r.caret), true, state, list)!;
  expect(r.value).toBe("old");
  state = r.state;
  expect(recallStep(at(r.value, 0), true, state, list)).toBeUndefined(); // oldest: nothing further
  r = recallStep(at("old"), false, state, list)!;
  r = recallStep(at(r.value), false, r.state, list)!;
  r = recallStep(at(r.value), false, r.state, list)!;
  expect(r).toMatchObject({ value: "draft", state: { at: 0 } });
});

test("arrows off the first/last line, with a selection, or with no history just move the caret", () => {
  expect(recallStep(at("a\nb"), true, null, ["x"])).toBeUndefined(); // caret on line 2
  expect(recallStep(at("a\nb", 0), false, null, ["x"])).toBeUndefined(); // caret on line 1
  expect(recallStep({ value: "ab", selectionStart: 0, selectionEnd: 2 }, true, null, ["x"])).toBeUndefined();
  expect(recallStep(at(""), true, null, [])).toBeUndefined();
  expect(recallStep(at(""), false, null, ["x"])).toBeUndefined(); // already at the draft
});
