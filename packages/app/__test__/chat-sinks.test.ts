import { describe, expect, it } from "vitest";
import type { RoutineChatopsSink } from "@bean/core";
import { chatTargets, cleanChatSinks, destinations } from "../src/renderer/components/routines/chat-sinks.js";

const mixed: RoutineChatopsSink[] = [
  { transport: "discord" },
  { transport: "discord", channel: "111" },
  { transport: "discord", channel: "222" },
  { transport: "discord", user: "u1" },
  { transport: "teams", channel: "19:abc@thread.v2" },
];

describe("cleanChatSinks", () => {
  it("keeps every distinct entry as-is (same objects)", () => {
    const out = cleanChatSinks({ chatops: mixed, note: true });
    expect(out.chatops).toHaveLength(5);
    out.chatops!.forEach((c, i) => expect(c).toBe(mixed[i]));
    expect(out.note).toBe(true);
  });

  it("trims ids, drops blank rows and exact duplicates", () => {
    const out = cleanChatSinks({ chatops: [
      { transport: "discord", channel: " 111 " },
      { transport: "discord", channel: "   " },
      { transport: "discord", channel: "" },
      { transport: "discord", channel: "111" },
      { transport: "teams", channel: "111" }, // other transport: not a duplicate
      { transport: "teams" },
      { transport: "teams" },
    ] });
    expect(out.chatops).toEqual([
      { transport: "discord", channel: "111" },
      { transport: "teams", channel: "111" },
      { transport: "teams" },
    ]);
  });

  it("drops chatops and the only-on-problems rule when nothing is left", () => {
    expect(cleanChatSinks({ chatops: [{ transport: "teams", channel: " " }], chatopsOnlyOnProblems: true, notify: true }))
      .toEqual({ notify: true });
  });
});

describe("chatTargets", () => {
  it("names each destination once", () => {
    expect(chatTargets(mixed)).toEqual(["Discord DM", "2 Discord channels", "Discord DM to 1 user", "1 Teams conversation"]);
    expect(chatTargets([{ transport: "teams" }, { transport: "teams", channel: "a" }, { transport: "teams", channel: "b" }, { transport: "teams", channel: "" }]))
      .toEqual(["Teams DM", "2 Teams conversations"]);
    expect(chatTargets(undefined)).toEqual([]);
  });
});

describe("destinations", () => {
  it("lists every chat entry, not just the first per transport", () => {
    const { on, off } = destinations({ chatops: mixed }, { discord: 1, teams: 1 });
    expect(on).toEqual([
      "Discord DM to you",
      "Discord channel 111",
      "Discord channel 222",
      "Discord DM to user u1",
      "Teams conversation 19:abc@thread.v2",
    ]);
    expect(off).toEqual(["no note", "no desktop notification"]);
  });
});
