// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { ChatSidebar } from "../src/renderer/components/chat/ChatSidebar.js";

const root = document.createElement("div");
afterEach(() => { render(null, root); });

test("Earlier starts folded (the open chat still shows) and its header unfolds it", async () => {
  const old = (id: string, d: number) => ({ id, title: id, updatedAt: new Date(2020, 0, d).toISOString(), agents: [] as string[] });
  const threads = [old("jan-9", 9), old("jan-8", 8), old("jan-7", 7), old("jan-6", 6)];
  const none = new Set<string>();
  const noop = () => {};
  await act(async () => {
    render(h(ChatSidebar, { threads, synced: [], activeId: "jan-6", busy: false, working: none, unread: none, live: none, terminal: none, overlay: false, onNew: noop, onOpen: noop, onDelete: noop }), root);
  });
  const titles = () => [...root.querySelectorAll(".bean-chat-sidebar-title")].map((e) => e.textContent);
  expect(titles()).toEqual(["jan-9", "jan-8", "jan-6"]);
  const fold = root.querySelector<HTMLButtonElement>(".bean-chat-sidebar-group--fold")!;
  expect(fold.getAttribute("aria-expanded")).toBe("false");
  await act(async () => { fold.click(); });
  expect(titles()).toEqual(["jan-9", "jan-8", "jan-7", "jan-6"]);
});
