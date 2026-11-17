import { describe, expect, it, vi } from "vitest";
import type { Dispatch, TriggerOutcome } from "@bean/core";
import { buildChatThreadHandlers } from "../src/chat.js";
import { createChatSessions } from "../src/chat-sessions.js";

const CLIENT = 1;
const A = "a0000000-0000-4000-8000-000000000001";
const B = "a0000000-0000-4000-8000-000000000002";
const THREAD = "c0000000-0000-4000-8000-000000000001";
const OTHER = "c0000000-0000-4000-8000-000000000002";

// Real chat sessions + thread pins (#921); the sprout trigger, history rows and push are fakes.
function setup() {
  const saved = new Map<string, string>();
  const threads = buildChatThreadHandlers({
    dbFile: "x",
    saveDesktopChat: (_f, c) => { saved.set(c.id, c.itemsJson); return c.title; },
    getDesktopChat: (_f, id) => (saved.has(id) ? { id, title: "t", itemsJson: saved.get(id)!, noteSlug: null } as never : undefined),
    deleteDesktopChat: (_f, id) => { saved.delete(id); },
    starDesktopChat: () => undefined, renameDesktopChat: () => undefined, groupDesktopChats: () => [],
    renameDesktopChatGroup: () => [], listDesktopChats: () => [],
  });
  const incognito = new Set<string>();
  const push = vi.fn();
  const sproutRun = vi.fn(async (_name: string, _origin: { channel?: string; keepBrief?: boolean }) =>
    ({ status: "started" as const, done: new Promise<TriggerOutcome>(() => {}), jobId: "job-1" }));
  const sproutOutcomes = vi.fn((_thread: string) => [{ jobId: "job-1", status: "ok" as const, text: "digest finished ✓" }]);
  const sessions = createChatSessions({
    isChatClient: (c) => c === CLIENT,
    chat: (async () => ({ reply: "ok" })) as never,
    memory: { release: vi.fn(), isIncognito: (k: string) => incognito.has(k), setIncognito: vi.fn() } as never,
    threads,
    delegateTasks: { start: vi.fn(), cancelMount: vi.fn() },
    liveTasks: { start: vi.fn(), send: vi.fn(), stop: vi.fn(), interrupt: vi.fn(), resume: vi.fn(), stopMount: vi.fn() } as never,
    push,
    sproutRun: sproutRun as never,
    sproutOutcomes: sproutOutcomes as never,
  });
  return { sessions, saved, incognito, push, sproutRun, sproutOutcomes };
}

const ended = (over: Partial<Dispatch> = {}): Dispatch => ({
  id: "job-1", surface: "desktop", conversation: THREAD, routine: "digest", runIds: [], status: "ok", brief: "3 items",
  createdAt: "2026-11-16T00:00:00.000Z", ...over,
});

describe("a desktop chat's sprout run (#921)", () => {
  it("answers at admission with the job id; its thread is the origin; off the record keeps no brief", async () => {
    const t = setup();
    t.sessions.attach(CLIENT, A);
    expect(await t.sessions.sproutRun(CLIENT, A, "digest", THREAD)).toEqual({ jobId: "job-1" });
    expect(t.sproutRun).toHaveBeenLastCalledWith("digest", { channel: THREAD, keepBrief: true });
    // Its admission is pushed too: a remote shell whose reply a drop lost finds the job id in it (#922).
    expect(t.push).toHaveBeenCalledWith(A, "sprout", { mountId: A, jobId: "job-1", name: "digest" });
    t.incognito.add(A);
    await t.sessions.sproutRun(CLIENT, A, "digest", THREAD);
    expect(t.sproutRun).toHaveBeenLastCalledWith("digest", { channel: THREAD, keepBrief: false });
    t.sproutRun.mockResolvedValueOnce({ status: "refused", reason: "already running" } as never);
    expect(await t.sessions.sproutRun(CLIENT, A, "digest", THREAD)).toEqual({ reason: "already running" });
  });

  it("refuses a thread another chat holds, and a chat that isn't attached", async () => {
    const t = setup();
    t.sessions.attach(CLIENT, A);
    t.sessions.attach(CLIENT, B);
    await t.sessions.sproutRun(CLIENT, A, "digest", THREAD);
    await expect(t.sessions.sproutRun(CLIENT, B, "digest", THREAD)).rejects.toThrow(/different chat thread/);
    t.sessions.threadSave(CLIENT, B, { id: OTHER, title: "b", items: [] });
    await expect(t.sessions.sproutRun(CLIENT, B, "digest", THREAD)).rejects.toThrow(/different chat thread/);
    await expect(t.sessions.sproutRun(CLIENT, "a0000000-0000-4000-8000-00000000000f", "digest", THREAD)).rejects.toThrow();
    expect(t.sproutRun).toHaveBeenCalledTimes(1);
  });

  it("the result reaches the chat that started it — even unsaved — and only that chat", async () => {
    const t = setup();
    t.sessions.attach(CLIENT, A);
    t.sessions.attach(CLIENT, B); // a new chat opened mid-run
    await t.sessions.sproutRun(CLIENT, A, "digest", THREAD);
    t.push.mockClear(); // the admission
    expect(t.sessions.deliverSprout(ended())).toBe(true);
    expect(t.push).toHaveBeenCalledTimes(1);
    expect(t.push).toHaveBeenCalledWith(A, "sprout", expect.objectContaining({ mountId: A, jobId: "job-1", status: "ok" }));
    // The brief rides fenced, as data.
    expect(t.push.mock.calls[0]![2].text).toContain("<<<\n3 items\n>>>");
  });

  it("with no chat open it stays owed while history has the thread, and goes to the chat that reopens it", async () => {
    const t = setup();
    t.sessions.attach(CLIENT, A);
    t.sessions.threadSave(CLIENT, A, { id: THREAD, title: "a", items: [] });
    await t.sessions.sproutRun(CLIENT, A, "digest", THREAD);
    t.sessions.release(CLIENT, A);
    t.push.mockClear(); // the admission
    expect(t.sessions.deliverSprout(ended())).toBe(false);
    expect(t.push).not.toHaveBeenCalled();
    t.sessions.attach(CLIENT, B);
    const restored = t.sessions.threadGet(CLIENT, B, THREAD);
    expect(restored).toMatchObject({ id: THREAD, sprouts: [{ jobId: "job-1", status: "ok" }] });
    expect(t.sproutOutcomes).toHaveBeenCalledWith(THREAD);
    expect(t.sessions.deliverSprout(ended())).toBe(true);
    expect(t.push).toHaveBeenCalledWith(B, "sprout", expect.objectContaining({ mountId: B }));
  });

  it("a thread no chat holds and history lacks (off the record, deleted) can't take it: dropped", async () => {
    const t = setup();
    t.sessions.attach(CLIENT, A);
    await t.sessions.sproutRun(CLIENT, A, "digest", THREAD);
    t.sessions.release(CLIENT, A);
    t.push.mockClear(); // the admission
    expect(t.sessions.deliverSprout(ended())).toBe(true);
    expect(t.push).not.toHaveBeenCalled();
  });
});
