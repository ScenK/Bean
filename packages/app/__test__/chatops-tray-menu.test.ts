import { describe, expect, it } from "vitest";
import { chatopsMenuRows } from "../src/chatops-tray-menu.js";
import type { ChatopsState } from "../src/chatops-servers.js";

const status = (discord: ChatopsState, teams: ChatopsState) => ({ discord, teams });

describe("chatopsMenuRows", () => {
  it("shows a gray dot and unchecked when a bot is stopped", () => {
    const rows = chatopsMenuRows(status({ running: false }, { running: false }));
    expect(rows).toEqual([
      { bot: "discord", label: "Discord", dot: "⚪", checked: false },
      { bot: "teams", label: "Teams", dot: "⚪", checked: false },
    ]);
  });

  it("shows a green dot and checked when a bot is running", () => {
    const rows = chatopsMenuRows(status({ running: true }, { running: false }));
    expect(rows[0]).toEqual({ bot: "discord", label: "Discord", dot: "🟢", checked: true });
  });

  it("shows a red dot and carries the error message when a bot errored", () => {
    const rows = chatopsMenuRows(status({ running: false, error: "boom" }, { running: false }));
    expect(rows[0]).toEqual({ bot: "discord", label: "Discord", dot: "🔴", checked: false, error: "boom" });
  });

  it("prefers the red error dot even if running is somehow still true", () => {
    const rows = chatopsMenuRows(status({ running: true, error: "boom" }, { running: false }));
    expect(rows[0]!.dot).toBe("🔴");
  });

  it("always returns discord then teams, in that order", () => {
    const rows = chatopsMenuRows(status({ running: false }, { running: true }));
    expect(rows.map((r) => r.bot)).toEqual(["discord", "teams"]);
  });

  it("collapses newlines/whitespace in the error into one line", () => {
    const rows = chatopsMenuRows(status({ running: false, error: "boom\nat foo.js:12\n  bar" }, { running: false }));
    expect(rows[0]!.error).toBe("boom at foo.js:12 bar");
  });

  it("truncates a long error with an ellipsis instead of growing the menu width", () => {
    const longError = "x".repeat(80);
    const rows = chatopsMenuRows(status({ running: false, error: longError }, { running: false }));
    expect(rows[0]!.error).toHaveLength(40);
    expect(rows[0]!.error).toBe(`${"x".repeat(39)}…`);
  });

  it("leaves a short error untouched", () => {
    const rows = chatopsMenuRows(status({ running: false, error: "boom" }, { running: false }));
    expect(rows[0]!.error).toBe("boom");
  });
});
