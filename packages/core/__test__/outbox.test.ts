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
});
