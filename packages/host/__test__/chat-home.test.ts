import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  deleteDesktopChat, getDesktopChat, groupDesktopChats, homeThreadId, insertHomePost, listDesktopChats, listPendingHomePosts,
  renameDesktopChat, renameDesktopChatGroup, saveDesktopChat, saveDesktopChatDraining, starDesktopChat,
} from "@bean/core";
import { buildChatThreadHandlers, HOME_TARGET } from "../src/chat.js";

// Today's Home (#960) over a real bean.db: the host hands pending posts to the chat that opens it and
// drains only those, with the save that holds them.
function setup(at = new Date(2026, 10, 19, 12)) {
  const dbFile = join(mkdtempSync(join(tmpdir(), "bean-home-")), "bean.db");
  const clock = { now: at };
  const threads = buildChatThreadHandlers({
    dbFile, saveDesktopChat, getDesktopChat, deleteDesktopChat, starDesktopChat, renameDesktopChat, groupDesktopChats,
    renameDesktopChatGroup, listDesktopChats, listPendingHomePosts: (f) => listPendingHomePosts(f, () => clock.now), saveDesktopChatDraining,
    now: () => clock.now,
  });
  const post = (body: string): string => insertHomePost(dbFile, { sprout: "digest", body }, undefined, () => clock.now);
  const pending = (): string[] => listPendingHomePosts(dbFile, () => clock.now).map((p) => p.id);
  return { dbFile, threads, clock, post, pending, home: homeThreadId(at) };
}
const posts = (...ids: string[]) => ids.map((postId) => ({ kind: "post", id: `i-${postId}`, postId, sprout: "digest", at: "x", text: "t" }));

describe("Home thread", () => {
  it("opens as an empty thread with the pending posts, and the save holding them drains them", () => {
    const { threads, post, pending, home } = setup();
    const p1 = post("one");
    const t = threads.get("a", HOME_TARGET);
    expect(t).toMatchObject({ id: home, items: [], noteSlug: null, home: { posts: [{ id: p1, body: "one" }] } });
    // A save that doesn't hold the post drains nothing; one that holds it drains it.
    threads.save("a", { id: home, title: "Home", items: [] });
    expect(pending()).toEqual([p1]);
    const ack = threads.save("a", { id: home, title: "Home", items: posts(p1) });
    expect(ack).toMatchObject({ id: home, home: true });
    expect(pending()).toEqual([]);
    expect(threads.list()).toEqual([expect.objectContaining({ id: home, home: true })]);
  });

  it("drains only posts the saved transcript holds and that were handed to that chat", () => {
    const { threads, post, pending, home } = setup();
    const p1 = post("one");
    const p0 = post("zero");
    threads.get("a", HOME_TARGET);
    const p2 = post("two"); // landed after the open: not this chat's to drain
    threads.save("a", { id: home, title: "Home", items: [...posts(p1, p2, "made-up"), { kind: "status", postId: p0 }] });
    expect(pending()).toEqual([p0, p2]);
  });

  it("a post item the restore would drop (missing a field) drains nothing", () => {
    const { threads, post, pending, home } = setup();
    const p1 = post("one");
    threads.get("a", HOME_TARGET);
    const [item] = posts(p1);
    const { text: _t, ...noText } = item!;
    threads.save("a", { id: home, title: "Home", items: [noText, { ...item!, id: 7 }] });
    expect(pending()).toEqual([p1]);
    threads.save("a", { id: home, title: "Home", items: [item] });
    expect(pending()).toEqual([]);
  });

  it("after midnight yesterday's Home can't keep posts it never saved; today's Home gets them", () => {
    const { threads, clock, post, pending, home } = setup(new Date(2026, 10, 19, 23, 59));
    const p1 = post("one");
    threads.get("a", HOME_TARGET);
    clock.now = new Date(2026, 10, 20, 0, 1);
    expect(() => threads.save("a", { id: home, title: "Home", items: posts(p1) })).toThrow(/day ended/);
    expect(threads.exists(home)).toBe(false);
    expect(threads.save("a", { id: home, title: "Home", items: [] })).toBeDefined();
    expect(threads.get("b", HOME_TARGET)).toMatchObject({ id: homeThreadId(clock.now), home: { posts: [{ id: p1 }] } });
    expect(pending()).toEqual([p1]);
  });

  it("a hidden chat can't drain: another mount is refused while one holds Home", () => {
    const { threads, post, pending, home } = setup();
    post("one");
    threads.get("a", HOME_TARGET);
    expect(() => threads.get("b", HOME_TARGET)).toThrow(/already open/);
    expect(() => threads.save("b", { id: home, title: "Home", items: posts(...pending()) })).toThrow(/another open chat/);
    expect(pending()).toHaveLength(1);
  });

  it("a reopen after a failed save hands the same posts again", () => {
    const { threads, post, home } = setup();
    const p1 = post("one");
    threads.get("a", HOME_TARGET);
    expect(() => threads.save("a", { id: home, title: "Home", items: [...posts(p1), { text: "x".repeat(3 * 1024 * 1024) }] })).toThrow(/too large/);
    threads.release("a");
    expect(threads.get("b", HOME_TARGET)).toMatchObject({ home: { posts: [{ id: p1 }] } });
  });

  it("can't be deleted, starred, renamed, grouped or taken off the record; yesterday's Home is plain history", () => {
    const { threads, clock, home } = setup();
    threads.get("a", HOME_TARGET);
    threads.save("a", { id: home, title: "Home", items: [] });
    expect(() => threads.star(home, true)).toThrow(/Home/);
    expect(() => threads.rename(home, "x")).toThrow(/Home/);
    expect(() => threads.group([home], "g")).toThrow(/Home/);
    threads.setIncognito("a", true);
    expect(threads.exists(home)).toBe(true);
    expect(threads.save("a", { id: home, title: "Home", items: [] })).toBeDefined(); // not latched
    threads.release("a");
    expect(() => threads.delete(home)).toThrow(/Home/);
    clock.now = new Date(2026, 10, 20, 9);
    const t = threads.get("b", home);
    expect(t).not.toHaveProperty("home");
    expect(threads.list()[0]).not.toHaveProperty("home");
    threads.release("b");
    threads.delete(home);
    expect(threads.exists(home)).toBe(false);
  });
});
