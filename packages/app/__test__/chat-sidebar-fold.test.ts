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
  expect(root.querySelector(".bean-chat-sidebar-head > span")!.textContent).toBe("All chats · 4");
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

test("drag a starred row onto a group header (move) or Starred (ungroup); only starred rows drag, highlights always clear", async () => {
  localStorage.clear();
  localStorage.setItem("bean.chat.foldedGroups", JSON.stringify(["Work"]));
  const row = (id: string, starred: boolean, groupName: string | null = null) => ({ id, title: id, updatedAt: new Date().toISOString(), agents: [] as string[], starred, groupName });
  let threads = [row("a", true), row("b", true, "Work"), row("c", true, "Home"), row("plain", false)];
  const none = new Set<string>();
  const onOpen = vi.fn();
  const draw = (): void => {
    render(h(ChatSidebar, { threads, synced: [], activeId: undefined, busy: false, working: none, unread: none, live: none, terminal: none, overlay: false, onNew: () => {}, onOpen, onDelete: () => {}, onStar: async () => {}, onRename: async () => {}, onGroup, onRenameGroup: async () => {} }), root);
  };
  const onGroup = vi.fn(async (ids: string[], name: string | null) => {
    threads = threads.map((t) => (ids.includes(t.id) ? { ...t, groupName: name } : t));
    draw();
  });
  document.body.appendChild(root);
  await act(async () => { draw(); });
  // jsdom has no DragEvent/DataTransfer: a plain event carrying a minimal store.
  const store = new Map<string, string>();
  const transfer = { get types() { return [...store.keys()]; }, setData: (k: string, v: string) => store.set(k, v), getData: (k: string) => store.get(k) ?? "", effectAllowed: "", dropEffect: "" };
  const fire = (el: Element, type: string): Event => {
    const e = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(e, "dataTransfer", { value: transfer });
    el.dispatchEvent(e);
    return e;
  };
  const rowEl = (id: string) => root.querySelector<HTMLElement>(`[data-row="${id}"]`)!;
  const header = (key: string) => root.querySelector<HTMLElement>(`[data-section="${key}"]`)!;
  const lit = () => [...root.querySelectorAll<HTMLElement>(".bean-chat-sidebar-group--drop")].map((el) => el.dataset.section);
  expect(rowEl("a").draggable).toBe(true);
  expect(rowEl("plain").draggable).toBe(false);
  // dragstart sets only the custom type.
  await act(async () => { fire(rowEl("a"), "dragstart"); });
  expect(transfer.types).toEqual(["application/x-bean-chat"]);
  expect(transfer.effectAllowed).toBe("move");
  // A date section refuses it; a group header takes it and lights up.
  let over!: Event;
  await act(async () => { over = fire(header("date:Today"), "dragover"); });
  expect(over.defaultPrevented).toBe(false);
  await act(async () => { over = fire(header("group:Work"), "dragover"); });
  expect(over.defaultPrevented).toBe(true);
  expect(lit()).toEqual(["group:Work"]);
  // Drop moves it; the folded header stays folded and the highlight is gone.
  await act(async () => { fire(header("group:Work"), "drop"); });
  expect(onGroup).toHaveBeenLastCalledWith(["a"], "Work");
  expect(header("group:Work").getAttribute("aria-expanded")).toBe("false");
  expect(lit()).toEqual([]);
  // Dropping on the row's own group is a no-op; onto Starred ungroups.
  store.clear();
  await act(async () => { fire(rowEl("c"), "dragstart"); fire(header("group:Home"), "dragover"); fire(header("group:Home"), "drop"); });
  expect(onGroup).toHaveBeenCalledTimes(1);
  await act(async () => { fire(header("starred"), "dragover"); });
  expect(lit()).toEqual(["starred"]);
  await act(async () => { fire(header("starred"), "drop"); });
  expect(onGroup).toHaveBeenLastCalledWith(["c"], null);
  // A drag without the custom type (text, files) is refused everywhere.
  store.clear();
  store.set("text/plain", "hi");
  await act(async () => { over = fire(header("starred"), "dragover"); });
  expect(over.defaultPrevented).toBe(false);
  // A cancelled drag (the row remounted, so only the document hears dragend) leaves no highlight.
  store.clear();
  await act(async () => { fire(rowEl("c"), "dragstart"); fire(header("starred"), "dragover"); threads = [...threads]; draw(); });
  expect(lit()).toEqual(["starred"]);
  await act(async () => { document.dispatchEvent(new Event("dragend")); });
  expect(lit()).toEqual([]);
  // Lost terminal events: the highlight times out on its own.
  vi.useFakeTimers();
  try {
    await act(async () => { fire(header("group:Work"), "dragover"); });
    expect(lit()).toEqual(["group:Work"]);
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(lit()).toEqual([]);
  } finally { vi.useRealTimers(); }
  // Rows still open after a drag; a row whose rename is open doesn't drag.
  await act(async () => { rowEl("plain").querySelector<HTMLButtonElement>(".bean-chat-sidebar-open")!.click(); });
  expect(onOpen).toHaveBeenCalledWith("plain");
  await act(async () => { rowEl("c").querySelector<HTMLButtonElement>(".bean-chat-sidebar-row-rename")!.click(); });
  expect(rowEl("c").draggable).toBe(false);
  root.remove();
});

test("select mode groups several chats by id: survives reorders and folds, drops vanished rows, keyboard Escape/Cancel, 100 cap, failure keeps the selection", async () => {
  localStorage.clear();
  const row = (id: string, starred: boolean, groupName: string | null = null, d = 0) => ({ id, title: id, updatedAt: new Date(Date.now() - d * 1000).toISOString(), agents: [] as string[], starred, groupName });
  let threads = [row("a", false, null, 1), row("b", true, null, 2), row("c", false, null, 3), row("w", true, "Work", 4)];
  const synced = [{ surface: "discord" as const, conversationId: "s", kind: "dm" as const, title: "DM", updatedAt: new Date().toISOString(), live: false }];
  const none = new Set<string>();
  let fail: string | undefined;
  const draw = (): void => {
    render(h(ChatSidebar, { threads, synced, activeId: "a", busy: false, working: none, unread: none, live: none, terminal: none, overlay: true, onNew: () => {}, onOpen: () => {}, onDelete: () => {}, onStar: async () => {}, onRename: async () => {}, onGroup, onRenameGroup: async () => {} }), root);
  };
  const onGroup = vi.fn(async (ids: string[], name: string | null): Promise<string | undefined> => {
    if (fail) return fail;
    threads = threads.map((t) => (ids.includes(t.id) ? { ...t, starred: true, groupName: name } : t));
    draw();
    return undefined;
  });
  document.body.appendChild(root);
  await act(async () => { draw(); });
  const q = <T extends Element>(sel: string) => root.querySelector<T>(sel);
  const box = (id: string) => q<HTMLInputElement>(`[data-row="${id}"] input[type=checkbox]`);
  const selectBtn = q<HTMLButtonElement>(".bean-chat-sidebar-select")!;
  const key = (el: Element, k: string): KeyboardEvent => {
    const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
    el.dispatchEvent(e);
    return e;
  };
  await act(async () => { selectBtn.click(); });
  // Every desktop row has a checkbox and no row controls; synced rows have none; New chat is gone.
  expect(root.querySelectorAll("input[type=checkbox]")).toHaveLength(4);
  expect(q('[data-row="discord:s"] input')).toBeNull();
  expect(root.querySelectorAll(".bean-chat-sidebar-row-star, .bean-chat-sidebar-row-rename, .bean-chat-sidebar-row-group, .bean-chat-sidebar-row-delete")).toHaveLength(0);
  expect(q(".bean-chat-sidebar-new")).toBeNull();
  const groupBtn = () => q<HTMLButtonElement>('.bean-chat-sidebar-bar button[type="submit"]')!;
  const nameInput = () => q<HTMLInputElement>('.bean-chat-sidebar-bar input[aria-label="Group name"]')!;
  const count = () => q(".bean-chat-sidebar-bar-count")!.textContent;
  await act(async () => { box("a")!.click(); box("c")!.click(); box("b")!.click(); });
  expect(count()).toBe("3 selected");
  expect(groupBtn().disabled).toBe(true); // no name yet
  // A save ack reorders the list; folding Work and back keeps the selection; "b" is deleted meanwhile.
  await act(async () => { threads = [threads[2]!, threads[0]!, threads[3]!]; draw(); });
  await act(async () => { q<HTMLButtonElement>('[data-section="group:Work"]')!.click(); });
  await act(async () => { q<HTMLButtonElement>('[data-section="group:Work"]')!.click(); });
  expect(count()).toBe("2 selected");
  expect(box("a")!.checked && box("c")!.checked).toBe(true);
  // Escape in the name input only leaves it (focus to Cancel); the next Escape leaves select mode.
  await act(async () => { nameInput().focus(); nameInput().value = "  Big   Project "; nameInput().dispatchEvent(new Event("input", { bubbles: true })); });
  let esc!: KeyboardEvent;
  await act(async () => { esc = key(nameInput(), "Escape"); });
  expect(esc.defaultPrevented).toBe(true);
  expect(document.activeElement?.textContent).toBe("Cancel");
  expect(q(".bean-chat-sidebar-bar")).not.toBeNull();
  // A failure keeps select mode, the selection and the name, with the error shown.
  fail = "disk full";
  await act(async () => { groupBtn().click(); });
  expect(onGroup).toHaveBeenLastCalledWith(["a", "c"], "Big Project");
  expect(q('.bean-chat-sidebar-bar [role="alert"]')!.textContent).toBe("Couldn't group those chats: disk full");
  expect(count()).toBe("2 selected");
  expect(nameInput().value).toBe("  Big   Project ");
  // Success: stars + groups, leaves select mode, the new group is unfolded and its header focused.
  fail = undefined;
  await act(async () => { groupBtn().click(); });
  expect(q(".bean-chat-sidebar-bar")).toBeNull();
  expect(threads.filter((t) => t.groupName === "Big Project").map((t) => t.id).sort()).toEqual(["a", "c"]);
  expect(document.activeElement).toBe(q('[data-section="group:Big Project"]'));
  expect(q('[data-section="group:Big Project"]')!.getAttribute("aria-expanded")).toBe("true");
  // Escape outside the input leaves select mode with nothing changed (default-prevented: overlay stays).
  onGroup.mockClear();
  await act(async () => { selectBtn.click(); });
  await act(async () => { box("w")!.click(); });
  await act(async () => { box("w")!.focus(); esc = key(box("w")!, "Escape"); });
  expect(esc.defaultPrevented).toBe(true);
  expect(q(".bean-chat-sidebar-bar")).toBeNull();
  expect(document.activeElement).toBe(selectBtn);
  // Cancel, likewise; re-entering starts empty.
  await act(async () => { selectBtn.click(); });
  expect(count()).toBe("0 selected");
  await act(async () => { box("w")!.click(); });
  await act(async () => { [...root.querySelectorAll<HTMLButtonElement>(".bean-chat-sidebar-bar button")].find((b) => b.textContent === "Cancel")!.click(); });
  expect(q(".bean-chat-sidebar-bar")).toBeNull();
  expect(onGroup).not.toHaveBeenCalled();
  // More than 100 selected is refused with a message, no call.
  await act(async () => { threads = Array.from({ length: 101 }, (_, i) => row(`t${i}`, false)); draw(); });
  await act(async () => { selectBtn.click(); });
  await act(async () => {
    q<HTMLButtonElement>(".bean-chat-sidebar-group--fold")?.click(); // unfold Earlier, if any
  });
  await act(async () => { root.querySelectorAll<HTMLInputElement>("input[type=checkbox]").forEach((b) => b.click()); });
  expect(count()).toBe("101 selected");
  await act(async () => { nameInput().value = "X"; nameInput().dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => { groupBtn().click(); });
  expect(onGroup).not.toHaveBeenCalled();
  expect(q('.bean-chat-sidebar-bar [role="alert"]')!.textContent).toBe("Group at most 100 chats at a time.");
  root.remove();
});
