import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

// The host runs outside Electron (#803): nothing under src may import it. `electron` isn't a
// dependency either, so a value import also fails typecheck/build — this names the rule.
test("no host source imports electron", () => {
  const dir = join(import.meta.dirname, "../src");
  const offenders = readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts"))
    .filter((f) => /from\s+["']electron["']|require\(\s*["']electron["']\s*\)/.test(readFileSync(join(dir, f), "utf8")));
  expect(offenders).toEqual([]);
});
