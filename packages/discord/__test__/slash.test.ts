import { expect, test, vi } from "vitest";
import { CHATOPS_COMMANDS } from "@bean/core";
import { answerSlash, slashCommands, slashMessage, type SlashInvocation } from "../src/slash.js";

test("registers every catalog command, with its one required option", () => {
  const cmds = slashCommands() as { name: string; options?: { name: string; required: boolean }[] }[];
  expect(cmds.map((c) => c.name)).toEqual(CHATOPS_COMMANDS.map((c) => c.name));
  expect(cmds).toHaveLength(12);
  const opt = (name: string) => cmds.find((c) => c.name === name)?.options;
  expect(opt("add-admin")).toEqual([expect.objectContaining({ name: "user", required: true })]);
  expect(opt("enable")).toEqual([expect.objectContaining({ name: "name", required: true })]);
  expect(opt("live-session")).toEqual([expect.objectContaining({ name: "prompt", required: true })]);
  expect(opt("new")).toBeUndefined();
});

const base: SlashInvocation = {
  commandName: "add-admin", user: { id: "u1", name: "Ann" }, conversationId: "thread1",
  scopeId: "chan1", direct: false, channelName: "#general",
};

test("maps the pick to the typed message core expects", () => {
  expect(slashMessage({ ...base, target: { id: "u2", name: "Bo", bot: false } })).toEqual({
    conversationId: "thread1", text: "add-admin", fromId: "u1", fromName: "Ann", scopeId: "chan1", direct: false,
    channelName: "#general", mentions: [{ id: "u2", name: "Bo" }], mentionedIds: ["u2"],
  });
  expect(slashMessage({ ...base, commandName: "enable", arg: "daily digest" }).text).toBe("enable daily digest");
  const dm = slashMessage({ ...base, commandName: "whoami", scopeId: undefined, direct: true, channelName: "DM" });
  expect(dm).toMatchObject({ direct: true, scopeId: undefined, mentions: [] });
});

test("drops a bot picked as the user option", () => {
  const msg = slashMessage({ ...base, target: { id: "b1", name: "Robo", bot: true } });
  expect(msg.mentions).toEqual([]);
  expect(msg.mentionedIds).toEqual([]);
});

const output = () => ({
  editReply: vi.fn(async () => {}), followUp: vi.fn(async () => {}), announce: vi.fn(async () => {}),
});

test("replies are collected into the ephemeral answer and chunked past 2000 chars", async () => {
  const out = output();
  await answerSlash(async (fx) => { await fx.reply("a".repeat(1500)); await fx.reply("b".repeat(1500)); return true; }, out);
  expect(out.editReply).toHaveBeenCalledWith("a".repeat(1500) + "\n");
  expect(out.followUp).toHaveBeenCalledWith("b".repeat(1500));
  expect(out.announce).not.toHaveBeenCalled();
});

test("an empty result still completes the interaction", async () => {
  const out = output();
  await answerSlash(async () => true, out);
  expect(out.editReply).toHaveBeenCalledWith("OK.");
  const unknown = output();
  await answerSlash(async () => false, unknown);
  expect(unknown.editReply).toHaveBeenCalledWith("Unknown command.");
});

test("announce posts publicly once and leaves a private pointer", async () => {
  const out = output();
  await answerSlash(async (fx) => { await fx.announce!("Added Bo as admin in #general."); return true; }, out);
  expect(out.announce).toHaveBeenCalledTimes(1);
  expect(out.announce).toHaveBeenCalledWith("Added Bo as admin in #general.");
  expect(out.editReply).toHaveBeenCalledWith("Posted in the channel.");
});

test("a failed announce is reported privately", async () => {
  const out = output();
  out.announce.mockRejectedValueOnce(new Error("Missing Permissions"));
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  await answerSlash(async (fx) => { await fx.announce!("Removed Bo."); return true; }, out);
  expect(out.editReply).toHaveBeenCalledWith("Removed Bo. (Couldn't post this in the channel.)");
  expect(err).toHaveBeenCalled();
  err.mockRestore();
});
