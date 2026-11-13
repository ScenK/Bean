import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test("no spawn site spreads the full process.env", () => {
  // Bean's own chatops servers are trusted children and keep the full env.
  const dir = fileURLToPath(new URL("../src/", import.meta.url));
  const offenders = (readdirSync(dir, { recursive: true }) as string[])
    .filter((f) => f.endsWith(".ts") && f !== "chatops-servers.ts" && readFileSync(dir + f, "utf8").includes("...process.env"));
  expect(offenders).toEqual([]);
});
