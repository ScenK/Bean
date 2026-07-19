import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { watchCliAvailability } from "../src/renderer/shared/cli-availability.js";
import type { AvailableModel, CliName } from "@bean/core";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = (path: string): string => readFileSync(resolve(appRoot, path), "utf8");

describe("CLI availability invalidation wiring", () => {
  test("refetches enabled CLIs and models when main invalidates the catalog", async () => {
    let clis: CliName[] = ["claude"];
    let models: AvailableModel[] = [{ id: "sonnet", label: "sonnet", availableOn: ["claude"] }];
    let invalidate: (() => void) | undefined;
    const seen: { clis: CliName[]; models: AvailableModel[] }[] = [];

    watchCliAvailability({
      availableClis: async () => clis,
      availableModels: async () => models,
      onCliAvailabilityChanged: (cb) => { invalidate = cb; },
    }, (availability) => { seen.push(availability); });
    await new Promise((resolve) => setImmediate(resolve));

    clis = ["codex"];
    models = [{ id: "gpt-5.6-sol", label: "gpt-5.6-sol", availableOn: ["codex"] }];
    invalidate?.();
    await new Promise((resolve) => setImmediate(resolve));

    expect(seen).toEqual([
      { clis: ["claude"], models: [{ id: "sonnet", label: "sonnet", availableOn: ["claude"] }] },
      { clis: ["codex"], models: [{ id: "gpt-5.6-sol", label: "gpt-5.6-sol", availableOn: ["codex"] }] },
    ]);
  });

  test("keeps channel, preload bridge, and renderer declaration in parity", () => {
    expect(source("src/channels.ts")).toContain('cliAvailabilityChanged: "bean:cli-availability-changed"');
    expect(source("src/preload.ts")).toContain("onCliAvailabilityChanged");
    expect(source("src/renderer/bean.d.ts")).toContain("onCliAvailabilityChanged");
  });

  test("every already-open desktop consumer subscribes through the shared availability hook", () => {
    for (const path of [
      "src/renderer/components/chat/ChatWindow.tsx",
      "src/renderer/components/plan/PlanWindow.tsx",
      "src/renderer/components/projects/ProjectsPanel.tsx",
      "src/renderer/components/routines/RoutinesPanel.tsx",
    ]) {
      expect(source(path), path).toContain("useCliAvailability");
    }
  });
});
