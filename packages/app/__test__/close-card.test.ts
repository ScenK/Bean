// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { closeCard } from "../src/renderer/components/chat/ChatWindow.js";
import { leaveTitle } from "../src/renderer/components/chat/ChatSession.js";

// #664: a running terminal command joins the window-close card and the off-the-record leave card.
describe("close and leave cards", () => {
  it("terminal only: names the foreground command", () => {
    expect(closeCard([{ delegates: 0, terminal: "pnpm" }]))
      .toEqual({ title: "pnpm is still running in the terminal — closing stops it.", stop: "Stop & close" });
  });

  it("terminal + delegate, terminal + live: combined count, generic wording", () => {
    expect(closeCard([{ delegates: 1, terminal: "pnpm" }]))
      .toEqual({ title: "Closing stops 2 tasks in 1 chat.", stop: "Stop & close" });
    expect(closeCard([{ delegates: 0, live: "claude", terminal: "pnpm" }]))
      .toEqual({ title: "Closing stops 2 tasks in 1 chat.", stop: "Stop & close" });
  });

  it("multi-chat: terminals count with delegates and live sessions", () => {
    expect(closeCard([{ delegates: 0, terminal: "pnpm" }, { delegates: 0, terminal: "vite" }]).title).toBe("Closing stops 2 tasks in 2 chats.");
    expect(closeCard([{ delegates: 2, terminal: "pnpm" }, { delegates: 0, live: "codex" }]).title).toBe("Closing stops 4 tasks in 2 chats.");
  });

  it("without a terminal the existing wording holds", () => {
    expect(closeCard([{ delegates: 1 }]).title).toBe("A delegated task is still running — closing will stop it.");
    expect(closeCard([{ delegates: 0, live: "claude" }]).stop).toBe("End Claude Code session & close");
  });

  it("leave card: terminal, task, both, neither", () => {
    expect(leaveTitle({ delegates: 0, terminal: "pnpm" })).toBe("Leaving discards this chat and stops pnpm in its terminal.");
    expect(leaveTitle({ delegates: 1 })).toBe("Leaving discards this chat and stops its task.");
    expect(leaveTitle({ delegates: 0, live: "claude", terminal: "pnpm" })).toBe("Leaving discards this chat and stops its task and pnpm in its terminal.");
    expect(leaveTitle({ delegates: 0 })).toBeUndefined();
  });
});
