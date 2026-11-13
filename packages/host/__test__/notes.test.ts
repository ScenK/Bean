import { expect, test, vi } from "vitest";
import { buildNotesHandlers } from "../src/index.js";

test("note image handlers accept raw bytes only and serve stored rows as data: URLs", async () => {
  const stored: Uint8Array[] = [];
  const saves: { body: string }[] = [];
  const handlers = buildNotesHandlers({
    loadNotes: async () => [],
    saveNote: async (_f, draft) => { saves.push({ body: draft.body }); return "s"; },
    archiveNote: async () => true, restoreNote: async () => true, purgeNote: async () => true,
    starNote: async () => {},
    loadNoteHistory: async () => [],
    saveNoteImage: async (_f, bytes) => { stored.push(bytes); return "abcdef12-2222-4333-8444-555555555555"; },
    loadNoteImage: async (_f, id) => (id === "known" ? { mime: "image/png", bytes: Uint8Array.from([1, 2]) } : undefined),
    dbFile: "/b/bean.db",
  });
  await expect(handlers.saveImage("/Users/me/secret.png")).rejects.toThrow(/raw bytes/);
  await expect(handlers.saveImage({ path: "/etc/passwd" })).rejects.toThrow(/raw bytes/);
  await expect(handlers.saveImage(new Uint8Array(10 * 1024 * 1024 + 1))).rejects.toThrow(/10 MB/);
  expect(stored).toHaveLength(0);
  expect(await handlers.saveImage(Uint8Array.from([9]))).toMatch(/^abcdef12/);
  expect(await handlers.image("known")).toBe("data:image/png;base64,AQI=");
  expect(await handlers.image("missing")).toBeUndefined();
  expect(await handlers.image(42)).toBeUndefined();
  await handlers.save({ title: "T", body: "B" }, [{ data: "AQI=", mimeType: "image/png" }]);
  expect(saves[0]!.body).toBe("B\n\n![image](bean-image:abcdef12-2222-4333-8444-555555555555)\n");
});

test("notes save copies only known draft fields", async () => {
  const drafts: unknown[] = [];
  const handlers = buildNotesHandlers({
    loadNotes: async () => [], saveNote: async (_f, draft) => { drafts.push(draft); return "s"; },
    archiveNote: async () => true, restoreNote: async () => true, purgeNote: async () => true,
    starNote: async () => {}, loadNoteHistory: async () => [],
    saveNoteImage: async () => "x", loadNoteImage: async () => undefined, dbFile: "/b/bean.db",
  });
  await handlers.save({ title: "T", body: "B", slug: "s1", project: "/p", source: "manual", archivedAt: "x", upsert: true } as never);
  expect(drafts).toEqual([{ title: "T", body: "B", slug: "s1", project: "/p", source: "manual" }]);
});

test("notes handlers pass the configured dir through to the injected store fns", async () => {
  const calls: unknown[][] = [];
  let purged = true;
  const handlers = buildNotesHandlers({
    loadNotes: async (dir, opts) => { calls.push(["list", dir, opts]); return []; },
    saveNote: async (dir, draft) => { calls.push(["save", dir, draft.title]); return "slug"; },
    archiveNote: async (dir, slug) => { calls.push(["archive", dir, slug]); return true; },
    restoreNote: async (dir, slug) => { calls.push(["restore", dir, slug]); return true; },
    purgeNote: async (dir, slug) => { calls.push(["purge", dir, slug]); return purged; },
    loadNoteHistory: async (dir, slug) => { calls.push(["history", dir, slug]); return []; },
    dbFile: "/b/notes",
  });
  await handlers.list();
  await handlers.list({ includeArchived: "yes" });
  await handlers.list({ includeArchived: true });
  expect(await handlers.save({ title: "T", body: "B" })).toBe("slug");
  await handlers.archive("t");
  await handlers.restore("t");
  await handlers.purge("t");
  await handlers.history("t");
  expect(calls).toEqual([
    ["list", "/b/notes", { includeArchived: false }], ["list", "/b/notes", { includeArchived: false }],
    ["list", "/b/notes", { includeArchived: true }], ["save", "/b/notes", "T"], ["archive", "/b/notes", "t"],
    ["restore", "/b/notes", "t"], ["purge", "/b/notes", "t"], ["history", "/b/notes", "t"],
  ]);
  // Slugs cross IPC untyped: non-strings never reach core, and a refused purge surfaces.
  await expect(handlers.restore(42)).rejects.toThrow(/invalid note slug/);
  await expect(handlers.purge(undefined)).rejects.toThrow(/invalid note slug/);
  purged = false;
  await expect(handlers.purge("live")).rejects.toThrow(/archived/);
});
