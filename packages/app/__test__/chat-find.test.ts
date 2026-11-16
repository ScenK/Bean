// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { findRanges } from "../src/renderer/components/chat/chat-find.js";

// #901: Cmd/Ctrl+F in the chat window — what counts as a match in the shown chat's message list.
const at = (html: string): HTMLElement => {
  const root = document.createElement("div");
  root.innerHTML = html;
  return root;
};
const found = (html: string, q: string): string[] => findRanges(at(html), q).map((r) => r.toString());

describe("findRanges", () => {
  it("matches case-insensitively, every occurrence", () => {
    expect(found("<p>Bean beans BEAN</p>", "bean")).toEqual(["Bean", "bean", "BEAN"]);
  });

  it("matches a phrase across inline markup", () => {
    const ranges = findRanges(at("<p>run <code>pnpm</code> <b>te</b>st now</p>"), "pnpm test");
    expect(ranges.map((r) => r.toString())).toEqual(["pnpm test"]);
  });

  it("never matches across block boundaries", () => {
    expect(found("<p>hello</p><p>world</p>", "helloworld")).toEqual([]);
    expect(found("<div>hello</div><div>world</div>", "hello world")).toEqual([]);
  });

  it("folds whitespace so a soft line break matches a space", () => {
    expect(found("<p>hello\nworld</p>", "hello world")).toEqual(["hello\nworld"]);
  });

  it("skips a closed <details> body but keeps its summary; an open one is searched", () => {
    const html = "<details><summary>needle head</summary><p>needle body</p></details>";
    expect(found(html, "needle")).toHaveLength(1);
    expect(found(html.replace("<details>", "<details open>"), "needle")).toHaveLength(2);
  });

  it("skips screen-reader-only labels, buttons, form controls and hidden elements", () => {
    const html = `<span class="bean-sr-only">You: </span><button>You</button><textarea>You</textarea>
      <div hidden>You</div><p>you</p>`;
    expect(found(html, "you")).toEqual(["you"]);
  });

  it("finds a single CJK character", () => {
    expect(found("<p>你好，世界。好的</p>", "好")).toEqual(["好", "好"]);
  });

  it("treats the query literally, and an empty query finds nothing", () => {
    expect(found("<p>a.b axb (x)</p>", "a.b")).toEqual(["a.b"]);
    expect(found("<p>(x)</p>", "(x)")).toEqual(["(x)"]);
    expect(found("<p>anything</p>", "")).toEqual([]);
  });
});
