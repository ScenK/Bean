import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claimOutbox, enqueueOutbox } from "../src/outbox.js";

const tmp = () => mkdtemp(join(tmpdir(), "bean-outbox-"));
let n = 0;
const newId = () => `id-${++n}`;

describe("outbox", () => {
  it("claim returns only the requested transport's messages, oldest first, and deletes them", async () => {
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
});
