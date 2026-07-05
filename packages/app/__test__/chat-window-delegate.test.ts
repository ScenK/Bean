import { describe, expect, it } from "vitest";
import { applyDelegateEventToItems, hasActiveDelegates, markDelegateStarting } from "../src/renderer/components/chat/ChatWindow.js";
import type { ChatItem } from "../src/renderer/shared/chat-types.js";
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

  it("marks a pending delegate as starting before taskId is known", () => {
    const pending = { ...delegate, state: "pending", taskId: undefined } satisfies ChatItem;

    expect(markDelegateStarting([pending], "d1")[0]).toMatchObject({ state: "starting", taskId: undefined });
  });

  it("treats starting delegates as active during close", () => {
    const starting = { ...delegate, state: "starting", taskId: undefined } satisfies ChatItem;

    expect(hasActiveDelegates([starting], 0)).toBe(true);
  });
});
