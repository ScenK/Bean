import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test("no spawn site spreads the full process.env", () => {
  // devtunnel is a trusted child and keeps the full env.
  const dir = fileURLToPath(new URL("../src/", import.meta.url));
  const offenders = (readdirSync(dir, { recursive: true }) as string[])
    .filter((f) => f.endsWith(".ts") && f !== "devtunnel.ts" && readFileSync(dir + f, "utf8").includes("...process.env"));
  expect(offenders).toEqual([]);
});
