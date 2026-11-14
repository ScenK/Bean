import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendMemories, dbFile, getMemoryMeta, setMemoryMeta, type Memory, type OutboxMessage } from "@bean/core";
import { sendMemoryDigestIfDue, type MemoryDigestDeps } from "../src/memory-digest.js";
import type { ChatopsBot } from "../src/chatops-servers.js";

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bean-digest-"));
  file = dbFile(dir);
});
afterEach(async () => {

  await rm(dir, { recursive: true, force: true });
});

const LAST = "2026-11-13T08:00:00.000Z";
const NOW = new Date("2026-11-14T09:00:00.000Z");
const row = (id: string, text: string, over: Partial<Memory> = {}): Memory =>
  ({ id, text, createdAt: "2026-11-13T12:00:00.000Z", ...over });

function deps(over: Partial<MemoryDigestDeps> = {}, bots: ChatopsBot[] = ["discord", "teams"]) {
  const sent: Omit<OutboxMessage, "id" | "createdAt">[] = [];
  const d: MemoryDigestDeps = {
    dbFile: file, canRun: () => true, runningBots: () => bots, ownerIds: async () => ["owner-1"],
    labels: () => new Map([["discord:c1", "#design"]]),
    enqueue: async (msg) => { sent.push(msg); return "id"; },
    now: () => NOW,
    ...over,
  };
  return { d, sent };
}

test("every running bot gets one owner DM with shared + owner rows, never a member's; then the watermark advances", async () => {
  await setMemoryMeta(file, "lastDigestAt", LAST);
  await appendMemories(file, [
    row("a", "Kind of want it to be blue.", { sourceId: "discord:c1", sourceTitle: "old-name", context: "logo color" }),
    row("b", "owner secret", { subjectId: "owner-1" }),
    row("c", "member secret", { subjectId: "member-9" }),
    row("d", "old fact", { createdAt: "2026-11-12T00:00:00.000Z" }),
  ]);
  const { d, sent } = deps();
  expect(await sendMemoryDigestIfDue(d)).toBe(2);
  expect(sent.map((m) => m.transport)).toEqual(["discord", "teams"]);
  for (const m of sent) {
    expect(m.channel).toBeUndefined();
    expect(m.displayBody).toBeUndefined();
    expect(m.context).toBe(false);
  }
  const body = sent[0]!.body;
  expect(body).toContain("#design\n- Kind of want it to be blue. (re: logo color)");
  expect(body).toContain("owner secret");
  expect(body).not.toContain("member secret");
  expect(body).not.toContain("old fact");
  expect(body).toContain("forget");
  expect(await getMemoryMeta(file, "lastDigestAt")).toBe(NOW.toISOString());
});

test("only the running bot gets it; with none, nothing is queued and the watermark stays", async () => {
  await setMemoryMeta(file, "lastDigestAt", LAST);
  await appendMemories(file, [row("a", "fact")]);
  const none = deps({}, []);
  expect(await sendMemoryDigestIfDue(none.d)).toBe(0);
  expect(none.sent).toEqual([]);
  expect(await getMemoryMeta(file, "lastDigestAt")).toBe(LAST);
  const one = deps({}, ["teams"]);
  expect(await sendMemoryDigestIfDue(one.d)).toBe(1);
  expect(one.sent.map((m) => m.transport)).toEqual(["teams"]);
});

test("no new rows sends nothing", async () => {
  await setMemoryMeta(file, "lastDigestAt", LAST);
  const { d, sent } = deps();
  expect(await sendMemoryDigestIfDue(d)).toBe(0);
  expect(sent).toEqual([]);
});

test("a host without the scheduler lease sends nothing and touches nothing", async () => {
  await setMemoryMeta(file, "lastDigestAt", LAST);
  await appendMemories(file, [row("a", "fact")]);
  const { d, sent } = deps({ canRun: () => false });
  expect(await sendMemoryDigestIfDue(d)).toBe(0);
  expect(sent).toEqual([]);
  expect(await getMemoryMeta(file, "lastDigestAt")).toBe(LAST);
});

test("not due within a day; the first run only starts the clock", async () => {
  await appendMemories(file, [row("a", "fact")]);
  const { d, sent } = deps();
  expect(await sendMemoryDigestIfDue(d)).toBe(0);
  expect(await getMemoryMeta(file, "lastDigestAt")).toBe(NOW.toISOString());
  await appendMemories(file, [row("b", "later", { createdAt: "2026-11-14T10:00:00.000Z" })]);
  expect(await sendMemoryDigestIfDue({ ...d, now: () => new Date("2026-11-15T08:00:00.000Z") })).toBe(0);
  expect(sent).toEqual([]);
  expect(await sendMemoryDigestIfDue({ ...d, now: () => new Date("2026-11-15T09:00:00.000Z") })).toBe(2);
  expect(sent[0]!.body).toContain("later");
  expect(sent[0]!.body).not.toContain("- fact");
});

test("one failed enqueue still delivers to the other bot", async () => {
  await setMemoryMeta(file, "lastDigestAt", LAST);
  await appendMemories(file, [row("a", "fact")]);
  const sent: string[] = [];
  const { d } = deps({
    enqueue: async (msg) => { if (msg.transport === "discord") throw new Error("disk full"); sent.push(msg.transport); return "id"; },
  });
  expect(await sendMemoryDigestIfDue(d)).toBe(1);
  expect(sent).toEqual(["teams"]);
  expect(await getMemoryMeta(file, "lastDigestAt")).toBe(NOW.toISOString());
});
