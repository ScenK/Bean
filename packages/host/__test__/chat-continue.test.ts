import { describe, expect, it, vi } from "vitest";
import { followUpRefusedText, GRANT_IDLE_MS, GRANT_MISMATCH_TEXT, type ChatRequest, type ConverseResult, type ProposedDelegate } from "@bean/core";
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
  const notes: (string | undefined)[] = [];
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
    chat: (async (_req: ChatRequest, _c: number, _k: string, _s: AbortSignal, active?: OfferedSession, note?: string) => {
      offeredTo.push(active);
      notes.push(note);
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
    sessions, starts, offeredTo, notes, busy, held, delegateTasks,
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

const loopback = (settledTask?: string): ChatRequest => ({ history: [], message: "[delegate failed]", source: "loopback", ...(settledTask ? { settledTask } : {}) });

describe("desktop automatic follow-up (#1132)", () => {
  /** A confirmed card's run that settled failed with `why`; Bean's outcome turn then follows it up. */
  const failedCard = async (t: ReturnType<typeof setup>, why = "FAILED: one sub-task") => {
    const opts = await t.confirm();
    opts.onEnd?.({ taskId: "task-1", type: "failed", message: why });
  };

  it("Bean's outcome turn on a settled run follows it up once, strictly, with n/2 on its card, without renewing the idle clock", async () => {
    const t = setup();
    await failedCard(t);
    t.tick(60_000);
    t.answer({ reply: "Finishing it.", proposedDelegate: FOLLOW });
    const res = await t.sessions.chat(CLIENT, A, loopback("task-1"));
    expect(t.offeredTo.at(-1)).toEqual({ cli: "claude", projectPath: "/p", lastInstruction: "fix the bug" });
    expect(t.notes.at(-1)).toMatch(/follow-up 1 of 2/);
    expect(res.continuedDelegate?.proposal).toMatchObject({ followUp: 1, cli: "claude" });
    expect(t.starts.at(-1)!.opts).toMatchObject({ resume: SESSION, continued: { followUp: 1 } });
    // Its settle doesn't renew the grant: 30 minutes from the card's run, it has lapsed.
    t.starts.at(-1)!.opts.onEnd?.({ taskId: "task-2", type: "failed", message: "FAILED: lint" });
    t.tick(GRANT_IDLE_MS - 60_000);
    await t.sessions.chat(CLIENT, A, loopback("task-2"));
    expect(t.offeredTo.at(-1)).toBeUndefined();
    expect(t.notes.at(-1)).toMatch(/No automatic follow-up/);
  });

  it("a forged or reused settled task id, or a cancelled run, gets no session", async () => {
    const t = setup();
    await failedCard(t);
    t.answer({ reply: "", proposedDelegate: FOLLOW });
    await t.sessions.chat(CLIENT, A, loopback()); // no id
    await t.sessions.chat(CLIENT, A, loopback("task-9")); // never settled here
    expect(t.offeredTo).toEqual([undefined, undefined]);
    t.answer({ reply: "" });
    await t.sessions.chat(CLIENT, A, loopback("task-1"));
    expect(t.offeredTo.at(-1)).toBeDefined();
    t.answer({ reply: "", proposedDelegate: FOLLOW });
    const res = await t.sessions.chat(CLIENT, A, loopback("task-1")); // reused
    expect(t.offeredTo.at(-1)).toBeUndefined();
    expect(res.continuedDelegate).toBeUndefined();
    const opts = await t.confirm();
    opts.onEnd?.({ taskId: "task-3", type: "cancelled" });
    await t.sessions.chat(CLIENT, A, loopback("task-3"));
    expect(t.offeredTo.at(-1)).toBeUndefined();
    expect(t.starts).toHaveLength(2); // the two confirmed cards only
  });

  it("a third attempt is refused, and Bean is told to ask the user", async () => {
    const t = setup();
    await failedCard(t, "FAILED: a");
    t.answer({ reply: "", proposedDelegate: FOLLOW });
    await t.sessions.chat(CLIENT, A, loopback("task-1"));
    t.starts.at(-1)!.opts.onEnd?.({ taskId: "task-2", type: "failed", message: "FAILED: b" });
    const second = await t.sessions.chat(CLIENT, A, loopback("task-2"));
    expect(second.continuedDelegate?.proposal.followUp).toBe(2);
    t.starts.at(-1)!.opts.onEnd?.({ taskId: "task-3", type: "done", result: "partly" });
    const third = await t.sessions.chat(CLIENT, A, loopback("task-3"));
    expect(t.offeredTo.at(-1)).toBeUndefined();
    expect(t.notes.at(-1)).toMatch(/already followed up twice/);
    expect(third.continuedDelegate).toBeUndefined();
    expect(t.starts).toHaveLength(3);
  });

  it("the same failure twice stops the chain with a question", async () => {
    const t = setup();
    await failedCard(t, "FAILED: no access to the ledger");
    t.answer({ reply: "", proposedDelegate: FOLLOW });
    await t.sessions.chat(CLIENT, A, loopback("task-1"));
    t.starts.at(-1)!.opts.onEnd?.({ taskId: "task-2", type: "failed", message: "FAILED: no access to the ledger" });
    await t.sessions.chat(CLIENT, A, loopback("task-2"));
    expect(t.offeredTo.at(-1)).toBeUndefined();
    expect(t.notes.at(-1)).toMatch(/same failure again/);
    expect(t.starts).toHaveLength(2);
  });

  it("a typed turn before or during the follow-up ends the chain", async () => {
    const t = setup();
    await failedCard(t);
    t.answer({ reply: "" });
    await t.sessions.chat(CLIENT, A, typed("wait")); // before Bean's outcome turn
    t.answer({ reply: "", proposedDelegate: FOLLOW });
    await t.sessions.chat(CLIENT, A, loopback("task-1"));
    expect(t.offeredTo.at(-1)).toBeUndefined();

    // During: a follow-up running when the user types can't be followed up again.
    const t2 = setup();
    await failedCard(t2);
    t2.answer({ reply: "", proposedDelegate: FOLLOW });
    await t2.sessions.chat(CLIENT, A, loopback("task-1"));
    t2.answer({ reply: "" });
    await t2.sessions.chat(CLIENT, A, typed("how's it going?"));
    t2.starts.at(-1)!.opts.onEnd?.({ taskId: "task-2", type: "failed", message: "FAILED: b" });
    t2.answer({ reply: "", proposedDelegate: FOLLOW });
    await t2.sessions.chat(CLIENT, A, loopback("task-2"));
    expect(t2.offeredTo.at(-1)).toBeUndefined();
    expect(t2.starts).toHaveLength(2);
  });

  it("a refused follow-up is a needs-you line, never a card; another skill is a normal card", async () => {
    const t = setup();
    await failedCard(t);
    const release = t.hold();
    t.answer({ reply: "", proposedDelegate: FOLLOW });
    const pending = t.sessions.chat(CLIENT, A, loopback("task-1"));
    t.sessions.revokeGrant(CLIENT, A); // Dismiss while Bean answers the outcome
    release();
    const res = await pending;
    expect(res.proposedDelegate).toBeUndefined();
    expect(res.delegateNotice).toBe(followUpRefusedText("revoked"));

    const t2 = setup();
    await failedCard(t2);
    t2.answer({ reply: "", proposedDelegate: { ...FOLLOW, skillName: "other" } });
    const card = await t2.sessions.chat(CLIENT, A, loopback("task-1"));
    expect(card.proposedDelegate).toMatchObject({ skillName: "other" });
    expect(card.proposedDelegate?.continue).toBeUndefined();
    expect(card.delegateNotice).toBe(GRANT_MISMATCH_TEXT.skill);
    expect(t2.starts).toHaveLength(1);
  });
});
