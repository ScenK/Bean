import type { DesktopChatListing } from "@bean/core";
import { Fragment } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { AgentAvatar, AGENT_NAMES } from "../../shared/AgentAvatar.js";
import type { AgentId, ChatItem } from "../../shared/chat-types.js";
import type { ChatThreadAck } from "../../../ipc.js";
import { agoText } from "../routines/watch-status.js";
import type { SyncedChatListing } from "../../../synced-chats.js";
import { kindChip, SURFACE_NAMES, syncedKey } from "./SyncedChat.js";

/** Below this window width the sidebar is an overlay (always opening collapsed). */
export const SIDEBAR_INLINE_MIN = 640;
/** Inline mode's remembered collapse toggle ("0" = collapsed). */
export const SIDEBAR_OPEN_KEY = "bean.chat.sidebarOpen";

/** Today, then the two most recent earlier days with activity ("Nov 2", "Oct 31"), then Earlier —
 * by local calendar day, in listed (newest-first) order; empty groups dropped. */
export function groupThreads<T extends { updatedAt: string }>(threads: T[], now: Date): Array<{ label: string; threads: T[] }> {
  const groups: Array<{ label: string; threads: T[] }> = [];
  const earlier: T[] = [];
  let days = 0;
  for (const t of threads) {
    const d = new Date(t.updatedAt);
    const label = d.toDateString() === now.toDateString() ? "Today" : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const last = groups[groups.length - 1];
    if (last?.label === label) last.threads.push(t);
    else if (label === "Today" || days < 2) { groups.push({ label, threads: [t] }); if (label !== "Today") days++; }
    else earlier.push(t);
  }
  return earlier.length > 0 ? [...groups, { label: "Earlier", threads: earlier }] : groups;
}

/** The list after a save ack: the active thread moves to the top with its new title, time and agents.
 * No push channel — this ack is the only live update. */
export function withSaveAck(threads: DesktopChatListing[], ack: ChatThreadAck, items: ChatItem[]): DesktopChatListing[] {
  const agents = [...new Set(items.flatMap((it) => (it.kind === "reply" && it.agent && it.agent !== "bean" ? [it.agent] : [])))];
  const old = threads.find((t) => t.id === ack.id);
  return [{ starred: false, groupName: null, ...old, ...ack, agents }, ...threads.filter((t) => t.id !== ack.id)];
}

/** One sidebar list: desktop threads and synced (Discord/Teams) chats, newest first. Stable, so
 * desktop threads keep their listed order among equal times. */
export type SidebarRow = { synced: false; key: string; updatedAt: string; thread: DesktopChatListing }
  | { synced: true; key: string; updatedAt: string; chat: SyncedChatListing };
export function mergeRows(threads: DesktopChatListing[], synced: SyncedChatListing[]): SidebarRow[] {
  return [
    ...threads.map((t): SidebarRow => ({ synced: false, key: t.id, updatedAt: t.updatedAt, thread: t })),
    ...synced.map((c): SidebarRow => ({ synced: true, key: syncedKey(c), updatedAt: c.updatedAt, chat: c })),
  ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

interface Props {
  threads: DesktopChatListing[];
  /** The owner's Discord/Teams conversations — opened read/continue, never deleted from here. */
  synced: SyncedChatListing[];
  activeId: string | undefined;
  /** The shown chat's switch-away save in flight: rows and New chat wait. */
  busy: boolean;
  /** Threads with work in flight (a spinner) and with a reply that landed while hidden (a dot). */
  working: Set<string>;
  unread: Set<string>;
  /** Threads with an open agent (live) session: a green wash and a breathing dot before the title. */
  live: Set<string>;
  /** Threads whose chat holds a live terminal shell: a calm `>_` (a dev server never finishes, so no spinner). */
  terminal: Set<string>;
  overlay: boolean;
  onNew: () => void;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  /** Settles (never rejects) once the list reflects the result; focus then returns to the row's ★. */
  onStar: (id: string, starred: boolean) => Promise<void>;
  /** Settles (never rejects) once the list reflects the result; focus then returns to the row's ✎. */
  onRename: (id: string, title: string) => Promise<void>;
  /** Puts threads in a group (`null` = out of it). Settles (never rejects) once the list reflects the
   * result: the error message on failure, else undefined. */
  onGroup: (ids: string[], name: string | null) => Promise<string | undefined>;
  /** Renames a group (onto an existing name, they merge). Settles once the list reflects the result. */
  onRenameGroup: (from: string, to: string) => Promise<void>;
}

/** Where focus goes after an edit: a row's control (or, folded away, its section's header), or a header. */
type Refocus = { id: string; control: "star" | "rename" | "group" } | { section: string };

/** One sidebar section. `key` never collides with a user's group name (kind-prefixed); `count` is
 * the header's number (Starred counts its groups' members too). */
export interface SidebarSection { kind: "starred" | "group" | "date" | "earlier"; key: string; label: string; count: number; threads: SidebarRow[] }

/** Starred desktop threads first — the ungrouped ones under "Starred", then its named groups in
 * alphabetical order (members newest first) — then the date sections over everything else. Synced
 * chats are never starred. */
export function sidebarGroups(rows: SidebarRow[], now: Date): SidebarSection[] {
  const isStarred = (r: SidebarRow): boolean => !r.synced && r.thread.starred;
  const loose: SidebarRow[] = [];
  const named = new Map<string, SidebarRow[]>();
  for (const r of rows.filter(isStarred)) {
    const name = r.synced ? null : r.thread.groupName;
    if (name) named.set(name, [...(named.get(name) ?? []), r]);
    else loose.push(r);
  }
  const groups = [...named].sort(([a], [b]) => a.localeCompare(b))
    .map(([name, threads]): SidebarSection => ({ kind: "group", key: `group:${name}`, label: name, count: threads.length, threads }));
  const total = loose.length + groups.reduce((n, g) => n + g.count, 0);
  const dates = groupThreads(rows.filter((r) => !isStarred(r)), now).map((g): SidebarSection => (g.label === "Earlier"
    ? { kind: "earlier", key: "earlier", label: g.label, count: g.threads.length, threads: g.threads }
    : { kind: "date", key: `date:${g.label}`, label: g.label, count: g.threads.length, threads: g.threads }));
  return [...(total > 0 ? [{ kind: "starred" as const, key: "starred", label: "Starred", count: total, threads: loose }] : []), ...groups, ...dates];
}

/** Palette size: theme.css defines `--bean-group-1…N` in each theme. */
export const GROUP_COLORS = 6;
/** Each group's palette entry (1-based), for names in listed order: a stable hash of the name, bumped
 * to the next entry when it equals the group directly above, so neighbours always differ.
 * ponytail: nothing stored — past GROUP_COLORS groups non-neighbours repeat, and a rename can change
 * a colour; persist per group (a groups table) if that proves confusing. */
export function groupColors(names: string[]): number[] {
  const out: number[] = [];
  for (const name of names) {
    let h = 0;
    for (const ch of name) h = (Math.imul(h, 31) + ch.codePointAt(0)!) >>> 0;
    let i = (h % GROUP_COLORS) + 1;
    if (i === out[out.length - 1]) i = (i % GROUP_COLORS) + 1;
    out.push(i);
  }
  return out;
}

/** Folded starred groups, by name (absent = unfolded). */
export const GROUP_FOLD_KEY = "bean.chat.foldedGroups";
/** Renderer copy of core's DESKTOP_CHAT_TITLE_MAX (node-free bundle rule) — keep in step. */
export const GROUP_NAME_MAX = 80;
/** Core's `desktopChatName` cleaning, so the renderer can patch rows with the stored group name. */
export const cleanGroupName = (name: string): string => name.replace(/\s+/g, " ").trim().slice(0, GROUP_NAME_MAX).trim();
/** The fold list after renaming group `from` to `to`: the entry moves, but onto an existing group
 * (a merge) the target's state wins. */
export function foldedAfterRename(folded: string[], from: string, to: string, names: string[]): string[] {
  const rest = folded.filter((n) => n !== from);
  return names.includes(to) || !folded.includes(from) ? rest : [...rest, to];
}
function readFolded(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(GROUP_FOLD_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((n): n is string => typeof n === "string") : [];
  } catch { return []; }
}
/** A dragged starred row's id. Custom type only (no `text/plain`), so text fields ignore the drag. */
export const CHAT_DRAG_TYPE = "application/x-bean-chat";
/** Drop-highlight silence timeout: Chromium re-fires dragover ~every 350ms over a target, so this
 * long without one means the drag's terminal events were lost (safety-drag-mode-needs-watchdog). */
const DROP_WATCHDOG_MS = 800;
/** The Group control's "New group…" value — whitespace only, so never a stored group name. */
const NEW_GROUP = "\n";

/** Most chats one Group call takes — main's chatThreadGroup refuses more. */
export const GROUP_SELECT_MAX = 100;

/** Row time: "now"/"3h" today, "Oct 28" before that. */
export function rowTime(iso: string, now: Date): string {
  if (new Date(iso).toDateString() !== now.toDateString()) {
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  return agoText(iso, now).replace("just now", "now").replace(" ago", "");
}

export function ChatSidebar({ threads, synced, activeId, busy, working, unread, live, terminal, overlay, onNew, onOpen, onDelete, onStar, onRename, onGroup, onRenameGroup }: Props) {
  const now = new Date();
  const rows = mergeRows(threads, synced);
  const sections = sidebarGroups(rows, now);
  const groupNames = sections.flatMap((s) => (s.kind === "group" ? [s.label] : []));
  const colors = groupColors(groupNames);
  // Earlier starts folded each time the sidebar mounts; the open chat stays visible inside it.
  const [earlierOpen, setEarlierOpen] = useState(false);
  // Starred groups' folds persist (localStorage); vanished names are pruned once the list has loaded.
  const [folded, setFoldedState] = useState(readFolded);
  // Updaters, so the prune effect (a closure from an older render) can't undo a rename's fold move.
  const setFolded = (update: (f: string[]) => string[]): void => setFoldedState((f) => {
    const next = update(f);
    try { localStorage.setItem(GROUP_FOLD_KEY, JSON.stringify(next)); } catch { /* unfolded next launch */ }
    return next;
  });
  useEffect(() => {
    if (threads.length > 0 && folded.some((n) => !groupNames.includes(n))) setFolded((f) => f.filter((n) => groupNames.includes(n)));
  }, [threads]);
  const isFolded = (s: SidebarSection): boolean => (s.kind === "earlier" ? !earlierOpen : s.kind === "group" && folded.includes(s.label));
  const toggleFold = (s: SidebarSection): void => {
    if (s.kind === "earlier") setEarlierOpen(!earlierOpen);
    else setFolded((f) => (f.includes(s.label) ? f.filter((n) => n !== s.label) : [...f, s.label]));
  };
  // A row that moved (a save ack lifts its thread to the top) slides from where it was (FLIP).
  const listRef = useRef<HTMLDivElement>(null);
  const tops = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const els = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-row]") ?? [])];
    const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === false; // false in jsdom (no matchMedia)
    const next = new Map(els.map((el) => [el.dataset.row!, el.offsetTop]));
    for (const el of els) {
      const was = tops.current.get(el.dataset.row!);
      const dy = was === undefined ? 0 : was - el.offsetTop;
      if (motion && dy !== 0) el.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: 260, easing: "cubic-bezier(0.2, 0, 0, 1)" });
    }
    tops.current = next;
  });
  // After a star, rename or group move the row may have changed section (remounted): put focus back
  // on its control, or on its section's fold when it's folded away (gone: the first fold).
  const [refocus, setRefocus] = useState<Refocus | undefined>(undefined);
  useLayoutEffect(() => {
    if (!refocus) return;
    const list = listRef.current;
    const header = (key: string | undefined) => [...(list?.querySelectorAll<HTMLElement>("[data-section]") ?? [])].find((el) => el.dataset.section === key);
    if ("section" in refocus) { header(refocus.section)?.focus(); return; }
    (list?.querySelector<HTMLElement>(`[data-row="${refocus.id}"] .bean-chat-sidebar-row-${refocus.control}`)
      ?? header(sections.find((s) => s.threads.some((r) => r.key === refocus.id))?.key)
      ?? list?.querySelector<HTMLElement>(".bean-chat-sidebar-group--fold"))?.focus();
  }, [refocus]);
  // Inline edit drafts — `title:<id>`, `group:<id>` (New group…), `header:<name>` — so a save ack (a new
  // title, a moved row) mid-edit doesn't lose one.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const startEdit = (key: string, value: string): void => setDrafts((d) => ({ ...d, [key]: value }));
  const endEdit = (key: string): void => setDrafts(({ [key]: _, ...rest }) => rest);
  // Enter or blur: an empty or unchanged value just ends the edit (focus `back(current)`). The ref
  // guards Enter's later blur.
  const saveEdit = (key: string, current: string, clean: (v: string) => string, commit: (v: string) => Promise<unknown>, back: (v: string) => Refocus): void => {
    const { [key]: draft, ...rest } = draftsRef.current;
    if (draft === undefined) return;
    draftsRef.current = rest;
    const value = clean(draft);
    endEdit(key);
    if (!value || value === current) { setRefocus(back(current)); return; }
    void commit(value).then(() => setRefocus(back(value)));
  };
  const cancelEdit = (key: string, back: Refocus): void => { endEdit(key); setRefocus(back); };
  const renameGroup = (from: string, to: string): Promise<void> => {
    // Moved up front: a prune between the list update and a later move would drop `from` first.
    // ponytail: a failed rename then loses the group's fold (it unfolds) — an error row says why.
    setFolded((f) => foldedAfterRename(f, from, to, groupNames));
    return onRenameGroup(from, to);
  };
  // Drag a starred row onto a group header (move) or the Starred header (ungroup). `over` is only a
  // highlight: clearing it never commits a move, and nothing reads it to block clicks.
  const [over, setOver] = useState<string | undefined>(undefined);
  const overTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const clearOver = (): void => { clearTimeout(overTimer.current); setOver(undefined); };
  useEffect(() => {
    // A save ack can remount the dragged row, losing its own dragend; the document still hears these.
    // (clearOver only touches the ref and the state setter, so this first render's copy stays valid.)
    document.addEventListener("dragend", clearOver, true);
    document.addEventListener("drop", clearOver, true);
    return () => {
      document.removeEventListener("dragend", clearOver, true);
      document.removeEventListener("drop", clearOver, true);
      clearTimeout(overTimer.current);
    };
  }, []);
  const dropTarget = (g: SidebarSection) => (g.kind !== "starred" && g.kind !== "group" ? {} : {
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes(CHAT_DRAG_TYPE)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setOver(g.key);
      clearTimeout(overTimer.current);
      overTimer.current = setTimeout(() => setOver(undefined), DROP_WATCHDOG_MS);
    },
    onDragLeave: (e: DragEvent) => {
      if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) clearOver();
    },
    onDrop: (e: DragEvent) => {
      const id = e.dataTransfer?.getData(CHAT_DRAG_TYPE);
      if (!id) return;
      e.preventDefault();
      clearOver();
      const t = threads.find((x) => x.id === id);
      const name = g.kind === "group" ? g.label : null;
      if (t?.starred && (t.groupName ?? null) !== name) void onGroup([id], name);
    },
  });
  // ⌘-click selection: a set of thread ids (never positions — a save ack reorders rows), only the
  // listed ones counted, so a deleted or pruned row drops out on its own. Any selection swaps New
  // chat for the group bar.
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [newGroup, setNewGroup] = useState("");
  const [selectError, setSelectError] = useState<string | undefined>(undefined);
  const [grouping, setGrouping] = useState(false);
  const newRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const barRef = useRef<HTMLFormElement>(null);
  const chosen = [...selected].filter((id) => threads.some((t) => t.id === id));
  const selecting = chosen.length > 0;
  // Focus inside the bar would be lost with it: it goes to New chat, which takes the bar's place.
  const focusNew = useRef(false);
  const endSelect = (): void => {
    focusNew.current = barRef.current?.contains(document.activeElement) ?? false;
    setSelected(new Set());
  };
  useLayoutEffect(() => {
    if (selecting) return;
    setNewGroup("");
    setSelectError(undefined);
    if (focusNew.current) newRef.current?.focus();
    focusNew.current = false;
  }, [selecting]);
  const toggleSelected = (id: string): void => setSelected((s) => {
    const next = new Set(s);
    if (!next.delete(id)) next.add(id);
    return next;
  });
  const groupSelected = (): void => {
    const name = cleanGroupName(newGroup);
    if (!name || chosen.length === 0 || grouping) return;
    if (chosen.length > GROUP_SELECT_MAX) { setSelectError(`Group at most ${GROUP_SELECT_MAX} chats at a time.`); return; }
    setGrouping(true);
    setSelectError(undefined);
    void onGroup(chosen, name).then((err) => {
      setGrouping(false);
      if (err !== undefined) { setSelectError(`Couldn't group those chats: ${err}`); return; }
      setSelected(new Set()); // not endSelect: focus goes to the new group's header, below
      setFolded((f) => f.filter((n) => n !== name));
      setRefocus({ section: `group:${name}` });
    });
  };
  const dropClass = (g: SidebarSection): string => (over === g.key ? " bean-chat-sidebar-group--drop" : "");
  const marker = (key: string) => (working.has(key)
    ? <span class="bean-chat-sidebar-spinner" role="img" aria-label="Working" />
    : unread.has(key) ? <span class="bean-chat-sidebar-dot" role="img" aria-label="New reply" /> : null);
  return (
    <nav
      id="bean-chat-sidebar"
      class={`bean-chat-sidebar${overlay ? " bean-chat-sidebar--overlay" : ""}`}
      aria-label="Chat history"
      // Escape drops the selection (the name input's own Escape, default-prevented, only leaves it).
      // Default-prevented too, so the overlay sidebar stays open.
      onKeyDown={selecting ? (e) => {
        if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
        e.preventDefault();
        endSelect();
      } : undefined}
    >
      <div class="bean-chat-sidebar-head">
        <span>All chats · {rows.length}</span>
      </div>
      <div class="bean-chat-sidebar-list" ref={listRef}>
        {rows.length === 0 ? <div class="bean-chat-sidebar-empty">No saved chats yet.</div> : null}
        {sections.map((g) => {
          const header = drafts[`header:${g.label}`];
          const named = g.kind === "group" ? " bean-chat-sidebar-group--named" : "";
          const inner = <>
            {g.kind === "group" && header !== undefined ? (
              <div class={`bean-chat-sidebar-group${named}${dropClass(g)}`} data-section={g.key} {...dropTarget(g)}>
                <RenameInput
                  value={header}
                  label={`Rename group "${g.label}"`}
                  onInput={(v) => setDrafts((d) => (`header:${g.label}` in d ? { ...d, [`header:${g.label}`]: v } : d))}
                  onSave={() => saveEdit(`header:${g.label}`, g.label, cleanGroupName, (to) => renameGroup(g.label, to), (v) => ({ section: `group:${v}` }))}
                  onCancel={() => cancelEdit(`header:${g.label}`, { section: g.key })}
                />
                <span>{g.count}</span>
              </div>
            ) : g.kind === "earlier" || g.kind === "group" ? (
              <button
                type="button"
                class={`bean-chat-sidebar-group bean-chat-sidebar-group--fold${named}${dropClass(g)}`}
                data-section={g.key}
                {...dropTarget(g)}
                aria-expanded={!isFolded(g)}
                title={g.kind === "group" ? "Fold group (double-click or F2 to rename)" : undefined}
                onClick={() => toggleFold(g)}
                onDblClick={g.kind === "group" ? () => startEdit(`header:${g.label}`, g.label) : undefined}
                onKeyDown={g.kind === "group" ? (e) => {
                  if (e.key !== "F2") return;
                  e.preventDefault();
                  startEdit(`header:${g.label}`, g.label);
                } : undefined}
              >
                <span><span class="bean-chat-sidebar-chevron" aria-hidden="true">{isFolded(g) ? "▸" : "▾"}</span> {g.label}</span><span>{g.count}</span>
              </button>
            ) : <div class={`bean-chat-sidebar-group${dropClass(g)}`} data-section={g.key} {...dropTarget(g)}><span>{g.label}</span><span>{g.count}</span></div>}
            {(isFolded(g) ? g.threads.filter((row) => row.key === activeId) : g.threads).map((row) => {
              if (row.synced) {
                const active = row.key === activeId;
                const surface = SURFACE_NAMES[row.chat.surface];
                return (
                  <div key={row.key} data-row={row.key} class={`bean-chat-sidebar-row${active ? " bean-chat-sidebar-row--active" : ""}`}>
                    <button
                      type="button"
                      class="bean-chat-sidebar-open"
                      disabled={busy}
                      aria-current={active ? "true" : undefined}
                      onClick={() => { if (!active) onOpen(row.key); }}
                    >
                      <span class="bean-chat-sidebar-line">
                        <span class="bean-chat-sidebar-badge">{surface}</span>
                        <span class="bean-chat-sidebar-title">{kindChip(row.chat)}</span>
                        {marker(row.key)}
                        <span class="bean-chat-sidebar-time">{rowTime(row.updatedAt, now)}</span>
                      </span>
                    </button>
                  </div>
                );
              }
              const t = row.thread;
              const active = t.id === activeId;
              const title = t.title || "Untitled chat";
              const agents = t.agents.filter((a): a is AgentId => a in AGENT_NAMES);
              // The row's inline edit: its title (✎ / F2) or a new group's name (Group → New group…).
              const editKey = `title:${t.id}` in drafts ? `title:${t.id}` : `group:${t.id}` in drafts ? `group:${t.id}` : undefined;
              const draft = editKey === undefined ? undefined : drafts[editKey];
              return (
                <div
                  key={t.id}
                  data-row={t.id}
                  class={`bean-chat-sidebar-row${active ? " bean-chat-sidebar-row--active" : ""}${live.has(t.id) ? " bean-chat-sidebar-row--live" : ""}${selected.has(t.id) ? " bean-chat-sidebar-row--selected" : ""}`}
                  draggable={t.starred && draft === undefined}
                  onDragStart={t.starred && draft === undefined ? (e) => {
                    if (!e.dataTransfer) return;
                    e.dataTransfer.setData(CHAT_DRAG_TYPE, t.id);
                    e.dataTransfer.effectAllowed = "move";
                  } : undefined}
                  onDragEnd={clearOver}
                  onKeyDown={(e) => {
                    if (e.key !== "F2" || draft !== undefined) return;
                    e.preventDefault();
                    startEdit(`title:${t.id}`, t.title);
                  }}
                >
                  {editKey !== undefined && draft !== undefined ? (
                    <RenameInput
                      value={draft}
                      label={editKey.startsWith("title:") ? `Rename "${title}"` : `New group for "${title}"`}
                      onInput={(v) => setDrafts((d) => (editKey in d ? { ...d, [editKey]: v } : d))}
                      onSave={() => (editKey.startsWith("title:")
                        ? saveEdit(editKey, t.title, (v) => v.trim(), (v) => onRename(t.id, v), () => ({ id: t.id, control: "rename" }))
                        : saveEdit(editKey, "", cleanGroupName, (v) => onGroup([t.id], v), () => ({ id: t.id, control: "group" })))}
                      onCancel={() => cancelEdit(editKey, { id: t.id, control: editKey.startsWith("title:") ? "rename" : "group" })}
                    />
                  ) : <button
                    type="button"
                    class="bean-chat-sidebar-open"
                    disabled={busy}
                    aria-current={active ? "true" : undefined}
                    aria-pressed={selecting ? selected.has(t.id) : undefined}
                    // ⌘-click (or ⌘-Enter on the focused row — Chromium sends no click for it) picks rows
                    // to group; a plain click drops the selection and opens as usual.
                    onKeyDown={(e) => {
                      if (!e.metaKey || e.key !== "Enter") return;
                      e.preventDefault();
                      toggleSelected(t.id);
                    }}
                    onClick={(e) => {
                      if (e.metaKey) { toggleSelected(t.id); return; }
                      if (selecting) endSelect();
                      if (!active) onOpen(t.id);
                    }}
                  >
                    <span class="bean-chat-sidebar-line">
                      {live.has(t.id) ? <span class="bean-chat-sidebar-live" role="img" aria-label="Agent session running" /> : null}
                      <span class="bean-chat-sidebar-title">{title}</span>
                      {active ? null : agents.map((a) => <AgentAvatar agent={a} size={12} />)}
                      {terminal.has(t.id) ? <span class="bean-chat-sidebar-term" role="img" aria-label="Terminal open">&gt;_</span> : null}
                      {marker(t.id)}
                      <span class="bean-chat-sidebar-time">{rowTime(t.updatedAt, now)}</span>
                    </span>
                    {active ? (
                      <span class="bean-chat-sidebar-meta">
                        <AgentAvatar agent="bean" size={12} />
                        {agents.map((a) => <AgentAvatar agent={a} size={12} />)}
                        {["Bean", ...agents.map((a) => AGENT_NAMES[a])].join(" · ")}
                      </span>
                    ) : null}
                  </button>}
                  {draft !== undefined ? null : (
                    <button
                      type="button"
                      class="bean-chat-sidebar-row-rename"
                      aria-label={`Rename "${title}"`}
                      title="Rename (F2)"
                      onClick={() => startEdit(`title:${t.id}`, t.title)}
                    >
                      ✎
                    </button>
                  )}
                  {t.starred ? (
                    // A native menu (keyboard and VoiceOver for free) under a hover-revealed glyph.
                    <span class="bean-chat-sidebar-row-grouping" title="Move to a group">
                      <span aria-hidden="true">⋯</span>
                      <select
                        class="bean-chat-sidebar-row-group"
                        aria-label={`Group "${title}"`}
                        value={t.groupName ?? ""}
                        onChange={(e) => {
                          const v = e.currentTarget.value;
                          e.currentTarget.value = t.groupName ?? "";
                          if (v === NEW_GROUP) startEdit(`group:${t.id}`, "");
                          else void onGroup([t.id], v || null).then(() => setRefocus({ id: t.id, control: "group" }));
                        }}
                      >
                        <option value="">{t.groupName ? "Remove from group" : "No group"}</option>
                        {groupNames.map((n) => <option value={n}>{n}</option>)}
                        <option value={NEW_GROUP}>New group…</option>
                      </select>
                    </span>
                  ) : null}
                  <button
                    type="button"
                    class={`bean-notes-star bean-chat-sidebar-row-star${t.starred ? " bean-notes-star--on" : ""}`}
                    aria-pressed={t.starred}
                    aria-label={`${t.starred ? "Unstar" : "Star"} "${title}"`}
                    title={t.starred ? "Unstar chat (starred chats can't be deleted)" : "Star chat"}
                    onClick={() => { void onStar(t.id, !t.starred).then(() => setRefocus({ id: t.id, control: "star" })); }}
                  >
                    {"\u2605"}
                  </button>
                  {active || t.starred ? null : (
                    <button type="button" class="bean-chat-sidebar-row-delete" aria-label={`Delete "${title}"`} title="Delete" onClick={() => onDelete(t.id)}>✕</button>
                  )}
                </div>
              );
            })}
          </>;
          // A named group's colour fills its header and runs as a line beside its rows.
          return g.kind === "group"
            ? <div key={g.key} class="bean-chat-sidebar-set" style={`--bean-group-color: var(--bean-group-${colors[groupNames.indexOf(g.label)] ?? 1})`}>{inner}</div>
            : <Fragment key={g.key}>{inner}</Fragment>;
        })}
      </div>
      {selecting ? (
        <form ref={barRef} class="bean-chat-sidebar-bar" onSubmit={(e) => { e.preventDefault(); groupSelected(); }}>
          <div class="bean-chat-sidebar-bar-count" aria-live="polite">{chosen.length} selected</div>
          <input
            class="bean-chat-sidebar-rename"
            value={newGroup}
            list="bean-chat-sidebar-groups"
            placeholder="Group name"
            aria-label="Group name"
            maxLength={GROUP_NAME_MAX}
            onInput={(e) => setNewGroup(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key !== "Escape" || e.isComposing) return;
              e.preventDefault();
              cancelRef.current?.focus();
            }}
          />
          {/* Suggestions: an existing group's name adds to that group. */}
          <datalist id="bean-chat-sidebar-groups">{groupNames.map((n) => <option value={n} />)}</datalist>
          {selectError ? <div class="bean-chat-sidebar-bar-error" role="alert">{selectError}</div> : null}
          <div class="bean-chat-sidebar-bar-actions">
            <button type="submit" class="bean-btn" disabled={grouping || !cleanGroupName(newGroup)}>{groupNames.includes(cleanGroupName(newGroup)) ? "Add to group" : "Create group"}</button>
            <button ref={cancelRef} type="button" class="bean-btn bean-btn--ghost" onClick={endSelect}>Cancel</button>
          </div>
        </form>
      ) : <button ref={newRef} type="button" class="bean-btn bean-chat-sidebar-new" disabled={busy} onClick={onNew}>+ New chat</button>}
      <div class="bean-chat-sidebar-foot">Kept 90 days unless starred · incognito chats never kept · ⌘-click chats to group them</div>
    </nav>
  );
}

/** A desktop row's title editor: focused and selected on mount (again if its row remounts). Escape is
 * default-prevented so the overlay sidebar stays open. */
function RenameInput({ value, label, onInput, onSave, onCancel }: {
  value: string; label: string; onInput: (v: string) => void; onSave: () => void; onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  return (
    <input
      ref={ref}
      class="bean-chat-sidebar-rename"
      value={value}
      aria-label={label}
      onInput={(e) => onInput(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.isComposing) return;
        if (e.key === "Enter") { e.preventDefault(); onSave(); }
        else if (e.key === "Escape") { e.preventDefault(); onCancel(); }
      }}
      // A remount (the row changed group) blurs a detached node — that's not the user leaving.
      onBlur={(e) => { if (e.currentTarget.isConnected) onSave(); }}
    />
  );
}
