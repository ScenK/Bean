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
    render(h(ChatSidebar, { threads, synced: [], activeId: "jan-6", busy: false, working: none, unread: none, live: none, terminal: none, overlay: false, onNew: noop, onOpen: noop, onDelete: noop, onStar: async () => {}, onRename: async () => {} }), root);
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
    render(h(ChatSidebar, { threads, synced, activeId: "act", busy: false, working: none, unread: none, live: none, terminal: none, overlay: false, onNew: () => {}, onOpen, onDelete: () => {}, onStar, onRename: async () => {} }), root);
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

test("✎ / F2 renames a desktop row inline: Enter or blur saves, Escape cancels (default-prevented), empty never saves", async () => {
  const row = (id: string) => ({ id, title: id, updatedAt: new Date().toISOString(), agents: [] as string[], starred: false });
  let threads = [row("a"), row("act")];
  const synced = [{ surface: "discord" as const, conversationId: "c", kind: "dm" as const, title: "DM", updatedAt: new Date().toISOString(), live: false }];
  const none = new Set<string>();
  const draw = (): void => {
    render(h(ChatSidebar, { threads, synced, activeId: "act", busy: false, working: none, unread: none, live: none, terminal: none, overlay: true, onNew: () => {}, onOpen: () => {}, onDelete: () => {}, onStar: async () => {}, onRename }), root);
  };
  const onRename = vi.fn(async (id: string, title: string) => {
    threads = threads.map((t) => (t.id === id ? { ...t, title } : t));
    draw();
  });
  document.body.appendChild(root);
  await act(async () => { draw(); });
  const pencil = (id: string) => root.querySelector<HTMLButtonElement>(`[data-row="${id}"] .bean-chat-sidebar-row-rename`);
  const input = () => root.querySelector<HTMLInputElement>(".bean-chat-sidebar-rename");
  const key = (el: Element, k: string): KeyboardEvent => {
    const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
    el.dispatchEvent(e);
    return e;
  };
  const type = async (v: string): Promise<void> => {
    await act(async () => { input()!.value = v; input()!.dispatchEvent(new Event("input", { bubbles: true })); });
  };
  // Desktop rows (the active one too) get ✎; the synced row doesn't.
  expect(root.querySelectorAll(".bean-chat-sidebar-row-rename")).toHaveLength(2);
  expect(root.querySelector('[data-row="discord:c"] .bean-chat-sidebar-row-rename')).toBeNull();
  // F2 on the focused row's open button: the title becomes a focused input.
  const open = root.querySelector<HTMLButtonElement>('[data-row="a"] .bean-chat-sidebar-open')!;
  open.focus();
  await act(async () => { key(open, "F2"); });
  expect(document.activeElement).toBe(input());
  expect(input()!.value).toBe("a");
  // Escape cancels and is default-prevented (the overlay's document listener leaves it open).
  await type("nope");
  let esc: KeyboardEvent | undefined;
  await act(async () => { esc = key(input()!, "Escape"); });
  expect(esc!.defaultPrevented).toBe(true);
  expect(input()).toBeNull();
  expect(onRename).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(pencil("a"));
  // Empty (whitespace) never saves.
  await act(async () => { pencil("a")!.click(); });
  await type("   ");
  await act(async () => { key(input()!, "Enter"); });
  expect(input()).toBeNull();
  expect(onRename).not.toHaveBeenCalled();
  // Enter saves the trimmed title once (no second save from the input's blur); focus returns to ✎.
  await act(async () => { pencil("act")!.click(); });
  await type("  Renamed  ");
  await act(async () => { key(input()!, "Enter"); });
  expect(onRename).toHaveBeenCalledTimes(1);
  expect(onRename).toHaveBeenCalledWith("act", "Renamed");
  expect(root.querySelector('[data-row="act"] .bean-chat-sidebar-title')!.textContent).toBe("Renamed");
  expect(document.activeElement).toBe(pencil("act"));
  // Blur saves too; a list update mid-edit keeps the draft.
  await act(async () => { pencil("a")!.click(); });
  await type("Blurred");
  await act(async () => { threads = [...threads]; draw(); });
  expect(input()!.value).toBe("Blurred");
  await act(async () => { input()!.blur(); });
  expect(onRename).toHaveBeenLastCalledWith("a", "Blurred");
  expect(onRename).toHaveBeenCalledTimes(2);
  root.remove();
});

test("starred groups: Group menu → New group…, join, fold (persisted, active row kept), F2 rename moves the fold", async () => {
  localStorage.clear();
  const row = (id: string, groupName: string | null = null) => ({ id, title: id, updatedAt: new Date().toISOString(), agents: [] as string[], starred: true, groupName });
  let threads = [row("a"), row("b"), row("act")];
  const none = new Set<string>();
  const draw = (): void => {
    render(h(ChatSidebar, { threads, synced: [], activeId: "act", busy: false, working: none, unread: none, live: none, terminal: none, overlay: true, onNew: () => {}, onOpen: () => {}, onDelete: () => {}, onStar: async () => {}, onRename: async () => {}, onGroup, onRenameGroup }), root);
  };
  const onGroup = vi.fn(async (ids: string[], name: string | null) => {
    threads = threads.map((t) => (ids.includes(t.id) ? { ...t, groupName: name } : t));
    draw();
  });
  const onRenameGroup = vi.fn(async (from: string, to: string) => {
    threads = threads.map((t) => (t.groupName === from ? { ...t, groupName: to } : t));
    draw();
  });
  document.body.appendChild(root);
  await act(async () => { draw(); });
  const select = (id: string) => root.querySelector<HTMLSelectElement>(`[data-row="${id}"] .bean-chat-sidebar-row-group`)!;
  const pick = async (id: string, value: string): Promise<void> => {
    await act(async () => { select(id).value = value; select(id).dispatchEvent(new Event("change", { bubbles: true })); });
  };
  const input = () => root.querySelector<HTMLInputElement>(".bean-chat-sidebar-rename");
  const key = (el: Element, k: string): KeyboardEvent => {
    const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
    el.dispatchEvent(e);
    return e;
  };
  const type = async (v: string): Promise<void> => {
    await act(async () => { input()!.value = v; input()!.dispatchEvent(new Event("input", { bubbles: true })); });
  };
  const header = (name: string) => [...root.querySelectorAll<HTMLElement>("[data-section]")].find((el) => el.dataset.section === `group:${name}`);
  const titles = () => [...root.querySelectorAll(".bean-chat-sidebar-title")].map((e) => e.textContent);
  expect(select("a").getAttribute("aria-label")).toBe('Group "a"');
  // New group… opens a focused name input; Escape cancels (default-prevented), back to the control.
  await pick("a", "\n");
  expect(document.activeElement).toBe(input());
  let esc: KeyboardEvent | undefined;
  await act(async () => { esc = key(input()!, "Escape"); });
  expect(esc!.defaultPrevented).toBe(true);
  expect(onGroup).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(select("a"));
  // A name + Enter creates the group holding the row; focus returns to its Group control.
  await pick("a", "\n");
  await type("  Earlier ");
  await act(async () => { key(input()!, "Enter"); });
  expect(onGroup).toHaveBeenCalledWith(["a"], "Earlier");
  expect(header("Earlier")!.textContent).toContain("1");
  expect(document.activeElement).toBe(select("a"));
  // A second row (the active one) joins from the menu.
  expect([...select("act").options].map((o) => o.textContent)).toEqual(["No group", "Earlier", "New group…"]);
  await pick("act", "Earlier");
  expect(onGroup).toHaveBeenLastCalledWith(["act"], "Earlier");
  // Fold: the active row stays visible, the count stays, the fold persists.
  await act(async () => { header("Earlier")!.click(); });
  expect(header("Earlier")!.getAttribute("aria-expanded")).toBe("false");
  expect(header("Earlier")!.textContent).toContain("2");
  expect(titles()).toEqual(["b", "act"]);
  expect(JSON.parse(localStorage.getItem("bean.chat.foldedGroups")!)).toEqual(["Earlier"]);
  // Moving the active row away from b: b's control → Earlier, folded away → focus lands on the header.
  await pick("b", "Earlier");
  expect(document.activeElement).toBe(header("Earlier"));
  // F2 renames the group: members and fold move with it.
  await act(async () => { key(header("Earlier")!, "F2"); });
  expect(document.activeElement).toBe(input());
  await type("Today");
  await act(async () => { key(input()!, "Enter"); });
  expect(onRenameGroup).toHaveBeenCalledWith("Earlier", "Today");
  expect(header("Today")!.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(header("Today"));
  expect(JSON.parse(localStorage.getItem("bean.chat.foldedGroups")!)).toEqual(["Today"]);
  // A remount reads the fold back; Remove from group on the last members makes the group vanish.
  render(null, root);
  await act(async () => { draw(); });
  expect(header("Today")!.getAttribute("aria-expanded")).toBe("false");
  await act(async () => { header("Today")!.click(); });
  for (const id of ["a", "b", "act"]) await pick(id, "");
  expect(header("Today")).toBeUndefined();
  expect(onGroup).toHaveBeenLastCalledWith(["act"], null);
  root.remove();
});
