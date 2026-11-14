import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test("no spawn site spreads the full process.env", () => {
  const dir = fileURLToPath(new URL("../src/", import.meta.url));
  const offenders = (readdirSync(dir, { recursive: true }) as string[])
    .filter((f) => f.endsWith(".ts") && readFileSync(dir + f, "utf8").includes("...process.env"));
  expect(offenders).toEqual([]);
});

test("outbox failures log outboxErrorLine, never the raw error (it carries the private body)", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/server.ts", import.meta.url)), "utf8");
  expect(src.match(/console\.error\([^\n]*outbox[^\n]*,\s*err\)/g) ?? []).toEqual([]);
  expect(src).toContain("outboxErrorLine(err)");
});
