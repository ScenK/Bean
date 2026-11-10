// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { ChatSidebar } from "../src/renderer/components/chat/ChatSidebar.js";

const root = document.createElement("div");
afterEach(() => { render(null, root); });

test("Earlier starts folded (the open chat still shows) and its header unfolds it", async () => {
  const old = (id: string, d: number) => ({ id, title: id, updatedAt: new Date(2020, 0, d).toISOString(), agents: [] as string[], starred: false });
  const threads = [old("jan-9", 9), old("jan-8", 8), old("jan-7", 7), old("jan-6", 6)];
  const none = new Set<string>();
  const noop = () => {};
  await act(async () => {
    render(h(ChatSidebar, { threads, synced: [], activeId: "jan-6", busy: false, working: none, unread: none, live: none, terminal: none, overlay: false, onNew: noop, onOpen: noop, onDelete: noop, onStar: async () => {} }), root);
  });
  const titles = () => [...root.querySelectorAll(".bean-chat-sidebar-title")].map((e) => e.textContent);
  expect(titles()).toEqual(["jan-9", "jan-8", "jan-6"]);
  const fold = root.querySelector<HTMLButtonElement>(".bean-chat-sidebar-group--fold")!;
  expect(fold.getAttribute("aria-expanded")).toBe("false");
  await act(async () => { fold.click(); });
  expect(titles()).toEqual(["jan-9", "jan-8", "jan-7", "jan-6"]);
});

test("★ stars a desktop row without opening it; a starred row sits in Starred with no ✕, and focus returns to its ★", async () => {
  const row = (id: string, starred: boolean) => ({ id, title: id, updatedAt: new Date().toISOString(), agents: [] as string[], starred });
  let threads = [row("a", false), row("b", false), row("act", false)];
  const synced = [{ surface: "discord" as const, conversationId: "c", kind: "dm" as const, title: "DM", updatedAt: new Date().toISOString(), live: false }];
  const none = new Set<string>();
  const onOpen = vi.fn();
  const draw = (): void => {
    render(h(ChatSidebar, { threads, synced, activeId: "act", busy: false, working: none, unread: none, live: none, terminal: none, overlay: false, onNew: () => {}, onOpen, onDelete: () => {}, onStar }), root);
  };
  const onStar = vi.fn(async (id: string, starred: boolean) => {
    threads = threads.map((t) => (t.id === id ? { ...t, starred } : t));
    draw();
  });
  document.body.appendChild(root);
  await act(async () => { draw(); });
  const star = (id: string) => root.querySelector<HTMLButtonElement>(`[data-row="${id}"] .bean-chat-sidebar-row-star`);
  // Every desktop row has a ★ (the active one too); the synced row has none.
  expect(root.querySelectorAll(".bean-chat-sidebar-row-star")).toHaveLength(3);
  expect(root.querySelector('[data-row="discord:c"] .bean-chat-sidebar-row-star')).toBeNull();
  expect(star("b")!.getAttribute("aria-label")).toBe('Star "b"');
  await act(async () => { star("b")!.focus(); star("b")!.click(); });
  expect(onStar).toHaveBeenCalledWith("b", true);
  expect(onOpen).not.toHaveBeenCalled();
  const groups = () => [...root.querySelectorAll(".bean-chat-sidebar-group")].map((g) => g.firstElementChild!.textContent);
  expect(groups()).toEqual(["Starred", "Today"]);
  expect(star("b")!.getAttribute("aria-pressed")).toBe("true");
  expect(star("b")!.getAttribute("aria-label")).toBe('Unstar "b"');
  expect(star("b")!.title).toBe("Unstar chat (starred chats can't be deleted)");
  expect(root.querySelector('[data-row="b"] .bean-chat-sidebar-row-delete')).toBeNull();
  expect(root.querySelector('[data-row="a"] .bean-chat-sidebar-row-delete')).not.toBeNull();
  expect(document.activeElement).toBe(star("b"));
  expect(root.querySelector(".bean-chat-sidebar-head")!.textContent).toBe("All chats · 4");
  // The active chat can be starred too.
  await act(async () => { star("act")!.click(); });
  expect(onStar).toHaveBeenLastCalledWith("act", true);
  await act(async () => { star("b")!.click(); });
  expect(onStar).toHaveBeenLastCalledWith("b", false);
  expect(groups()).toEqual(["Starred", "Today"]);
  expect(document.activeElement).toBe(star("b"));
  root.remove();
});
