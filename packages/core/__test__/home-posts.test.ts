// packages/core/__test__/home-posts.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  countPendingHomePosts, HOME_PENDING_CAP, HOME_POST_MAX_CHARS, insertHomePost, listPendingHomePosts, markHomePostsDrained,
  nextHomePostExpiry, saveDesktopChatDraining,
} from "../src/home-posts.js";
import { DESKTOP_CHAT_MAX_BYTES, HOME_THREAD_ID, getDesktopChat, listDesktopChats, saveDesktopChat } from "../src/desktop-chats.js";

let dir: string;
let file: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "bean-home-")); file = join(dir, "bean.db"); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const at = (min: number) => () => new Date(Date.UTC(2026, 10, 19, 12, min));
let n = 0;
const id = () => `p${n++}`;

describe("home posts", () => {
  it("names the soonest pending expiry (#961): none without a TTL, none once expired or drained", () => {
    n = 0;
    insertHomePost(file, { sprout: "a", body: "forever" }, id, at(0));
    expect(nextHomePostExpiry(file, at(0))).toBeUndefined();
    insertHomePost(file, { sprout: "b", body: "later", ttlMinutes: 10 }, id, at(0));
    insertHomePost(file, { sprout: "c", body: "soon", ttlMinutes: 5 }, id, at(0));
    expect(nextHomePostExpiry(file, at(1))).toBe(at(5)().toISOString());
    expect(nextHomePostExpiry(file, at(5))).toBe(at(10)().toISOString());
    markHomePostsDrained(file, ["p1"], at(6));
    expect(nextHomePostExpiry(file, at(6))).toBeUndefined();
  });

  it("lists pending posts oldest first; an expired post is neither listed nor counted", () => {
    n = 0;
    insertHomePost(file, { sprout: "a", body: "one" }, id, at(0));
    insertHomePost(file, { sprout: "b", body: "two", ttlMinutes: 5 }, id, at(1));
    expect(listPendingHomePosts(file, at(2))).toEqual([
      { id: "p0", sprout: "a", body: "one", createdAt: at(0)().toISOString() },
      { id: "p1", sprout: "b", body: "two", createdAt: at(1)().toISOString(), expiresAt: at(6)().toISOString() },
    ]);
    expect(countPendingHomePosts(file, at(2))).toBe(2);
    expect(listPendingHomePosts(file, at(6)).map((p) => p.id)).toEqual(["p0"]);
    expect(countPendingHomePosts(file, at(6))).toBe(1);
  });

  it("marking drained is idempotent and ignores unknown ids", () => {
    n = 0;
    insertHomePost(file, { sprout: "a", body: "one" }, id, at(0));
    insertHomePost(file, { sprout: "a", body: "two" }, id, at(1));
    expect(markHomePostsDrained(file, ["p0", "nope"], at(2))).toBe(1);
    expect(markHomePostsDrained(file, ["p0"], at(3))).toBe(0);
    expect(markHomePostsDrained(file, [])).toBe(0);
    expect(listPendingHomePosts(file, at(4)).map((p) => p.id)).toEqual(["p1"]);
  });

  it("caps a long body with a Dashboard tail, under the transcript's per-text cap", () => {
    insertHomePost(file, { sprout: "a", body: "x".repeat(HOME_POST_MAX_CHARS + 10) });
    const [post] = listPendingHomePosts(file);
    expect(post!.body.length).toBe(HOME_POST_MAX_CHARS);
    expect(post!.body).toMatch(/full digest in Dashboard\)$/);
  });

  it("keeps only the newest HOME_PENDING_CAP undrained posts", () => {
    n = 0;
    for (let i = 0; i < HOME_PENDING_CAP + 3; i++) insertHomePost(file, { sprout: "a", body: `b${i}` }, id, at(i));
    const pending = listPendingHomePosts(file, at(0));
    expect(pending).toHaveLength(HOME_PENDING_CAP);
    expect(pending[0]!.id).toBe("p3");
  });
});

describe("Home thread (#960, #976)", () => {
  it("one fixed UUID-shaped id that outlives the 90-day prune; an old daily Home doesn't", () => {
    expect(HOME_THREAD_ID).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const daily = "11111111-1111-4111-8111-111111111111";
    const idle = new Date(Date.UTC(2026, 0, 1));
    saveDesktopChat(file, { id: HOME_THREAD_ID, title: "Home", itemsJson: "[]" }, idle);
    saveDesktopChat(file, { id: daily, title: "Home · Jan 1", itemsJson: "[]" }, idle);
    const later = new Date(idle.getTime() + 91 * 86_400_000);
    expect(listDesktopChats(file, later).map((t) => t.id)).toEqual([HOME_THREAD_ID]);
  });

  it("saves the transcript and drains its posts together; a failed save drains nothing", () => {
    n = 0;
    insertHomePost(file, { sprout: "a", body: "one" }, id, at(0));
    insertHomePost(file, { sprout: "a", body: "two" }, id, at(1));
    const home = HOME_THREAD_ID;
    expect(() => saveDesktopChatDraining(file, { id: home, title: "Home", itemsJson: "x".repeat(DESKTOP_CHAT_MAX_BYTES + 1) }, ["p0"], at(2)()))
      .toThrow(/too large/);
    expect(listPendingHomePosts(file, at(2)).map((p) => p.id)).toEqual(["p0", "p1"]);
    expect(saveDesktopChatDraining(file, { id: home, title: "Home", itemsJson: "[]" }, ["p0"], at(3)())).toBe("Home");
    expect(getDesktopChat(file, home)).toBeDefined();
    expect(listPendingHomePosts(file, at(3)).map((p) => p.id)).toEqual(["p1"]);
  });
});
