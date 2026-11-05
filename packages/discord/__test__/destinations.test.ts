import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgetDestination, listDestinations, recordDestination, setAlias } from "@bean/core";
import { ChannelType, PermissionFlagsBits } from "discord.js";
import { expect, test, vi } from "vitest";
import { discordDestinations, type ChannelLike } from "../src/destinations.js";

const store = () => {
  const file = join(mkdtempSync(join(tmpdir(), "bean-ddest-")), "bean.db");
  return { file, store: { record: recordDestination.bind(null, file), forget: forgetDestination.bind(null, file) } };
};

const me = { id: "bot" };
const guild = { name: "Home", members: { me } };
/** A guild channel where Bean holds exactly `perms`. */
const channel = (id: string, type: ChannelType, name: string, perms: bigint[]): ChannelLike => ({
  id, type, name, guild,
  permissionsFor: (m) => (m === me ? { has: (want) => want.every((p) => perms.includes(p)) } : null),
});
const { ViewChannel, SendMessages } = PermissionFlagsBits;

test("guild listing records only text/announcement channels Bean can view and post in", () => {
  const { file, store: s } = store();
  const dest = discordDestinations(s);
  for (const c of [
    channel("1", ChannelType.GuildText, "general", [ViewChannel, SendMessages]),
    channel("2", ChannelType.GuildAnnouncement, "news", [ViewChannel, SendMessages]),
    channel("3", ChannelType.GuildText, "read-only", [ViewChannel]),
    channel("4", ChannelType.GuildText, "hidden", [SendMessages]),
    channel("5", ChannelType.GuildVoice, "voice", [ViewChannel, SendMessages]),
    channel("6", ChannelType.PublicThread, "a thread", [ViewChannel, SendMessages]),
  ]) dest.sync(c);
  expect(listDestinations(file).map((d) => [d.conversationId, d.kind, d.platformName, d.parentName]).sort()).toEqual([
    ["1", "channel", "#general", "Home"], ["2", "channel", "#news", "Home"],
  ]);
  // Losing SendMessages forgets it; a thread is recorded once seen; a DM by the person's name.
  dest.sync(channel("2", ChannelType.GuildAnnouncement, "news", [ViewChannel]));
  dest.seen(channel("6", ChannelType.PublicThread, "a thread", []));
  dest.seen({ id: "9", type: ChannelType.DM }, "Ana");
  expect(listDestinations(file).map((d) => [d.conversationId, d.kind, d.platformName]).sort()).toEqual([
    ["1", "channel", "#general"], ["6", "thread", "a thread"], ["9", "dm", "Ana"],
  ]);
});

test("delete removes nothing the owner aliased: row and name kept", () => {
  const { file, store: s } = store();
  const dest = discordDestinations(s);
  const ops = channel("1", ChannelType.GuildText, "ops", [ViewChannel, SendMessages]);
  dest.sync(ops);
  dest.sync(channel("2", ChannelType.GuildText, "misc", [ViewChannel, SendMessages]));
  expect(setAlias(file, { surface: "discord", conversationId: "1" }, "Ops room", () => []).ok).toBe(true);
  dest.removed(ops);
  dest.removed(channel("2", ChannelType.GuildText, "misc", []));
  expect(listDestinations(file)).toMatchObject([{ conversationId: "1", alias: "Ops room", platformName: "#ops" }]);
});

test("a throwing store is logged, never thrown", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const boom = () => { throw new Error("db locked"); };
  const dest = discordDestinations({ record: boom, forget: boom });
  expect(() => dest.seen({ id: "9", type: ChannelType.DM }, "Ana")).not.toThrow();
  expect(() => dest.sync(channel("1", ChannelType.GuildText, "x", []))).not.toThrow();
  expect(() => dest.removed(channel("1", ChannelType.GuildText, "x", []))).not.toThrow();
  expect(warn).toHaveBeenCalledTimes(3);
  warn.mockRestore();
});
