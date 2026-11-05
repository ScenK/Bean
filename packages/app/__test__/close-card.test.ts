// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { closeCard } from "../src/renderer/components/chat/ChatWindow.js";
import { commandList, leaveTitle } from "../src/renderer/components/chat/ChatSession.js";

// #664/#675: every running terminal command (one per busy tab) joins the window-close card and the
// off-the-record leave card.
describe("close and leave cards", () => {
  it("command list: one, two, three-plus", () => {
    expect(commandList(["npm"])).toBe("npm");
    expect(commandList(["npm", "vim"])).toBe("npm and vim");
    expect(commandList(["npm", "vim", "top"])).toBe("npm, vim + 1 more");
    expect(commandList(["npm", "vim", "top", "make"])).toBe("npm, vim + 2 more");
  });

  it("one chat, terminals only: names the commands", () => {
    expect(closeCard([{ delegates: 0, terminal: ["pnpm"] }]))
      .toEqual({ title: "pnpm is still running in the terminal — closing stops it.", stop: "Stop & close" });
    expect(closeCard([{ delegates: 0, terminal: ["npm", "vim"] }]))
      .toEqual({ title: "npm and vim are still running in this chat's terminals — closing stops them.", stop: "Stop & close" });
    expect(closeCard([{ delegates: 0, terminal: ["npm", "vim", "top"] }]).title)
      .toBe("npm, vim + 1 more are still running in this chat's terminals — closing stops them.");
  });

  it("terminal + delegate, terminal + live: each command counts, generic wording", () => {
    expect(closeCard([{ delegates: 1, terminal: ["pnpm"] }]))
      .toEqual({ title: "Closing stops 2 tasks in 1 chat.", stop: "Stop & close" });
    expect(closeCard([{ delegates: 0, live: "claude", terminal: ["pnpm"] }]))
      .toEqual({ title: "Closing stops 2 tasks in 1 chat.", stop: "Stop & close" });
    expect(closeCard([{ delegates: 1, terminal: ["npm", "vim"] }]).title).toBe("Closing stops 3 tasks in 1 chat.");
  });

  it("several chats: every command counts with delegates and live sessions", () => {
    expect(closeCard([{ delegates: 0, terminal: ["pnpm"] }, { delegates: 0, terminal: ["vite"] }]).title).toBe("Closing stops 2 tasks in 2 chats.");
    expect(closeCard([{ delegates: 0, terminal: ["npm", "vim"] }, { delegates: 0, terminal: ["vite"] }]).title).toBe("Closing stops 3 tasks in 2 chats.");
    expect(closeCard([{ delegates: 0, terminal: ["npm", "vim", "top"] }, { delegates: 0, live: "codex" }]).title).toBe("Closing stops 4 tasks in 2 chats.");
    expect(closeCard([{ delegates: 2, terminal: ["pnpm"] }, { delegates: 0, live: "codex" }]).title).toBe("Closing stops 4 tasks in 2 chats.");
  });

  it("without a terminal the existing wording holds", () => {
    expect(closeCard([{ delegates: 1 }]).title).toBe("A delegated task is still running — closing will stop it.");
    expect(closeCard([{ delegates: 0, live: "claude" }]).stop).toBe("End Claude Code session & close");
  });

  it("leave card: one, two, three-plus commands, with and without a task", () => {
    expect(leaveTitle({ delegates: 0, terminal: ["pnpm"] })).toBe("Leaving discards this chat and stops pnpm in its terminal.");
    expect(leaveTitle({ delegates: 0, terminal: ["npm", "vim"] })).toBe("Leaving discards this chat and stops npm and vim in its terminals.");
    expect(leaveTitle({ delegates: 0, terminal: ["npm", "vim", "top"] })).toBe("Leaving discards this chat and stops npm, vim + 1 more in its terminals.");
    expect(leaveTitle({ delegates: 1 })).toBe("Leaving discards this chat and stops its task.");
    expect(leaveTitle({ delegates: 0, live: "claude", terminal: ["pnpm"] })).toBe("Leaving discards this chat and stops its task and pnpm in its terminal.");
    expect(leaveTitle({ delegates: 1, terminal: ["npm", "vim"] })).toBe("Leaving discards this chat and stops its task and npm and vim in its terminals.");
    expect(leaveTitle({ delegates: 0 })).toBeUndefined();
  });
});
