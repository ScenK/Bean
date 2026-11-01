import { expect, test } from "vitest";
import { groupThreads, mergeRows, withSaveAck } from "../src/renderer/components/chat/ChatSidebar.js";
import { composerState, kindChip } from "../src/renderer/components/chat/SyncedChat.js";
import type { ChatItem } from "../src/renderer/shared/chat-types.js";

const now = new Date(2026, 9, 29, 15, 0);
const at = (d: Date) => d.toISOString();
const t = (id: string, updatedAt: string) => ({ id, title: id, updatedAt, agents: [] as string[] });

test("groups into Today and Earlier by local day, dropping empty groups", () => {
  const today = t("a", at(new Date(2026, 9, 29, 0, 5)));
  const yesterday = t("b", at(new Date(2026, 9, 28, 23, 55)));
  expect(groupThreads([today, yesterday], now)).toEqual([
    { label: "Today", threads: [today] },
    { label: "Earlier", threads: [yesterday] },
  ]);
  expect(groupThreads([yesterday], now).map((g) => g.label)).toEqual(["Earlier"]);
  expect(groupThreads([], now)).toEqual([]);
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
    { id: "b", title: "B!", updatedAt: "2026-10-29T11:00:00.000Z", agents: ["claude"] },
    list[0],
  ]);
  // A first save adds the row.
  expect(withSaveAck([], { id: "c", title: "c", updatedAt: "x" }, [])).toEqual([{ id: "c", title: "c", updatedAt: "x", agents: [] }]);
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
