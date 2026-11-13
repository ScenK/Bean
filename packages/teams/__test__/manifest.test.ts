import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { CHATOPS_COMMANDS } from "@bean/core";

test("the command catalog names exactly the Teams manifest's commandLists, no duplicates", () => {
  const manifest = JSON.parse(readFileSync(new URL("../teamsAppManifest/manifest.json", import.meta.url), "utf8")) as {
    bots: { commandLists: { commands: { title: string }[] }[] }[];
  };
  const teams = new Set(manifest.bots[0]!.commandLists.flatMap((l) => l.commands.map((c) => c.title)));
  const names = CHATOPS_COMMANDS.map((c) => c.name);
  expect(new Set(names).size).toBe(names.length);
  expect([...names].sort()).toEqual([...teams].sort());
});
