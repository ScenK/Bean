import { describe, expect, it, vi } from "vitest";
import { cliAuthPresent, headlessRoutinesOn, missedNotice, tzProblem, withFinishReply } from "../src/headless-routines.js";

describe("headless routines boot checks", () => {
  it("is off unless BEAN_HEADLESS_ROUTINES=1", () => {
    expect(headlessRoutinesOn({})).toBe(false);
    expect(headlessRoutinesOn({ BEAN_HEADLESS_ROUTINES: "true" })).toBe(false);
    expect(headlessRoutinesOn({ BEAN_HEADLESS_ROUTINES: "1" })).toBe(true);
  });

  it("refuses an unset TZ with one line", () => {
    expect(tzProblem({ TZ: "UTC" })).toBeUndefined();
    const err = tzProblem({});
    expect(err).toMatch(/TZ/);
    expect(err).not.toContain("\n");
  });

  it("detects CLI auth from env or the credentials file", () => {
    const none = (): boolean => false;
    expect(cliAuthPresent("claude", { CLAUDE_CODE_OAUTH_TOKEN: "t" }, "/h", none)).toBe(true);
    expect(cliAuthPresent("claude", {}, "/h", none)).toBe(false);
    expect(cliAuthPresent("claude", {}, "/h", (p) => p === "/h/.claude/.credentials.json")).toBe(true);
    expect(cliAuthPresent("codex", { CODEX_HOME: "/c" }, "/h", (p) => p === "/c/auth.json")).toBe(true);
    expect(cliAuthPresent("opencode", {}, "/h", (p) => p === "/h/.local/share/opencode/auth.json")).toBe(true);
  });

  it("names every missed routine in one notice", () => {
    expect(missedNotice(["a", "b"])).toContain('"a", "b"');
  });
});

describe("withFinishReply", () => {
  it("posts one fixed line to the asking channel once a started run ends", async () => {
    let finish!: (o: { status: "failed"; runs: number; ok: number; needsAttention: number; failed: number }) => void;
    const done = new Promise<Parameters<typeof finish>[0]>((res) => { finish = res; });
    const sent: { channel?: string; body: string }[] = [];
    const trigger = withFinishReply(async () => ({ status: "started", done }), async (m) => { sent.push(m); });
    expect((await trigger("pr-digest", "run", { channel: "thread-1" })).status).toBe("started");
    expect(sent).toEqual([]);
    finish({ status: "failed", runs: 1, ok: 0, needsAttention: 0, failed: 1 });
    await vi.waitFor(() => expect(sent).toEqual([{ channel: "thread-1", body: "pr-digest failed ✗ · see Dashboard" }]));
  });

  it("a DM origin has no channel; refusals and checks post nothing", async () => {
    const sent: unknown[] = [];
    const ok = withFinishReply(async () => ({ status: "started", done: Promise.resolve({ status: "ok", runs: 1, ok: 1, needsAttention: 0, failed: 0 }) }), async (m) => { sent.push(m); });
    await ok("s", "run", {});
    await vi.waitFor(() => expect(sent).toEqual([{ body: "s finished ✓" }]));
    sent.length = 0;
    await withFinishReply(async () => ({ status: "refused", reason: "already running" }), async (m) => { sent.push(m); })("s", "run", {});
    await withFinishReply(async () => ({ status: "checked", result: { newItems: 0 } }), async (m) => { sent.push(m); })("w", "check", {});
    expect(sent).toEqual([]);
  });
});
