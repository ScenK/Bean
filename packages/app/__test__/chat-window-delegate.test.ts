import { describe, expect, it } from "vitest";
import {
  addDelegateProposal, applyDelegateEventToItems, attachDelegateTaskId, continuedDelegateItems, grantCardAfter, hasActiveDelegates, markDelegateStarting,
} from "../src/renderer/components/chat/ChatSession.js";
import { insertDroppedPath, type ChatItem } from "../src/renderer/shared/chat-types.js";
import type { DelegateEvent } from "@bean/host";

const delegate = {
  kind: "delegate",
  id: "d1",
  proposal: { projectPath: "/p", instruction: "check it", composedPrompt: "go" },
  state: "running",
  taskId: "t1",
  tail: [],
} satisfies ChatItem;

describe("ChatWindow delegate state", () => {
  it("adds delegate proposals in pending state, awaiting user confirmation", () => {
    const result = addDelegateProposal([], {
      projectPath: "/p",
      instruction: "read README",
      composedPrompt: "read README",
    }, "d1");

    expect(result[0]).toMatchObject({ kind: "delegate", id: "d1", state: "pending" });
    expect(result[0]).not.toHaveProperty("taskId");
  });

  it("returns a summary loopback when a delegate finishes", () => {
    const event = { taskId: "t1", type: "done", result: "fixed" } satisfies DelegateEvent;
    const result = applyDelegateEventToItems([delegate], event);

    expect(result.items[0]).toMatchObject({ state: "done", result: "fixed" });
    expect(result.loopback).toEqual({
      text: `[delegate result for "check it"]: fixed\n\nBriefly summarize this outcome for the user in your own words.`,
      display: "📦 Delegate finished",
      source: "loopback",
    });
  });

  it("loops a task's result back once: a replayed done is ignored", () => {
    const event = { taskId: "t1", type: "done", result: "fixed" } satisfies DelegateEvent;
    const first = applyDelegateEventToItems([delegate], event);
    const replayed = applyDelegateEventToItems(first.items, event);
    expect(replayed.loopback).toBeUndefined();
    expect(replayed.items).toBe(first.items);
  });

  it("keeps the resume receipt on the card but never in the loopback text", () => {
    const receipt = { label: "claude · abcd…", command: "cd '/p' && claude --resume abcd-1" };
    const done = applyDelegateEventToItems([delegate], { taskId: "t1", type: "done", result: "fixed", receipt });
    expect(done.items[0]).toMatchObject({ state: "done", receipt });
    expect(JSON.stringify(done.loopback)).not.toContain("abcd");
    const failed = applyDelegateEventToItems([delegate], { taskId: "t1", type: "failed", message: "x", receipt });
    expect(failed.items[0]).toMatchObject({ state: "failed", receipt });
  });

  it("replays buffered events after a fast delegate finishes before taskId is attached", () => {
    const starting = { ...delegate, state: "starting", taskId: undefined } satisfies ChatItem;
    const buffered = [
      { taskId: "t1", type: "output", line: "already done" },
      { taskId: "t1", type: "done", result: "fixed" },
    ] satisfies DelegateEvent[];

    const result = attachDelegateTaskId([starting], "d1", "t1", "edited prompt", buffered);

    expect(result.items[0]).toMatchObject({ state: "done", taskId: "t1", tail: ["already done"], result: "fixed" });
    expect(result.loopbacks).toEqual([{
      text: `[delegate result for "edited prompt"]: fixed\n\nBriefly summarize this outcome for the user in your own words.`,
      display: "📦 Delegate finished",
      source: "loopback",
    }]);
  });

  it("marks a pending delegate as starting before taskId is known", () => {
    const pending = { ...delegate, state: "pending", taskId: undefined } satisfies ChatItem;

    expect(markDelegateStarting([pending], "d1")[0]).toMatchObject({ state: "starting", taskId: undefined });
  });

  it("treats starting delegates as active during close", () => {
    const starting = { ...delegate, state: "starting", taskId: undefined } satisfies ChatItem;

    expect(hasActiveDelegates([starting], 0)).toBe(true);
  });
});

describe("desktop cardless continuation (#1113)", () => {
  it("loops a failed or cancelled run back once, like a finished one", () => {
    const failed = applyDelegateEventToItems([delegate], { taskId: "t1", type: "failed", message: "tests broke" });
    expect(failed.loopback).toMatchObject({ text: expect.stringContaining('[delegate failed for "check it"]: tests broke'), source: "loopback" });
    expect(applyDelegateEventToItems(failed.items, { taskId: "t1", type: "failed", message: "tests broke" }).loopback).toBeUndefined();
    const cancelled = applyDelegateEventToItems([delegate], { taskId: "t1", type: "cancelled" });
    expect(cancelled.loopback).toMatchObject({ text: expect.stringContaining('[delegate cancelled for "check it"]'), display: "📦 Delegate stopped" });
  });

  it("a continuation that finished before the reply came settles from its buffered events", () => {
    const c = { taskId: "t2", proposal: { projectPath: "/p", instruction: "add a test", composedPrompt: "add a test", cli: "claude" as const } };
    const { items, loopbacks } = continuedDelegateItems(c, "d2", [
      { taskId: "t2", type: "started", projectPath: "/p", instruction: "add a test" },
      { taskId: "t2", type: "failed", message: "boom" },
      { taskId: "t2", type: "failed", message: "boom" }, // replayed
    ]);
    expect(items).toEqual([expect.objectContaining({ id: "d2", taskId: "t2", continued: true, state: "failed", error: "boom" })]);
    expect(loopbacks).toHaveLength(1);
  });

  it("a refused resume ends the compact card and offers the same instruction as a normal card, no loopback", () => {
    const cont = { ...delegate, continued: true, proposal: { ...delegate.proposal, continue: true } } satisfies ChatItem;
    const r = applyDelegateEventToItems([cont], { taskId: "t1", type: "failed", message: "Couldn't resume the earlier claude session — nothing ran.", resumeRefused: true });
    expect(r.loopback).toBeUndefined();
    expect(r.items[0]).toMatchObject({ state: "failed", continued: true });
    expect(r.items[1]).toMatchObject({ kind: "delegate", state: "pending", proposal: { instruction: "check it", composedPrompt: "go" } });
    expect(r.items[1]).not.toHaveProperty("continued");
    expect((r.items[1] as { proposal: object }).proposal).not.toHaveProperty("continue");
  });

  it("the grant line sits on the confirmed card while the host says its grant anchors the run", () => {
    const cont = { ...delegate, id: "d2", taskId: "t2", continued: true } satisfies ChatItem;
    const items = [delegate, cont];
    expect(grantCardAfter(undefined, items, { taskId: "t1", type: "done", result: "", granted: true })).toBe("d1");
    expect(grantCardAfter("d1", items, { taskId: "t2", type: "done", result: "", granted: true })).toBe("d1");
    expect(grantCardAfter("d1", items, { taskId: "t2", type: "failed", message: "", resumeRefused: true })).toBeUndefined();
    expect(grantCardAfter("d1", items, { taskId: "t1", type: "output", line: "x" })).toBe("d1");
    expect(grantCardAfter(undefined, items, { taskId: "t1", type: "done", result: "" })).toBeUndefined();
  });
});

describe("chat composer drops", () => {
  it("inserts a dropped path at the cursor with spacing", () => {
    expect(insertDroppedPath("summarize ", "/tmp/image.png", 10, 10)).toEqual({
      value: "summarize /tmp/image.png ",
      cursor: 25,
    });
  });

  it("replaces the current selection with the dropped path", () => {
    expect(insertDroppedPath("read this file", "/tmp/folder", 5, 9)).toEqual({
      value: "read /tmp/folder file",
      cursor: 17,
    });
  });
});
