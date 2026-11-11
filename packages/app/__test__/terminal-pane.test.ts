// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { pathLinks, tabShortcut } from "../src/renderer/components/chat/TerminalPane.js";

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

// A buffer row from cells: "" = an empty cell, "\0" = the right half of the wide char before it.
const row = (cells: string[]) => ({
  getCell: (x: number) => {
    const c = cells[x];
    if (c === undefined) return undefined;
    return { getChars: () => (c === "\0" ? "" : c), getWidth: () => (c === "\0" ? 0 : 1) } as never;
  },
});
const ascii = (s: string) => row([...s]);
const links = (s: string) => pathLinks(ascii(s), s.length);

describe("pathLinks", () => {
  it("links absolute and ~/ paths at their 1-based cell columns", () => {
    expect(links("/Users/me/dev/bean")).toEqual([{ value: "/Users/me/dev/bean", start: 1, end: 18 }]);
    expect(links("see ~/notes/a.md:12, then")).toEqual([{ value: "~/notes/a.md:12", start: 5, end: 19 }]);
    expect(links("(/tmp/x.log)")).toEqual([{ value: "/tmp/x.log", start: 2, end: 11 }]);
  });

  it("never links relative paths, URLs, prompts or a lone slash", () => {
    expect(links("./run.sh ../up src/a.ts README.md")).toEqual([]);
    expect(links("https://example.com/a file:///etc/hosts")).toEqual([]);
    expect(links("me@host:~/dev$ / ~ ~root/x")).toEqual([]);
  });

  it("maps columns past a wide char and empty cells", () => {
    const cells = ["日", "\0", "", "/", "t", "m", "p"];
    expect(pathLinks(row(cells), cells.length)).toEqual([{ value: "/tmp", start: 4, end: 7 }]);
  });
});
