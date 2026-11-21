import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { openDb } from "../src/db.js";
import {
  ConversationCatalog, ConversationStore, HOME_THREAD_ID, MAIN_CONVERSATION_ID, MAIN_CUTOVER_KEY, listChatopsConversations,
  mainCutover, runMainCutover, saveDesktopChat, type ChatTurn, type ConverseDeps,
} from "../src/index.js";

function setup() {
  const file = join(mkdtempSync(join(tmpdir(), "bean-cutover-")), "bean.db");
  const calls: string[] = [];
  const deps: ConverseDeps = {
    model: "m",
    chat: async (req) => {
      calls.push(req.messages.map((m) => String(m.content)).join("\n"));
      return { content: `summary ${calls.length}`, toolCalls: [] };
    },
  } as ConverseDeps;
  const store = new ConversationStore(file);
  const dm = (surface: "discord" | "teams", id: string, ownerId: string, turns: Array<[ChatTurn["role"], string, string]>): void => {
    new ConversationCatalog(file, surface).upsert({ conversationId: id, place: { kind: "dm", title: "DM" }, ownerId });
    for (const [role, content, at] of turns) {
      store.append(id, { role, content });
      openDb(file).prepare("UPDATE chatops_turns SET created_at = ? WHERE conversation_id = ? AND content = ?").run(at, id, content);
    }
  };
  const owners = [{ surface: "discord" as const, ownerId: "u1" }, { surface: "teams" as const, ownerId: "aad-1" }];
  return { file, calls, deps, store, dm, owners };
}

describe("main conversation cutover (#999)", () => {
  test("folds Home and both owner DMs in time order into the log's first turn, then switches on", async () => {
    const t = setup();
    saveDesktopChat(t.file, {
      id: HOME_THREAD_ID, title: "Home",
      itemsJson: JSON.stringify([
        { kind: "user", id: "a", text: "old, covered" },
        { kind: "summary", id: "s", text: "home so far" },
        { kind: "user", id: "b", text: "undated desk" },
        { kind: "reply", id: "c", text: "desk reply", at: "2026-11-01T10:00:00Z" },
        { kind: "proposal", id: "d", state: "expired", run: { skillName: "ship" } },
        { kind: "send", id: "e", state: "sent", at: "2026-11-01T10:30:00Z" },
        { kind: "sprout", id: "f", state: "done", plan: { action: "check", routine: "inbox" }, result: "nothing new", at: "2026-11-01T10:40:00Z" },
      ]),
    });
    t.dm("discord", "discord:dm1", "u1", [["user", "discord fact", "2026-11-01T09:00:00Z"]]);
    t.dm("teams", "teams:dm1", "29:x", [["user", "teams fact", "2026-11-01T11:00:00Z"]]);
    (new ConversationCatalog(t.file, "teams")).upsert({ conversationId: "teams:dm1", place: { kind: "dm", title: "DM" }, ownerId: "29:x", ownerAltId: "aad-1" });
    t.dm("discord", "discord:mia", "mia", [["user", "member secret", "2026-11-01T09:30:00Z"]]);
    // A DM quiet for longer than the archive retention: its archive must not be pruned on the first listing.
    openDb(t.file).prepare("UPDATE chatops_conversations SET updated_at = ? WHERE conversation_id = ?").run("2025-01-01T00:00:00Z", "discord:dm1");

    expect(await runMainCutover(t.file, t.owners, t.deps)).toBe("done");
    expect(t.calls).toHaveLength(1);
    const prompt = t.calls[0]!;
    expect(prompt).toContain("Summary so far:\nhome so far");
    expect(prompt).not.toContain("old, covered");
    expect(prompt).not.toContain("member secret");
    const order = ["undated desk", '[card: run "ship" — expired]', "discord fact", "desk reply", "[card: send — sent]", '[card: sprout "inbox" — checked]', "teams fact"].map((s) => prompt.indexOf(s));
    expect(order.every((n, i) => n >= 0 && (i === 0 || n > order[i - 1]!))).toBe(true);

    expect(mainCutover(t.file)).toBe(true);
    const log = t.store.history(MAIN_CONVERSATION_ID);
    expect(log).toHaveLength(1);
    expect(log[0]!.content).toContain("summary 1");
    // The owner DMs' own history moved to read-only archives; the live rows leave the sidebar.
    expect(t.store.history("discord:dm1")).toEqual([]);
    const listed = listChatopsConversations(t.file, t.owners);
    expect(listed.map((c) => c.archivedFrom).sort()).toEqual(["discord:dm1", "teams:dm1"]);
    expect(t.store.history("discord:mia")).toHaveLength(1);
    // Already done: no second fold.
    expect(await runMainCutover(t.file, t.owners, t.deps)).toBe("already");
    expect(t.calls).toHaveLength(1);
  });

  test("a source written during the fold leaves everything as before, and the next run cuts over", async () => {
    const t = setup();
    t.dm("discord", "discord:dm1", "u1", [["user", "first", "2026-11-01T09:00:00Z"]]);
    const chat = t.deps.chat;
    let once = true;
    t.deps.chat = async (req) => {
      if (once) { once = false; t.store.append("discord:dm1", { role: "user", content: "mid-fold" }); }
      return chat(req);
    };
    expect(await runMainCutover(t.file, t.owners, t.deps)).toBe("changed");
    expect(mainCutover(t.file)).toBe(false);
    expect(t.store.history(MAIN_CONVERSATION_ID)).toEqual([]);
    expect(t.store.history("discord:dm1")).toHaveLength(2);
    expect(await runMainCutover(t.file, t.owners, t.deps)).toBe("done");
    expect(t.calls.at(-1)).toContain("mid-fold");
  });

  test("a failed summary call writes nothing", async () => {
    const t = setup();
    t.dm("discord", "discord:dm1", "u1", [["user", "first", "2026-11-01T09:00:00Z"]]);
    t.deps.chat = async () => { throw new Error("offline"); };
    await expect(runMainCutover(t.file, t.owners, t.deps)).rejects.toThrow("offline");
    expect(mainCutover(t.file)).toBe(false);
    expect(t.store.history("discord:dm1")).toHaveLength(1);
  });

  test("a core with no Home and no DM cuts over empty, without a model call", async () => {
    const t = setup();
    expect(await runMainCutover(t.file, [], t.deps)).toBe("done");
    expect(t.calls).toHaveLength(0);
    expect(t.store.history(MAIN_CONVERSATION_ID)).toEqual([]);
    expect(openDb(t.file).prepare("SELECT value FROM memory_meta WHERE key = ?").get(MAIN_CUTOVER_KEY)).toBeDefined();
  });
});
