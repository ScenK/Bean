import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  TURN_QUEUE_FULL, findDelegateRun, recordDelegateSession,
  type CliName, type LiveSessionCallbacks, type LiveSessionRequest, type ResumableRun,
} from "@bean/core";
import {
  ASK_LIMIT, LABEL_LIMIT, HANDOFF_CHARS, HANDOFF_ITEMS, LIVE_CAP_REACHED, LIVE_SESSION_CAP, buildHandoff, createLiveTasks, liveSpawnFn,
  type HandoffItem, type LiveEvent,
} from "../src/live-tasks.js";
import type { TaskJob } from "../src/task-status.js";

const A = { clientId: 1, mountId: "m1" };
const B = { clientId: 2, mountId: "m2" };
const tmp = (): string => mkdtempSync(join(tmpdir(), "bean-live-tasks-"));
const record = (dir: string, id: string): { pid: number } | undefined => {
  const f = join(dir, "runs", `${id}.json`);
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) as { pid: number } : undefined;
};

function harness(opts: {
  clis?: CliName[]; allowed?: (p: string) => Promise<boolean>; pid?: number; sendOk?: boolean;
  findResumable?: (id: string) => ResumableRun;
  modelOffered?: (cli: string, model: string) => boolean;
  /** The child's pid once the first send spawns it (a lazy resume). */
  sendPid?: number;
  /** What the engine's interrupt() answers (false = no turn running). */
  interruptOk?: boolean;
} = {}) {
  const dir = tmp();
  const events: Array<{ e: LiveEvent }> = [];
  const reqs: LiveSessionRequest[] = [];
  const cbs: LiveSessionCallbacks[] = [];
  const sent: string[] = [];
  let stops = 0;
  let interrupts = 0;
  let n = 0;
  const live = createLiveTasks({
    dir,
    enabledClis: () => opts.clis ?? ["claude", "codex", "opencode"],
    cliModels: () => [
      { provider: "claude", models: ["opus", "--danger"] },
      { provider: "codex", models: ["gpt-5.5"] },
      { provider: "opencode", models: ["anthropic/claude-sonnet-4-5"] },
    ],
    projectAllowed: opts.allowed ?? (async (p) => p === "/proj" || p === "/scratch"),
    scratchPath: "/scratch",
    ...(opts.findResumable ? { findResumable: opts.findResumable } : {}),
    ...(opts.modelOffered ? { modelOffered: opts.modelOffered } : {}),
    send: (e) => { events.push({ e }); },
    newId: () => `s${++n}`,
    engine: (req, c) => {
      reqs.push(req);
      cbs.push(c);
      let pid = opts.pid;
      return {
        get pid() { return pid; },
        send: (t) => { sent.push(t); pid ??= opts.sendPid; return opts.sendOk ?? true; },
        interrupt: () => { interrupts++; return opts.interruptOk ?? true; },
        stop: () => { stops++; },
      };
    },
  });
  return { live, dir, events, reqs, cbs, sent, stops: () => stops, interrupts: () => interrupts, types: () => events.map(({ e }) => e.type) };
}

describe("createLiveTasks", () => {
  it("passes an allowlisted model to the engine for each CLI; none when omitted", async () => {
    const h = harness();
    const picks = [["claude", "opus"], ["codex", "gpt-5.5"], ["opencode", "anthropic/claude-sonnet-4-5"]] as const;
    for (const [i, [agent, model]] of picks.entries()) {
      expect(await h.live.start({ clientId: 1, mountId: `m${i}` }, { agent, projectPath: "/proj", ask: "go", model })).toMatchObject({ sessionId: `s${i + 1}` });
    }
    await h.live.start(B, { agent: "claude", projectPath: "/proj", ask: "go" });
    expect(h.reqs.map((r) => [r.cli, r.model])).toEqual([...picks, ["claude", undefined]]);
    expect(h.reqs.at(-1)).not.toHaveProperty("model");
  });

  it("rejects a non-string, unknown, dash-led or other-CLI model without spawning", async () => {
    const h = harness();
    for (const model of [42, "", "nope", "--danger", "gpt-5.5"]) {
      const res = await h.live.start(A, { agent: "claude", projectPath: "/proj", ask: "go", model });
      expect(res).toEqual({ error: typeof model === "string" ? `Claude Code doesn't offer the model "${model}" in clis.json.` : "Invalid live session request." });
    }
    expect(h.reqs).toHaveLength(0);
    expect(h.events).toHaveLength(0);
    expect(h.live.canStart(A)).toBe(true);
  });

  it("starts, sends and stops a session, releasing its record only once the process exits", async () => {
    const h = harness();
    const res = await h.live.start(A, { agent: "claude", projectPath: "/proj", ask: "fix the bug" });
    expect(res).toEqual({ sessionId: "s1", handedOver: 0 });
    expect(h.reqs[0]).toEqual({ cli: "claude", projectPath: "/proj", prompt: "fix the bug" });
    expect(h.events[0]).toEqual({ e: { type: "started", sessionId: "s1", agent: "claude", mountId: "m1", seq: 1, projectPath: "/proj", handedOver: 0 } });

    h.cbs[0]!.onOutput("reading files");
    h.cbs[0]!.onTurnComplete({ result: "done", durationMs: 1200 });
    expect(h.live.send(A, "s1", "now the tests")).toBeUndefined();
    expect(h.sent).toEqual(["now the tests"]);

    h.live.stop(A, "s1");
    expect(h.stops()).toBe(1);
    expect(record(h.dir, "s1")).toBeDefined(); // the child hasn't confirmed dead yet
    h.cbs[0]!.onExit();
    expect(record(h.dir, "s1")).toBeUndefined();
    expect(h.events.map(({ e }) => [e.type, e.seq])).toEqual([["started", 1], ["output", 2], ["turn", 3], ["ended", 4]]);
    expect(h.events.at(-1)!.e).toMatchObject({ type: "ended", reason: "stopped" });
    expect(h.live.send(A, "s1", "late")).toBe("That agent session has ended.");
  });

  it("remembers a chat's project past its session for Cmd+click; a second project or a release forgets it", async () => {
    const h = harness();
    expect(h.live.projectOf("m1")).toBeUndefined();
    await h.live.start(A, { agent: "claude", projectPath: "/proj", ask: "go" });
    h.live.stop(A, "s1");
    h.cbs[0]!.onExit();
    expect(h.live.projectOf("m1")).toBe("/proj"); // older replies stay clickable
    await h.live.start(A, { agent: "claude", projectPath: "/proj", ask: "again" });
    expect(h.live.projectOf("m1")).toBe("/proj");
    expect(h.live.projectOf("m2")).toBeUndefined();
    h.live.stop(A, "s2");
    h.cbs[1]!.onExit();
    await h.live.start(A, { agent: "claude", projectPath: "", ask: "scratch" }); // -> /scratch
    expect(h.live.projectOf("m1")).toBeUndefined();
    h.live.stopMount("m1");
    h.cbs[2]!.onExit();
    await h.live.start(A, { agent: "claude", projectPath: "/proj", ask: "fresh" });
    expect(h.live.projectOf("m1")).toBe("/proj");
    h.live.stopMount("m1");
    expect(h.live.projectOf("m1")).toBeUndefined();
  });

  it("reports a crash as failed and an idle/clean exit as ended", async () => {
    const h = harness();
    await h.live.start(A, { agent: "codex", projectPath: "/proj", ask: "a" });
    h.cbs[0]!.onExit(new Error("codex exited with code 1"));
    expect(h.events.at(-1)!.e).toMatchObject({ type: "ended", reason: "failed", error: "codex exited with code 1" });
    await h.live.start(A, { agent: "codex", projectPath: "/proj", ask: "b" });
    h.cbs[1]!.onExit();
    expect(h.events.at(-1)!.e).toMatchObject({ type: "ended", reason: "ended" });
  });

  it("refuses a second session in the same window, not in another one", async () => {
    const h = harness();
    await h.live.start(A, { agent: "claude", projectPath: "/proj", ask: "a" });
    expect(await h.live.start(A, { agent: "codex", projectPath: "/proj", ask: "b" })).toEqual({ error: expect.stringMatching(/already has an agent/) });
    expect(await h.live.start(B, { agent: "codex", projectPath: "/proj", ask: "b" })).toMatchObject({ sessionId: "s2" });
    expect(h.reqs).toHaveLength(2);
  });

  it("one session per chat, several chats in one window at once, at most LIVE_SESSION_CAP across them", async () => {
    const h = harness({ findResumable: () => ({ run: { cli: "claude", projectPath: "/proj", sessionId: "sess-r" } } as ResumableRun) });
    const chat = (i: number) => ({ clientId: 1, mountId: `c${i}` });
    for (let i = 0; i < LIVE_SESSION_CAP - 1; i++) expect(await h.live.start(chat(i), { agent: "codex", projectPath: "/proj", ask: "a" })).toMatchObject({ sessionId: `s${i + 1}` });
    expect(await h.live.start(chat(0), { agent: "codex", projectPath: "/proj", ask: "b" })).toEqual({ error: expect.stringMatching(/already has an agent/) });
    // A pending start counts: it's registered before its project check resolves.
    const tenth = h.live.start(chat(LIVE_SESSION_CAP - 1), { agent: "codex", projectPath: "/proj", ask: "a" });
    expect(h.live.canStart(chat(99))).toBe(false);
    expect(await h.live.start(chat(99), { agent: "codex", projectPath: "/proj", ask: "a" })).toEqual({ error: LIVE_CAP_REACHED });
    expect(h.live.resume(chat(99), "sess-r")).toEqual({ error: LIVE_CAP_REACHED });
    expect(await tenth).toMatchObject({ sessionId: `s${LIVE_SESSION_CAP}` });
    // A stopping one still counts until its process exits.
    h.live.stop(chat(0), "s1");
    expect(await h.live.start(chat(99), { agent: "codex", projectPath: "/proj", ask: "a" })).toEqual({ error: LIVE_CAP_REACHED });
    h.cbs[0]!.onExit();
    expect(await h.live.start(chat(99), { agent: "codex", projectPath: "/proj", ask: "a" })).toMatchObject({ sessionId: expect.any(String) });
    // Events name their chat; a released chat's session stops; another chat can't drive it.
    expect(h.events.find(({ e }) => e.sessionId === "s2")!.e.mountId).toBe("c1");
    expect(h.live.send(chat(2), "s2", "hi")).toBe("That agent session has ended.");
    h.live.stopMount("c1");
    expect(h.stops()).toBe(2);
  });

  it("a switch can start the next session while the ended one is still exiting; no project = scratch", async () => {
    const h = harness();
    await h.live.start(A, { agent: "claude", projectPath: "/proj", ask: "a" });
    expect(h.live.hasSession(A)).toBe(true);
    h.live.stop(A, "s1"); // its onExit hasn't fired yet
    expect(h.live.hasSession(A)).toBe(false); // stopping counts as gone: Bean may offer again
    expect(await h.live.start(A, { agent: "codex", projectPath: "", ask: "b" })).toMatchObject({ sessionId: "s2" });
    expect(h.reqs[1]).toMatchObject({ cli: "codex", projectPath: "/scratch" });
  });

  it("a window close during startup leaves no child and no record", async () => {
    let allow!: (ok: boolean) => void;
    const h = harness({ allowed: () => new Promise((r) => { allow = r; }) });
    const pending = h.live.start(A, { agent: "claude", projectPath: "/proj", ask: "a" });
    h.live.stopClient(1);
    allow(true);
    expect(await pending).toEqual({ error: "Stopped before it started." });
    expect(h.reqs).toHaveLength(0);
    expect(record(h.dir, "s1")).toBeUndefined();
    expect(h.events).toHaveLength(0);
  });

  it("validates the CLI, project and payload sizes", async () => {
    const h = harness({ clis: ["claude"] });
    expect(await h.live.start(A, { agent: "codex", projectPath: "/proj", ask: "a" })).toEqual({ error: expect.stringMatching(/Codex isn't installed/) });
    expect(await h.live.start(A, { agent: "bash", projectPath: "/proj", ask: "a" })).toEqual({ error: "Invalid live session request." });
    expect(await h.live.start(A, { agent: "claude", projectPath: "/etc", ask: "a" })).toEqual({ error: "That project isn't configured in Bean." });
    expect(await h.live.start(A, { agent: "claude", projectPath: "/proj", ask: "x".repeat(ASK_LIMIT + 1) })).toEqual({ error: expect.stringMatching(/too long/) });
    expect(await h.live.start(A, { agent: "claude", projectPath: "/proj", ask: "a", label: 7 })).toEqual({ error: "Invalid live session request." });
    expect(await h.live.start(A, { agent: "claude", projectPath: "/proj", ask: "a", label: "x".repeat(LABEL_LIMIT + 1) })).toEqual({ error: expect.stringMatching(/label is too long/) });
    expect(h.reqs).toHaveLength(0);

    // A composed /skill prompt fits (#597): exactly ASK_LIMIT starts and sends.
    expect(ASK_LIMIT).toBe(32000);
    const res = await h.live.start(A, { agent: "claude", projectPath: "/proj", ask: "x".repeat(ASK_LIMIT) });
    const id = "sessionId" in res ? res.sessionId : "";
    expect(h.live.send(A, id, "x".repeat(ASK_LIMIT + 1))).toMatch(/too long/);
    expect(h.live.send(A, id, "x".repeat(ASK_LIMIT))).toBeUndefined();
    expect(h.live.send(B, id, "not my window")).toBe("That agent session has ended.");
    h.live.stop(B, id);
    expect(h.stops()).toBe(0);
    expect(h.sent).toEqual(["x".repeat(ASK_LIMIT)]);
  });

  it("surfaces a full next-turn queue", async () => {
    const h = harness({ sendOk: false });
    await h.live.start(A, { agent: "opencode", projectPath: "/proj", ask: "a" });
    expect(h.live.send(A, "s1", "more")).toBe(TURN_QUEUE_FULL);
  });

  it("moves claude's record to its child pid; per-turn CLIs keep this process's", async () => {
    const h = harness({ pid: 424242 });
    await h.live.start(A, { agent: "claude", projectPath: "/proj", ask: "a" });
    await h.live.start(B, { agent: "codex", projectPath: "/proj", ask: "a" });
    expect(record(h.dir, "s1")?.pid).toBe(424242);
    expect(record(h.dir, "s2")?.pid).toBe(process.pid);
  });

  it("hands the recent chat over as quoted context", async () => {
    const h = harness();
    const history: HandoffItem[] = [{ role: "user", text: "hi" }, { role: "reply", text: "hello" }];
    const res = await h.live.start(A, { agent: "claude", projectPath: "/proj", ask: "go", history });
    expect(res).toMatchObject({ handedOver: 2 });
    expect(h.reqs[0]!.prompt).toContain("> User: hi\n>\n> Bean: hello\n\ngo");
  });
});

describe("createLiveTasks resume (Continue live)", () => {
  // A real bean.db and the same lookup main wires: findDelegateRun(…, "desktop").
  function resumable() {
    const file = join(tmp(), "bean.db");
    const proj = tmp();
    const row = { surface: "desktop" as const, cli: "claude" as const, sessionId: "sess-1", projectPath: proj, instruction: "fix it" };
    recordDelegateSession(file, row);
    recordDelegateSession(file, { ...row, sessionId: "cx-not-uuid", cli: "codex" });
    recordDelegateSession(file, { ...row, sessionId: "chatops-1", surface: "discord" });
    return { file, proj, find: (id: string) => findDelegateRun(file, id, undefined, "desktop") };
  }

  it("resumes the recorded CLI in the recorded project with no handoff and no opening turn", () => {
    const r = resumable();
    const h = harness({ findResumable: r.find });
    expect(h.live.resume(A, "sess-1")).toEqual({ sessionId: "s1", agent: "claude", projectPath: r.proj });
    expect(h.reqs[0]).toEqual({ cli: "claude", projectPath: r.proj, prompt: "", resume: "sess-1" });
    expect(h.events[0]!.e).toMatchObject({ type: "started", projectPath: r.proj, handedOver: 0 });
  });

  it("reapplies the run's recorded model while clis.json still offers it, else the CLI default (#613)", () => {
    const file = join(tmp(), "bean.db");
    const proj = tmp();
    recordDelegateSession(file, { surface: "desktop", cli: "claude", sessionId: "sess-m", projectPath: proj, instruction: "x", model: "opus" });
    const find = (id: string) => findDelegateRun(file, id, undefined, "desktop");
    const offered = harness({ findResumable: find, modelOffered: (cli, m) => cli === "claude" && m === "opus" });
    offered.live.resume(A, "sess-m");
    expect(offered.reqs[0]).toEqual({ cli: "claude", projectPath: proj, prompt: "", model: "opus", resume: "sess-m" });
    const dropped = harness({ findResumable: find, modelOffered: () => false });
    dropped.live.resume(A, "sess-m");
    expect(dropped.reqs[0]).not.toHaveProperty("model");
  });

  it("claude's run record moves to the child once the first send spawns it", () => {
    const r = resumable();
    const h = harness({ findResumable: r.find, sendPid: 4242 });
    h.live.resume(A, "sess-1");
    expect(record(h.dir, "s1")?.pid).toBe(process.pid);
    expect(h.live.send(A, "s1", "what changed?")).toBeUndefined();
    expect(h.sent).toEqual(["what changed?"]);
    expect(record(h.dir, "s1")?.pid).toBe(4242);
  });

  it("refuses forged, mismatched and chatops ids, a disabled CLI, and a missing lookup", () => {
    const r = resumable();
    const h = harness({ findResumable: r.find });
    expect(h.live.resume(A, "forged")).toEqual({ error: "I have no record of that run." });
    expect(h.live.resume(A, "--help")).toEqual({ error: expect.stringMatching(/session id/) });
    expect(h.live.resume(A, "cx-not-uuid")).toEqual({ error: expect.stringMatching(/session id/) }); // codex needs a UUID
    expect(h.live.resume(A, "chatops-1")).toEqual({ error: "I have no record of that run." });
    expect(h.live.resume(A, 42)).toEqual({ error: "Invalid live session request." });
    expect(harness({ findResumable: r.find, clis: ["codex"] }).live.resume(A, "sess-1")).toEqual({ error: expect.stringMatching(/turned off/) });
    expect(harness().live.resume(A, "sess-1")).toEqual({ error: "I have no record of that run." });
    expect(h.reqs).toEqual([]);
  });

  it("a double click starts one session, and one id can't run live in two windows", () => {
    const r = resumable();
    const h = harness({ findResumable: r.find });
    h.live.resume(A, "sess-1");
    expect(h.live.resume(A, "sess-1")).toEqual({ error: expect.stringMatching(/already has an agent/) });
    expect(h.live.resume(B, "sess-1")).toEqual({ error: "That session is already live." });
    expect(h.reqs).toHaveLength(1);
    // Once it has exited, the id is free again.
    h.cbs[0]!.onExit();
    expect(h.live.resume(B, "sess-1")).toMatchObject({ sessionId: "s2" });
  });
});

describe("createLiveTasks CLI session ids", () => {
  const rows = (dir: string) => findDelegateRun(join(dir, "bean.db"), "sess-a", () => true, "desktop");

  it("records one desktop row per fresh session with the user's ask, and emits the receipt", async () => {
    const h = harness();
    await h.live.start(A, { agent: "claude", projectPath: "", ask: "  fix the bug ", history: [{ role: "user", text: "earlier" }] });
    h.cbs[0]!.onSessionId!("sess-a");
    expect(rows(h.dir)).toEqual({ run: { surface: "desktop", cli: "claude", sessionId: "sess-a", projectPath: "/scratch", instruction: "fix the bug" } });
    expect(h.events.at(-1)!.e).toEqual({
      type: "session", sessionId: "s1", agent: "claude", mountId: "m1", seq: 2, receipt: { sessionId: "sess-a", agent: "claude", label: "claude · sess…" },
    });
  });

  it("records a /skill run's label instead of its composed body; an empty label falls back to the ask", async () => {
    const h = harness();
    await h.live.start(A, { agent: "claude", projectPath: "", ask: "# Review PR\n…long skill body…", label: "  ▶ review-pr — fix X " });
    h.cbs[0]!.onSessionId!("sess-a");
    expect(rows(h.dir)).toMatchObject({ run: { instruction: "▶ review-pr — fix X" } });

    const h2 = harness();
    await h2.live.start(A, { agent: "claude", projectPath: "", ask: "fix the bug", label: "   " });
    h2.cbs[0]!.onSessionId!("sess-a");
    expect(findDelegateRun(join(h2.dir, "bean.db"), "sess-a", () => true, "desktop")).toMatchObject({ run: { instruction: "fix the bug" } });
  });

  it("ignores an id its CLI can't continue", async () => {
    const h = harness();
    await h.live.start(A, { agent: "codex", projectPath: "/proj", ask: "a" });
    h.cbs[0]!.onSessionId!("not-a-uuid");
    expect(h.types()).toEqual(["started"]);
  });

  it("a resume adds no row but re-emits the receipt", () => {
    const dir = tmp();
    const proj = tmp();
    recordDelegateSession(join(dir, "bean.db"), { surface: "desktop", cli: "claude", sessionId: "sess-a", projectPath: proj, instruction: "x" });
    const h = harness({ findResumable: (id) => findDelegateRun(join(dir, "bean.db"), id, undefined, "desktop") });
    h.live.resume(A, "sess-a");
    h.cbs[0]!.onSessionId!("sess-a");
    expect(h.events.at(-1)!.e).toMatchObject({ type: "session", receipt: { sessionId: "sess-a" } });
    expect(existsSync(join(h.dir, "bean.db"))).toBe(false);
  });

  it("refuses to continue a fresh session while its child is still stopping", async () => {
    const h = harness({ findResumable: (id) => findDelegateRun(join(h.dir, "bean.db"), id, () => true, "desktop") });
    await h.live.start(A, { agent: "claude", projectPath: "/proj", ask: "a" });
    h.cbs[0]!.onSessionId!("sess-a");
    h.live.stop(A, "s1");
    expect(h.live.resume(B, "sess-a")).toEqual({ error: "That session is already live." });
    h.cbs[0]!.onExit();
    expect(h.live.resume(B, "sess-a")).toMatchObject({ sessionId: "s2" });
  });
});

describe("createLiveTasks interrupt (Stop / Esc Esc)", () => {
  it("interrupts only the owner's running turn; foreign chats, bad payloads and ended sessions are refused", async () => {
    const h = harness();
    await h.live.start(A, { agent: "claude", projectPath: "/proj", ask: "go" });
    expect(h.live.interrupt(B, "s1", 0)).toBe(false);
    expect(h.live.interrupt({ clientId: 1, mountId: "other" }, "s1", 0)).toBe(false);
    expect(h.live.interrupt({ clientId: 2, mountId: "m1" }, "s1", 0)).toBe(false);
    for (const turns of ["0", undefined, 0.5, Number.NaN]) expect(h.live.interrupt(A, "s1", turns)).toBe(false);
    expect(h.live.interrupt(A, "nope", 0)).toBe(false);
    expect(h.interrupts()).toBe(0);
    expect(h.live.interrupt(A, "s1", 0)).toBe(true);
    expect(h.interrupts()).toBe(1);
    h.live.stop(A, "s1");
    expect(h.live.interrupt(A, "s1", 0)).toBe(false);
    expect(h.interrupts()).toBe(1);
  });

  it("drops a press aimed at a turn that already ended (stale turns), not the queued one now running", async () => {
    const h = harness();
    await h.live.start(A, { agent: "claude", projectPath: "/proj", ask: "go" });
    h.live.send(A, "s1", "then this");
    h.cbs[0]!.onTurnComplete({ result: "first" });
    h.cbs[0]!.onTurnStart!();
    expect(h.live.interrupt(A, "s1", 0)).toBe(false); // the renderer hadn't seen turn 1 end
    expect(h.interrupts()).toBe(0);
    expect(h.live.interrupt(A, "s1", 1)).toBe(true);
    expect(h.interrupts()).toBe(1);
  });

  it("passes the engine's false through (no turn running)", async () => {
    const h = harness({ interruptOk: false });
    await h.live.start(A, { agent: "codex", projectPath: "/proj", ask: "go" });
    expect(h.live.interrupt(A, "s1", 0)).toBe(false);
    expect(h.interrupts()).toBe(1);
  });

  it("emits turn-start for every turn the engine starts (queued ones too), and marks an interrupted turn", async () => {
    const h = harness();
    await h.live.start(A, { agent: "codex", projectPath: "/proj", ask: "go" });
    h.cbs[0]!.onTurnStart!();
    h.cbs[0]!.onTurnComplete({ result: "", durationMs: 5, interrupted: true });
    h.cbs[0]!.onTurnStart!(); // the queued, merged turn
    h.cbs[0]!.onTurnComplete({ result: "ok" });
    expect(h.types()).toEqual(["started", "turn-start", "turn", "turn-start", "turn"]);
    expect(h.events[2]!.e).toEqual(expect.objectContaining({ type: "turn", interrupted: true }));
    expect(h.events[4]!.e).not.toHaveProperty("interrupted");
    h.live.stop(A, "s1");
    h.cbs[0]!.onTurnStart!(); // nothing while stopping
    expect(h.types().at(-1)).toBe("turn");
  });

  it("forwards the engine's onConsumed as a consumed event, never while stopping (#746)", async () => {
    const h = harness();
    await h.live.start(A, { agent: "claude", projectPath: "/proj", ask: "go" });
    h.cbs[0]!.onConsumed!(1);
    h.cbs[0]!.onConsumed!(2);
    expect(h.events.slice(1).map((x) => x.e)).toEqual([
      expect.objectContaining({ type: "consumed", count: 1, sessionId: "s1", agent: "claude" }),
      expect.objectContaining({ type: "consumed", count: 2 }),
    ]);
    h.live.stop(A, "s1");
    h.cbs[0]!.onConsumed!(1);
    expect(h.types()).toEqual(["started", "consumed", "consumed"]);
  });
});

describe("liveSpawnFn", () => {
  const probe = "const fs=require('fs');process.stdout.write(JSON.stringify({pipe:!fs.fstatSync(0).isCharacterDevice(),path:process.env.PATH,pwd:process.env.PWD}))";
  const run = async (agent: "claude" | "codex" | "opencode") => {
    const cwd = realpathSync(tmp());
    const child = liveSpawnFn(agent, "/opt/bean-test/bin:/usr/bin:/bin")(process.execPath, ["-e", probe], cwd);
    child.stdin?.end();
    let out = "";
    child.stdout?.on("data", (d) => { out += String(d); });
    await new Promise((resolve) => child.on("close", resolve));
    return { ...JSON.parse(out) as { pipe: boolean; path: string; pwd: string }, cwd };
  };

  it("claude gets a stdin pipe; codex and opencode get stdin ignored; all get the resolved PATH and PWD", async () => {
    const claude = await run("claude");
    expect(claude.pipe).toBe(true);
    expect(claude.path).toBe("/opt/bean-test/bin:/usr/bin:/bin");
    expect(claude.pwd).toBe(claude.cwd);
    for (const agent of ["codex", "opencode"] as const) {
      const r = await run(agent);
      expect(r.pipe).toBe(false);
      expect(r.path).toBe("/opt/bean-test/bin:/usr/bin:/bin");
      expect(r.pwd).toBe(r.cwd);
    }
  });
});

describe("buildHandoff", () => {
  it("keeps the newest items in chronological order, capped by count", () => {
    const history: HandoffItem[] = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? "reply" : "user", text: `m${i}` }));
    const r = buildHandoff(history, "ask");
    if ("error" in r) throw new Error(r.error);
    expect(r.count).toBe(HANDOFF_ITEMS);
    expect(r.prompt.indexOf("m10")).toBeGreaterThan(0);
    expect(r.prompt).not.toContain("m9\n");
    expect(r.prompt.indexOf("m10")).toBeLessThan(r.prompt.indexOf("m29"));
    expect(r.prompt.endsWith("\n\nask")).toBe(true);
  });

  it("caps the quoted context at HANDOFF_CHARS and reports the exact count", () => {
    const history: HandoffItem[] = Array.from({ length: 10 }, (_, i) => ({ role: "reply", text: `${i}`.repeat(1500), agent: "codex" }));
    const r = buildHandoff(history, "ask");
    if ("error" in r) throw new Error(r.error);
    const quoted = r.prompt.split("\n").filter((l) => l.startsWith("> Codex:"));
    expect(quoted).toHaveLength(r.count);
    expect(r.count).toBe(Math.floor(HANDOFF_CHARS / "> Codex: ".concat("x".repeat(1500)).length));
    expect(quoted.at(-1)).toContain("9999");
  });

  it("rejects an oversized ask instead of truncating it, and sends a bare ask with no history", () => {
    expect(buildHandoff([], "x".repeat(ASK_LIMIT + 1))).toEqual({ error: expect.stringMatching(/too long/) });
    expect(buildHandoff([], "  ")).toEqual({ error: "Nothing to send." });
    expect(buildHandoff([], "just this")).toEqual({ prompt: "just this", count: 0 });
  });
});

describe("live-session teardown", () => {
  // The host's quit hook must SIGKILL live trees. The app's update relaunch (which skips
  // before-quit) is guarded in packages/app/__test__/live-teardown.test.ts.
  const src = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
  const block = (text: string, start: string): string => text.slice(text.indexOf(start), text.indexOf("});", text.indexOf(start)));

  it("force-kills live sessions on quit", () => {
    expect(block(src("../src/host.ts"), "deps.onQuit(() => {\n    delegateTasks.interruptAll();")).toContain("liveTasks.forceKillAll();");
  });
});

describe("handover (Continue in Discord)", () => {
  const started = async () => {
    const h = harness();
    await h.live.start(A, { agent: "claude", projectPath: "/proj", ask: "go" });
    h.cbs[0]!.onSessionId!("11111111-1111-4111-8111-111111111111");
    return h;
  };

  it("refuses a busy session, then stops an idle one and waits for its exit", async () => {
    const h = await started();
    expect(await h.live.handover(A, "s1")).toEqual({ error: "Wait for Claude Code to finish its turn first." });
    h.cbs[0]!.onTurnComplete({ result: "done" });
    expect(await h.live.handover(B, "s1")).toEqual({ error: "That agent session has ended." });
    let settled = false;
    const held = h.live.handover(A, "s1").then((r) => { settled = true; return r; });
    await Promise.resolve();
    expect(h.stops()).toBe(1);
    expect(settled).toBe(false); // not until the process is gone
    expect(h.live.send(A, "s1", "more")).toBe("That agent session has ended.");
    h.cbs[0]!.onExit();
    expect(await held).toMatchObject({ cliId: "11111111-1111-4111-8111-111111111111", agent: "claude" });
  });

  it("refuses a resume of the handed-over id until release", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const h = harness({ findResumable: () => ({ run: { cli: "claude", sessionId: id, projectPath: "/proj" } }) as ResumableRun });
    await h.live.start(A, { agent: "claude", projectPath: "/proj", ask: "go" });
    h.cbs[0]!.onSessionId!(id);
    h.cbs[0]!.onTurnComplete({ result: "done" });
    const held = h.live.handover(A, "s1");
    h.cbs[0]!.onExit();
    const r = await held;
    if ("error" in r) throw new Error(r.error);
    expect(h.live.resume(B, id)).toEqual({ error: "That session is moving to Discord." });
    r.release();
    expect(h.live.resume(B, id)).toMatchObject({ agent: "claude" });
  });

  it("claude: a send injected into the running turn leaves it idle at that turn's result (#725)", async () => {
    const h = await started();
    expect(h.live.send(A, "s1", "and then this")).toBeUndefined(); // written during a tool run
    h.cbs[0]!.onTurnComplete({ result: "both answered" });
    const held = h.live.handover(A, "s1");
    h.cbs[0]!.onExit();
    expect(await held).toMatchObject({ agent: "claude" });
  });

  it("claude: two sends merged into one following turn leave it idle after that turn (#725)", async () => {
    const h = await started();
    h.live.send(A, "s1", "one");
    h.live.send(A, "s1", "two");
    h.cbs[0]!.onTurnComplete({ result: "opening" });
    h.cbs[0]!.onTurnStart!(); // claude answers "one\ntwo" as one turn
    expect(await h.live.handover(A, "s1")).toEqual({ error: "Wait for Claude Code to finish its turn first." });
    h.cbs[0]!.onTurnComplete({ result: "one. two." });
    const held = h.live.handover(A, "s1");
    h.cbs[0]!.onExit();
    expect(await held).toMatchObject({ agent: "claude" });
  });

  it("claude: queued sends answered one turn each relight busy when the next turn starts", async () => {
    const h = await started();
    h.live.send(A, "s1", "one");
    h.live.send(A, "s1", "two");
    const refused = { error: "Wait for Claude Code to finish its turn first." };
    h.cbs[0]!.onTurnComplete({ result: "opening" });
    h.cbs[0]!.onTurnStart!();
    h.cbs[0]!.onTurnComplete({ result: "one" });
    h.cbs[0]!.onTurnStart!(); // "two" as its own turn
    expect(await h.live.handover(A, "s1")).toEqual(refused);
    h.cbs[0]!.onTurnComplete({ result: "two" });
    const held = h.live.handover(A, "s1");
    h.cbs[0]!.onExit();
    expect(await held).toMatchObject({ agent: "claude" });
  });

  it("codex: two sends queued mid-turn run as one merged turn, idle after it", async () => {
    const h = harness();
    await h.live.start(A, { agent: "codex", projectPath: "/proj", ask: "go" });
    h.cbs[0]!.onTurnStart!();
    h.cbs[0]!.onSessionId!("019a0000-0000-7000-8000-000000000000");
    h.live.send(A, "s1", "one");
    h.live.send(A, "s1", "two");
    h.cbs[0]!.onTurnComplete({ result: "opening" });
    h.cbs[0]!.onTurnStart!(); // the merged "one\n\ntwo" turn, started synchronously
    expect(await h.live.handover(A, "s1")).toEqual({ error: "Wait for Codex to finish its turn first." });
    h.cbs[0]!.onTurnComplete({ result: "merged" });
    const held = h.live.handover(A, "s1");
    h.cbs[0]!.onExit();
    expect(await held).toMatchObject({ agent: "codex" });
  });

  it("a per-turn CLI's send that starts its turn inside send() isn't counted as queued", async () => {
    const h = await started();
    h.cbs[0]!.onTurnComplete({ result: "first" });
    // Simulates turn-live-session: an idle send() spawns the turn and reports onTurnStart synchronously.
    const handle = h.cbs[0]!;
    const origSend = h.sent.push.bind(h.sent);
    h.sent.push = (...t: string[]) => { handle.onTurnStart!(); return origSend(...t); };
    expect(h.live.send(A, "s1", "next")).toBeUndefined();
    h.cbs[0]!.onTurnComplete({ result: "next done" });
    const held = h.live.handover(A, "s1");
    h.cbs[0]!.onExit();
    expect(await held).toMatchObject({ agent: "claude" });
  });

  it("refuses a session that hasn't reported its CLI id", async () => {
    const h = harness();
    await h.live.start(A, { agent: "codex", projectPath: "/proj", ask: "go" });
    h.cbs[0]!.onTurnComplete({ result: "done" });
    expect(await h.live.handover(A, "s1")).toEqual({ error: "Codex hasn't reported its session yet." });
    expect(h.stops()).toBe(0);
  });
});
