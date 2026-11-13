import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { DISCONNECT_GRACE_MS, HEARTBEAT_TIMEOUT_MS } from "../src/attachments.js";
import { createHost } from "../src/host.js";

// main.ts isn't unit-testable; this boots the real host on a fresh data dir (no Electron) and checks
// the seams the shell relies on: chats refuse non-chat clients, pushes route by mount, quit hooks stop it.
test("createHost boots on an empty data dir and its quit hooks tear it down", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bean-host-"));
  const quit: (() => void)[] = [];
  const push = vi.fn();
  const host = await createHost({
    dir, builtinDir: dir, push, onJobs: vi.fn(),
    notification: { name: "notification", available: () => false, send: vi.fn() },
    isChatClient: (id) => id === 1, onQuit: (fn) => quit.push(fn), firstAutoMemory: async () => false,
    bots: { root: dir, onEvent: vi.fn(), onSynced: vi.fn() },
  });
  try {
    expect(host.handlers.getConfig().paths.config).toBe(join(dir, "config.json"));
    const chats = host.handlers.chat;
    const A = "a0000000-0000-4000-8000-000000000001";
    chats.attach(2, A); // not the chat window
    expect(() => chats.key(2, A)).toThrow(/chat window/);
    chats.attach(1, A);
    expect(chats.key(1, A)).toBe(A);
    expect(chats.clientOf(A)).toBe(1);
    expect(await chats.liveStart(2, A, {})).toEqual({ error: expect.stringMatching(/chat window/) });
    chats.releaseClient(1);
    expect(() => chats.key(1, A)).toThrow(/unknown chat session/);
    expect(chats.clientOf(A)).toBe(1); // a late push still reaches the window that held it
  } finally {
    for (const fn of quit) fn();
  }
  expect(quit.length).toBeGreaterThanOrEqual(5); // lease, registries, builder, scheduler, bots
  expect(host.schedulerLease.held()).toBe(false);
});

// bean-core (#806): no shell, so a sprout missed while it was down is announced and rebased to its
// next slot (no Run-now button would ever clear the flag), and the lease names bean-core.
test("a headless host rebases missed sprouts with a notice", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bean-host-"));
  mkdirSync(join(dir, "routines"));
  writeFileSync(join(dir, "routines", "daily.json"), JSON.stringify({
    name: "daily", enabled: true, cron: "0 9 * * *", steps: [{ kind: "command", command: "true" }], sinks: {},
  }));
  const lastRun = "2020-01-01T00:00:00.000Z";
  writeFileSync(join(dir, "routines", ".state.json"), JSON.stringify({ daily: { lastRun, history: [] } }));
  const quit: (() => void)[] = [];
  const send = vi.fn();
  const host = await createHost({
    dir, builtinDir: dir, push: vi.fn(), onJobs: vi.fn(),
    notification: { name: "owner", available: () => true, send },
    isChatClient: () => false, onQuit: (fn) => quit.push(fn), firstAutoMemory: async () => false,
    bots: { root: dir, onEvent: vi.fn(), onSynced: vi.fn() },
    headless: { onLeaseLost: vi.fn() },
  });
  try {
    expect(host.schedulerLease.held()).toBe(true);
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith({ body: expect.stringContaining('"daily"') }));
    await vi.waitFor(() => {
      const state = JSON.parse(readFileSync(join(dir, "routines", ".state.json"), "utf8")) as Record<string, { lastRun?: string; missed?: boolean }>;
      expect(state.daily?.missed).toBeUndefined();
      expect(state.daily?.lastRun).not.toBe(lastRun);
    });
  } finally {
    for (const fn of quit) fn();
  }
});

// #808: a lost remote shell's grace expiring stops only that shell's chats — the scheduler lease
// (routines, reminders) and the local window's chats are untouched.
test("a remote shell's grace expiry leaves the scheduler and local chats alone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bean-host-"));
  const quit: (() => void)[] = [];
  const host = await createHost({
    dir, builtinDir: dir, push: vi.fn(), onJobs: vi.fn(),
    notification: { name: "notification", available: () => false, send: vi.fn() },
    isChatClient: (id) => id === 1, onQuit: (fn) => quit.push(fn), firstAutoMemory: async () => false,
    bots: { root: dir, onEvent: vi.fn(), onSynced: vi.fn() },
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const chats = host.handlers.chat;
    const L = "a0000000-0000-4000-8000-000000000001";
    const R = "a0000000-0000-4000-8000-000000000002";
    chats.attach(1, L);
    const { generation, clientId } = host.attachments.attach("5a000000-0000-4000-8000-00000000000a", vi.fn());
    host.attachments.resume(generation, {});
    chats.attach(clientId, R); // an attached shell may hold chats
    expect(chats.key(clientId, R)).toBe(R);
    vi.advanceTimersByTime(HEARTBEAT_TIMEOUT_MS + DISCONNECT_GRACE_MS);
    expect(() => chats.key(clientId, R)).toThrow(/unknown chat session/);
    expect(chats.key(1, L)).toBe(L);
    expect(host.schedulerLease.held()).toBe(true);
  } finally {
    vi.useRealTimers();
    for (const fn of quit) fn();
  }
});

// #837: while a core update's latch is closed, nothing new starts.
test("a closed update latch refuses new chat turns, delegates, live sessions and sprout runs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bean-host-"));
  const quit: (() => void)[] = [];
  const host = await createHost({
    dir, builtinDir: dir, push: vi.fn(), onJobs: vi.fn(),
    notification: { name: "notification", available: () => false, send: vi.fn() },
    isChatClient: (id) => id === 1, onQuit: (fn) => quit.push(fn), firstAutoMemory: async () => false,
    bots: { root: dir, onEvent: vi.fn(), onSynced: vi.fn() },
  });
  try {
    const chats = host.handlers.chat;
    const L = "a0000000-0000-4000-8000-000000000001";
    chats.attach(1, L);
    expect(host.coreUpdate.busy()).toEqual([]);
    // Admitted just before the latch closed, still in their async checks: busy, not idle.
    const run = host.handlers.routines.runNow("demo");
    const delegate = chats.delegateStart(1, L, { projectPath: "/not/configured", prompt: "p", instruction: "i" });
    host.coreUpdate.close();
    expect(host.coreUpdate.busy()).toEqual([{ kind: "request", name: "2 start request(s) in progress" }]);
    await Promise.all([run, delegate]);
    expect(host.coreUpdate.busy()).toEqual([]);
    const msg = /Bean is updating/;
    await expect(chats.chat(1, L, { history: [], message: "hi" })).rejects.toThrow(msg);
    await expect(chats.delegateStart(1, L, { projectPath: dir, prompt: "p", instruction: "i" })).rejects.toThrow(msg);
    expect(chats.liveStart(1, L, {})).toEqual({ error: expect.stringMatching(msg) });
    expect(chats.liveResume(1, L, "s")).toEqual({ error: expect.stringMatching(msg) });
    expect(await host.handlers.routines.runNow("any")).toMatchObject({ started: false, reason: expect.stringMatching(msg) });
    host.coreUpdate.open();
    expect(chats.liveStart(1, L, {})).not.toEqual({ error: expect.stringMatching(msg) }); // its own validation answers now
  } finally {
    for (const fn of quit) fn();
  }
});
