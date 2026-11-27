import { describe, expect, it } from "vitest";
import {
  createGrant, matchGrant, refreshGrant, revokeGrant, isGrantExpired, GRANT_IDLE_MS, GRANT_MISMATCH_TEXT,
  FOLLOW_UP_MAX, failureFingerprint, matchFollowUp, reserveFollowUp, followUpRefusedText,
  type GrantRequest,
} from "../src/delegate-grant.js";

const T0 = 1_000_000;
const fields = {
  surface: "discord" as const, scopeKey: "conv-1", actorId: "u-1", projectPath: "/p", cli: "claude" as const,
  model: "opus", skillName: "fix", browser: false, sessionId: "s-1",
};
const base: GrantRequest = { surface: "discord", scopeKey: "conv-1", actorId: "u-1" };

describe("delegate grant", () => {
  it("omitted selectors inherit the grant; naming the same values still matches", () => {
    const g = createGrant(fields, T0);
    expect(matchGrant(g, base, T0)).toEqual({ ok: true, grant: g });
    expect(matchGrant(g, { ...base, projectPath: "/p", cli: "claude", model: "opus", skillName: "fix", browser: false, generation: 1 }, T0).ok).toBe(true);
  });

  it.each([
    ["surface", { surface: "teams" }],
    ["scope", { scopeKey: "conv-2" }],
    ["actor", { actorId: "u-2" }],
    ["project", { projectPath: "/q" }],
    ["cli", { cli: "codex" }],
    ["model", { model: "sonnet" }],
    ["skill", { skillName: "other" }],
    ["browser", { browser: true }],
    ["stale", { generation: 2 }],
  ] as const)("a %s mismatch is refused with that reason", (reason, diff) => {
    const g = createGrant(fields, T0);
    expect(matchGrant(g, { ...base, ...diff }, T0)).toEqual({ ok: false, reason });
    expect(GRANT_MISMATCH_TEXT[reason]).toBeTruthy();
  });

  it("a grant with no model or skill refuses a named one (no widening)", () => {
    const g = createGrant({ ...fields, model: undefined, skillName: undefined }, T0);
    expect(matchGrant(g, { ...base, model: "opus" }, T0)).toEqual({ ok: false, reason: "model" });
    expect(matchGrant(g, { ...base, skillName: "fix" }, T0)).toEqual({ ok: false, reason: "skill" });
  });

  it("no grant, revoked, and 30 minutes idle are refused; refresh restarts the idle clock", () => {
    expect(matchGrant(undefined, base, T0)).toEqual({ ok: false, reason: "none" });
    const g = createGrant(fields, T0);
    expect(matchGrant(revokeGrant(g), base, T0)).toEqual({ ok: false, reason: "revoked" });
    expect(isGrantExpired(g, T0 + GRANT_IDLE_MS - 1)).toBe(false);
    expect(matchGrant(g, base, T0 + GRANT_IDLE_MS)).toEqual({ ok: false, reason: "expired" });
    const fresh = refreshGrant(g, T0 + GRANT_IDLE_MS - 1);
    expect(matchGrant(fresh, base, T0 + GRANT_IDLE_MS).ok).toBe(true);
    expect(fresh.generation).toBe(g.generation);
  });

  it("a new grant over a previous (even revoked) one bumps the generation", () => {
    const g1 = createGrant(fields, T0);
    const g2 = createGrant({ ...fields, sessionId: "s-2" }, T0, revokeGrant(g1));
    expect([g1.generation, g2.generation]).toEqual([1, 2]);
    expect(g2.revoked).toBeUndefined();
    expect(matchGrant(g2, { ...base, generation: 1 }, T0)).toEqual({ ok: false, reason: "stale" });
  });
});

describe("automatic follow-up (#1132)", () => {
  it("spends a budget of FOLLOW_UP_MAX per task, never renews the idle clock, and resets with a new grant", () => {
    let g = createGrant(fields, T0);
    for (let i = 1; i <= FOLLOW_UP_MAX; i++) {
      const why = `FAILED: ${"x".repeat(i)}`;
      expect(matchFollowUp(g, base, why, T0).ok).toBe(true);
      g = reserveFollowUp(g, why);
      expect(g.followUps).toBe(i);
      expect(g.lastActivity).toBe(T0);
    }
    expect(matchFollowUp(g, base, "FAILED: other", T0)).toEqual({ ok: false, reason: "budget" });
    expect(matchFollowUp(refreshGrant(g, T0 + 1), base, undefined, T0 + 1)).toEqual({ ok: false, reason: "budget" });
    expect(createGrant(fields, T0, g).followUps).toBeUndefined();
  });

  it("the same failure again stops the chain; a finished run or another failure doesn't", () => {
    const g = reserveFollowUp(createGrant(fields, T0), "FAILED: tests fail (3 of 10)");
    expect(matchFollowUp(g, base, "failed:  tests fail (4 of 10) ", T0)).toEqual({ ok: false, reason: "repeat" });
    expect(matchFollowUp(g, base, "FAILED: lint fails", T0).ok).toBe(true);
    expect(matchFollowUp(g, base, undefined, T0).ok).toBe(true);
    // A follow-up after a finished run forgets the earlier failure.
    expect(reserveFollowUp(g, undefined).lastFailure).toBeUndefined();
    expect(failureFingerprint("A  1\n2")).toBe("a # #");
  });

  it("still needs the grant itself: lapsed, revoked or replaced refuses", () => {
    const g = createGrant(fields, T0);
    expect(matchFollowUp(g, base, undefined, T0 + GRANT_IDLE_MS)).toEqual({ ok: false, reason: "expired" });
    expect(matchFollowUp(revokeGrant(g), base, undefined, T0)).toEqual({ ok: false, reason: "revoked" });
    expect(matchFollowUp(g, { ...base, generation: 2 }, undefined, T0)).toEqual({ ok: false, reason: "stale" });
    expect(followUpRefusedText("budget")).toBe("Bean stopped following up on its own: Bean already followed up twice on that task. Reply to tell it how to go on.");
    expect(followUpRefusedText("revoked")).toContain("That agent session was closed. Reply");
  });
});
