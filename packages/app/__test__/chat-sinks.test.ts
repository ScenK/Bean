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
    expect(cleanChatSinks({ chatops: [{ transport: "teams", channel: " " }], chatopsOnlyOnProblems: true, chatopsVerbatim: true, notify: true }))
      .toEqual({ notify: true });
  });

  it("keeps the Home sink untouched, with or without chat sinks", () => {
    const home = { ttlMinutes: 15 };
    expect(cleanChatSinks({ chatops: [{ transport: "teams", channel: " " }], chatopsVerbatim: true, home }).home).toBe(home);
    expect(cleanChatSinks({ chatops: [{ transport: "teams" }], home }).home).toBe(home);
  });

  it("keeps the only-on-problems and verbatim rules while Home is set (#1068: they govern its DM copy)", () => {
    expect(cleanChatSinks({ chatops: [{ transport: "teams", channel: " " }], chatopsOnlyOnProblems: true, chatopsVerbatim: true, home: {} }))
      .toEqual({ chatopsOnlyOnProblems: true, chatopsVerbatim: true, home: {} });
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
    expect(off).toEqual(["no note", "no desktop notification", "no post to your chat with Bean"]);
  });

  it("names the main conversation after the persona", () => {
    expect(destinations({ home: { ttlMinutes: 30 } }, undefined).on).toEqual(["Posted to your chat with Bean"]);
  });

  it("names Home's enabled DM copies and flags one that can't be reached (#1069)", () => {
    const dms = { discord: true, teams: true };
    expect(destinations({ home: {} }, { discord: 1, teams: 0 }, "Mr. Bean", dms).on).toEqual([
      "Posted to your chat with Mr. Bean and your Discord and Teams DMs",
      "Teams DM copy — dropped: no ownerId in teams.json, or you haven't DMed the bot yet",
    ]);
    // Over SSH there are no recipients: the wording stays, no reachability line.
    expect(destinations({ home: {} }, undefined, "Bean", { discord: true, teams: false }).on).toEqual(["Posted to your chat with Bean and your Discord DM"]);
  });
});

describe("alias sinks", () => {
  it("aren't merged with the default DM; exact alias duplicates are", () => {
    const out = cleanChatSinks({ chatops: [
      { transport: "teams" }, { transport: "teams", alias: "Ops" }, { transport: "teams", alias: "Ops" }, { transport: "teams", alias: "Dev" },
    ] });
    expect(out.chatops).toEqual([{ transport: "teams" }, { transport: "teams", alias: "Ops" }, { transport: "teams", alias: "Dev" }]);
  });

  it("count as conversations in the footer and show by name in the review", () => {
    expect(chatTargets([{ transport: "teams", alias: "Ops" }, { transport: "teams", channel: "c" }])).toEqual(["2 Teams conversations"]);
    expect(destinations({ chatops: [{ transport: "discord", alias: "Ops" }] }, { discord: 1 }).on).toEqual(['Discord channel "Ops"']);
  });
});
