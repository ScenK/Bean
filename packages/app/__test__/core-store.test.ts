import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coreFile, loadCoreChoice, saveCoreChoice } from "../src/core-store.js";

describe("core choice (#810)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bean-core-store-"));

  it("first run: a Mac runs its local core, elsewhere no core", async () => {
    const file = coreFile(join(dir, "none"));
    expect(await loadCoreChoice(file, "darwin")).toEqual({ selected: "local" });
    expect(await loadCoreChoice(file, "win32")).toEqual({ selected: null });
  });

  it("keeps a saved choice; an unknown id is not the local core; corrupt falls back", async () => {
    const file = coreFile(dir);
    await saveCoreChoice(file, { selected: null });
    expect(await loadCoreChoice(file, "darwin")).toEqual({ selected: null });
    await saveCoreChoice(file, { selected: "local" });
    expect(await loadCoreChoice(file, "linux")).toEqual({ selected: "local" });
    await writeFile(file, JSON.stringify({ selected: "remote-1" }));
    expect(await loadCoreChoice(file, "darwin")).toEqual({ selected: null });
    await writeFile(file, "{not json");
    expect(await loadCoreChoice(file, "darwin")).toEqual({ selected: "local" });
  });
});
