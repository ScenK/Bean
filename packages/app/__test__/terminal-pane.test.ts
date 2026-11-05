// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { tabShortcut } from "../src/renderer/components/chat/TerminalPane.js";

const key = (code: string, mods: Partial<Pick<KeyboardEvent, "metaKey" | "shiftKey" | "ctrlKey" | "altKey">> = {}): KeyboardEvent =>
  new KeyboardEvent("keydown", { code, metaKey: true, ...mods });

describe("tabShortcut", () => {
  it("maps Cmd+T, Cmd+1…4 and Cmd+Shift+[ / ] by key code", () => {
    expect(tabShortcut(key("KeyT"))).toEqual({ kind: "new" });
    expect(tabShortcut(key("Digit1"))).toEqual({ kind: "select", index: 0 });
    expect(tabShortcut(key("Digit4"))).toEqual({ kind: "select", index: 3 });
    expect(tabShortcut(key("BracketLeft", { shiftKey: true }))).toEqual({ kind: "step", by: -1 });
    expect(tabShortcut(key("BracketRight", { shiftKey: true }))).toEqual({ kind: "step", by: 1 });
  });

  it("leaves everything else to the shell and the window", () => {
    expect(tabShortcut(key("Digit5"))).toBeUndefined();
    expect(tabShortcut(key("KeyW"))).toBeUndefined(); // Cmd+W stays Close Window
    expect(tabShortcut(key("KeyT", { metaKey: false, ctrlKey: true }))).toBeUndefined(); // readline's Control+T
    expect(tabShortcut(key("KeyT", { shiftKey: true }))).toBeUndefined();
    expect(tabShortcut(key("KeyT", { altKey: true }))).toBeUndefined();
    expect(tabShortcut(key("BracketLeft"))).toBeUndefined();
  });
});
