import { describe, expect, it } from "vitest";
import { lineDiff } from "../src/renderer/components/skills/line-diff.js";

describe("lineDiff", () => {
  it("marks kept, removed and added lines, frontmatter included", () => {
    const before = "---\ntarget: terminal\n---\n# Review\nstep one\nstep two";
    const after = "---\ntarget: terminal\nbrowser: true\n---\n# Review\nstep one\nstep 2";
    const diff = lineDiff(before, after);
    expect(diff.filter((l) => l.op !== " ")).toEqual([
      { op: "+", text: "browser: true" },
      { op: "-", text: "step two" },
      { op: "+", text: "step 2" },
    ]);
    // Replaying either side of the diff gives back the original file.
    expect(diff.filter((l) => l.op !== "+").map((l) => l.text).join("\n")).toBe(before);
    expect(diff.filter((l) => l.op !== "-").map((l) => l.text).join("\n")).toBe(after);
  });
});
