import { describe, expect, it } from "vitest";
import { applyDelegateEventToItems, attachDelegateTaskId, hasActiveDelegates, markDelegateStarting } from "../src/renderer/components/chat/ChatWindow.js";
import { insertDroppedPath, type ChatItem } from "../src/renderer/shared/chat-types.js";
import type { DelegateEvent } from "../src/delegate-tasks.js";

const delegate = {
  kind: "delegate",
  id: "d1",
  proposal: { projectPath: "/p", instruction: "check it", composedPrompt: "go" },
  state: "running",
  taskId: "t1",
  tail: [],
} satisfies ChatItem;

describe("ChatWindow delegate state", () => {
  it("returns a summary loopback when a delegate finishes", () => {
    const event = { taskId: "t1", type: "done", result: "fixed" } satisfies DelegateEvent;
    const result = applyDelegateEventToItems([delegate], event);

    expect(result.items[0]).toMatchObject({ state: "done", result: "fixed" });
    expect(result.loopback).toEqual({
      text: `[delegate result for "check it"]: fixed\n\nBriefly summarize this outcome for the user in your own words.`,
      display: "📦 Delegate finished",
    });
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
