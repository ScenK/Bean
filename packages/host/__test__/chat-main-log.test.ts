import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  ConversationStore, deleteDesktopChat, formatSummaryBlock, getDesktopChat, groupDesktopChats, HOME_THREAD_ID, insertHomePost, listDesktopChats,
  listPendingHomePosts, MAIN_CONVERSATION_ID, renameDesktopChat, renameDesktopChatGroup, saveDesktopChat, saveDesktopChatDraining,
  starDesktopChat, type ChatMessage,
} from "@bean/core";
import { buildChatHandler, buildChatThreadHandlers, HOME_TARGET } from "../src/chat.js";

// Home on the main conversation's log (#997), over a real bean.db: dark until the cutover marker.
function setup() {
  const dbFile = join(mkdtempSync(join(tmpdir(), "bean-main-")), "bean.db");
  const flags = { cutover: false };
  let store: ConversationStore | undefined;
  const mainLog = (): ConversationStore | undefined => (flags.cutover ? (store ??= new ConversationStore(dbFile)) : undefined);
  const threads = buildChatThreadHandlers({
    dbFile, saveDesktopChat, getDesktopChat, deleteDesktopChat, starDesktopChat, renameDesktopChat, groupDesktopChats,
    renameDesktopChatGroup, listDesktopChats, listPendingHomePosts: (f) => listPendingHomePosts(f), saveDesktopChatDraining, mainLog,
  });
  const seen: ChatMessage[][] = [];
  const chat = buildChatHandler({
    loadSkills: async () => [], loadProjects: async () => [], loadPersona: async () => ({ name: "Bean", tags: [] }),
    loadMemories: async () => [], appendMemories: async () => {}, deleteMemories: async () => [],
    converse: async ({ messages }) => { seen.push(messages); return { content: "reply", toolCalls: [] }; },
    getModel: () => "m", projectSkillsDir: "/x", skillsDir: "/x", projectsFile: "/x", personaFile: "/x", projectPersonaFile: "/x", dbFile,
    mainLog: (mountId) => (mountId !== undefined && threads.isMain(mountId) ? mainLog() : undefined),
  });
  const log = () => new ConversationStore(dbFile).history(MAIN_CONVERSATION_ID);
  return { dbFile, flags, threads, chat, seen, log };
}
const said = (msgs: ChatMessage[]): string[] => msgs.filter((m) => m.role !== "system").map((m) => String(m.content));

describe("Home on the main log", () => {
  it("without the marker, Home keeps the shell's history and the log stays empty", async () => {
    const { threads, chat, seen, log } = setup();
    const t = threads.get("a", HOME_TARGET);
    expect(t).toMatchObject({ home: { posts: [] } });
    expect((t as { home: { log?: true } }).home.log).toBeUndefined();
    expect(threads.isMain("a")).toBe(false);
    await chat({ history: [{ role: "user", content: "from the shell" }], message: "hi", turnId: "t1", delta: [{ key: "x", role: "user", content: "ignored" }] }, 1, "a");
    expect(said(seen[0]!)).toContain("from the shell");
    expect(log()).toEqual([]);
  });

  it("with the marker: history is the log, the delta and the turn append once, a re-sent delta appends nothing", async () => {
    const { flags, threads, chat, seen, log } = setup();
    flags.cutover = true;
    expect(threads.get("a", HOME_TARGET)).toMatchObject({ home: { posts: [], log: true } });
    const delta = [{ key: "c1:[card]", role: "assistant" as const, content: "[card: note — saved]" }];
    await chat({ history: [{ role: "user", content: "renderer history" }], message: "first", turnId: "t1", delta }, 1, "a");
    expect(said(seen[0]!)).not.toContain("renderer history");
    expect(log()).toEqual([
      { role: "assistant", content: "[card: note — saved]" },
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
    ]);
    // Lost ack: the shell re-sends the delta and its own copy of t1 — nothing doubles.
    await chat({ history: [], message: "second", turnId: "t2", delta: [...delta, { key: "t1", role: "user", content: "first" }] }, 1, "a");
    expect(said(seen[1]!)).toEqual(expect.arrayContaining(["first", "reply", "[card: note — saved]"]));
    expect(log().map((t) => t.content)).toEqual(["[card: note — saved]", "first", "reply", "second", "reply"]);
  });

  it("a non-Home chat never touches the log", async () => {
    const { flags, chat, log } = setup();
    flags.cutover = true;
    await chat({ history: [], message: "elsewhere", turnId: "t1" }, 1, "b");
    expect(log()).toEqual([]);
  });

  it("the gap marker comes from the log's own times", async () => {
    const { dbFile, flags, threads, chat } = setup();
    flags.cutover = true;
    threads.get("a", HOME_TARGET);
    new ConversationStore(dbFile).append(MAIN_CONVERSATION_ID, { role: "user", content: "old" });
    new DatabaseSync(dbFile).prepare("UPDATE chatops_turns SET created_at = ?").run(new Date(Date.now() - 4 * 3600_000).toISOString());
    const res = await chat({ history: [], message: "back", turnId: "t1" }, 1, "a");
    expect(res.gapMarker).toMatch(/^\[— /);
    const again = await chat({ history: [], message: "still here", turnId: "t2", gap: true }, 1, "a");
    expect(again.gapMarker).toBeUndefined(); // the shell's own claim is ignored
  });

  it("bounds the log before the model sees it: past the byte budget the oldest fold into a summary in the log", async () => {
    const { dbFile, flags, threads, chat, seen, log } = setup();
    flags.cutover = true;
    threads.get("a", HOME_TARGET);
    const store = new ConversationStore(dbFile);
    const big = "x".repeat(60_000);
    for (let i = 0; i < 5; i++) store.append(MAIN_CONVERSATION_ID, { role: "user", content: `${i}${big}` }); // 300 KB, 5 turns
    await chat({ history: [], message: "short follow-up", turnId: "t1" }, 1, "a");
    const sent = said(seen.at(-1)!).join("").length;
    expect(sent).toBeLessThan(200_000);
    expect(log()[0]!.content).toMatch(/^\[Summary of the earlier conversation/);
    expect(log().map((t) => t.content).join("").length).toBeLessThan(200_000);
  });

  it("folds the log's own summary whole (not clipped as a turn) and replaces it with the turns", async () => {
    const { dbFile, flags, threads, chat, seen, log } = setup();
    flags.cutover = true;
    threads.get("a", HOME_TARGET);
    const store = new ConversationStore(dbFile);
    store.append(MAIN_CONVERSATION_ID, { role: "user", content: formatSummaryBlock(`${"s".repeat(3000)} END-OF-SUMMARY`) });
    for (let i = 0; i < 61; i++) store.append(MAIN_CONVERSATION_ID, { role: i % 2 ? "assistant" : "user", content: `turn ${i}` });
    await chat({ history: [], message: "next", turnId: "t1" }, 1, "a");
    const ask = seen.find((m) => String(m[0]?.content).startsWith("Summarize"))!;
    expect(String(ask[1]!.content)).toMatch(/^Summary so far:\n[\s\S]*END-OF-SUMMARY/);
    expect(String(ask[1]!.content)).not.toContain("[Summary of the earlier conversation");
    const after = log();
    expect(after.filter((t) => t.content.startsWith("[Summary of the earlier conversation"))).toHaveLength(1);
    expect(after[0]!.content).toBe(formatSummaryBlock("reply"));
  });

  it("a remote save (keepNote) never unlinks the chat's note", () => {
    const { dbFile, threads } = setup();
    saveDesktopChat(dbFile, { id: HOME_THREAD_ID, title: "Home", itemsJson: "[]", noteSlug: "n1" });
    threads.get("a", HOME_TARGET);
    threads.save("a", { id: HOME_THREAD_ID, title: "Home", items: [] }, { keepNote: true });
    expect(getDesktopChat(dbFile, HOME_THREAD_ID)?.noteSlug).toBe("n1");
    threads.save("a", { id: HOME_THREAD_ID, title: "Home", items: [] }); // a local unlink still unlinks
    expect(getDesktopChat(dbFile, HOME_THREAD_ID)?.noteSlug).toBeNull();
  });

  it("a drain replayed after compaction doesn't bring the post back", () => {
    const { dbFile, flags, threads, log } = setup();
    flags.cutover = true;
    const p1 = insertHomePost(dbFile, { sprout: "digest", body: "news" });
    threads.get("a", HOME_TARGET);
    const items = [{ kind: "post", id: "i1", postId: p1, sprout: "digest", at: new Date().toISOString(), text: "news" }];
    threads.save("a", { id: HOME_THREAD_ID, title: "Home", items });
    const store = new ConversationStore(dbFile);
    expect(store.replaceOldest(MAIN_CONVERSATION_ID, store.oldest(MAIN_CONVERSATION_ID, 1), { role: "user", content: "summary" })).toBe(true);
    saveDesktopChatDraining(dbFile, { id: HOME_THREAD_ID, title: "Home", itemsJson: "[]", noteSlug: null }, [p1], new Date(), { mainLog: true });
    expect(log()).toEqual([{ role: "user", content: "summary" }]);
  });

  it("a save flushes its turns once, and a re-run drain appends each post once", () => {
    const { dbFile, flags, threads, log } = setup();
    flags.cutover = true;
    const p1 = insertHomePost(dbFile, { sprout: "digest", body: "news" });
    threads.get("a", HOME_TARGET);
    const items = [{ kind: "post", id: "i1", postId: p1, sprout: "digest", at: new Date().toISOString(), text: "news" }];
    const turns = [{ key: "r1", role: "assistant" as const, content: "[Claude Code] done" }];
    threads.save("a", { id: HOME_THREAD_ID, title: "Home", items, turns });
    expect(log().map((t) => t.content)).toEqual(["[Claude Code] done", expect.stringContaining("news")]);
    // A re-run drain (the same posts, the same turns) appends nothing new.
    saveDesktopChatDraining(dbFile, { id: HOME_THREAD_ID, title: "Home", itemsJson: "[]", noteSlug: null }, [p1], new Date(), { mainLog: true });
    threads.save("a", { id: HOME_THREAD_ID, title: "Home", items: [...items, { kind: "status", id: "s" }], turns });
    expect(log()).toHaveLength(2);
  });
});
