import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
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
  expect(quit.length).toBeGreaterThanOrEqual(4); // lease, registries, builder, scheduler
  expect(host.schedulerLease.held()).toBe(false);
});
