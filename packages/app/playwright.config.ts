import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  timeout: 30_000,
  reporter: "list",
  // Electron enforces a single-instance OS-level lock (~/Library/Application Support/Electron)
  // regardless of the sandboxed HOME env var, so two Electron test workers launched in
  // parallel collide on SingletonLock. Run e2e files serially.
  workers: 1,
});
