import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ownerDmRefs, sinkRecipients } from "../src/watch-io.js";

const dm = (id: string, user: { id?: string; aadObjectId?: string }, bot?: Record<string, unknown>) =>
  ({ conversation: { id, conversationType: "personal" }, user, ...(bot ? { bot } : {}) });

test("outbox DMs reach only the owner's personal conversation, not a coworker's", () => {
  const owner = dm("a", { id: "29:owner", aadObjectId: "aad-owner" });
  const coworker = dm("b", { id: "29:cow", aadObjectId: "aad-cow" });
  const channel = { conversation: { id: "c", conversationType: "channel" }, user: { id: "29:owner" } };
  const refs = { a: owner, b: coworker, c: channel };
  expect(ownerDmRefs(refs, "29:owner")).toEqual([owner]);
  expect(ownerDmRefs(refs, "aad-owner")).toEqual([owner]);
  expect(ownerDmRefs(refs, undefined)).toEqual([]);
});

test("a ref stored from a targeted (/ picker) activity is not the owner's DM", () => {
  const user = { id: "29:owner" };
  const targeted = dm("t", user, { id: "28:bot", isTargeted: true });
  const missing = dm("m", user, { id: "28:bot" });
  const off = dm("f", user, { id: "28:bot", isTargeted: false });
  const odd = dm("s", user, { id: "28:bot", isTargeted: "true" });
  expect(ownerDmRefs({ t: targeted, m: missing, f: off, s: odd }, "29:owner")).toEqual([missing, off, odd]);
});

test("sinkRecipients counts the owner's real DM, not a targeted ref", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bean-sink-"));
  await writeFile(join(dir, "teams.json"), JSON.stringify({ ownerId: "29:owner" }), "utf8");
  await writeFile(join(dir, "teams-conversations.json"), JSON.stringify({
    "a:real": dm("a:real", { id: "29:owner" }, { id: "28:bot" }),
    "a:pick": dm("a:pick", { id: "29:owner" }, { id: "28:bot", isTargeted: true }),
  }), "utf8");
  expect(await sinkRecipients(dir)).toEqual({ teams: 1 });
});
