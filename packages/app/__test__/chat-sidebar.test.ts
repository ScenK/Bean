import { expect, test } from "vitest";
import { DESKTOP_CHAT_TITLE_MAX } from "@bean/core";
import { cleanGroupName, foldedAfterRename, GROUP_COLORS, groupColors, GROUP_NAME_MAX, groupThreads, mergeRows, sidebarGroups, withSaveAck } from "../src/renderer/components/chat/ChatSidebar.js";
import { composerState, kindChip, liveTurnRunning } from "../src/renderer/components/chat/SyncedChat.js";
import type { ChatItem } from "../src/renderer/shared/chat-types.js";

const now = new Date(2026, 9, 29, 15, 0);
const at = (d: Date) => d.toISOString();
const t = (id: string, updatedAt: string) => ({ id, title: id, updatedAt, agents: [] as string[], starred: false, groupName: null as string | null });

test("groups into Today, the two latest earlier active days, and Earlier, dropping empty groups", () => {
  const today = t("a", at(new Date(2026, 9, 29, 0, 5)));
  const yesterday = t("b", at(new Date(2026, 9, 28, 23, 55)));
  expect(groupThreads([today, yesterday], now)).toEqual([
    { label: "Today", threads: [today] },
    { label: new Date(2026, 9, 28).toLocaleDateString(undefined, { month: "short", day: "numeric" }), threads: [yesterday] },
  ]);
  expect(groupThreads([], now)).toEqual([]);
  const day = (d: number, h = 12) => t(`${d}-${h}`, at(new Date(2026, 9, d, h)));
  const [y1, y2, d27, d24, d20] = [day(28, 18), day(28, 9), day(27), day(24), day(20)];
  const label = (d: number) => new Date(2026, 9, d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  expect(groupThreads([today, y1, y2, d27, d24, d20], now)).toEqual([
    { label: "Today", threads: [today] },
    { label: label(28), threads: [y1, y2] },
    { label: label(27), threads: [d27] },
    { label: "Earlier", threads: [d24, d20] },
  ]);
  // No chat today: still the two latest active days, then Earlier.
  expect(groupThreads([d27, d24, d20], now).map((g) => g.label)).toEqual([label(27), label(24), "Earlier"]);
});

test("a save ack moves the active row to the top with its title, time and live agents", () => {
  const list = [t("a", "2026-10-29T10:00:00.000Z"), t("b", "2026-10-29T09:00:00.000Z")];
  const items: ChatItem[] = [
    { kind: "reply", id: "1", text: "hi" },
    { kind: "reply", id: "2", text: "x", agent: "claude" },
    { kind: "reply", id: "3", text: "y", agent: "claude" },
    { kind: "reply", id: "4", text: "z", agent: "bean" },
  ];
  const next = withSaveAck(list, { id: "b", title: "B!", updatedAt: "2026-10-29T11:00:00.000Z" }, items);
  expect(next).toEqual([
    { id: "b", title: "B!", updatedAt: "2026-10-29T11:00:00.000Z", agents: ["claude"], starred: false, groupName: null },
    list[0],
  ]);
  // A first save adds the row.
  expect(withSaveAck([], { id: "c", title: "c", updatedAt: "x" }, [])).toEqual([{ id: "c", title: "c", updatedAt: "x", agents: [], starred: false, groupName: null }]);
  // A starred row stays starred and keeps its group.
  const starred = [{ ...t("d", "2026-10-29T08:00:00.000Z"), starred: true, groupName: "Work" }];
  expect(withSaveAck(starred, { id: "d", title: "d", updatedAt: "y" }, [])[0]).toMatchObject({ starred: true, groupName: "Work" });
});

test("starred desktop threads come first as one group and skip the date groups' day slots", () => {
  const day = (id: string, d: number, starred = false) => ({ ...t(id, at(new Date(2026, 9, d, 12))), starred });
  const threads = [day("a", 29), day("s1", 28, true), day("b", 27), day("s2", 2, true), day("c", 26), day("d", 25)];
  const synced = [{ surface: "teams" as const, conversationId: "x", kind: "post" as const, title: "T", updatedAt: at(new Date(2026, 9, 24, 12)), live: false }];
  const groups = sidebarGroups(mergeRows(threads, synced), now);
  const label = (d: number) => new Date(2026, 9, d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  expect(groups.map((g) => [g.label, g.threads.map((r) => r.key)])).toEqual([
    ["Starred", ["s1", "s2"]],
    ["Today", ["a"]],
    [label(27), ["b"]],
    [label(26), ["c"]],
    ["Earlier", ["d", "teams:x"]],
  ]);
  // Every row once; no Starred group when nothing is starred.
  expect(groups.flatMap((g) => g.threads)).toHaveLength(7);
  expect(sidebarGroups(mergeRows([day("a", 29)], []), now).map((g) => g.label)).toEqual(["Today"]);
});

test("synced chats merge into the one list by time, keyed so they never collide with a thread", () => {
  const threads = [t("a", "2026-10-29T12:00:00.000Z"), t("b", "2026-10-29T08:00:00.000Z")];
  const synced = [{ surface: "teams" as const, conversationId: "19:x;messageid=1", kind: "post" as const, title: "Standup", updatedAt: "2026-10-29T10:00:00.000Z", live: false }];
  expect(mergeRows(threads, synced).map((r) => r.key)).toEqual(["a", "teams:19:x;messageid=1", "b"]);
});

test("the kind chip names a DM, a thread, a #channel and a running live session", () => {
  const base = { surface: "discord" as const, conversationId: "c", updatedAt: "", live: false };
  expect(kindChip({ ...base, kind: "dm", title: "DM" })).toBe("DM");
  expect(kindChip({ ...base, kind: "thread", title: "bugs" })).toBe("bugs");
  expect(kindChip({ ...base, kind: "channel", title: "ops", live: true })).toBe("#ops · live");
});

test("an archive chips `· archived` (never with `· live`) and stays read-only with the bot up", () => {
  const archive = { surface: "discord" as const, conversationId: "c~a", kind: "dm" as const, title: "DM", updatedAt: "", live: true, resumable: true, archived: true, archivedFrom: "c" };
  expect(kindChip(archive)).toBe("DM · archived");
  const rows = [{ role: "agent" as const, text: "done", agent: "claude" as const }];
  expect(composerState(archive, true, rows)).toEqual({ readOnly: true, placeholder: "Archived after /new — read only" });
  expect(composerState(archive, false, [])).toEqual({ readOnly: true, placeholder: "Archived after /new — read only" });
  expect(composerState({ ...archive, archived: false, live: false, resumable: false }, true, [])).toEqual({ readOnly: false, placeholder: "Message Bean" });
});

test("a live turn is in flight while the transcript ends on a user line", () => {
  const live = { surface: "discord" as const, conversationId: "c", kind: "thread" as const, title: "t", updatedAt: "", live: true, liveCli: "claude" as const, resumable: true, archived: false };
  const user = { role: "user" as const, text: "go" };
  const reply = { role: "agent" as const, text: "done", agent: "claude" as const };
  expect(liveTurnRunning(live, [reply, user])).toBe(true);
  expect(liveTurnRunning(live, [user, reply])).toBe(false);
  expect(liveTurnRunning(live, [])).toBe(false);
  expect(liveTurnRunning({ ...live, live: false }, [user])).toBe(false);
});

test("Starred holds its ungrouped rows, then named groups A→Z; keys never collide with a group's name", () => {
  const s = (id: string, d: number, groupName: string | null = null) => ({ ...t(id, at(new Date(2026, 9, d, 12))), starred: true, groupName });
  const threads = [t("a", at(new Date(2026, 9, 29, 12))), s("w1", 29, "Work"), s("loose", 28), s("e1", 27, "Earlier"), s("w2", 26, "Work"), s("t1", 25, "Today"), s("st", 24, "Starred"), t("old", at(new Date(2026, 8, 1)))];
  const sections = sidebarGroups(mergeRows(threads, []), now);
  expect(sections.map((g) => [g.kind, g.key, g.label, g.count, g.threads.map((r) => r.key)])).toEqual([
    ["starred", "starred", "Starred", 6, ["loose"]],
    ["group", "group:Earlier", "Earlier", 1, ["e1"]],
    ["group", "group:Starred", "Starred", 1, ["st"]],
    ["group", "group:Today", "Today", 1, ["t1"]],
    ["group", "group:Work", "Work", 2, ["w1", "w2"]],
    ["date", "date:Today", "Today", 1, ["a"]],
    ["date", `date:${new Date(2026, 8, 1).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`, new Date(2026, 8, 1).toLocaleDateString(undefined, { month: "short", day: "numeric" }), 1, ["old"]],
  ]);
  expect(new Set(sections.map((g) => g.key)).size).toBe(sections.length);
  // Only grouped stars: Starred still heads them, with no rows of its own.
  expect(sidebarGroups(mergeRows([s("w", 29, "Work")], []), now).map((g) => [g.key, g.count, g.threads.length])).toEqual([["starred", 1, 0], ["group:Work", 1, 1]]);
});

test("a group rename moves its fold, but a merge keeps the target's; names clean like core's", () => {
  expect(foldedAfterRename(["A", "B"], "A", "C", ["A", "B"])).toEqual(["B", "C"]);
  expect(foldedAfterRename(["A"], "A", "B", ["A", "B"])).toEqual([]);
  expect(foldedAfterRename(["B"], "A", "B", ["A", "B"])).toEqual(["B"]);
  expect(foldedAfterRename([], "A", "C", ["A"])).toEqual([]);
  expect(cleanGroupName("  Side\n  projects ")).toBe("Side projects");
  expect(cleanGroupName("x".repeat(100))).toHaveLength(GROUP_NAME_MAX);
  expect(GROUP_NAME_MAX).toBe(DESKTOP_CHAT_TITLE_MAX);
});

test("groupColors: a stable palette entry per name, never shared with the group directly above", () => {
  const names = Array.from({ length: 40 }, (_, i) => `group ${i}`);
  const colors = groupColors(names);
  expect(colors.every((c) => Number.isInteger(c) && c >= 1 && c <= GROUP_COLORS)).toBe(true);
  for (let i = 1; i < colors.length; i++) expect(colors[i], names[i]).not.toBe(colors[i - 1]);
  // Same names, same colours (restarts, folding); a group alone keeps its hash colour.
  expect(groupColors(names)).toEqual(colors);
  expect(groupColors(["group 0"])).toEqual([colors[0]]);
  // Two names hashing alike: the lower one moves to the next entry.
  const [first] = groupColors(["Work"]);
  expect(groupColors(["Work", "Work"])).toEqual([first, (first! % GROUP_COLORS) + 1]);
});
