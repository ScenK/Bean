import { readFileSync } from "node:fs";
import { defineConfig } from "@playwright/test";

// Quarantined tests (.memory/convention-e2e-tiers.md): skipped everywhere until their
// "Flaky e2e:" issue fixes or deletes them. The E2E Patrol sprout adds entries; a fix removes one.
const quarantined = (JSON.parse(readFileSync(new URL("./e2e/quarantine.json", import.meta.url), "utf8")) as { title: string }[])
  .map((q) => q.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

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
