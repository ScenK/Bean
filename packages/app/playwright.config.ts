import { readFileSync } from "node:fs";
import { defineConfig } from "@playwright/test";

// Quarantined tests (.memory/convention-e2e-tiers.md): skipped everywhere until their
// "Flaky e2e:" issue fixes or deletes them. The E2E Patrol sprout adds entries; a fix removes one.
// Matched against Playwright's grep title, "<file> [describe…] <title> [@tags]": the exact test, no substring.
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const quarantined = (JSON.parse(readFileSync(new URL("./e2e/quarantine.json", import.meta.url), "utf8")) as { file: string; title: string }[])
  .map((q) => `(?:^| )${esc(q.file)} (?:.* )?${esc(q.title)}(?: @|$)`);

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  timeout: 30_000,
  // Each test launches a whole Electron app, and in parallel they contend and fail
  // spuriously — pre-existing, reproducible on any of these specs with `--workers=5`.
  workers: 1,
  reporter: "list",
  ...(quarantined.length ? { grepInvert: new RegExp(quarantined.join("|")) } : {}),
});
