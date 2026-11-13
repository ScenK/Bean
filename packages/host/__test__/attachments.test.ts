import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatRequest, ConverseResult } from "@bean/core";
import {
  createAttachments, shellClientId, DISCONNECT_GRACE_MS, HEARTBEAT_TIMEOUT_MS, REPLAY_LIMIT, StaleAttachmentError,
  type AttachmentMessage,
} from "../src/attachments.js";
import { createChatSessions } from "../src/chat-sessions.js";

const SHELL_A = "5a000000-0000-4000-8000-00000000000a";
const SHELL_B = "5b000000-0000-4000-8000-00000000000b";
const LOCAL = 1; // the in-process chat window (a webContents id)
const L = "a0000000-0000-4000-8000-000000000001";
const R = "a0000000-0000-4000-8000-000000000002";
const R2 = "a0000000-0000-4000-8000-000000000003";

// Real chat sessions + attachments, as createHost wires them; the registries behind them are spies.
function setup() {
  let chatImpl = async (_req: ChatRequest, _c: number, _k: string, _signal: AbortSignal): Promise<ConverseResult> => ({ reply: "ok" });
  const memory = {
    release: vi.fn(), captureTurn: vi.fn(async () => []), isIncognito: vi.fn(() => false), setIncognito: vi.fn(),
    rememberOnClose: vi.fn(async () => []),
  };
  const delegateTasks = { start: vi.fn(async () => "t"), cancelMount: vi.fn() };
  const liveTasks = { start: vi.fn(), send: vi.fn(), stop: vi.fn(), interrupt: vi.fn(), resume: vi.fn(), stopMount: vi.fn() };
  const local = vi.fn();
  const attachments = createAttachments({
    holder: (id) => sessions.holder(id), ofClient: (c) => sessions.ofClient(c), abortTurn: (id) => sessions.abortTurn(id),
    expire: (c) => sessions.expireClient(c), release: (c) => sessions.releaseClient(c),
  });
  const push = attachments.push(local);
  const sessions = createChatSessions({
    isChatClient: (c) => c === LOCAL || attachments.isClient(c),
    chat: ((req: ChatRequest, c: number, k: string, signal: AbortSignal) => chatImpl(req, c, k, signal)) as never,
    memory: memory as never,
    threads: { release: vi.fn(), setIncognito: vi.fn() } as never,
    delegateTasks, liveTasks: liveTasks as never, push,
  });
  const inbox = (): { msgs: AttachmentMessage[]; send: (m: AttachmentMessage) => void } => {
    const msgs: AttachmentMessage[] = [];
    return { msgs, send: (m) => msgs.push(m) };
  };
  return { sessions, attachments, push, local, memory, delegateTasks, liveTasks, inbox, setChat: (fn: typeof chatImpl) => { chatImpl = fn; } };
}

const seqs = (msgs: AttachmentMessage[]): number[] => msgs.flatMap((m) => (m.type === "push" ? [m.seq] : []));

describe("attachments", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("a reconnect inside the grace replays the missed events once, and the work keeps running", async () => {
    const t = setup();
    const a1 = t.inbox();
    const { generation: g1, clientId } = t.attachments.attach(SHELL_A, a1.send);
    t.attachments.resume(g1, {});
    t.sessions.attach(clientId, R);
    t.push(R, "delegate", { taskId: "t1", type: "output", line: "one" });
    expect(seqs(a1.msgs)).toEqual([1]);
    t.attachments.heartbeat(g1, { [R]: 1 });

    // Bean's own turn in flight is aborted on disconnect.
    let aborted = false;
    t.setChat((_r, _c, _k, signal) => new Promise((resolve) => signal.addEventListener("abort", () => { aborted = true; resolve({ reply: "", stopped: true }); })));
    const turn = t.sessions.chat(clientId, R, { history: [], message: "hi", source: "typed", turnId: "x" });

    vi.advanceTimersByTime(HEARTBEAT_TIMEOUT_MS); // no heartbeat → disconnected
    await turn;
    expect(aborted).toBe(true);
    expect(() => t.attachments.heartbeat(g1)).toThrow(StaleAttachmentError);
    t.push(R, "delegate", { taskId: "t1", type: "output", line: "two" });
    t.push(R, "delegate", { taskId: "t1", type: "done", result: "fixed" });
    expect(seqs(a1.msgs)).toEqual([1]); // nothing reaches a lost shell

    vi.advanceTimersByTime(DISCONNECT_GRACE_MS - HEARTBEAT_TIMEOUT_MS);
    expect(t.delegateTasks.cancelMount).not.toHaveBeenCalled();

    const a2 = t.inbox();
    const again = t.attachments.attach(SHELL_A, a2.send);
    expect(again.clientId).toBe(clientId); // same install, same chats
    expect(t.sessions.key(clientId, R)).toBe(R);
    t.attachments.resume(again.generation, { [R]: 1 });
    t.push(R, "delegate", { taskId: "t2", type: "started", projectPath: "/p", instruction: "go" });
    expect(seqs(a2.msgs)).toEqual([2, 3, 4]); // replayed 2–3 once, then 4 live

    vi.advanceTimersByTime(DISCONNECT_GRACE_MS); // the grace was cleared at reconnect (a new one starts after this drop)
    expect(t.delegateTasks.cancelMount).not.toHaveBeenCalled();
  });

  it("expiry cancels only that client's work and runs its close catch-up", async () => {
    const t = setup();
    t.sessions.attach(LOCAL, L);
    const { generation, clientId } = t.attachments.attach(SHELL_A, t.inbox().send);
    t.attachments.resume(generation, {});
    t.sessions.attach(clientId, R);
    await t.sessions.chat(clientId, R, { history: [], message: "I live in Camas", source: "typed", turnId: "u1" });

    vi.advanceTimersByTime(HEARTBEAT_TIMEOUT_MS + DISCONNECT_GRACE_MS);
    expect(t.delegateTasks.cancelMount.mock.calls).toEqual([[R]]);
    expect(t.liveTasks.stopMount.mock.calls).toEqual([[R]]);
    expect(t.memory.rememberOnClose).toHaveBeenCalledWith(
      [{ role: "user", content: "I live in Camas", source: "typed", id: "u1" }, { role: "assistant", content: "ok" }],
      { incognito: false, rejected: [], key: R },
    );
    expect(() => t.sessions.key(clientId, R)).toThrow(/unknown chat session/);
    expect(t.sessions.key(LOCAL, L)).toBe(L); // the local window's chat is untouched
  });

  it("a second attach revokes the first before it is acknowledged; the displaced shell's late request is rejected", async () => {
    const t = setup();
    const log: string[] = [];
    const { generation: gA, clientId: cA } = t.attachments.attach(SHELL_A, (m) => log.push(`A:${m.type}`));
    t.attachments.resume(gA, {});
    t.sessions.attach(cA, R);
    let finish = (): void => {};
    const late = t.attachments.run(gA, () => new Promise<string>((resolve) => { finish = () => resolve("late"); }));

    const b = t.attachments.attach(SHELL_B, (m) => log.push(`B:${m.type}`));
    log.push("B:acked");
    expect(log).toEqual(["A:revoked", "B:acked"]);
    expect(b.clientId).not.toBe(cA); // A's chats are not adopted
    expect(() => t.sessions.key(b.clientId, R)).toThrow();

    finish();
    await expect(late).rejects.toBeInstanceOf(StaleAttachmentError); // rejected after its async work
    await expect(t.attachments.run(gA, () => "x")).rejects.toBeInstanceOf(StaleAttachmentError);
    t.attachments.check(b.generation);

    // A's chats keep their own grace; B keeps beating.
    for (let i = 0; i < DISCONNECT_GRACE_MS / 10_000; i++) {
      vi.advanceTimersByTime(10_000);
      t.attachments.heartbeat(b.generation);
    }
    expect(t.delegateTasks.cancelMount.mock.calls).toEqual([[R]]);
  });

  it("an explicit detach releases at once, with no grace", () => {
    const t = setup();
    const { generation, clientId } = t.attachments.attach(SHELL_A, t.inbox().send);
    t.sessions.attach(clientId, R);
    t.attachments.detach(generation);
    expect(t.delegateTasks.cancelMount.mock.calls).toEqual([[R]]);
    expect(t.memory.rememberOnClose).not.toHaveBeenCalled(); // the shell sends its own catch-up before detaching
    vi.advanceTimersByTime(HEARTBEAT_TIMEOUT_MS + DISCONNECT_GRACE_MS);
    expect(t.delegateTasks.cancelMount).toHaveBeenCalledTimes(1);
    expect(() => t.attachments.heartbeat(generation)).toThrow(StaleAttachmentError);
  });

  it("bounds the replay buffer by output lines only: results and a live turn's answer survive until acked", () => {
    const t = setup();
    const { generation, clientId } = t.attachments.attach(SHELL_A, t.inbox().send);
    t.attachments.resume(generation, {});
    t.sessions.attach(clientId, R);
    t.sessions.attach(clientId, R2);
    vi.advanceTimersByTime(HEARTBEAT_TIMEOUT_MS);
    t.push(R, "delegate", { taskId: "t1", type: "done", result: "first" });
    t.push(R, "live", { sessionId: "s", type: "turn", result: "the answer" });
    for (let i = 0; i < REPLAY_LIMIT + 50; i++) t.push(R, "delegate", { taskId: "t2", type: "output", line: `${i}` });
    t.push(R, "live", { sessionId: "s", type: "ended", reason: "ended" });
    t.push(R2, "memory", { saved: [] });

    const back = t.inbox();
    const g2 = t.attachments.attach(SHELL_A, back.send).generation;
    t.attachments.resume(g2, { [R2]: 1 });
    const r = back.msgs.filter((m) => m.type === "push" && m.mountId === R);
    expect(r).toHaveLength(REPLAY_LIMIT);
    expect(r[0]).toMatchObject({ seq: 1, payload: { type: "done" } });
    expect(r[1]).toMatchObject({ seq: 2, kind: "live", payload: { type: "turn", result: "the answer" } });
    expect(r.at(-1)).toMatchObject({ kind: "live", payload: { type: "ended" } });
    expect(back.msgs.some((m) => m.type === "push" && m.mountId === R2)).toBe(false); // acked
    const n = back.msgs.length;
    t.attachments.resume(g2, {}); // a repeat on the same connection replays nothing
    expect(back.msgs).toHaveLength(n);
  });

  it("local windows' pushes pass through unnumbered", () => {
    const t = setup();
    t.sessions.attach(LOCAL, L);
    t.push(L, "memory", { saved: [] });
    expect(t.local).toHaveBeenCalledWith(L, "memory", { saved: [] });
    t.sessions.releaseClient(LOCAL); // window close still releases at once
    expect(t.delegateTasks.cancelMount).toHaveBeenCalledWith(L);
  });

  it("refuses a malformed shell id", () => {
    expect(() => setup().attachments.attach("nope", () => {})).toThrow(/shell id/);
  });
});

describe("shellClientId", () => {
  it("is created once (0600) and then read back", () => {
    const file = join(mkdtempSync(join(tmpdir(), "bean-shell-")), "shell-id");
    const id = shellClientId(file);
    expect(shellClientId(file)).toBe(id);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    writeFileSync(file, "garbage");
    const fresh = shellClientId(file);
    expect(fresh).not.toBe(id);
    expect(readFileSync(file, "utf8").trim()).toBe(fresh);
  });
});
