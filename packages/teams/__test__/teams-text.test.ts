import { expect, test } from "vitest";
import { teamsText } from "../src/teams-text.js";

test("a lone newline between prose lines becomes a paragraph break", () => {
  expect(teamsText("• first\n• second")).toBe("• first\n\n• second");
  expect(teamsText("intro\n**Title** text")).toBe("intro\n\n**Title** text");
  expect(teamsText("see #general\n#general\n-5°C")).toBe("see #general\n\n#general\n\n-5°C");
});

test("a newline before a block start stays single", () => {
  expect(teamsText("- a\n- b")).toBe("- a\n- b");
  expect(teamsText("Steps:\n- a\n* b\n+ c\n1. d\n2) e")).toBe("Steps:\n- a\n* b\n+ c\n1. d\n2) e");
  expect(teamsText("| a | b |\n|---|---|\n| 1 | 2 |")).toBe("| a | b |\n|---|---|\n| 1 | 2 |");
  expect(teamsText("text\n> quote\n## Heading\n#")).toBe("text\n> quote\n## Heading\n#");
  expect(teamsText("text\n   - indented")).toBe("text\n   - indented");
});

test("existing blank lines and leading/trailing newlines are unchanged", () => {
  expect(teamsText("a\n\nb\n\n\nc")).toBe("a\n\nb\n\n\nc");
  expect(teamsText("\na\nb\n")).toBe("\na\n\nb\n");
  expect(teamsText("")).toBe("");
});

test("fenced code is left alone", () => {
  expect(teamsText("run:\n```sh\nls\npwd\n```\ndone\nok")).toBe("run:\n```sh\nls\npwd\n```\n\ndone\n\nok");
  expect(teamsText("~~~~\na\n~~~\nb\n~~~~\nc\nd")).toBe("~~~~\na\n~~~\nb\n~~~~\n\nc\n\nd");
  expect(teamsText("````\na\n```\nb\n````")).toBe("````\na\n```\nb\n````");
  expect(teamsText("x\n```\nunclosed\nstill code")).toBe("x\n```\nunclosed\nstill code");
});

test("CRLF is normalized and the transform is idempotent", () => {
  expect(teamsText("a\r\nb\r\n\r\nc")).toBe("a\n\nb\n\nc");
  const dense = "Hi\nline 2\n- a\n- b\ntail\n```\ncode\nmore\n```\n> q\nend\n\n\nlast\n";
  expect(teamsText(teamsText(dense))).toBe(teamsText(dense));
});

test("adversarial delimiter runs stay linear and well-formed", () => {
  const evil = ("`".repeat(5000) + "\n" + "~".repeat(3) + "\n").repeat(200) + "|>#-*\n".repeat(1000);
  const t0 = performance.now();
  const out = teamsText(evil);
  expect(performance.now() - t0).toBeLessThan(1000);
  expect(teamsText(out)).toBe(out);
});
