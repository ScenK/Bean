import { describe, expect, test, vi } from "vitest";
import type { ProposedRoutine, Routine } from "@bean/core";
import { buildRoutineDraftHandlers } from "../src/routine-drafts.js";

const check = { kind: "chat" as const, id: "check", instruction: "Is it out?",
  route: { paths: [{ when: "found", goto: "done" }, { when: "nothing", goto: "quiet" }] } };
const cron: Routine = { name: "album", enabled: true, cron: "0 9 * * *", webSearch: true, until: "2026-12-20", steps: [check], sinks: { home: {} } };
const feed: Routine = { ...cron, cron: undefined, watch: { kind: "feed", url: "https://example.com/feed.xml" }, todoDriven: true };
const now = new Date(2026, 10, 20, 12);

function setup(saved: Routine[] = []) {
  let n = 0;
  const store = [...saved];
  const save = vi.fn(async (r: Routine) => {
    const i = store.findIndex((x) => x.name === r.name);
    if (i >= 0) store[i] = { ...r }; else store.push({ ...r });
  });
  const enableWatch = vi.fn(async (name: string) => {
    const r = store.find((x) => x.name === name)!;
    Object.assign(r, { enabled: true });
  });
  const h = buildRoutineDraftHandlers({
    loadRoutines: async () => store.map((r) => ({ ...r })), save, enableWatch,
    cliModels: () => [], destinations: () => [], newId: () => `d${++n}`, now: () => now,
  });
  const propose = (routine: Routine, problem?: string) =>
    h.propose({ routine, updating: false, ...(problem ? { problem } : {}) } as ProposedRoutine);
  return { h, store, save, enableWatch, propose };
}

describe("desktop sprout drafts (#982)", () => {
  test("Save turns a scheduled draft on; the renderer hands back only the id", async () => {
    const s = setup();
    const card = await s.propose(cron);
    expect(card).toMatchObject({ id: "d1", name: "album", stops: "Dec 20, 2026, or sooner if found", tellYou: ["Home"] });
    expect(await s.h.save("d1", "save")).toEqual({ ok: true, name: "album", enabled: true });
    expect(s.store).toEqual([cron]);
    expect(await s.h.save("d1", "save")).toEqual({ ok: false, error: expect.stringMatching(/expired/) });
  });

  test("a feed watch saves off, then is seeded from now and turned on", async () => {
    const s = setup();
    await s.propose(feed);
    expect(await s.h.save("d1", "save")).toMatchObject({ ok: true, enabled: true });
    expect(s.save).toHaveBeenCalledWith({ ...feed, enabled: false });
    expect(s.enableWatch).toHaveBeenCalledWith("album");
    expect(s.store[0]).toMatchObject({ enabled: true, until: "2026-12-20", sinks: { home: {} } });
  });

  test("a feed that can't be checked leaves the watch saved off, and says so", async () => {
    const s = setup();
    s.enableWatch.mockRejectedValueOnce(new Error("feed down"));
    await s.propose(feed);
    expect(await s.h.save("d1", "save")).toEqual({ ok: false, error: expect.stringMatching(/switched off — couldn't check its feed: feed down/) });
    expect(s.store[0]?.enabled).toBe(false);
  });

  test("Open in editor saves it off, never seeding", async () => {
    const s = setup();
    await s.propose(feed);
    expect(await s.h.save("d1", "edit")).toEqual({ ok: true, name: "album", enabled: false });
    expect(s.enableWatch).not.toHaveBeenCalled();
    expect(s.store[0]?.enabled).toBe(false);
  });

  test("reusing an archived name shows as a replacement and keeps the saved Listed under", async () => {
    const s = setup([{ ...cron, enabled: false, until: "2026-10-01", projects: ["/p/app"] }]);
    expect((await s.propose(cron)).replaces).toBe("archived");
    expect((await s.propose({ ...cron, name: "Album" })).problem).toMatch(/"album" already exists/);
    expect(await s.h.save("d1", "save")).toMatchObject({ ok: true });
    expect(s.store).toEqual([{ ...cron, projects: ["/p/app"] }]);
  });

  test("Save re-checks the replace target, the end date and the draft itself", async () => {
    const s = setup();
    await s.propose(cron);
    s.store.push({ ...cron, enabled: true });
    expect(await s.h.save("d1", "save")).toEqual({ ok: false, error: '"album" changed since this card — ask me again.' });
    const late = setup();
    await late.propose({ ...cron, until: "2026-11-19" });
    expect(await late.h.save("d1", "save")).toEqual({ ok: false, error: expect.stringMatching(/end date has passed/) });
    const bad = setup();
    await bad.propose({ ...cron, sinks: { chatops: [{ transport: "discord", user: "x" }] } });
    expect(await bad.h.save("d1", "save")).toEqual({ ok: false, error: expect.stringMatching(/post to Home or DM you/) });
    expect(await bad.h.save("d1", "bogus")).toEqual({ ok: false, error: "Unknown action." });
    expect(bad.save).not.toHaveBeenCalled();
  });

  test("a draft that failed validation never saves", async () => {
    const s = setup();
    expect((await s.propose(cron, "bad cron")).problem).toBe("bad cron");
    expect(await s.h.save("d1", "save")).toEqual({ ok: false, error: "bad cron" });
    expect(s.save).not.toHaveBeenCalled();
  });

  test("the tool's names: every sprout, the live and archived lists sorted", () => {
    const s = setup();
    expect(s.h.authoring([{ ...cron, name: "b" }, { ...cron, name: "a" }, { ...cron, name: "old", enabled: false, until: "2026-01-01" }])).toMatchObject({
      transport: "desktop", existing: ["a", "b", "old"], listed: { live: ["a", "b"], archived: ["old"] },
    });
  });
});
