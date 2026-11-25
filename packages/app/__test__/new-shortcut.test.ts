// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { useNewShortcut } from "../src/renderer/shared/new-shortcut.js";

const root = document.createElement("div");
document.body.append(root);
afterEach(() => { render(null, root); });

function Panel({ onNew, blocked }: { onNew: () => void; blocked?: boolean }) {
  useNewShortcut(onNew, blocked);
  return h("div", null, h("button", { id: "b" }, "x"), h("input", { id: "i" }));
}

const press = (target: Element, init: KeyboardEventInit = {}): void => {
  target.dispatchEvent(new KeyboardEvent("keydown", { key: "n", bubbles: true, cancelable: true, ...init }));
};

test("n fires New outside text fields; not with a modifier, in an input, or while blocked", async () => {
  const onNew = vi.fn();
  await act(async () => { render(h(Panel, { onNew }), root); });
  press(root.querySelector("#b")!);
  expect(onNew).toHaveBeenCalledTimes(1);
  press(root.querySelector("#i")!);
  press(root.querySelector("#b")!, { metaKey: true });
  press(root.querySelector("#b")!, { repeat: true });
  expect(onNew).toHaveBeenCalledTimes(1);
  await act(async () => { render(h(Panel, { onNew, blocked: true }), root); });
  press(root.querySelector("#b")!);
  expect(onNew).toHaveBeenCalledTimes(1);
});
