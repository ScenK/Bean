import { describe, expect, it } from "vitest";
import { cliAuthPresent, headlessRoutinesOn, missedNotice, tzProblem } from "../src/headless-routines.js";

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
