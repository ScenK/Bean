import { ChannelType, PermissionFlagsBits, ThreadAutoArchiveDuration } from "discord.js";
import { expect, test } from "vitest";
import { openContinueThread, ownerOnly } from "../src/desk-continue.js";

const me = { id: "bot" };
const home = (type: ChannelType, perms: bigint[]) => {
  const created: object[] = [];
  return {
    created,
    channel: {
      type,
      permissionsFor: (u: { id: string }) => (u === me ? { has: (want: bigint[]) => want.every((p) => perms.includes(p)) } : null),
      threads: { create: async (o: object) => { created.push(o); return { id: "th1" }; } },
    },
  };
};
const both = [PermissionFlagsBits.CreatePublicThreads, PermissionFlagsBits.SendMessagesInThreads];

test("opens a one-day public thread named by the title (cut to 100)", async () => {
  const h = home(ChannelType.GuildText, both);
  await expect(openContinueThread(h.channel, me, "t".repeat(150))).resolves.toEqual({ id: "th1" });
  expect(h.created).toEqual([{ name: "t".repeat(100), autoArchiveDuration: ThreadAutoArchiveDuration.OneDay }]);
});

test("no fallback: a non-text channel or a missing permission throws without creating anything", async () => {
  for (const h of [
    home(ChannelType.GuildText, [PermissionFlagsBits.CreatePublicThreads]),
    home(ChannelType.GuildText, [PermissionFlagsBits.SendMessagesInThreads]),
    home(ChannelType.GuildAnnouncement, both), home(ChannelType.DM, both),
  ]) {
    await expect(openContinueThread(h.channel, me, "x")).rejects.toThrow();
    expect(h.created).toEqual([]);
  }
  await expect(openContinueThread(null, me, "x")).rejects.toThrow();
  await expect(openContinueThread(home(ChannelType.GuildText, both).channel, null, "x")).rejects.toThrow();
});

test("the first post may ping the owner only, whatever the text holds", () => {
  expect(ownerOnly("u1", "<@u1> hi @everyone <@u2> <@&r1>"))
    .toEqual({ content: "<@u1> hi @everyone <@u2> <@&r1>", allowedMentions: { users: ["u1"] } });
});
