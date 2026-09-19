import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  timeout: 30_000,
  // Each test launches a whole Electron app, and in parallel they contend and fail
  // spuriously — pre-existing, reproducible on any of these specs with `--workers=5`.
  workers: 1,
  reporter: "list",
});
