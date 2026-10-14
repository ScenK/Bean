import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ackOutbox, claimOutbox, drainOutbox, enqueueOutbox, OUTBOX_MAX_ATTEMPTS, recoverOutbox } from "../src/outbox.js";

const tmp = () => mkdtemp(join(tmpdir(), "bean-outbox-"));
let n = 0;
const newId = () => `id-${++n}`;

describe("outbox", () => {
  it("claim returns only the requested transport's messages, oldest first, and holds them until acked", async () => {
    const dir = await tmp();
    const t0 = () => new Date("2026-07-12T06:00:00Z");
    const t1 = () => new Date("2026-07-12T07:00:00Z");
    await enqueueOutbox(dir, { transport: "discord", channel: "c1", body: "second" }, newId, t1);
    await enqueueOutbox(dir, { transport: "discord", channel: "c1", body: "first" }, newId, t0);
    await enqueueOutbox(dir, { transport: "teams", channel: "conv1", title: "T", body: "teams msg" }, newId);
    const discord = await claimOutbox(dir, "discord");
    expect(discord.map((m) => m.body)).toEqual(["first", "second"]);
    expect(await claimOutbox(dir, "discord")).toEqual([]); // claimed = gone
    const teams = await claimOutbox(dir, "teams");
    expect(teams).toHaveLength(1);
    expect(teams[0]).toMatchObject({ channel: "conv1", title: "T", body: "teams msg" });
    expect((await readdir(dir)).every((f) => f.endsWith(".json.sending"))).toBe(true);
    for (const m of [...discord, ...teams]) await ackOutbox(dir, m);
    expect(await readdir(dir)).toEqual([]);
  });
  it("missing dir → [], malformed files are deleted and skipped", async () => {
    expect(await claimOutbox("/nonexistent/nowhere", "discord")).toEqual([]);
    const dir = await tmp();
    await writeFile(join(dir, "junk.json"), "{broken", "utf8");
    expect(await claimOutbox(dir, "discord")).toEqual([]);
    expect(await readdir(dir)).toEqual([]);
  });
  it("a malformed file for one transport is untouched by another transport's claim, but self-cleans on its own claim", async () => {
    const dir = await tmp();
    await writeFile(join(dir, "teams-x.json"), "{broken", "utf8");
    await enqueueOutbox(dir, { transport: "discord", channel: "c1", body: "hi" }, newId);

    const discord = await claimOutbox(dir, "discord");
    expect(discord.map((m) => m.body)).toEqual(["hi"]);
    await ackOutbox(dir, discord[0]!);
    expect(await readdir(dir)).toEqual(["teams-x.json"]); // malformed teams file left alone

    const teams = await claimOutbox(dir, "teams");
    expect(teams).toEqual([]); // still no valid teams messages
    expect(await readdir(dir)).toEqual([]); // but its own claim swept the malformed file
  });
  it("filename prefix matches but body transport disagrees (hand-edited) → deleted, not returned or stranded", async () => {
    const dir = await tmp();
    await writeFile(
      join(dir, "discord-mismatch.json"),
      JSON.stringify({ transport: "teams", channel: "conv1", body: "hi" }),
      "utf8",
    );
    expect(await claimOutbox(dir, "discord")).toEqual([]);
    expect(await readdir(dir)).toEqual([]); // no longer left on disk forever
  });
  it("enqueues and claims a DM message with no channel (channel omitted = DM)", async () => {
    const dir = await tmp();
    await enqueueOutbox(dir, { transport: "discord", body: "dm me" }, newId);
    const discord = await claimOutbox(dir, "discord");
    expect(discord).toHaveLength(1);
    expect(discord[0]).toMatchObject({ body: "dm me" });
    expect(discord[0]!.channel).toBeUndefined();
  });

  it("the desktop chat transport round-trips and isn't swept as an orphan by another transport's claim", async () => {
    const dir = await tmp();
    await enqueueOutbox(dir, { transport: "chat", body: "interrupted" }, newId);
    expect(await claimOutbox(dir, "discord")).toEqual([]); // not this transport's file
    expect(await readdir(dir)).toEqual([expect.stringMatching(/^chat-/)]); // left untouched, not swept
    const chat = await claimOutbox(dir, "chat");
    expect(chat.map((m) => m.body)).toEqual(["interrupted"]);
    expect(await claimOutbox(dir, "chat")).toEqual([]);
  });

  it("displayBody round-trips alongside body when present, and is absent for plain messages", async () => {
    const dir = await tmp();
    await enqueueOutbox(dir, { transport: "chat", body: "full instruction here", displayBody: "short version" }, newId);
    await enqueueOutbox(dir, { transport: "discord", channel: "c1", body: "plain digest" }, newId);
    const chat = await claimOutbox(dir, "chat");
    expect(chat[0]).toMatchObject({ body: "full instruction here", displayBody: "short version" });
    const discord = await claimOutbox(dir, "discord");
    expect(discord[0]!.displayBody).toBeUndefined();
  });

  it("a failed send is kept and retried with backoff, then given up on once with one notice", async () => {
    const dir = await tmp();
    let t = new Date("2026-07-12T06:00:00Z").getTime();
    const now = () => new Date(t);
    await enqueueOutbox(dir, { transport: "discord", channel: "c1", body: "flaky" }, newId, now);
    await enqueueOutbox(dir, { transport: "teams", body: "not mine" }, newId, now);
    const sent: string[] = [];
    const gaveUp: string[] = [];
    const failing = async () => { throw new Error("network blip"); };
    const onGiveUp = async (m: { body: string }) => { gaveUp.push(m.body); };

    await drainOutbox(dir, "discord", failing, onGiveUp, now);
    const [file] = (await readdir(dir)).filter((f) => f.startsWith("discord-"));
    expect(file).toMatch(/\.json$/); // back in the queue, not lost
    expect(JSON.parse(await readFile(join(dir, file!), "utf8"))).toMatchObject({ attempts: 1, retryAt: "2026-07-12T06:01:00.000Z" });
    await drainOutbox(dir, "discord", async (m) => { sent.push(m.body); }, onGiveUp, now);
    expect(sent).toEqual([]); // still backing off

    for (let i = 1; i < OUTBOX_MAX_ATTEMPTS; i++) {
      t += 60 * 60_000;
      await drainOutbox(dir, "discord", failing, onGiveUp, now);
    }
    expect(gaveUp).toEqual(["flaky"]);
    expect(await readdir(dir)).toEqual([expect.stringMatching(/^teams-.*\.json$/)]); // other transport untouched

    // a later success acks it
    await enqueueOutbox(dir, { transport: "discord", body: "ok" }, newId, now);
    await drainOutbox(dir, "discord", async (m) => { sent.push(m.body); }, onGiveUp, now);
    expect(sent).toEqual(["ok"]);
    expect(await readdir(dir)).toEqual([expect.stringMatching(/^teams-/)]);
  });

  it("boot recovery re-queues this transport's mid-send files as one failed attempt", async () => {
    const dir = await tmp();
    await enqueueOutbox(dir, { transport: "discord", body: "crashed mid-send" }, newId);
    await enqueueOutbox(dir, { transport: "teams", body: "teams in flight" }, newId);
    await claimOutbox(dir, "discord"); // ...and the bot dies before acking
    await claimOutbox(dir, "teams");
    await recoverOutbox(dir, "discord", async () => { throw new Error("not exhausted yet"); });
    const files = (await readdir(dir)).sort();
    expect(files).toEqual([expect.stringMatching(/^discord-.*\.json$/), expect.stringMatching(/^teams-.*\.json\.sending$/)]);
    expect(JSON.parse(await readFile(join(dir, files[0]!), "utf8"))).toMatchObject({ body: "crashed mid-send", attempts: 1 });
  });
});
