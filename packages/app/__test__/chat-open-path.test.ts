import { describe, expect, it, vi } from "vitest";
import { chatPathTarget, chooseOpen, openChatPath, PATH_LIMIT, type OpenPathDeps } from "../src/chat-open-path.js";
import { classifyLink, linkAt } from "../src/renderer/components/chat/chat-links.js";

const HOME = "/Users/me";

describe("chatPathTarget", () => {
  it("resolves absolute, ~/ and (with a project) relative paths, stripping a :line[:col] suffix", () => {
    expect(chatPathTarget("/tmp/a.md", undefined, HOME)).toBe("/tmp/a.md");
    expect(chatPathTarget(" /tmp/x/../a.md:12:3 ", undefined, HOME)).toBe("/tmp/a.md");
    expect(chatPathTarget("~/notes/a.md:7", undefined, HOME)).toBe("/Users/me/notes/a.md");
    expect(chatPathTarget("~", undefined, HOME)).toBe(HOME);
    expect(chatPathTarget("src/a.ts", "/proj", HOME)).toBe("/proj/src/a.ts");
    expect(chatPathTarget("../other/b.ts", "/proj", HOME)).toBe("/other/b.ts"); // outside the project is allowed
  });

  it("refuses schemes, ~user, control characters, oversize input, non-strings and relative paths with no project", () => {
    for (const bad of [
      "file:///etc/passwd", "javascript:alert(1)", "vscode://file/x", "mailto:a@b.c", "~root/.ssh", "/tmp/a\nb", "/tmp/\x00",
      `/${"a".repeat(PATH_LIMIT)}`, "", "  ", 42, undefined, null,
    ]) {
      expect(chatPathTarget(bad, "/proj", HOME)).toBeUndefined();
    }
    expect(chatPathTarget("src/a.ts", undefined, HOME)).toBeUndefined();
  });
});

describe("chooseOpen", () => {
  it("enters a plain directory, reveals a package, opens a file in the editor", () => {
    expect(chooseOpen("dir", "/proj/src", "Zed", "")).toBe("finder");
    expect(chooseOpen("dir", "/Applications/Evil.app", "Zed", "")).toBe("reveal");
    expect(chooseOpen("dir", "/proj/App.xcodeproj", "Zed", "")).toBe("reveal");
    expect(chooseOpen("file", "/proj/a.ts", "Zed", "")).toBe("editor");
    expect(chooseOpen("other", "/tmp/sock", "Zed", "")).toBe("reveal");
  });

  it("reveals a file when no editor is set or the editor is a terminal app", () => {
    expect(chooseOpen("file", "/a.sh", "", "")).toBe("reveal");
    expect(chooseOpen("file", "/a.sh", "  ", "")).toBe("reveal");
    for (const t of ["Terminal", "terminal.app", "iTerm", "iTerm2", "/Applications/iTerm.app"]) expect(chooseOpen("file", "/a.sh", t, "")).toBe("reveal");
    expect(chooseOpen("file", "/a.sh", "Ghostty", "Ghostty")).toBe("reveal");
    expect(chooseOpen("file", "/a.sh", "Ghostty.app", "/Applications/Ghostty.app")).toBe("reveal");
  });
});

describe("openChatPath", () => {
  const deps = (over: Partial<OpenPathDeps> & { kind?: "dir" | "file" | "missing" } = {}) => {
    const kind = over.kind ?? "file";
    return {
      stat: vi.fn(async () => {
        if (kind === "missing") throw new Error("ENOENT");
        return { isDirectory: () => kind === "dir", isFile: () => kind === "file" };
      }),
      editorApp: "Zed", terminalApp: "",
      openDir: vi.fn(async () => {}), reveal: vi.fn(), openInEditor: vi.fn(async () => {}),
      ...over,
    };
  };

  it("a missing path is a no-op", async () => {
    const d = deps({ kind: "missing" });
    expect(await openChatPath("/nope", d)).toBeUndefined();
    expect([d.openDir, d.reveal, d.openInEditor].map((f) => f.mock.calls.length)).toEqual([0, 0, 0]);
  });

  it("opens a file with the editor's argv, a directory in Finder", async () => {
    const f = deps({ editorApp: " Zed " });
    expect(await openChatPath("/proj/a.ts", f)).toBe("editor");
    expect(f.openInEditor.mock.calls).toEqual([["Zed", "/proj/a.ts"]]);
    const d = deps({ kind: "dir" });
    expect(await openChatPath("/proj/src", d)).toBe("finder");
    expect(d.openDir.mock.calls).toEqual([["/proj/src"]]);
  });

  it("a failed editor launch reveals the file instead of opening it elsewhere", async () => {
    const d = deps({ openInEditor: vi.fn(async () => { throw new Error("Unable to find application named 'Nope'"); }) });
    expect(await openChatPath("/proj/a.ts", d)).toBe("reveal");
    expect(d.reveal.mock.calls).toEqual([["/proj/a.ts"]]);
  });
});

describe("chat link tokens", () => {
  it("classifies URLs and paths, and leaves fractions, dates and and/or as text", () => {
    for (const p of ["/Users/me/a.md", "~/notes/a.md", "./a.ts", "../b/c.ts", "src/a.ts", "dir/file.ext:12:3", "/tmp", "packages/app/src/ipc.ts"]) {
      expect(classifyLink(p)).toBe("path");
    }
    expect(classifyLink("https://example.com/a?b=1")).toBe("url");
    for (const t of ["1/2", "2026/11/10", "and/or", "1/2.5", "/", "~/", "hello", "a.ts", "ftp://x"]) expect(classifyLink(t)).toBeUndefined();
  });

  it("finds the token under the offset, trimmed of surrounding punctuation", () => {
    const text = "Saved to (/tmp/out.md), see https://example.com/x. Done";
    expect(linkAt(text, text.indexOf("out"))).toMatchObject({ kind: "path", value: "/tmp/out.md" });
    expect(linkAt(text, text.indexOf("example"))).toMatchObject({ kind: "url", value: "https://example.com/x" });
    expect(linkAt(text, text.indexOf("Done"))).toBeUndefined();
    const t = linkAt(text, text.indexOf("/tmp"))!;
    expect(text.slice(t.start, t.end)).toBe("/tmp/out.md");
    expect(linkAt("open `src/a.ts:4`.", 7)).toMatchObject({ value: "src/a.ts:4" });
  });
});
