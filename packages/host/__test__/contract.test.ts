import { describe, expect, it } from "vitest";
import { argsOk, buildHandshake, checkHandshake, CONTRACT_VERSION, guard } from "../src/contract.js";

describe("handshake (#807)", () => {
  it("round-trips a host's handshake", () => {
    const h = buildHandshake("1.2.3", "darwin", ["pty", "pathOpen"]);
    expect(h).toEqual({ contract: CONTRACT_VERSION, core: "1.2.3", platform: "darwin", capabilities: ["pty", "pathOpen"] });
    expect(checkHandshake(JSON.parse(JSON.stringify(h)))).toEqual({ ok: true, handshake: h });
  });

  it("reports a contract version mismatch as such, apart from a malformed reply", () => {
    const newer = { ...buildHandshake("9.0.0", "linux", []), contract: CONTRACT_VERSION + 1 };
    expect(checkHandshake(newer)).toEqual({
      ok: false, reason: "version", message: expect.stringMatching(new RegExp(`core speaks v${CONTRACT_VERSION + 1}, this shell speaks v${CONTRACT_VERSION}`)),
    });
    expect(checkHandshake(undefined)).toMatchObject({ ok: false, reason: "malformed" });
    expect(checkHandshake({ ...buildHandshake("1", "darwin", []), capabilities: ["teleport"] })).toMatchObject({ ok: false, reason: "malformed" });
  });

  it("guards check arity and shallow shape", () => {
    const { str, num, obj, arr, opt, nullable } = guard;
    expect(argsOk([str, opt(num)], ["a"])).toBe(true);
    expect(argsOk([str], ["a", "b"])).toBe(false);
    expect(argsOk([obj], [[]])).toBe(false);
    expect(argsOk([obj], [null])).toBe(false);
    expect(argsOk([num], [Number.NaN])).toBe(false);
    expect(argsOk([arr(str), nullable(str)], [["a"], null])).toBe(true);
    expect(argsOk([arr(str)], [["a", 1]])).toBe(false);
  });
});
