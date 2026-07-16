import { describe, expect, it } from "vitest";
import { systemControlCommand, systemControlTool } from "../src/system-control.js";

describe("systemControlCommand", () => {
  it("maps volume to osascript with a clamped integer", () => {
    expect(systemControlCommand({ kind: "volume", level: 42.4 })).toEqual({
      cmd: "osascript",
      args: ["-e", "set volume output volume 42"],
    });
  });

  it("rejects out-of-range volume", () => {
    expect(() => systemControlCommand({ kind: "volume", level: 101 })).toThrow("0-100");
    expect(() => systemControlCommand({ kind: "volume", level: NaN })).toThrow("0-100");
  });

  it("maps mute", () => {
    expect(systemControlCommand({ kind: "mute", muted: true }).args[1]).toBe("set volume output muted true");
  });

  it("maps media with default Music app", () => {
    expect(systemControlCommand({ kind: "media", action: "next" }).args[1]).toBe('tell application "Music" to next track');
    expect(systemControlCommand({ kind: "media", action: "playpause", app: "Spotify" }).args[1]).toBe('tell application "Spotify" to playpause');
  });

  it("maps app launch/quit and rejects injection-shaped names", () => {
    expect(systemControlCommand({ kind: "app", action: "launch", name: "Visual Studio Code" })).toEqual({
      cmd: "open",
      args: ["-a", "Visual Studio Code"],
    });
    expect(systemControlCommand({ kind: "app", action: "quit", name: "Safari" }).args[1]).toBe('quit app "Safari"');
    expect(() => systemControlCommand({ kind: "app", action: "quit", name: 'x" & do shell script "rm' })).toThrow("invalid app name");
    expect(() => systemControlCommand({ kind: "app", action: "quit", name: "x\\" })).toThrow("invalid app name");
  });

  it("accepts non-English app names", () => {
    expect(systemControlCommand({ kind: "app", action: "launch", name: "网易云音乐" }).args).toEqual(["-a", "网易云音乐"]);
    expect(systemControlCommand({ kind: "app", action: "quit", name: "微信" }).args[1]).toBe('quit app "微信"');
  });
});

describe("systemControlTool", () => {
  it("refuses when disabled and never execs", async () => {
    let called = false;
    const tool = systemControlTool(() => false, async () => { called = true; });
    expect(await tool.run({ kind: "mute", muted: true })).toContain("disabled");
    expect(called).toBe(false);
  });

  it("execs the mapped command when enabled", async () => {
    const seen: string[][] = [];
    const tool = systemControlTool(() => true, async (cmd, args) => { seen.push([cmd, ...args]); });
    expect(await tool.run({ kind: "volume", level: 30 })).toBe("done");
    expect(seen).toEqual([["osascript", "-e", "set volume output volume 30"]]);
  });

  it("returns invalid input as a tool error string", async () => {
    const tool = systemControlTool(() => true, async () => {});
    expect(await tool.run({ kind: "app", action: "quit", name: "" })).toContain("error:");
  });
});
