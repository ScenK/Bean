import { describe, expect, it, vi } from "vitest";
import type { DeskContinueBody, DeskContinueResult, Destination } from "@bean/core";
import { buildDeskContinueHandler } from "../src/desk-continue.js";
import { buildCarryTail, type LiveHandover } from "@bean/host";

const A = { clientId: 1, mountId: "m1" };
const dest = (over: Partial<Destination>): Destination =>
  ({ surface: "discord", conversationId: "c1", kind: "channel", platformName: "general", lastSeen: "2026-11-05T00:00:00Z", ...over });

function harness(opts: { handover?: () => Promise<LiveHandover>; ack?: () => Promise<DeskContinueResult> } = {}) {
  const sent: DeskContinueBody[] = [];
  const release = vi.fn();
  const handover = vi.fn(opts.handover ?? (async (): Promise<LiveHandover> => ({ cliId: "cli-1", agent: "claude", release })));
  const handler = buildDeskContinueHandler({
    listDestinations: () => [dest({}), dest({ conversationId: "t1", kind: "thread" }), dest({ surface: "teams", conversationId: "x1" })],
    deskContinue: async (body) => { sent.push(body); return opts.ack ? opts.ack() : { ok: true, threadId: "th-1" }; },
    handover,
  });
  return { handler, sent, release, handover };
}
const history = [{ role: "user", text: "plan my week" }, { role: "reply", text: "Sure" }];

describe("desk-continue handler", () => {
  it("carries a plain chat's recent messages to a known Discord channel", async () => {
    const h = harness();
    expect(await h.handler(A, false, { channelId: "c1", title: "  Week plan ", history })).toEqual({ ok: true, threadId: "th-1" });
    expect(h.sent).toEqual([{ mode: "chat", channelId: "c1", title: "Week plan", tail: "User: plan my week\n\nBean: Sure", count: 2 }]);
    expect(h.handover).not.toHaveBeenCalled();
  });

  it("refuses off-the-record chats, threads, Teams rows, unknown channels, bad titles and empty chats before any send", async () => {
    const h = harness();
    expect(await h.handler(A, true, { channelId: "c1", title: "t", history })).toEqual({ failed: "Off-the-record chats stay on this Mac." });
    for (const channelId of ["t1", "x1", "nope"]) {
      expect(await h.handler(A, false, { channelId, title: "t", history })).toEqual({ failed: "Pick a Discord channel Bean knows." });
    }
    expect(await h.handler(A, false, { channelId: "c1", title: " ", history })).toHaveProperty("failed");
    expect(await h.handler(A, false, { channelId: "c1", title: "x".repeat(101), history })).toHaveProperty("failed");
    expect(await h.handler(A, false, { channelId: "c1", title: "t", history: [] })).toEqual({ failed: "Nothing to carry over yet." });
    expect(await h.handler(A, false, null)).toEqual({ failed: "Invalid request." });
    expect(h.sent).toEqual([]);
  });

  it("a double click sends one request", async () => {
    let ack!: (r: DeskContinueResult) => void;
    const h = harness({ ack: () => new Promise((r) => { ack = r; }) });
    const first = h.handler(A, false, { channelId: "c1", title: "t", history });
    expect(await h.handler(A, false, { channelId: "c1", title: "t", history })).toEqual({ failed: "This chat is already being continued." });
    ack({ partial: true, threadId: "th-2" });
    expect(await first).toEqual({ partial: true, threadId: "th-2" });
    expect(h.sent).toHaveLength(1);
  });

  it("agent mode hands over the session, sends its CLI id, and releases the hold after the ack", async () => {
    const h = harness();
    expect(await h.handler(A, false, { channelId: "c1", title: "t", sessionId: "s1" })).toEqual({ ok: true, threadId: "th-1" });
    expect(h.handover).toHaveBeenCalledWith(A, "s1");
    expect(h.sent).toEqual([{ mode: "agent", channelId: "c1", title: "t", sessionId: "cli-1" }]);
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it("a refused hand-over (busy session) sends nothing; a failed send still releases the hold", async () => {
    const busy = harness({ handover: async () => ({ error: "Wait for Claude Code to finish its turn first." }) });
    expect(await busy.handler(A, false, { channelId: "c1", title: "t", sessionId: "s1" })).toEqual({ failed: "Wait for Claude Code to finish its turn first." });
    expect(busy.sent).toEqual([]);
    const down = harness({ ack: () => Promise.reject(new Error("discord bot is not running")) });
    expect(await down.handler(A, false, { channelId: "c1", title: "t", sessionId: "s1" })).toEqual({ failed: "discord bot is not running" });
    expect(down.release).toHaveBeenCalledTimes(1);
  });

  it("the carried tail names agents and keeps only well-formed items", () => {
    expect(buildCarryTail([{ role: "reply", text: "done", agent: "codex" }, { role: "bogus", text: "x" }, "junk"]))
      .toEqual({ tail: "Codex: done", count: 1 });
    expect(buildCarryTail(undefined)).toEqual({ tail: "", count: 0 });
  });
});
