import { describe, expect, it } from "vitest";
import {
  addDelegateProposal, adoptContinued, applyDelegateEventToItems, attachDelegateTaskId, continuedDelegateItems, grantCardAfter, hasActiveDelegates,
  markDelegateStarting, placeContinued,
} from "../src/renderer/components/chat/ChatSession.js";
import { delegateOutcomeTurn } from "@bean/core/prompt";
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
      text: delegateOutcomeTurn("check it", { type: "done", result: "fixed" }),
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
      text: delegateOutcomeTurn("edited prompt", { type: "done", result: "fixed" }),
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

  it("a failed run's outcome turn carries the agent's final message as quoted data (#1131)", () => {
    const final = "FAILED: couldn't push\n\nDone: fixed the bug, tests pass. Not done: the push (no token).";
    const failed = applyDelegateEventToItems([delegate], { taskId: "t1", type: "failed", message: "couldn't push", final });
    expect(failed.loopback?.text).toContain('[delegate failed for "check it"]: couldn\'t push');
    expect(failed.loopback?.text).toContain(`<<<\n${final}\n>>>`);
    expect(failed.loopback?.text).toMatch(/partly done/);
    const stopped = applyDelegateEventToItems([delegate], { taskId: "t1", type: "cancelled", final: "half way" });
    expect(stopped.loopback?.text).toContain("<<<\nhalf way\n>>>");
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

  it("a dropped chat reply: the replayed started push alone gives the card, once, and its outcome loops back once", () => {
    const proposal = { projectPath: "/p", instruction: "add a test", composedPrompt: "add a test", cli: "claude" as const };
    const started = { taskId: "t2", type: "started", projectPath: "/p", instruction: "add a test", continued: proposal } satisfies DelegateEvent;
    const items = adoptContinued([delegate], started, "d2")!;
    expect(items[1]).toMatchObject({ id: "d2", kind: "delegate", taskId: "t2", state: "running", continued: true });
    expect(adoptContinued(items, started, "d3")).toBeUndefined(); // replayed after reconnect
    expect(adoptContinued([delegate], { ...started, continued: undefined }, "d4")).toBeUndefined(); // a carded run
    const done = applyDelegateEventToItems(items, { taskId: "t2", type: "done", result: "ok" });
    expect(done.loopback).toBeDefined();
    expect(applyDelegateEventToItems(done.items, { taskId: "t2", type: "done", result: "ok" }).loopback).toBeUndefined();
  });

  it("the reply's continuation lands after Bean's sentence: a pushed card moves there, else the reply's own is added", () => {
    const card = { ...delegate, id: "d2", taskId: "t2", continued: true } satisfies ChatItem;
    const reply = { kind: "reply", id: "r", text: "On it." } satisfies ChatItem;
    expect(placeContinued([card, reply], "t2", []).map((i) => i.id)).toEqual(["r", "d2"]);
    expect(placeContinued([reply], "t2", [card]).map((i) => i.id)).toEqual(["r", "d2"]);
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
