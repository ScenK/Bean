import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, openDb } from "../src/db.js";
import { insertHomePost } from "../src/home-posts.js";
import {
  MIND_ACTIVE_CAP, applyPulsePlan, countPulsePostsToday, getMindItem, listMindItems, ownerTouchedSeedSince,
  resolveMindItem, undoMindItem,
} from "../src/mind-store.js";

let dir: string;
let file: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "bean-mind-")); file = join(dir, "bean.db"); });
afterEach(() => { closeDb(file); rmSync(dir, { recursive: true, force: true }); });

const day = (d: number, h = 12) => new Date(2026, 10, d, h, 0);
let n = 0;
const newId = () => `m${n++}`;
const seed = (topicKey: string, extra: Record<string, unknown> = {}) => ({ topicKey, text: `about ${topicKey}`, ...extra });

describe("bean.db migration (#1156)", () => {
  it("adds home_posts.kind and mind_items to an older bean.db, and re-opens cleanly", () => {
    const old = new DatabaseSync(file);
    old.exec("CREATE TABLE home_posts (id TEXT PRIMARY KEY, sprout TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT, drained_at TEXT)");
    old.prepare("INSERT INTO home_posts (id, sprout, body, created_at) VALUES ('old', 's', 'b', ?)").run(day(27).toISOString());
    old.close();
    const db = openDb(file);
    expect((db.prepare("SELECT kind FROM home_posts WHERE id = 'old'").get() as { kind: string }).kind).toBe("sprout");
    expect(listMindItems(file)).toEqual([]);
    closeDb(file);
    expect(() => openDb(file)).not.toThrow();
    const cols = (openDb(file).prepare("PRAGMA table_info(home_posts)").all() as { name: string }[]).filter((c) => c.name === "kind");
    expect(cols).toHaveLength(1);
  });
});

describe("mind store", () => {
  beforeEach(() => { n = 0; });

  it("adds new topics up to the active cap and never duplicates an active key", () => {
    const keys = Array.from({ length: MIND_ACTIVE_CAP + 2 }, (_, i) => seed(`k${i}`));
    const out = applyPulsePlan(file, { upserts: [...keys, seed("k0")], resolve: [] }, day(27), newId);
    expect(out.added).toHaveLength(MIND_ACTIVE_CAP);
    expect(listMindItems(file).filter((s) => s.topicKey === "k0")).toHaveLength(1);
  });

  it("a dismissed topic stays let go; a done one comes back only from a newer run", () => {
    applyPulsePlan(file, { upserts: [seed("bill"), seed("trip")], resolve: [] }, day(20), newId);
    resolveMindItem(file, "m0", "done", undefined, day(21));
    resolveMindItem(file, "m1", "dismissed", "not-interested", day(21));
    expect(getMindItem(file, "m1")?.dismissReason).toBe("not-interested");
    const again = applyPulsePlan(file, {
      upserts: [seed("bill", { sourceStartedAt: day(19).toISOString() }), seed("trip", { sourceStartedAt: day(26).toISOString() })], resolve: [],
    }, day(27), newId);
    expect(again.added).toEqual([]);
    const later = applyPulsePlan(file, { upserts: [seed("bill", { sourceStartedAt: day(26).toISOString() })], resolve: [] }, day(27), newId);
    expect(later.added).toHaveLength(1);
  });

  it("the owner's Done between a pulse's read and its commit wins (version check)", () => {
    applyPulsePlan(file, { upserts: [seed("a"), seed("b")], resolve: [] }, day(27, 9), newId);
    const snapshot = listMindItems(file);
    const [a, b] = [snapshot[0]!, snapshot[1]!];
    resolveMindItem(file, a.id, "dismissed", "wrong", day(27, 10));
    resolveMindItem(file, b.id, "done", undefined, day(27, 10));
    const out = applyPulsePlan(file, {
      upserts: [{ id: a.id, version: a.version, topicKey: "a", text: "reworded" }],
      resolve: [{ id: b.id, version: b.version, status: "expired" }],
    }, day(27, 11), newId);
    expect(out.conflicts.sort()).toEqual([a.id, b.id].sort());
    expect(getMindItem(file, a.id)).toMatchObject({ status: "dismissed", text: "about a" });
    expect(getMindItem(file, b.id)?.status).toBe("done");
  });

  it("rewords and resolves at the current version, and undo brings a seed back", () => {
    applyPulsePlan(file, { upserts: [seed("a")], resolve: [] }, day(27, 9), newId);
    const a = listMindItems(file)[0]!;
    applyPulsePlan(file, { upserts: [{ id: a.id, version: a.version, topicKey: "a", text: "new words" }], resolve: [] }, day(27, 10), newId);
    const b = getMindItem(file, a.id)!;
    expect(b).toMatchObject({ text: "new words", version: 2 });
    expect(applyPulsePlan(file, { upserts: [], resolve: [{ id: a.id, version: b.version, status: "done" }] }, day(27, 11)).resolved).toEqual([a.id]);
    expect(ownerTouchedSeedSince(file, day(27, 8).toISOString())).toBe(false);
    expect(undoMindItem(file, a.id, day(27, 12))).toMatchObject({ status: "active", version: 4 });
    expect(ownerTouchedSeedSince(file, day(27, 8).toISOString())).toBe(true);
  });

  it("prunes terminal rows 90 days after their last update; lists recent ones on request", () => {
    applyPulsePlan(file, { upserts: [seed("old"), seed("new")], resolve: [] }, new Date(2026, 5, 1), newId);
    resolveMindItem(file, "m0", "done", undefined, new Date(2026, 5, 2));
    resolveMindItem(file, "m1", "done", undefined, day(25));
    expect(listMindItems(file, { now: day(27) })).toEqual([]);
    expect(listMindItems(file, { recentDays: 7, now: day(27) }).map((s) => s.id)).toEqual(["m1"]);
    applyPulsePlan(file, { upserts: [], resolve: [] }, day(27));
    expect(getMindItem(file, "m0")).toBeUndefined();
    expect(getMindItem(file, "m1")).toBeDefined();
  });

  it("counts only today's pulse posts", () => {
    insertHomePost(file, { sprout: "bean", body: "yesterday", kind: "pulse" }, newId, () => day(26, 20));
    insertHomePost(file, { sprout: "bean", body: "today", kind: "pulse" }, newId, () => day(27, 8));
    insertHomePost(file, { sprout: "digest", body: "a sprout" }, newId, () => day(27, 9));
    expect(countPulsePostsToday(file, day(27, 15))).toBe(1);
  });
});
