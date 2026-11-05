import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRoutineHost } from "../src/routine-host.js";
import { createRoutineScheduler, withSinkProblems } from "../src/routine-scheduler.js";
import { chatRoutineProblem, describeRoutineError, resolveSinkAlias, sinkAliasProblems, type Routine, type RoutineState } from "../src/routine-store.js";
import { parseBrief } from "../src/routine-brief.js";
import { recordDestination, retargetAlias, setAlias, listDestinations, type Destination } from "../src/destinations.js";
import { dbFile, outboxDir } from "../src/config.js";
import { claimOutbox } from "../src/outbox.js";
import type { RoutineRunResult } from "../src/routine-runner.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "bean-alias-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const routine = (over: Partial<Routine> = {}): Routine =>
  ({ name: "r", enabled: true, cron: "0 6 * * *", steps: [{ kind: "chat", instruction: "x" }], sinks: {}, ...over });
const ops: Destination = { surface: "teams", conversationId: "19:ops@thread.tacv2", kind: "channel", alias: "Ops", lastSeen: "" };

function seed(): void {
  const db = dbFile(dir);
  recordDestination(db, { surface: "teams", conversationId: "19:ops@thread.tacv2", kind: "channel", platformName: "ops" });
  recordDestination(db, { surface: "teams", conversationId: "19:new@thread.tacv2", kind: "channel", platformName: "ops-new" });
  setAlias(db, { surface: "teams", conversationId: "19:ops@thread.tacv2" }, "Ops", () => []);
}

const result = (status: "ok" | "failed" | "needs-attention" = "ok"): RoutineRunResult =>
  ({ digest: "d", results: [], record: { startedAt: "2026-11-05T06:00:00.000Z", finishedAt: "2026-11-05T06:01:00.000Z", status, digest: "d", steps: [] } });

describe("alias chat sinks", () => {
  it("validates: alias is a non-empty string, exclusive with channel and user", () => {
    expect(describeRoutineError(routine({ sinks: { chatops: [{ transport: "teams", alias: "Ops" }] } }))).toBeNull();
    expect(describeRoutineError(routine({ sinks: { chatops: [{ transport: "teams", alias: " " }] } }))).toMatch(/invalid destination name/);
    expect(describeRoutineError(routine({ sinks: { chatops: [{ transport: "teams", alias: "Ops", channel: "c" }] } }))).toMatch(/can't have a destination name/);
    expect(describeRoutineError(routine({ sinks: { chatops: [{ transport: "discord", alias: "Ops", user: "u" }] } }))).toMatch(/can't have a destination name/);
  });

  it("resolves an alias; unknown and other-platform aliases are problems, never a DM", () => {
    expect(resolveSinkAlias({ transport: "teams", alias: "Ops" }, [ops])).toEqual({ channel: "19:ops@thread.tacv2" });
    expect(resolveSinkAlias({ transport: "teams", alias: "Nope" }, [ops])).toEqual({ error: expect.stringMatching(/"Nope" isn't known/) });
    expect(resolveSinkAlias({ transport: "discord", alias: "Ops" }, [ops])).toEqual({ error: expect.stringMatching(/Teams conversation, but this sink posts to Discord/) });
    const r = routine({ sinks: { chatops: [{ transport: "teams" }, { transport: "teams", alias: "Ops" }, { transport: "teams", alias: "Gone" }] } });
    expect(sinkAliasProblems(r, [ops])).toEqual([expect.stringContaining('"Gone"')]);
  });

  it("survives the builder's brief parse; an alias wins over a channel", () => {
    const brief = parseBrief(JSON.stringify({ name: "r", trigger: "schedule", cron: "0 6 * * *", steps: [],
      sinks: { chatops: [{ transport: "teams", alias: " Ops ", channel: "c" }] } }), { skills: [], projects: [] } as never);
    expect(brief.sinks.chatops).toEqual([{ transport: "teams", alias: "Ops" }]);
  });

  it("chatRoutineProblem resolves first, then applies the drafting-channel rule", () => {
    const r = (alias: string): Routine => routine({ name: "r", sinks: { chatops: [{ transport: "teams", alias }] } });
    expect(chatRoutineProblem(r("Ops"), "teams", [], undefined, "19:ops@thread.tacv2", [ops])).toBeNull();
    expect(chatRoutineProblem(r("Ops"), "teams", [], undefined, "19:other@thread.tacv2", [ops])).toMatch(/channel they're drafted in/);
    expect(chatRoutineProblem(r("Nope"), "teams", [], undefined, "19:ops@thread.tacv2", [ops])).toMatch(/isn't known/);
    expect(chatRoutineProblem(r("Ops"), "teams", [], undefined, "19:ops@thread.tacv2")).toMatch(/isn't known/);
  });

  it("deliverDigest resolves at enqueue (a retarget applies to the next digest) and skips an unknown alias", async () => {
    seed();
    let n = 0;
    const h = createRoutineHost({
      dir, converse: async () => ({ content: "", toolCalls: [] }), getModel: () => "m",
      delegateStep: async () => ({ output: "", cli: "claude" }), commandStep: async () => ({ exitCode: 0, output: "" }),
      tools: [], loadSkills: async () => [], memories: async () => [], getRoutineDigestContext: () => false, newId: () => `id-${n++}`,
    });
    const r = routine({ sinks: { chatops: [{ transport: "teams", alias: "Ops" }, { transport: "teams", alias: "Gone" }] } });
    expect(h.sinkProblems(r)).toEqual([expect.stringContaining('"Gone"')]);
    await h.deliverDigest(r, result("needs-attention"));
    let posted = await claimOutbox(outboxDir(dir), "teams");
    // One message, to the named conversation — the unknown alias posts nowhere (no owner DM).
    expect(posted.map((m) => m.channel)).toEqual(["19:ops@thread.tacv2"]);

    expect(retargetAlias(dbFile(dir), "Ops", { surface: "teams", conversationId: "19:new@thread.tacv2" }, () => ["r"]).ok).toBe(true);
    await h.deliverDigest(r, result("needs-attention"));
    posted = await claimOutbox(outboxDir(dir), "teams");
    expect(posted.map((m) => m.channel)).toEqual(["19:new@thread.tacv2"]);
    expect(listDestinations(dbFile(dir)).find((d) => d.alias === "Ops")?.conversationId).toBe("19:new@thread.tacv2");
  });

  it("withSinkProblems: ok → needs-attention with the lines in the digest; failed stays failed", () => {
    const flagged = withSinkProblems(result("ok"), ["chat destination \"Gone\" isn't known"]);
    expect(flagged.record.status).toBe("needs-attention");
    expect(flagged.digest).toBe('d\n\n⚠ chat destination "Gone" isn\'t known');
    expect(flagged.record.digest).toBe(flagged.digest);
    expect(withSinkProblems(result("failed"), ["x"]).record.status).toBe("failed");
    expect(withSinkProblems(result("ok"), [])).toEqual(result("ok"));
  });

  it("the scheduler records an unresolvable alias run as needs-attention before delivering it", async () => {
    let states: Record<string, RoutineState> = {};
    const delivered: RoutineRunResult[] = [];
    const r = routine({ sinks: { chatops: [{ transport: "teams", alias: "Gone" }] } });
    const s = createRoutineScheduler({
      loadRoutines: async () => [r], loadStates: async () => states, saveStates: async (x) => { states = x; },
      runRoutine: async () => result("ok"),
      deliverDigest: async (_r, res) => { delivered.push(res); },
      sinkProblems: () => ['chat destination "Gone" isn\'t known'],
    });
    const started = await s.runNow("r");
    expect(started.started).toBe(true);
    await expect.poll(() => delivered.length).toBe(1);
    expect(states.r?.history[0]?.status).toBe("needs-attention");
    expect(delivered[0]?.record.status).toBe("needs-attention");
    s.stop();
  });
});
