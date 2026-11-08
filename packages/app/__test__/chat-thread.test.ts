import { describe, expect, it } from "vitest";
import { IMAGE_PLACEHOLDER, THREAD_ITEMS_MAX, THREAD_MAX_BYTES, THREAD_TEXT_MAX, continuedTo, normalizeForSave, pdfAskAgain, restoreItems, restoredPdf, threadTitle } from "../src/renderer/components/chat/chat-thread.js";
import { applyDelegateEventToItems, closeTranscript } from "../src/renderer/components/chat/ChatSession.js";
import { canContinueLive } from "../src/renderer/components/chat/agent-mode.js";
import { newId, type ChatItem } from "../src/renderer/shared/chat-types.js";

const run = { skillName: "s", projectPath: "/p", confidence: 1, composedPrompt: "go" };
const proposal = { projectPath: "/p", instruction: "check it", composedPrompt: "go" };
const receipt = { label: "claude · abc", command: "claude -r abc", sessionId: "abc", agent: "claude" as const };

const transcript: ChatItem[] = [
  { kind: "user", id: "old-1", text: "look", images: ["data:image/png;base64,AAAA"], source: "typed" },
  { kind: "working", id: "old-2", text: "Spinning up" },
  { kind: "reply", id: "old-3", text: "here", images: [{ path: "/tmp/a.png", dataUrl: "data:image/png;base64,BBBB" }] },
  { kind: "reply", id: "old-4", text: "half", agent: "claude", session: "s1", tail: ["Read x"], streaming: true },
  { kind: "proposal", id: "old-5", run, state: "pending" },
  { kind: "delegate", id: "old-6", proposal, state: "pending", tail: [] },
  { kind: "delegate", id: "old-7", proposal, state: "running", taskId: "t7", tail: ["…"] },
  { kind: "delegate", id: "old-8", proposal, state: "done", taskId: "t8", tail: ["…"], result: "ok", receipt },
  { kind: "note", id: "old-9", note: { title: "n", body: "b" }, state: "pending", images: ["data:image/png;base64,CCCC"] },
  { kind: "skill", id: "old-10", skill: { name: "k", body: "b" }, state: "pending" },
  { kind: "todo", id: "old-11", todo: { routine: "r", text: "t" }, state: "pending" },
  { kind: "offer", id: "old-12", offer: { instruction: "fix", projectPath: "/p" }, state: "pending" },
  { kind: "memory", id: "old-13", saved: [{ id: "m1", text: "likes tea" }], state: "saved" },
  { kind: "status", id: "old-14", text: "Claude ended", tone: "info", receipt: { sessionId: "abc", agent: "claude", label: "l" }, exiting: "bean-1" },
  { kind: "forgot", id: "old-15", text: "lives in Seattle", row: { id: "m2", text: "lives in Seattle", createdAt: "2026-07-01T00:00:00.000Z", subjectId: "u1" }, state: "saved" },
  { kind: "forgot", id: "old-16", text: "uses zed", row: { id: "m3", text: "uses zed", createdAt: "2026-07-01T00:00:00.000Z" }, state: "restored" },
  { kind: "forgot", id: "old-17", text: "x", row: { id: "m4", text: "x", createdAt: "" }, state: "error", error: "boom" },
] as ChatItem[];


describe("normalizeForSave", () => {
  const saved = normalizeForSave(transcript);
  const find = <K extends ChatItem["kind"]>(id: string) => saved.find((it) => it.id === id) as Extract<ChatItem, { kind: K }>;

  it("drops a live row's pending marker (#746)", () => {
    expect(normalizeForSave([{ kind: "user", id: "u", text: "hi", source: "live", pending: "k" }])).toEqual([{ kind: "user", id: "u", text: "hi", source: "live" }]);
  });

  it("restores every actionable kind inert", () => {
    expect(saved.some((it) => it.kind === "working")).toBe(false);
    for (const id of ["old-5", "old-6", "old-9", "old-10", "old-11", "old-12"]) expect((find(id) as { state: string }).state).toBe("expired");
    expect(find<"delegate">("old-7").state).toBe("interrupted");
    expect(find<"delegate">("old-7").taskId).toBeUndefined();
    expect(find<"memory">("old-13").state).toBe("kept");
    const reply = find<"reply">("old-4");
    expect(reply.streaming).toBeUndefined();
    expect(reply.session).toBeUndefined();
    expect(reply.tail).toBeUndefined();
    expect(reply.footer).toBe("— turn interrupted");
    expect(find<"status">("old-14").exiting).toBeUndefined();
  });

  it("restores a sprout card inert: pending expires, a running one says it started", () => {
    const plan = { routine: "r", action: "run" as const, actionLine: "Runs its steps once now", resultsTo: "a note", paused: false, queuesNew: false };
    const [pending, running, done] = restoreItems(JSON.parse(JSON.stringify([
      { kind: "sprout", id: "s1", plan, state: "pending" },
      { kind: "sprout", id: "s2", plan, state: "running" },
      { kind: "sprout", id: "s3", plan, state: "done", result: "Finished" },
    ]))) as Extract<ChatItem, { kind: "sprout" }>[];
    expect(pending!.state).toBe("expired");
    expect(running).toMatchObject({ state: "done", result: "Started — see the Dashboard for how it went" });
    expect(done).toMatchObject({ state: "done", result: "Finished" });
  });

  it("restores a send card inert: pending and sending expire, a sent one stays sent", () => {
    const card = { id: "p1", destination: "ops", body: "hi", options: [] };
    const items = restoreItems(JSON.parse(JSON.stringify([
      { kind: "send", id: "a", card, state: "pending" },
      { kind: "send", id: "b", card, state: "sending" },
      { kind: "send", id: "c", card, state: "sent" },
    ]))) as Extract<ChatItem, { kind: "send" }>[];
    expect(items.map((it) => it.state)).toEqual(["expired", "expired", "sent"]);
  });

  it("keeps a forget receipt's text only: kept without Undo (restored stays restored), no row snapshot", () => {
    expect(find("old-15")).toEqual({ kind: "forgot", id: "old-15", text: "lives in Seattle", state: "kept" });
    expect(find("old-16")).toEqual({ kind: "forgot", id: "old-16", text: "uses zed", state: "restored" });
    expect(find("old-17")).toEqual({ kind: "forgot", id: "old-17", text: "x", state: "kept" });
    expect(restoreItems(JSON.parse(JSON.stringify(saved))).filter((it) => it.kind === "forgot")).toHaveLength(3);
  });

  it("keeps delegate and live receipts, so Continue live still works", () => {
    expect(find<"delegate">("old-8").receipt).toEqual(receipt);
    expect(find<"delegate">("old-8").result).toBe("ok");
    expect(canContinueLive(find("old-14"), ["claude"], false)).toBe(true);
    expect(canContinueLive(find("old-8"), ["claude"], false)).toBe(true);
  });

  it("strips image bytes to a placeholder that doesn't multiply on repeat save/load", () => {
    const json = JSON.stringify(saved);
    expect(json).not.toContain("data:image");
    const again = normalizeForSave(restoreItems(JSON.parse(JSON.stringify(normalizeForSave(restoreItems(JSON.parse(json)))))));
    const user = again.find((it) => it.kind === "user") as Extract<ChatItem, { kind: "user" }>;
    expect(user.text).toBe(`look\n${IMAGE_PLACEHOLDER}`);
    const reply = again.find((it) => it.kind === "reply") as Extract<ChatItem, { kind: "reply" }>;
    expect(reply.text).toBe(`here\n${IMAGE_PLACEHOLDER}`);
  });

  it("never mutates its input", () => {
    const before = JSON.stringify(transcript);
    normalizeForSave(transcript);
    restoreItems(transcript);
    expect(JSON.stringify(transcript)).toBe(before);
  });

  it("caps each text, the item count (oldest dropped) and the total size", () => {
    const long: ChatItem = { kind: "reply", id: "r", text: "x".repeat(THREAD_TEXT_MAX + 50) };
    expect((normalizeForSave([long])[0] as { text: string }).text).toHaveLength(THREAD_TEXT_MAX + 1);
    // A reply's display (live progress prose + final answer) keeps its end, so the answer survives.
    const prose: ChatItem = { kind: "reply", id: "p", text: "Done.", display: `${"x".repeat(THREAD_TEXT_MAX)}\n\nDone.` };
    expect((normalizeForSave([prose])[0] as { display: string }).display.endsWith("Done.")).toBe(true);
    const many = Array.from({ length: THREAD_ITEMS_MAX + 20 }, (_, i): ChatItem => ({ kind: "status", id: `s${i}`, text: `${i}`, tone: "info" }));
    const capped = normalizeForSave(many);
    expect(capped).toHaveLength(THREAD_ITEMS_MAX);
    expect(capped[0]!.id).toBe("s20");
    const big = Array.from({ length: 200 }, (_, i): ChatItem => ({ kind: "reply", id: `b${i}`, text: "é".repeat(THREAD_TEXT_MAX) }));
    const fitted = normalizeForSave(big);
    expect(new TextEncoder().encode(JSON.stringify(fitted)).length).toBeLessThanOrEqual(THREAD_MAX_BYTES);
    expect(fitted.at(-1)!.id).toBe("b199");
  });
});

describe("restoreItems", () => {
  const restored = restoreItems(JSON.parse(JSON.stringify(normalizeForSave(transcript))));

  it("remaps ids and drops source on user turns", () => {
    const ids = restored.map((it) => it.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Fresh ids from this load's counter: no collision with what the window adds next.
    expect(ids).not.toContain(newId());
    for (const it of transcript) expect(ids).not.toContain(it.id);
    const user = restored.find((it) => it.kind === "user") as Extract<ChatItem, { kind: "user" }>;
    expect(user.source).toBeUndefined();
    expect(closeTranscript(restored, true)[0]).toMatchObject({ role: "user", source: undefined });
  });

  it("a restored done delegate never loops back", () => {
    const done = { type: "done", taskId: "t8", result: "again" } as const;
    expect(applyDelegateEventToItems(restored, done).loopback).toBeUndefined();
    const interrupted = { type: "done", taskId: "t7", result: "late" } as const;
    expect(applyDelegateEventToItems(restored, interrupted).loopback).toBeUndefined();
  });

  it("drops malformed entries", () => {
    expect(restoreItems("nope")).toEqual([]);
    expect(restoreItems([null, 3, { kind: "bogus", id: "x" }, { kind: "status", text: "no id" }])).toEqual([]);
  });
});

describe("close-time memory", () => {
  it("an unchanged reopened chat sends nothing to rememberOnClose", () => {
    const restored = restoreItems(JSON.parse(JSON.stringify(normalizeForSave(transcript))));
    expect(closeTranscript(restored, false)).toEqual([]);
    expect(closeTranscript([...restored, { kind: "user", id: "new", text: "I use vim", source: "typed" }], true).at(-1))
      .toMatchObject({ content: "I use vim", source: "typed" });
  });
});

it("titles a thread from its first message", () => {
  expect(threadTitle("  fix\n the   build ")).toBe("fix the build");
  expect(threadTitle("x".repeat(100))).toHaveLength(60);
  expect(threadTitle("")).toBe("New chat");
});

describe("continued pointer (#697)", () => {
  const pointer: ChatItem = { kind: "continued", id: "c-1", surface: "discord", conversationId: "th-1", title: "Week plan" };

  it("survives normalize, a save round trip, restore and a later autosave", () => {
    const saved = normalizeForSave([{ kind: "user", id: "u", text: "hi" }, pointer]);
    expect(saved[1]).toEqual(pointer);
    const restored = restoreItems(JSON.parse(JSON.stringify(saved)));
    expect(restored[1]).toMatchObject({ kind: "continued", surface: "discord", conversationId: "th-1", title: "Week plan" });
    // A late autosave of the restored chat writes it again unchanged.
    expect(normalizeForSave(restored).map(({ id: _id, ...rest }) => rest)).toEqual(saved.map(({ id: _id, ...rest }) => rest));
    expect(continuedTo(restored)?.conversationId).toBe("th-1");
  });

  it("drops a malformed pointer and any extra fields", () => {
    const extra = { ...pointer, secret: "x" } as ChatItem;
    expect(restoreItems([extra])[0]).not.toHaveProperty("secret");
    expect(restoreItems([{ kind: "continued", id: "c", surface: "teams", conversationId: "t", title: "x" }])).toEqual([]);
    expect(restoreItems([{ kind: "continued", id: "c", surface: "discord", conversationId: "", title: "x" }])).toEqual([]);
  });
});

describe("PDF attachments in saved threads (#731)", () => {
  const items: ChatItem[] = [
    { kind: "user", id: "u1", text: "summarise", pdf: { name: "report.pdf", size: 2048 }, source: "typed" },
    { kind: "reply", id: "r1", text: "It says…" },
    { kind: "user", id: "u2", text: "and page 2?", source: "typed" },
  ];

  it("saves a placeholder and never the pdf field", () => {
    const saved = normalizeForSave(items);
    expect(saved[0]).toEqual({ kind: "user", id: "u1", text: "summarise\n[PDF attached: report.pdf]", source: "typed" });
    expect(JSON.stringify(saved)).not.toContain("size");
    // Repeat save/load doesn't multiply the placeholder.
    expect(normalizeForSave(restoreItems(saved))[0]).toMatchObject({ text: "summarise\n[PDF attached: report.pdf]" });
  });

  it("a restored chat asks for the PDF again, once", () => {
    const restored = restoreItems(normalizeForSave(items));
    expect(restoredPdf(restored)).toBe("report.pdf");
    const asked: ChatItem[] = [...restored, { kind: "status", id: "s1", text: pdfAskAgain("report.pdf"), tone: "info" }];
    expect(restoredPdf(restoreItems(normalizeForSave(asked)))).toBeUndefined();
    expect(restoredPdf(restoreItems(normalizeForSave([items[2]!])))).toBeUndefined();
  });
});
