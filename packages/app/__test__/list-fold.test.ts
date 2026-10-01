// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { ListFoldToggle, readFolded, useListFold } from "../src/renderer/shared/ListFold.js";

const KEY = "bean.test.listFolded";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  document.body.innerHTML = "";
});

function Harness() {
  const [folded, toggle] = useListFold(KEY);
  return h(ListFoldToggle, { folded, onToggle: toggle, listId: "list" });
}

function mount(): HTMLButtonElement {
  const root = document.createElement("div");
  document.body.append(root);
  act(() => render(h(Harness, null), root));
  return root.querySelector("button")!;
}

test("only an exact stored true folds; missing, invalid, or throwing storage is unfolded", () => {
  expect(readFolded(KEY)).toBe(false);
  for (const v of ["1", "yes", "TRUE", "false", "{}"]) {
    localStorage.setItem(KEY, v);
    expect(readFolded(KEY)).toBe(false);
  }
  localStorage.setItem(KEY, "true");
  expect(readFolded(KEY)).toBe(true);
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
  expect(readFolded(KEY)).toBe(false);
});

test("toggle flips aria-expanded and writes true/false", () => {
  const btn = mount();
  expect(btn.getAttribute("aria-expanded")).toBe("true");
  expect(btn.getAttribute("aria-controls")).toBe("list");
  expect(btn.getAttribute("aria-label")).toBe("Hide list");
  act(() => btn.click());
  expect(btn.getAttribute("aria-expanded")).toBe("false");
  expect(btn.getAttribute("aria-label")).toBe("Show list");
  expect(localStorage.getItem(KEY)).toBe("true");
  act(() => btn.click());
  expect(localStorage.getItem(KEY)).toBe("false");
});

test("a throwing setItem still toggles for the session", () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
  const btn = mount();
  act(() => btn.click());
  expect(btn.getAttribute("aria-expanded")).toBe("false");
});
