import { describe, expect, it } from "vitest";
import { IMAGE_PLACEHOLDER, THREAD_ITEMS_MAX, THREAD_MAX_BYTES, THREAD_TEXT_MAX, normalizeForSave, restoreItems, threadTitle } from "../src/renderer/components/chat/chat-thread.js";
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
] as ChatItem[];


describe("normalizeForSave", () => {
  const saved = normalizeForSave(transcript);
  const find = <K extends ChatItem["kind"]>(id: string) => saved.find((it) => it.id === id) as Extract<ChatItem, { kind: K }>;

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
