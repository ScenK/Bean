import { describe, expect, test } from "vitest";
import { PHONE_COLS, renderStream, renderTables } from "../src/tables.js";

const fence = (...lines: string[]): string => ["```", ...lines, "```"].join("\n");

describe("renderTables", () => {
  test("an ASCII table that fits becomes a grid with two-space gutters", () => {
    const md = "Status:\n| PR | State |\n|---|:-:|\n| 1071 | merged |\n| 9 | open |\nDone.";
    expect(renderTables(md)).toBe(
      `Status:\n${fence("PR    State", "----  ------", "1071  merged", "9     open")}\nDone.`,
    );
  });

  test("the epic's CJK sample renders byte-for-byte with U+3000 padding", () => {
    const md = "| 任务 | 状态 | 负责人 |\n|---|---|---|\n| 修复表格 | 进行中 | alice |\n| Discord 卡片 | 完成 | bean |";
    const sample = fence(
      "任务　　          状态　  负责人",
      "--------－－－－  －－－  -----－－－",
      "修复表格          进行中  alice",
      "Discord 卡片　　  完成　  bean",
    );
    // 37 columns: wider than the phone, so it needs a wider width to stay a grid.
    expect(renderTables(md, 37)).toBe(sample);
    expect(renderTables(md)).not.toContain("```");
  });

  test("exactly PHONE_COLS wide is a grid; one more is records", () => {
    const row = (w: number) => `| ${"a".repeat(10)} | ${"b".repeat(w)} |\n|---|---|\n| x | y |`;
    // 10 + 2 + 21 = 33
    expect(renderTables(row(PHONE_COLS - 12))).toMatch(/^```/);
    expect(renderTables(row(PHONE_COLS - 11))).toBe(`**x** · ${"b".repeat(22)}: y`);
  });

  test("a link or emoji in the last column stays a grid; in a middle column it's records", () => {
    expect(renderTables("| a | b |\n|-|-|\n| x | ✅ |")).toBe(fence("a  b", "-  --", "x  ✅"));
    expect(renderTables("| a | b |\n|-|-|\n| x | [t](u) |")).toBe(fence("a  b", "-  ------", "x  [t](u)"));
    expect(renderTables("| a | b | c |\n|-|-|-|\n| x | ✅ | y |")).toBe("**x** · b: ✅ · c: y");
    expect(renderTables("| a | b | c |\n|-|-|-|\n| [#1](https://e/1) | ok | y |")).toBe(
      "**[#1](https://e/1)** · b: ok · c: y",
    );
  });

  test("a backtick outside the last column, or a fence marker anywhere, is records", () => {
    expect(renderTables("| a | b |\n|-|-|\n| `x` | y |")).toBe("**`x`** · b: y");
    expect(renderTables("| a | b |\n|-|-|\n| x | ```y |")).toBe("**x** · b: ```y");
  });

  test("records keep every non-empty cell and its markdown; bold first cells aren't double-bolded", () => {
    const md = `| Item | Note | Link |\n|---|---|---|\n| **Total** |  | [see](https://example.com/${"x".repeat(30)}) |`;
    expect(renderTables(md)).toBe(`**Total** · Link: [see](https://example.com/${"x".repeat(30)})`);
  });

  test("escaped pipes and pipes in code spans don't split cells", () => {
    expect(renderTables("| a | b |\n|-|-|\n| x \\| y | z |")).toBe(fence("a      b", "-----  -", "x | y  z"));
    expect(renderTables("| a | b |\n|-|-|\n| x | `p|q` |")).toBe(fence("a  b", "-  -----", "x  `p|q`"));
  });

  test("tabs become four spaces", () => {
    expect(renderTables("| a | b |\n|-|-|\n| x\ty | z |")).toBe(fence("a       b", "------  -", "x    y  z"));
  });

  test("a table inside a fenced code block or a code span is untouched", () => {
    const fenced = "```md\n| a | b |\n|-|-|\n| x | y |\n```";
    expect(renderTables(fenced)).toBe(fenced);
    const inline = "`| a | b |`\n`|-|-|`\n`| x | y |`";
    expect(renderTables(inline)).toBe(inline);
  });

  test("two tables in one text both render", () => {
    const t = "| a | b |\n|-|-|\n| x | y |";
    expect(renderTables(`${t}\n\ntext\n\n${t}`)).toBe(`${fence("a  b", "-  -", "x  y")}\n\ntext\n\n${fence("a  b", "-  -", "x  y")}`);
  });

  test("a malformed delimiter, a column-count mismatch or no body rows is untouched", () => {
    for (const md of ["| a | b |\n|-x-|---|\n| x | y |", "| a | b |\n|---|\n| x | y |", "| a | b |\n|---|---|", "a | b"]) {
      expect(renderTables(md)).toBe(md);
    }
  });

  test("short and long body rows are padded or cut to the header", () => {
    expect(renderTables("| a | b |\n|-|-|\n| x |\n| y | z | w |")).toBe(fence("a  b", "-  -", "x", "y  z"));
  });
});

describe("renderStream (#1085)", () => {
  test("a streamed table stays raw until its first row arrives, then renders each snapshot", () => {
    const head = "Results:\n| PR | State |";
    expect(renderStream(head)).toBe(head);
    expect(renderStream(`${head}\n|---|---|`)).toBe(`${head}\n|---|---|`);
    expect(renderStream(`${head}\n|---|---|\n| 1 | open |`)).toBe(`Results:\n${fence("PR  State", "--  -----", "1   open")}`);
    expect(renderStream(`${head}\n|---|---|\n| 1 | open |\n| 22 | merged |`)).toBe(
      `Results:\n${fence("PR  State", "--  ------", "1   open", "22  merged")}`,
    );
  });

  test("a render past the limit falls back to the raw snapshot", () => {
    // Records outgrow the raw rows (each repeats the header names).
    const md = `| ${"h".repeat(20)} | ${"k".repeat(20)} |\n|-|-|\n${"| a | b |\n".repeat(50)}`;
    expect(renderTables(md).length).toBeGreaterThan(md.length);
    expect(renderStream(md, renderTables(md).length)).not.toBe(md);
    expect(renderStream(md, md.length)).toBe(md);
  });
});
