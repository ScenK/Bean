import { describe, expect, it, vi } from "vitest";
import { GRANT_IDLE_MS, GRANT_MISMATCH_TEXT, type ChatRequest, type ConverseResult, type ProposedDelegate } from "@bean/core";
import { buildChatThreadHandlers, type OfferedSession } from "../src/chat.js";
import { createChatSessions } from "../src/chat-sessions.js";
import type { DelegateStartOpts, DelegateStartRequest } from "../src/delegate-tasks.js";

const CLIENT = 1;
const A = "a0000000-0000-4000-8000-000000000001";
const B = "a0000000-0000-4000-8000-000000000002";
const SESSION = "3f2a9c1e-0000-4000-8000-000000000001";
const CARD = { projectPath: "/p", prompt: "fix the bug", instruction: "fix the bug", cli: "claude" as const };
const FOLLOW: ProposedDelegate = { projectPath: "/p", instruction: "now add a test", composedPrompt: "now add a test", continue: true };
const typed = (message = "and add a test"): ChatRequest => ({ history: [], message, source: "typed" });

// Real chat sessions (#1113); the model turn, delegate and live registries are fakes.
function setup() {
  let clock = 1_000_000;
  let reply: ConverseResult = { reply: "ok" };
  let gate: Promise<void> | undefined;
  const offeredTo: (OfferedSession | undefined)[] = [];
  const starts: { req: DelegateStartRequest; opts: DelegateStartOpts }[] = [];
  const busy = new Set<string>();
  const held = new Set<string>();
  let nextTask = 0;
  const delegateTasks = {
    start: vi.fn(async (req: DelegateStartRequest, opts: DelegateStartOpts = {}) => { starts.push({ req, opts }); return `task-${++nextTask}`; }),
    cancelMount: vi.fn(),
    busy: (id: string) => busy.has(id),
  };
  const threads = buildChatThreadHandlers({
    dbFile: "x", saveDesktopChat: () => "t", getDesktopChat: () => undefined, deleteDesktopChat: () => {},
    starDesktopChat: () => undefined, renameDesktopChat: () => undefined, groupDesktopChats: () => [],
    renameDesktopChatGroup: () => [], listDesktopChats: () => [],
  });
  const sessions = createChatSessions({
    isChatClient: (c) => c === CLIENT,
    chat: (async (_req: ChatRequest, _c: number, _k: string, _s: AbortSignal, active?: OfferedSession) => {
      offeredTo.push(active);
      await gate;
      return structuredClone(reply);
    }) as never,
    memory: { release: vi.fn(), isIncognito: () => false, setIncognito: vi.fn(), noteTurn: () => false } as never,
    threads,
    delegateTasks,
    liveTasks: { stopMount: vi.fn(), holds: (id: string) => held.has(id), resume: vi.fn(() => ({ sessionId: "live-1" })) } as never,
    push: vi.fn(),
    now: () => clock,
  });
  sessions.attach(CLIENT, A);
  /** A confirmed card in chat A whose run reported SESSION and settled. */
  const confirm = async (mount = A, req: DelegateStartRequest = CARD): Promise<DelegateStartOpts> => {
    await sessions.delegateStart(CLIENT, mount, req);
    const { opts } = starts.at(-1)!;
    opts.onSession?.({ sessionId: SESSION, cli: "claude", browser: false, projectPath: "/p" });
    return opts;
  };
  return {
    sessions, starts, offeredTo, busy, held, delegateTasks,
    answer: (r: ConverseResult) => { reply = r; },
    /** Holds the next model turns until the returned release. */
    hold: (): (() => void) => { let open!: () => void; gate = new Promise((r) => { open = r; }); return () => { gate = undefined; open(); }; },
    tick: (ms: number) => { clock += ms; },
    confirm,
  };
}

describe("desktop cardless continuation (#1113)", () => {
  it("a follow-up after a confirmed card resumes its session strictly, with no card", async () => {
    const t = setup();
    expect(await t.sessions.chat(CLIENT, A, typed("hi"))).toEqual({ reply: "ok" });
    expect(t.offeredTo.at(-1)).toBeUndefined(); // no grant yet: no `continue` offered
    const first = await t.confirm();
    expect(first.onEnd?.({ taskId: "task-1", type: "done", result: "fixed" })).toBe(true); // its card says so
    t.answer({ reply: "On it.", proposedDelegate: FOLLOW });
    const res = await t.sessions.chat(CLIENT, A, typed());
    expect(t.offeredTo.at(-1)).toEqual({ cli: "claude", projectPath: "/p", lastInstruction: "fix the bug" });
    expect(res.proposedDelegate).toBeUndefined();
    expect(res.continuedDelegate).toEqual({
      taskId: "task-2",
      proposal: { projectPath: "/p", instruction: "now add a test", composedPrompt: "now add a test", cli: "claude" },
    });
    const { req, opts } = t.starts.at(-1)!;
    expect(req).toMatchObject({ projectPath: "/p", prompt: "now add a test", cli: "claude", mountId: A });
    expect(opts).toMatchObject({ resume: SESSION, browserAllowed: false, continued: res.continuedDelegate!.proposal });
    // The next turn offers the continued instruction as the session's last one.
    t.answer({ reply: "ok" });
    await t.sessions.chat(CLIENT, A, typed());
    expect(t.offeredTo.at(-1)?.lastInstruction).toBe("now add a test");
  });

  it("any mismatch is a normal card with its reason: another project, a busy session, a live session", async () => {
    const t = setup();
    await t.confirm();
    t.answer({ reply: "", proposedDelegate: { ...FOLLOW, projectPath: "/other" } });
    let res = await t.sessions.chat(CLIENT, A, typed());
    expect(res.proposedDelegate).toEqual({ projectPath: "/other", instruction: "now add a test", composedPrompt: "now add a test" });
    expect(res.delegateNotice).toBe(GRANT_MISMATCH_TEXT.project);
    t.answer({ reply: "", proposedDelegate: FOLLOW });
    t.busy.add(SESSION);
    res = await t.sessions.chat(CLIENT, A, typed());
    expect(res.delegateNotice).toBe(GRANT_MISMATCH_TEXT.busy);
    t.busy.clear();
    t.held.add(SESSION);
    res = await t.sessions.chat(CLIENT, A, typed());
    expect(res.delegateNotice).toBe(GRANT_MISMATCH_TEXT.busy);
    expect(t.starts).toHaveLength(1); // only the confirmed card ever ran
  });

  it("Continue live is refused while a delegate holds that session (two writers never share one)", () => {
    const t = setup();
    t.busy.add(SESSION);
    expect(t.sessions.liveResume(CLIENT, A, SESSION)).toEqual({ error: expect.stringMatching(/still working in that session/) });
    t.busy.clear();
    expect(t.sessions.liveResume(CLIENT, A, SESSION)).toEqual({ sessionId: "live-1" });
  });

  it("30 idle minutes, a revoke (Dismiss / End) or a refused resume end the grant", async () => {
    const t = setup();
    const first = await t.confirm();
    first.onEnd?.({ taskId: "task-1", type: "done", result: "" });
    t.tick(GRANT_IDLE_MS);
    t.answer({ reply: "", proposedDelegate: FOLLOW });
    await t.sessions.chat(CLIENT, A, typed());
    expect(t.offeredTo.at(-1)).toBeUndefined();

    await t.confirm();
    t.sessions.revokeGrant(CLIENT, A);
    await t.sessions.chat(CLIENT, A, typed());
    expect(t.offeredTo.at(-1)).toBeUndefined();

    await t.confirm();
    await t.sessions.chat(CLIENT, A, typed());
    const cont = t.starts.at(-1)!.opts;
    expect(cont.resume).toBe(SESSION);
    expect(cont.onEnd?.({ taskId: "task-4", type: "failed", message: "Couldn't resume", resumeRefused: true })).toBe(false);
    const res = await t.sessions.chat(CLIENT, A, typed());
    expect(t.offeredTo.at(-1)).toBeUndefined();
    expect(res.proposedDelegate?.continue).toBeUndefined(); // never offered → never honored
  });

  it("a loopback turn is never offered the session, and its `continue` is never honored", async () => {
    const t = setup();
    await t.confirm();
    t.answer({ reply: "", proposedDelegate: FOLLOW });
    const res = await t.sessions.chat(CLIENT, A, { history: [], message: "[delegate result]", source: "loopback" });
    expect(t.offeredTo.at(-1)).toBeUndefined();
    expect(res.proposedDelegate?.continue).toBeUndefined();
    expect(res.continuedDelegate).toBeUndefined();
  });

  it("a newer confirmed card during the turn makes the offered grant stale", async () => {
    const t = setup();
    await t.confirm();
    t.answer({ reply: "", proposedDelegate: FOLLOW });
    const open = t.hold();
    const turn = t.sessions.chat(CLIENT, A, typed());
    await t.confirm(); // replaces the grant (generation 2) before the turn's reply is handled
    open();
    const res = await turn;
    expect(res.delegateNotice).toBe(GRANT_MISMATCH_TEXT.stale);
  });

  it("grants are per chat and dropped on release; a release during the start stops the run", async () => {
    const t = setup();
    t.sessions.attach(CLIENT, B);
    await t.confirm(A);
    await t.sessions.chat(CLIENT, B, typed());
    expect(t.offeredTo.at(-1)).toBeUndefined(); // chat B never confirmed a card

    t.answer({ reply: "", proposedDelegate: FOLLOW });
    t.delegateTasks.start.mockImplementationOnce(async (req, opts = {}) => {
      t.starts.push({ req, opts });
      t.sessions.release(CLIENT, A);
      return "task-late";
    });
    const res = await t.sessions.chat(CLIENT, A, typed());
    expect(res.continuedDelegate?.taskId).toBe("task-late");
    expect(t.delegateTasks.cancelMount).toHaveBeenCalledWith(A);
  });
});
