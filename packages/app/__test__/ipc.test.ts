import { describe, expect, it, test, vi } from "vitest";
import {
  buildThemeHandlers, buildLaunchHandler, buildPlanStore, buildDroppedUrlStore, buildChatPromptStore,
  buildPendingUpdateStore, buildUpdateHandlers, parseDashboardTarget, openComponentPayload, notificationOpens,
} from "../src/ipc.js";
import type { RouteSuggestion } from "@bean/core";
import type { LaunchSpawnFn } from "@bean/core";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";

test("theme handlers read and write through the injected deps", async () => {
  let current: "hearth" | "graphite" = "hearth";
  const setCurrentTheme = vi.fn(async (t: "hearth" | "graphite") => { current = t; });
  const handlers = buildThemeHandlers({ getCurrentTheme: () => current, setCurrentTheme });

  expect(handlers.get()).toBe("hearth");
  await handlers.set("graphite");
  expect(setCurrentTheme).toHaveBeenCalledWith("graphite");
  expect(handlers.get()).toBe("graphite");
});

function fakeChild() {
  return new EventEmitter() as EventEmitter & { kill: () => void };
}

test("launch handler opens the configured editor via `open -a` (open mode, no script)", () => {
  const child = fakeChild();
  const spawnLaunch = vi.fn<LaunchSpawnFn>(() => child as never);
  const handler = buildLaunchHandler({ spawnLaunch, getEditorApp: () => "/Applications/Zed.app" });

  handler({ mode: "open", projectPath: "/p" });

  expect(spawnLaunch).toHaveBeenCalledWith("open", ["-a", "/Applications/Zed.app", "/p"]);
});

test("launch handler reports an error and never spawns when no editor is configured", () => {
  const spawnLaunch = vi.fn<LaunchSpawnFn>();
  const onLaunchError = vi.fn();
  const handler = buildLaunchHandler({ spawnLaunch, onLaunchError });

  handler({ mode: "open", projectPath: "/p" });

  expect(spawnLaunch).not.toHaveBeenCalled();
  expect(onLaunchError).toHaveBeenCalledWith(
    { mode: "open", projectPath: "/p" },
    expect.objectContaining({ message: expect.stringContaining("No editor configured") }),
  );
});

test("launch handler forwards getTerminalApp() into launchInTerminal's terminalApp arg", () => {
  const child = fakeChild();
  const spawnLaunch = vi.fn<LaunchSpawnFn>(() => child as never);
  const handler = buildLaunchHandler({ spawnLaunch, getTerminalApp: () => "/Applications/Warp.app" });

  handler({ mode: "opencode", projectPath: "/p", prompt: "go" });

  // "open" is called with the -a flag naming the configured app.
  expect(spawnLaunch).toHaveBeenCalledWith("open", expect.arrayContaining(["-a", "/Applications/Warp.app"]));
});

test("plan store lets a late subscriber pull the pending plan (drop race fix)", () => {
  const store = buildPlanStore();
  const run: RouteSuggestion = { skillName: "review-code", projectPath: "/work/api", composedPrompt: "go", confidence: 0 };

  // No plan proposed yet: a window that opens first sees nothing.
  expect(store.get()).toBeUndefined();

  // main stores the plan the instant it's computed, before the fresh window's
  // renderer has even loaded — the exact timing that used to drop the push message.
  store.set(run);

  // The renderer mounts later and pulls it: no race, it's there.
  expect(store.get()).toBe(run);
  // Consumed once so a reopened plan window can't replay a stale proposal.
  expect(store.get()).toBeUndefined();
});

test("dropped-url store lets a late subscriber pull the pending drop (same drop-race fix as the plan store)", () => {
  const store = buildDroppedUrlStore();

  // No drop yet: a window that opens first sees nothing.
  expect(store.get()).toBeUndefined();

  // main stores the url the instant a drop lands, before a fresh chat window's renderer has
  // mounted and subscribed — the exact timing that silently dropped the push message.
  store.set("/Users/x/photo.png");

  // The renderer mounts later and pulls it: no race, it's there.
  expect(store.get()).toBe("/Users/x/photo.png");
  // Consumed once so a later reopen can't replay a stale drop.
  expect(store.get()).toBeUndefined();
});

test("chat-prompt store lets a late-mounting chat window pull the pending prompt (same race fix)", () => {
  const store = buildChatPromptStore();
  expect(store.get()).toBeUndefined();
  store.set({ prompt: "## Skill\nsummarize…", label: "summarize" });
  expect(store.get()).toEqual({ prompt: "## Skill\nsummarize…", label: "summarize" });
  // Consumed once so a reopened chat can't replay a stale run.
  expect(store.get()).toBeUndefined();
});

test("launch handler with a real projectPath fires synchronously (no scratch-workspace detour)", () => {
  const child = fakeChild();
  const spawnLaunch = vi.fn<LaunchSpawnFn>(() => child as never);
  const handler = buildLaunchHandler({ spawnLaunch });

  handler({ mode: "opencode", projectPath: "/dev/acme", prompt: "go" });

  // Synchronous: no awaited microtask needed before the spawn happens.
  expect(spawnLaunch).toHaveBeenCalledWith("open", expect.anything());
});

test("launch handler rejects a stale request for a disabled CLI", () => {
  const child = fakeChild();
  const spawnLaunch = vi.fn<LaunchSpawnFn>(() => child as never);
  const onLaunchError = vi.fn();
  const handler = buildLaunchHandler({
    spawnLaunch,
    onLaunchError,
    getAvailableClis: () => ["claude"],
    getCliModels: () => [
      { provider: "claude", models: ["sonnet"] },
      { provider: "codex", models: ["gpt-5.6-sol"] },
    ],
  });

  handler({ mode: "codex", projectPath: "/dev/acme", prompt: "go", model: "gpt-5.6-sol" });

  expect(spawnLaunch).not.toHaveBeenCalled();
  expect(onLaunchError).toHaveBeenCalledWith(
    expect.objectContaining({ mode: "codex" }),
    expect.objectContaining({ message: expect.stringContaining("disabled") }),
  );
});

test("launch handler normalizes an unsupported model to one supported by the valid CLI", () => {
  const child = fakeChild();
  const spawnLaunch = vi.fn<LaunchSpawnFn>(() => child as never);
  const handler = buildLaunchHandler({
    spawnLaunch,
    getAvailableClis: () => ["claude"],
    getCliModels: () => [
      { provider: "claude", models: ["sonnet"] },
      { provider: "codex", models: ["gpt-5.6-sol"] },
    ],
  });

  handler({ mode: "claude", projectPath: "/dev/acme", prompt: "go", model: "gpt-5.6-sol" });

  const scriptPath = spawnLaunch.mock.calls[0]?.[1][0];
  expect(scriptPath).toEqual(expect.stringMatching(/bean-run-.*\.command$/));
  const script = readFileSync(scriptPath!, "utf8");
  expect(script).toContain("'--model' 'sonnet'");
  expect(script).not.toContain("gpt-5.6-sol");
});

test("launch handler keeps open mode available when every terminal CLI is disabled", () => {
  const child = fakeChild();
  const spawnLaunch = vi.fn<LaunchSpawnFn>(() => child as never);
  const handler = buildLaunchHandler({
    spawnLaunch,
    getEditorApp: () => "/Applications/Zed.app",
    getAvailableClis: () => [],
    getCliModels: () => [],
  });

  handler({ mode: "open", projectPath: "/p" });

  expect(spawnLaunch).toHaveBeenCalledWith("open", ["-a", "/Applications/Zed.app", "/p"]);
});

test("launch handler with no project resolves via a bare scratch dir before launching", async () => {
  const child = fakeChild();
  const spawnLaunch = vi.fn<LaunchSpawnFn>(() => child as never);
  const ensureDir = vi.fn(async () => {});
  const handler = buildLaunchHandler({ spawnLaunch, beanDirPath: "/b", ensureDir });

  handler({ mode: "opencode", projectPath: "", prompt: "go" });
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(ensureDir).toHaveBeenCalledWith("/b/workspace");
  // launchInTerminal writes a real .command script and opens it via `open` — same shape
  // launcher.test.ts already covers; here we're only proving the async resolution ran first.
  expect(spawnLaunch).toHaveBeenCalledWith("open", [expect.stringMatching(/bean-run-.*\.command$/)]);
});

test("buildPendingUpdateStore returns undefined until set, then the same value on repeated get (not consumed)", () => {
  const store = buildPendingUpdateStore();
  expect(store.get()).toBeUndefined();
  store.set("/tmp/bean-update-xyz/Bean.app");
  expect(store.get()).toBe("/tmp/bean-update-xyz/Bean.app");
  expect(store.get()).toBe("/tmp/bean-update-xyz/Bean.app");
});

test("buildUpdateHandlers.check strips extractedAppPath/URLs before returning to the renderer, and stores the path for install", async () => {
  const store = buildPendingUpdateStore();
  const handlers = buildUpdateHandlers({
    currentVersion: "0.8.12",
    isPackaged: true,
    checkAndDownloadUpdate: async () => ({
      result: { status: "available", version: "0.8.13", notes: "notes", zipUrl: "https://x/zip", sigUrl: "https://x/sig" },
      extractedAppPath: "/tmp/bean-update-xyz/Bean.app",
    }),
    installUpdate: async () => {},
    pendingUpdateStore: store,
    openReleasesPage: () => {},
    cleanupExtractedBundle: async () => {},
  });
  const status = await handlers.check();
  expect(status).toEqual({ status: "available", version: "0.8.13", notes: "notes" });
  expect(store.get()).toBe("/tmp/bean-update-xyz/Bean.app");
});

test("buildUpdateHandlers.check passes up-to-date/error results through unchanged", async () => {
  const handlers = buildUpdateHandlers({
    currentVersion: "0.8.12",
    isPackaged: true,
    checkAndDownloadUpdate: async () => ({ result: { status: "up-to-date" } }),
    installUpdate: async () => {},
    pendingUpdateStore: buildPendingUpdateStore(),
    openReleasesPage: () => {},
    cleanupExtractedBundle: async () => {},
  });
  expect(await handlers.check()).toEqual({ status: "up-to-date" });
});

test("buildUpdateHandlers.install errors when nothing has been checked/downloaded yet", async () => {
  const installed: string[] = [];
  const handlers = buildUpdateHandlers({
    currentVersion: "0.8.12",
    isPackaged: true,
    checkAndDownloadUpdate: async () => ({ result: { status: "up-to-date" } }),
    installUpdate: async (path: string) => { installed.push(path); },
    pendingUpdateStore: buildPendingUpdateStore(),
    openReleasesPage: () => {},
    cleanupExtractedBundle: async () => {},
  });
  expect(await handlers.install()).toEqual({
    status: "error",
    message: "No update is ready to install — check for updates again.",
  });
  expect(installed).toEqual([]);
});

test("buildUpdateHandlers.install calls installUpdate with the stored path", async () => {
  const installed: string[] = [];
  const store = buildPendingUpdateStore();
  const handlers = buildUpdateHandlers({
    currentVersion: "0.8.12",
    isPackaged: true,
    checkAndDownloadUpdate: async () => ({
      result: { status: "available", version: "0.8.13", notes: "notes", zipUrl: "https://x/zip", sigUrl: "https://x/sig" },
      extractedAppPath: "/tmp/bean-update-xyz/Bean.app",
    }),
    installUpdate: async (path: string) => { installed.push(path); },
    pendingUpdateStore: store,
    openReleasesPage: () => {},
    cleanupExtractedBundle: async () => {},
  });
  await handlers.check();
  const outcome = await handlers.install();
  expect(installed).toEqual(["/tmp/bean-update-xyz/Bean.app"]);
  expect(outcome).toBeUndefined();
});

test("buildUpdateHandlers.install surfaces an error from installUpdate instead of throwing", async () => {
  const store = buildPendingUpdateStore();
  store.set("/tmp/bean-update-xyz/Bean.app");
  const handlers = buildUpdateHandlers({
    currentVersion: "0.8.12",
    isPackaged: true,
    checkAndDownloadUpdate: async () => ({ result: { status: "up-to-date" } }),
    installUpdate: async () => { throw new Error("EACCES"); },
    pendingUpdateStore: store,
    openReleasesPage: () => {},
    cleanupExtractedBundle: async () => {},
  });
  expect(await handlers.install()).toEqual({ status: "error", message: "EACCES" });
});

test("buildUpdateHandlers.openReleasesPage delegates to the injected opener", () => {
  const opened: boolean[] = [];
  const handlers = buildUpdateHandlers({
    currentVersion: "0.8.12",
    isPackaged: true,
    checkAndDownloadUpdate: async () => ({ result: { status: "up-to-date" } }),
    installUpdate: async () => {},
    pendingUpdateStore: buildPendingUpdateStore(),
    openReleasesPage: () => { opened.push(true); },
    cleanupExtractedBundle: async () => {},
  });
  handlers.openReleasesPage();
  expect(opened).toEqual([true]);
});

test("buildUpdateHandlers.check refuses in a dev build without calling checkAndDownloadUpdate", async () => {
  const checked: string[] = [];
  const handlers = buildUpdateHandlers({
    currentVersion: "0.8.12",
    isPackaged: false,
    checkAndDownloadUpdate: async (v: string) => { checked.push(v); return { result: { status: "up-to-date" } }; },
    installUpdate: async () => {},
    pendingUpdateStore: buildPendingUpdateStore(),
    openReleasesPage: () => {},
    cleanupExtractedBundle: async () => {},
  });
  expect(await handlers.check()).toEqual({ status: "error", message: "Updates aren't available in a dev build." });
  expect(checked).toEqual([]);
});

test("buildUpdateHandlers.install refuses in a dev build without calling installUpdate, even with a pending path", async () => {
  const installed: string[] = [];
  const store = buildPendingUpdateStore();
  store.set("/tmp/bean-update-xyz/Bean.app");
  const handlers = buildUpdateHandlers({
    currentVersion: "0.8.12",
    isPackaged: false,
    checkAndDownloadUpdate: async () => ({ result: { status: "up-to-date" } }),
    installUpdate: async (path: string) => { installed.push(path); },
    pendingUpdateStore: store,
    openReleasesPage: () => {},
    cleanupExtractedBundle: async () => {},
  });
  expect(await handlers.install()).toEqual({ status: "error", message: "Updates aren't available in a dev build." });
  expect(installed).toEqual([]);
});

test("buildUpdateHandlers.check cleans up the previous extracted bundle when a second check supersedes it", async () => {
  const store = buildPendingUpdateStore();
  const cleanedUp: string[] = [];
  let call = 0;
  const handlers = buildUpdateHandlers({
    currentVersion: "0.8.12",
    isPackaged: true,
    checkAndDownloadUpdate: async () => {
      call += 1;
      return {
        result: { status: "available", version: `0.8.1${call + 2}`, notes: "notes", zipUrl: "https://x/zip", sigUrl: "https://x/sig" },
        extractedAppPath: `/tmp/bean-update-${call}/Bean.app`,
      };
    },
    installUpdate: async () => {},
    pendingUpdateStore: store,
    openReleasesPage: () => {},
    cleanupExtractedBundle: async (path: string) => { cleanedUp.push(path); },
  });

  await handlers.check();
  expect(cleanedUp).toEqual([]);

  await handlers.check();
  expect(cleanedUp).toEqual(["/tmp/bean-update-1/Bean.app"]);
  expect(store.get()).toBe("/tmp/bean-update-2/Bean.app");
});

test("buildUpdateHandlers.check does not clean up when the new result has no extracted bundle (up-to-date/error)", async () => {
  const store = buildPendingUpdateStore();
  store.set("/tmp/bean-update-1/Bean.app");
  const cleanedUp: string[] = [];
  const handlers = buildUpdateHandlers({
    currentVersion: "0.8.12",
    isPackaged: true,
    checkAndDownloadUpdate: async () => ({ result: { status: "up-to-date" } }),
    installUpdate: async () => {},
    pendingUpdateStore: store,
    openReleasesPage: () => {},
    cleanupExtractedBundle: async (path: string) => { cleanedUp.push(path); },
  });

  await handlers.check();
  expect(cleanedUp).toEqual([]);
  expect(store.get()).toBe("/tmp/bean-update-1/Bean.app");
});

// Dashboard deep links cross renderer → main (bubble click) and ride notification `meta`: both are
// validated before main acts on them.
describe("dashboard targets", () => {
  const at = "2026-10-23T06:00:00.000Z";
  test("keeps only a non-empty routine and an ISO startedAt; an invalid date rejects the target", () => {
    expect(parseDashboardTarget({ routine: "nightly", startedAt: at, extra: "x" })).toEqual({ routine: "nightly", startedAt: at });
    expect(parseDashboardTarget({ routine: "nightly" })).toEqual({ routine: "nightly" });
    expect(parseDashboardTarget({ routine: "nightly", startedAt: "yesterday" })).toBeUndefined();
    expect(parseDashboardTarget({ routine: "nightly", startedAt: "2026-13-45T99:99" })).toBeUndefined();
    expect(parseDashboardTarget({ routine: "nightly", startedAt: 0 })).toBeUndefined();
    expect(parseDashboardTarget({ routine: "" })).toBeUndefined();
    expect(parseDashboardTarget("nightly")).toBeUndefined();
    expect(parseDashboardTarget(null)).toBeUndefined();
  });

  test("openComponent payload pairs by kind: URL for chat, target for dashboard, else dropped", () => {
    expect(openComponentPayload("chat", "https://x.test")).toBe("https://x.test");
    expect(openComponentPayload("chat", { routine: "r" })).toBeUndefined();
    expect(openComponentPayload("dashboard", { routine: "r", startedAt: at })).toEqual({ routine: "r", startedAt: at });
    expect(openComponentPayload("dashboard", "https://x.test")).toBeUndefined();
    expect(openComponentPayload("routines", { routine: "r" })).toBeUndefined();
  });

  test("openComponent chat payload accepts avatar-dropped images, rejects malformed ones", () => {
    const img = { path: "/tmp/a.png", mimeType: "image/png", size: 3, data: "AAAA" };
    // data must be exactly `size` bytes of base64, so a lied-about size can't dodge the 10 MB guard.
    expect(openComponentPayload("chat", [{ ...img, size: 0 }])).toBeUndefined();
    expect(openComponentPayload("chat", [{ ...img, data: "AAAAAAAA" }])).toBeUndefined();
    expect(openComponentPayload("chat", [{ ...img, size: -1, data: undefined }])).toBeUndefined();
    const unread = { path: "/tmp/b.gif", mimeType: "image/gif", size: 3 };
    expect(openComponentPayload("chat", [img, unread])).toEqual([img, unread]);
    expect(openComponentPayload("chat", [])).toBeUndefined();
    expect(openComponentPayload("chat", [{ ...img, size: "3" }])).toBeUndefined();
    expect(openComponentPayload("chat", [{ ...img, data: 1 }])).toBeUndefined();
    expect(openComponentPayload("dashboard", [img])).toBeUndefined();
  });

  test("a notification click opens the run, the Routines panel, or Chat", () => {
    expect(notificationOpens({ open: "dashboard", target: { routine: "r", startedAt: at } })).toEqual({ kind: "dashboard", target: { routine: "r", startedAt: at } });
    expect(notificationOpens({ open: "dashboard", target: { routine: 1 } })).toEqual({ kind: "dashboard" });
    expect(notificationOpens({ open: "routines" })).toEqual({ kind: "routines" });
    expect(notificationOpens(undefined)).toEqual({ kind: "chat" });
  });
});

