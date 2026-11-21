import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { openDb } from "../src/db.js";
import {
  ConversationStore, MAIN_CONVERSATION_ID, MAIN_CUTOVER_KEY, formatSummaryBlock, homeMainCursor, mainSince, setHomeMainCursor,
} from "../src/index.js";

// #1000: the owner's DM exchanges in the main log, as the desktop pulls them past a cursor.
function setup() {
  const file = join(mkdtempSync(join(tmpdir(), "bean-main-since-")), "bean.db");
  const store = new ConversationStore(file);
  const add = (role: "user" | "assistant", content: string, surface?: "desktop" | "discord" | "teams"): void => {
    store.append(MAIN_CONVERSATION_ID, { role, content }, surface ? { surface } : {});
  };
  return { file, store, add };
}

describe("mainSince", () => {
  test("only DM-surface entries, mapped for display: no desktop turn, post or summary", () => {
    const { file, add } = setup();
    openDb(file).prepare("INSERT INTO memory_meta (key, value) VALUES (?, ?)").run(MAIN_CUTOVER_KEY, "2026-11-20T00:00:00.000Z");
    add("user", formatSummaryBlock("the folded start")); // 1: the cutover summary
    add("user", "typed at the desk", "desktop"); // 2
    add("user", "[Scen]: from my phone", "discord"); // 3
    add("assistant", "got it", "discord"); // 4
    add("assistant", '[card: note — saved]', "teams"); // 5
    add("assistant", "[live session] all done", "discord"); // 6
    add("user", "[sprout \"x\" posted]: <<<\nnews\n>>>"); // 7: a drained post (no surface)
    const pull = mainSince(file, 0);
    expect(pull.rows).toEqual([
      { seq: 3, via: "discord", row: { role: "user", text: "from my phone" } },
      { seq: 4, via: "discord", row: { role: "bean", text: "got it" } },
      { seq: 5, via: "teams", row: { role: "status", text: "Card: note — saved" } },
      { seq: 6, via: "discord", row: { role: "agent", text: "all done" } },
    ]);
    expect(pull).toMatchObject({ cursor: 7, trimmed: false, cutoverAt: "2026-11-20T00:00:00.000Z" });
    expect(mainSince(file, 4).rows.map((r) => r.seq)).toEqual([5, 6]);
    expect(mainSince(file, 7)).toMatchObject({ rows: [], cursor: 7, trimmed: false });
  });

  test("no cutover time without history: a fresh install's first pull carries no line", () => {
    const { file, add } = setup();
    openDb(file).prepare("INSERT INTO memory_meta (key, value) VALUES (?, ?)").run(MAIN_CUTOVER_KEY, "2026-11-20T00:00:00.000Z");
    add("user", "typed at the desk", "desktop");
    expect(mainSince(file, 0).cutoverAt).toBeUndefined();
    add("user", "[Scen]: first DM", "discord");
    expect(mainSince(file, 0).cutoverAt).toBe("2026-11-20T00:00:00.000Z");
  });

  test("a cursor overtaken by compaction reports trimmed; one behind it does not", () => {
    const { file, store, add } = setup();
    for (let i = 1; i <= 6; i++) add("user", `[Scen]: m${i}`, "discord");
    expect(mainSince(file, 2).trimmed).toBe(false);
    // Compaction folds seqs 1–4 into a summary at seq 1.
    expect(store.replaceOldest(MAIN_CONVERSATION_ID, store.oldest(MAIN_CONVERSATION_ID, 4), { role: "user", content: formatSummaryBlock("s") })).toBe(true);
    expect(mainSince(file, 2)).toMatchObject({ trimmed: true, cursor: 6 });
    expect(mainSince(file, 2).rows.map((r) => r.seq)).toEqual([5, 6]);
    expect(mainSince(file, 4).trimmed).toBe(false); // everything it hadn't seen is still there
  });

  test("Home's cursor round-trips; junk reads as 0", () => {
    const { file } = setup();
    expect(homeMainCursor(file)).toBe(0);
    setHomeMainCursor(file, 42);
    expect(homeMainCursor(file)).toBe(42);
    setHomeMainCursor(file, -1);
    expect(homeMainCursor(file)).toBe(42);
  });
});
