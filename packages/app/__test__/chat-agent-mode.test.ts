// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import type { ChatTurn, LiveCli } from "@bean/core";
import {
  AGENT_FINAL_CHARS, TAIL_LINES, applyLiveEvent, consumeLive, canContinueLive, chatHeader, chatTurns, handoffLines, liveModelKey, liveProjectKey, offerAgent, offerLaunch,
  parseSlash, turnFooter, validModel, validProject, handoffItems, nextImageNumber, withImagePaths, mappedImageLabels, removeImageLabel, IMAGE_NOT_HANDED, pdfNotHanded,
} from "../src/renderer/components/chat/agent-mode.js";
import { slashMenu } from "../src/renderer/components/chat/slash-commands.js";
import { ChatWindow } from "../src/renderer/components/chat/ChatWindow.js";
import { PDF_NO_PATH, type ChatItem } from "../src/renderer/shared/chat-types.js";
import type { LiveEvent } from "@bean/host";
import type { DelegateEvent } from "@bean/host";

let n = 0;
const id = (): string => `t${++n}`;

describe("agent-mode helpers", () => {
  it("chatHeader shows whoever is answering: Bean's own turn, else the live agent, else Bean (#794)", () => {
    const bean = { status: "idle" as const, model: "gpt-5" };
    expect(chatHeader(bean)).toEqual({ agent: "bean", status: "idle", model: "gpt-5" });
    expect(chatHeader({ ...bean, live: { agent: "claude", model: "opus", busy: true } })).toEqual({ agent: "claude", status: "working", model: "opus" });
    expect(chatHeader({ ...bean, live: { agent: "codex", model: "o3", busy: false } })).toEqual({ agent: "codex", status: "idle", model: "o3" });
    expect(chatHeader({ ...bean, live: { agent: "codex", busy: false, stopping: true } })).toEqual({ agent: "codex", status: "working" });
    expect(chatHeader({ ...bean, live: { agent: "opencode", busy: false } })).toEqual({ agent: "opencode", status: "idle" });
    expect(chatHeader({ status: "working", model: "gpt-5", live: { agent: "claude", busy: false } })).toEqual({ agent: "bean", status: "working", model: "gpt-5" });
    expect(chatHeader({ ...bean, status: "error", live: undefined })).toEqual({ agent: "bean", status: "error", model: "gpt-5" });
  });
  it("parses only the four aliases, bare or with text", () => {
    expect(parseSlash("/claude")).toEqual({ agent: "claude", rest: "" });
    expect(parseSlash("/claude fix X\nplease")).toEqual({ agent: "claude", rest: "fix X\nplease" });
    expect(parseSlash("/bean hi")).toEqual({ agent: "bean", rest: "hi" });
    expect(parseSlash("/agy fix X")).toEqual({ agent: "agy", rest: "fix X" });
    expect(parseSlash("/claudex")).toBeUndefined();
    expect(parseSlash("/new")).toBeUndefined();
    expect(parseSlash("see /claude")).toBeUndefined();
  });

  it("an offer starts Claude Code when enabled, else the first enabled live agent", () => {
    expect(offerAgent(["codex", "claude"])).toBe("claude");
    expect(offerAgent(["opencode", "codex"])).toBe("codex");
    expect(offerAgent([])).toBeUndefined();
  });

  it("lists only installed agents in the / popover", () => {
    const names = (text: string, agents: LiveCli[]): string[] =>
      slashMenu(text, "bean", { agents, skills: [] }).map((e) => e.name);
    expect(names("/", ["claude"])).toEqual(["bean", "claude"]);
    expect(names("/c", ["claude", "codex"])).toEqual(["claude", "codex"]);
    expect(names("/claude fix", ["claude"])).toEqual([]);
    expect(names("hi", ["claude"])).toEqual([]);
  });

  it("maps agent finals into Bean's history as [Agent] <result>, capped; streaming bubbles stay out", () => {
    const items: ChatItem[] = [
      { kind: "user", id: "u1", text: "hi", source: "typed" },
      { kind: "reply", id: "r1", text: "hello" },
      { kind: "user", id: "u2", text: "fix X", source: "live" },
      { kind: "reply", id: "r2", text: "x".repeat(AGENT_FINAL_CHARS + 50), agent: "claude", session: "s1" },
      { kind: "reply", id: "r3", text: "", agent: "claude", session: "s1", streaming: true, tail: ["Read a.ts"] },
    ];
    const turns = chatTurns(items);
    expect(turns.map((t) => t.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(turns[2]).toMatchObject({ content: "fix X", source: "live" });
    expect(turns[3]!.content.startsWith("[Claude Code] xxx")).toBe(true);
    expect(turns[3]!.content.length).toBe("[Claude Code] ".length + AGENT_FINAL_CHARS + 1);
    // Close-time transcript: typed steering is citable, a composed skill prompt is not, and an
    // agent final is short context; user turns keep their id.
    const memory = chatTurns([...items, { kind: "user", id: "u3", text: "composed", display: "/review", source: "live" }], { memory: true });
    expect(memory.slice(0, 3)).toEqual([
      { role: "user", content: "hi", source: "typed", id: "u1" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "fix X", source: "typed", id: "u2" },
    ]);
    expect(memory[3]!.content.length).toBe("[Claude Code] ".length + 1000 + 1);
    expect(memory[4]).toEqual({ role: "user", content: "composed", source: "skill", id: "u3" });
  });

  it("maps every card to one record line from its state (#941); none in the memory transcript or a handoff", () => {
    const plan = { routine: "pr-digest", action: "run" as const, actionLine: "Runs its steps once now", resultsTo: "this chat", paused: false, queuesNew: false };
    const sprout = (patch: Partial<Extract<ChatItem, { kind: "sprout" }>>): ChatItem => ({ kind: "sprout", id: "s", plan, state: "pending", ...patch });
    const items: ChatItem[] = [
      { kind: "user", id: "u1", text: "run the pr digest", source: "typed" },
      sprout({}),
      sprout({ state: "running", jobId: "j" }),
      sprout({ state: "done", jobId: "j", result: "Finished" }),
      sprout({ state: "done", jobId: "j", result: "Failed" }),
      sprout({ state: "done", result: "Didn't start: busy" }),
      sprout({ state: "done", plan: { ...plan, action: "check" }, result: "nothing new" }),
      sprout({ state: "done", plan: { ...plan, action: "check" }, result: "feed unreachable", failed: true }),
      sprout({ state: "done", jobId: "j", result: "Started — see the Dashboard for how it went" }),
      { kind: "todo", id: "t", todo: { routine: "fixer", text: "SECRET todo text" }, state: "done", jobId: "j", result: "Needs attention" },
      { kind: "note", id: "n", note: { title: "SECRET title", body: "SECRET body" }, state: "saved" },
      { kind: "skill", id: "k", skill: { name: "summarize", body: "SECRET", updating: false }, state: "pending" },
      { kind: "send", id: "x", card: { id: "c", destination: "SECRET place", body: "SECRET", options: [] }, state: "sent" },
      { kind: "routine", id: "w", card: { id: "c", name: "album-watch", ask: "SECRET ask", commitment: true, how: ["SECRET"], tellYou: ["Home"] }, state: "saved" },
      { kind: "proposal", id: "p", run: { skillName: "review", projectPath: "/SECRET/path" } as never, state: "confirmed" },
      { kind: "delegate", id: "d", proposal: { projectPath: "/SECRET", instruction: "SECRET", composedPrompt: "SECRET" }, state: "done", tail: [], result: "SECRET" },
      { kind: "offer", id: "o", offer: { projectPath: "/SECRET", instruction: "SECRET" }, state: "expired" },
      { kind: "user", id: "u2", text: "tell me when it's done", source: "typed" },
    ];
    const records = chatTurns(items).filter((t) => t.role === "assistant").map((t) => t.content);
    expect(records).toEqual([
      '[card: sprout "pr-digest" — pending]',
      '[card: sprout "pr-digest" — running]',
      '[card: sprout "pr-digest" — finished]',
      '[card: sprout "pr-digest" — failed]',
      '[card: sprout "pr-digest" — didn\'t start]',
      '[card: sprout "pr-digest" — checked]',
      '[card: sprout "pr-digest" — failed]',
      '[card: sprout "pr-digest" — unknown]',
      '[card: todo "fixer" — needs attention]',
      "[card: note — saved]",
      '[card: skill "summarize" — pending]',
      "[card: send — sent]",
      '[card: sprout draft "album-watch" — saved]',
      '[card: run "review" — started]',
      "[card: delegate — finished]",
      "[card: live session — expired]",
    ]);
    for (const r of records) expect(r).not.toContain("SECRET");
    expect(chatTurns(items, { memory: true }).filter((t) => t.role === "assistant")).toEqual([]);
    expect(handoffItems(items).every((it) => it.role === "user")).toBe(true);
  });

  it("streams output into one bubble per turn and closes it on the turn result", () => {
    const ev = (e: Partial<LiveEvent> & { type: LiveEvent["type"] }): LiveEvent => ({ sessionId: "s1", agent: "codex", seq: 1, ...e } as LiveEvent);
    let items = applyLiveEvent([], ev({ type: "started", projectPath: "/p", handedOver: 0 }), id);
    // Prose shows in the bubble; only `▸ tool` parts go to the collapsed steps.
    items = applyLiveEvent(items, ev({ type: "text", text: "Checking." }), id);
    items = applyLiveEvent(items, ev({ type: "output", line: "Checking. · ▸ Bash" }), id);
    items = applyLiveEvent(items, ev({ type: "output", line: "Checking." }), id);
    expect(items[0]).toMatchObject({ text: "", display: "Checking.", tail: ["▸ Bash"], streaming: true });
    items = applyLiveEvent(items, ev({ type: "text", text: "Done." }), id);
    items = applyLiveEvent(items, ev({ type: "turn", result: "Done.", durationMs: 12_300, costUsd: 0.04 }), id);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "reply", agent: "codex", text: "Done.", display: "Checking.\n\nDone.", tail: ["▸ Bash"], streaming: false, footer: "— turn done (12.3s, $0.04)" });
    // Next turn's output opens a new bubble; ending the session closes it.
    items = applyLiveEvent(items, ev({ type: "output", line: "▸ shell" }), id);
    items = applyLiveEvent(items, ev({ type: "ended", reason: "stopped" }), id);
    expect(items[1]).toMatchObject({ streaming: false, footer: "— turn interrupted", stepCount: 1 });
    expect(turnFooter({ failed: "boom" })).toBe("— turn failed: boom");
  });

  it("keeps tail capped at TAIL_LINES while stepCount tracks the real total", () => {
    const ev = (line: string): LiveEvent => ({ sessionId: "s1", agent: "agy", seq: 1, type: "output", line } as LiveEvent);
    let items = applyLiveEvent([], { sessionId: "s1", agent: "agy", seq: 1, type: "started", projectPath: "/p", handedOver: 0 } as LiveEvent, id);
    const total = TAIL_LINES + 5;
    for (let i = 1; i <= total; i++) items = applyLiveEvent(items, ev(`▸ tool_${i}`), id);
    const reply = items[0] as Extract<ChatItem, { kind: "reply" }>;
    expect(reply.stepCount).toBe(total);
    expect(reply.tail).toHaveLength(TAIL_LINES);
    expect(reply.tail![0]).toBe("▸ tool_6");
    expect(reply.tail!.at(-1)).toBe(`▸ tool_${total}`);
  });

  it("doesn't duplicate multi-step prose when agy's turn result joins the same steps with single newlines", () => {
    const ev = (e: Partial<LiveEvent> & { type: LiveEvent["type"] }): LiveEvent => ({ sessionId: "s1", agent: "agy", seq: 1, ...e } as LiveEvent);
    let items = applyLiveEvent([], ev({ type: "started", projectPath: "/p", handedOver: 0 }), id);
    items = applyLiveEvent(items, ev({ type: "text", text: "Waiting on build." }), id);
    items = applyLiveEvent(items, ev({ type: "text", text: "Build passed.\n\nAll done." }), id);
    items = applyLiveEvent(items, ev({ type: "turn", result: "Waiting on build.\nBuild passed.\n\nAll done.\n", durationMs: 5000 }), id);
    expect(items[0]).toMatchObject({
      display: "Waiting on build.\n\nBuild passed.\n\nAll done.",
      text: "Waiting on build.\nBuild passed.\n\nAll done.\n",
      streaming: false,
    });
    // Genuine new text in the final result still appends.
    let items2 = applyLiveEvent([], ev({ type: "started", projectPath: "/p", handedOver: 0 }), id);
    items2 = applyLiveEvent(items2, ev({ type: "text", text: "Working on it." }), id);
    items2 = applyLiveEvent(items2, ev({ type: "turn", result: "Final answer.", durationMs: 1000 }), id);
    expect(items2[0]).toMatchObject({ display: "Working on it.\n\nFinal answer.", text: "Final answer." });
  });

  it("an interrupted turn closes its bubble with the partial text kept; turn-start changes nothing", () => {
    const ev = (e: Partial<LiveEvent> & { type: LiveEvent["type"] }): LiveEvent => ({ sessionId: "s1", agent: "claude", seq: 1, ...e } as LiveEvent);
    let items = applyLiveEvent([], ev({ type: "started", projectPath: "/p", handedOver: 0 }), id);
    items = applyLiveEvent(items, ev({ type: "turn-start" }), id);
    items = applyLiveEvent(items, ev({ type: "text", text: "Half an ans" }), id);
    items = applyLiveEvent(items, ev({ type: "output", line: "▸ Bash" }), id);
    items = applyLiveEvent(items, ev({ type: "turn", result: "", durationMs: 900, interrupted: true }), id);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ display: "Half an ans", tail: ["▸ Bash"], streaming: false, footer: "— turn interrupted" });
    // Interrupted wins over failed (a killed per-turn child can carry both shapes).
    expect(turnFooter({ interrupted: true, failed: "codex exited with code 143" })).toBe("— turn interrupted");
  });

  it("expands the handoff row to exactly the handed-over tail", () => {
    const history = [{ role: "user" as const, text: "a" }, { role: "reply" as const, text: " " }, { role: "reply" as const, text: "b", agent: "codex" as const }];
    expect(handoffLines(history, 1)).toEqual(["Codex: b"]);
    expect(handoffLines(history, 2)).toEqual(["You: a", "Codex: b"]);
  });
});

// ChatWindow end to end against a fake window.bean.
describe("consumeLive (#746)", () => {
  const user = (id: string, pending?: string): ChatItem => ({ kind: "user", id, text: id, source: "live", ...(pending ? { pending } : {}) });
  const reply = (id: string, extra: Partial<Extract<ChatItem, { kind: "reply" }>> = {}): ChatItem =>
    ({ kind: "reply", id, text: "", agent: "claude", session: "s1", tail: [], streaming: true, ...extra });
  const ids = (items: ChatItem[]): string[] => items.map((it) => it.id);

  it("splits an open bubble above the picked-up row: kept with no footer, the Working bubble reopens below", () => {
    const out = consumeLive([user("a"), reply("r1", { display: "prose", tail: ["▸ Bash"] }), user("b", "k")], "s1", "k", "claude", 1, "r2");
    expect(ids(out)).toEqual(["a", "r1", "b", "r2"]);
    expect(out[1]).toMatchObject({ display: "prose", tail: ["▸ Bash"], streaming: false, text: "" });
    expect(out[1]).not.toHaveProperty("footer");
    expect(out[2]).not.toHaveProperty("pending");
    expect(out[3]).toMatchObject({ kind: "reply", streaming: true, session: "s1" });
  });

  it("drops an empty open bubble above the row; one already below it stays (idle send)", () => {
    expect(ids(consumeLive([reply("r1"), user("b", "k")], "s1", "k", "claude", 1, "r2"))).toEqual(["b", "r2"]);
    const idle = [user("b", "k"), reply("r1")];
    const out = consumeLive(idle, "s1", "k", "claude", 1, "r2");
    expect(ids(out)).toEqual(["b", "r1"]);
    expect(out[1]).toBe(idle[1]);
  });

  it("clears the oldest `count` rows of that key only; clearing none changes nothing", () => {
    const items = [user("a", "k"), user("b", "old"), user("c", "k"), user("d", "k")];
    const out = consumeLive(items, "s1", "k", "codex", 2, "r");
    expect(out.map((it) => (it.kind === "user" ? it.pending : "reply"))).toEqual([undefined, "old", undefined, "k", "reply"]);
    const none = [user("b", "old"), reply("r1", { display: "x" })];
    expect(consumeLive(none, "s1", "k", "claude", 1, "r")).toBe(none);
    expect(consumeLive([user("a", "k")], "s1", "k", "claude", 0, "r")).toHaveLength(1);
  });

  it("the turn's final result lands on the newest bubble; history keeps exactly one copy", () => {
    const ev = (e: Partial<LiveEvent> & { type: LiveEvent["type"] }): LiveEvent => ({ sessionId: "s1", agent: "claude", seq: 1, ...e } as LiveEvent);
    let items = applyLiveEvent([user("a")], ev({ type: "text", text: "Before." }), id);
    items = [...items, user("b", "k")];
    expect(applyLiveEvent(items, ev({ type: "consumed", count: 1 }), id)).toBe(items);
    items = consumeLive(items, "s1", "k", "claude", 1, id());
    items = applyLiveEvent(items, ev({ type: "text", text: "After." }), id);
    items = applyLiveEvent(items, ev({ type: "turn", result: "After.", durationMs: 10 }), id);
    const replies = items.filter((it): it is Extract<ChatItem, { kind: "reply" }> => it.kind === "reply");
    expect(replies.map((r) => [r.display, r.text, r.footer])).toEqual([["Before.", "", undefined], ["After.", "After.", "— turn done (0.0s)"]]);
    expect(chatTurns(items).filter((t) => t.role === "assistant")).toEqual([{ role: "assistant", content: "[Claude Code] After." }]);
  });
});

describe("canContinueLive", () => {
  const card = (receipt?: { label: string; command: string; sessionId?: string; agent?: "claude" | "codex" }): ChatItem => ({
    kind: "delegate", id: "d", proposal: { projectPath: "/p", instruction: "i", composedPrompt: "i" }, state: "done", tail: [],
    ...(receipt ? { receipt } : {}),
  });
  it("needs a live receipt, an enabled CLI and no live session in the window", () => {
    const live = { label: "l", command: "c", sessionId: "s", agent: "claude" as const };
    expect(canContinueLive(card(live), ["claude"], false)).toBe(true);
    expect(canContinueLive(card(live), ["claude"], true)).toBe(false);
    expect(canContinueLive(card(live), ["codex"], false)).toBe(false);
    expect(canContinueLive(card({ label: "l", command: "c" }), ["claude"], false)).toBe(false);
    expect(canContinueLive(card(), ["claude"], false)).toBe(false);
  });

  it("also offers it on an ended live session's status row; its child's ended event clears `exiting`", () => {
    const row: ChatItem = { kind: "status", id: "r", text: "ended", tone: "info", receipt: { sessionId: "sess-a", agent: "codex", label: "l" }, exiting: "s1" };
    expect(canContinueLive(row, ["codex"], false)).toBe(true);
    expect(canContinueLive({ kind: "status", id: "x", text: "t", tone: "info" }, ["codex"], false)).toBe(false);
    const ev = (type: "session" | "ended"): LiveEvent => (type === "session"
      ? { sessionId: "s1", agent: "codex", seq: 2, type, receipt: { sessionId: "sess-a", agent: "codex", label: "l" } }
      : { sessionId: "s1", agent: "codex", seq: 3, type, reason: "stopped" });
    expect(applyLiveEvent([row], ev("session"), () => "n")).toEqual([row]);
    expect(applyLiveEvent([row], ev("ended"), () => "n")).toEqual([{ kind: "status", id: "r", text: "ended", tone: "info", receipt: row.receipt }]);
  });
});

describe("per-agent picks helpers (#612)", () => {
  const models = [
    { id: "sonnet", label: "sonnet", availableOn: ["claude" as const] },
    { id: "gpt-5", label: "gpt-5", availableOn: ["codex" as const, "opencode" as const] },
  ];
  const projects = [{ path: "/p" }, { path: "/q" }];

  it("keys: the model key is chatops' live:model:<cli>, the project key is desktop-only", () => {
    expect(liveModelKey("claude")).toBe("live:model:claude");
    expect(liveProjectKey("codex")).toBe("desktop:live:project:codex");
  });

  it("a stale or other-CLI model falls back to that CLI's first configured model; a removed project is scratch; absent keeps", () => {
    expect(validModel(models, "claude", "sonnet")).toBe("sonnet");
    expect(validModel(models, "claude", "gpt-5")).toBe("sonnet");
    expect(validModel(models, "claude", "opus-old")).toBe("sonnet");
    expect(validModel(models, "claude", "")).toBe("sonnet");
    expect(validModel([], "claude", "sonnet")).toBeUndefined();
    expect(validProject(projects, "/p")).toBe("/p");
    expect(validProject(projects, "/gone")).toBe("");
    expect(validProject(projects, "")).toBe("");
    expect(validProject(projects, undefined)).toBeUndefined();
  });

  it("an offer's registered project wins, else the agent's remembered one, else scratch; model is the agent's or first configured", () => {
    const picks = { claude: { project: "/q", model: "sonnet" } };
    expect(offerLaunch("/p", "claude", picks, projects, models)).toEqual({ projectPath: "/p", model: "sonnet" });
    expect(offerLaunch("/scratch-abs", "claude", picks, projects, models)).toEqual({ projectPath: "/q", model: "sonnet" });
    expect(offerLaunch("/scratch-abs", "codex", picks, projects, models)).toEqual({ projectPath: "", model: "gpt-5" });
  });
});

describe("agent-mode image labels", () => {
  const labels = new Map([[1, { path: "/a.png", agent: "claude" as const }], [3, { path: "/c.png", agent: "claude" as const }]]);

  it("the agent text appends each mapped label still present once, in number order; unknown labels stay text", () => {
    expect(withImagePaths("see [Image #3] and [Image #1], again [Image #3], [Image #2]", labels))
      .toBe("see [Image #3] and [Image #1], again [Image #3], [Image #2]\n\n[Image #1]: /a.png\n[Image #3]: /c.png");
    expect(withImagePaths("no images", labels)).toBe("no images");
    expect(mappedImageLabels("[Image #2] [Image #3]", labels)).toEqual([3]);
  });

  it("the next number is one past the highest in the user turns, the composer and the map — never reused", () => {
    const items: ChatItem[] = [{ kind: "user", id: "u", text: "[Image #5]" }, { kind: "reply", id: "r", text: "[Image #9]" }];
    expect(nextImageNumber(items, "[Image #6]", labels)).toBe(7);
    expect(nextImageNumber([], "", new Map())).toBe(1);
    expect(nextImageNumber([], "", labels)).toBe(4); // #3 was deleted from the composer: still not reused
  });

  it("removing a label keeps the rest of the draft exactly as typed (#951)", () => {
    const draft = "fix [Image #1] here:\n    def f():\n        return  1\n[Image #12] [Image #1]";
    expect(removeImageLabel(draft, 1)).toBe("fix here:\n    def f():\n        return  1\n[Image #12] ");
  });

  it("hand-off marks earlier Bean-mode image turns", () => {
    expect(handoffItems([{ kind: "user", id: "u", text: "what is this", images: ["data:image/png;base64,AA"] }]))
      .toEqual([{ role: "user", text: `what is this\n${IMAGE_NOT_HANDED}` }]);
  });

  it("hand-off marks earlier Bean-mode PDF turns by name only", () => {
    expect(handoffItems([{ kind: "user", id: "u", text: "sum up", pdf: { name: "r.pdf", size: 9 } }]))
      .toEqual([{ role: "user", text: "sum up\n[PDF attached: r.pdf — not handed over]" }]);
    expect(pdfNotHanded("r.pdf")).toBe("[PDF attached: r.pdf — not handed over]");
  });
});

describe("ChatWindow agent mode", () => {
  const listeners: Record<string, (arg: unknown) => void> = {};
  let bean: Record<string, ReturnType<typeof vi.fn>>;
  let root: HTMLDivElement;

  const flush = async (): Promise<void> => { await act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); }); };
  const send = async (text: string): Promise<void> => {
    const ta = root.querySelector("textarea.bean-input--composer") as HTMLTextAreaElement;
    ta.value = text;
    await act(async () => { ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    await flush();
  };
  const click = async (label: string): Promise<void> => {
    const btn = [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
    if (!btn) throw new Error(`no button "${label}"`);
    await act(async () => { btn.click(); });
    await flush();
  };
  const live = async (e: Omit<LiveEvent, "agent" | "seq" | "sessionId">): Promise<void> => {
    await act(async () => { listeners.onLiveEvent!({ sessionId: "s1", agent: "claude", seq: 1, ...e }); });
    await flush();
  };
  const chatCalls = (): Array<{ message: string; source: string; history: ChatTurn[] }> => bean.chat!.mock.calls.map((c) => c[0]);

  beforeEach(() => {
    bean = {
      getModel: vi.fn(async () => "m"),
      getTheme: vi.fn(async () => "light"),
      listProjects: vi.fn(async () => []),
      listSkills: vi.fn(async () => []),
      availableClis: vi.fn(async () => ["claude"]),
      availableModels: vi.fn(async () => []),
      chat: vi.fn(async () => ({ reply: "ok", model: "m" })),
      liveStart: vi.fn(async () => ({ sessionId: "s1", handedOver: 2 })),
      liveSend: vi.fn(async () => undefined),
      liveStop: vi.fn(),
      delegateStart: vi.fn(async () => "task1"),
      rememberOnClose: vi.fn(),
      allowChatClose: vi.fn(),
    };
    (window as unknown as { bean: unknown }).bean = new Proxy(bean, {
      get: (t, k: string) => t[k] ?? (k.startsWith("on") ? (cb: (a: unknown) => void) => { listeners[k] = cb; } : async () => undefined),
    });
    root = document.createElement("div");
    document.body.appendChild(root);
  });
  afterEach(() => { render(null, root); document.body.innerHTML = ""; });

  it("a pushed prompt that isn't Add to current chat (a Plan skill) goes to Bean even in agent mode", async () => {
    await act(async () => { render(h(ChatWindow, {}), root); });
    await flush();
    await send("/claude");
    await act(async () => { bean.getPendingChatPrompt = vi.fn().mockResolvedValueOnce({ prompt: "run the skill", label: "skill" }); listeners.onChatPrompt!(undefined); });
    await flush();
    expect(bean.liveStart).not.toHaveBeenCalled();
    expect(bean.chat).toHaveBeenCalledWith(expect.objectContaining({ message: "run the skill" }), expect.any(String));
  });

  it("Add to current chat goes to whoever is talking: the live agent (note in the ask), then Bean once it ends", async () => {
    bean.listNotes = vi.fn(async () => [{ slug: "plan", title: "Plan", version: 2, body: "step one" }]);
    await act(async () => { render(h(ChatWindow, {}), root); });
    await flush();
    await send("/claude fix X");
    await live({ type: "started", projectPath: "/scratch", handedOver: 0 });
    const note = { prompt: "Pick up Plan.", label: "Continue: Plan", noteSlug: "plan", here: true };
    await act(async () => { bean.getPendingChatPrompt = vi.fn().mockResolvedValueOnce(note); listeners.onChatPrompt!(undefined); });
    await flush();
    expect(bean.liveSend).toHaveBeenCalledWith("s1", expect.stringContaining("Pick up Plan."), expect.any(String));
    expect(bean.liveSend!.mock.calls[0]![1]).toContain("<<<\nstep one\n>>>");
    expect(bean.chat).not.toHaveBeenCalled();

    await send("/bean");
    await act(async () => { bean.getPendingChatPrompt = vi.fn().mockResolvedValueOnce(note); listeners.onChatPrompt!(undefined); });
    await flush();
    expect(bean.chat).toHaveBeenCalledWith(expect.objectContaining({ message: "Pick up Plan.", linkedNote: expect.objectContaining({ slug: "plan" }) }), expect.any(String));
    expect(bean.liveSend).toHaveBeenCalledTimes(1);
  });

  it("/claude streams the agent, a delegate loopback still goes to Bean, /bean returns with the agent's result in history, and close memory skips live turns", async () => {
    await act(async () => { render(h(ChatWindow, {}), root); });
    await flush();

    // A Bean turn that proposes a delegate, confirmed — its result will loop back later.
    bean.chat!.mockResolvedValueOnce({ reply: "on it", model: "m", proposedDelegate: { projectPath: "/p", instruction: "audit", composedPrompt: "audit" } });
    await send("hi bean");
    await click("Delegate");
    expect(bean.delegateStart).toHaveBeenCalledTimes(1);

    await send("/claude fix X");
    // The confirmed delegate's project is this window's last used one.
    expect(bean.liveStart).toHaveBeenCalledWith(expect.objectContaining({ agent: "claude", projectPath: "/p", ask: "fix X" }), expect.any(String));
    expect(bean.liveStart!.mock.calls[0]![0].history.map((h: { text: string }) => h.text)).toEqual(["hi bean", "on it"]);
    await live({ type: "started", projectPath: "/scratch", handedOver: 2 });
    expect(root.textContent).toContain("Handed over 2 messages");
    for (let i = 1; i <= TAIL_LINES + 2; i++) await live({ type: "output", line: `▸ step_${i}` });
    expect(root.querySelector(".bean-agent-tail summary")?.textContent).toBe(`${TAIL_LINES + 2} steps`);
    const pre = root.querySelector(".bean-agent-tail pre")?.textContent ?? "";
    expect(pre.startsWith("… 2 earlier steps\n▸ step_3\n")).toBe(true);
    expect(pre.endsWith(`▸ step_${TAIL_LINES + 2}`)).toBe(true);
    await live({ type: "turn", result: "Fixed X in x.ts", durationMs: 1000 });
    expect(root.textContent).toContain("Fixed X in x.ts");

    // Typed text in agent mode steers the session.
    await send("also add a test");
    expect(bean.liveSend).toHaveBeenCalledWith("s1", "also add a test", expect.any(String));

    // The delegate finishes while the agent is live: its loopback is a Bean turn, never live-send.
    await act(async () => { listeners.onDelegateEvent!({ taskId: "task1", type: "done", result: "audit ok" } satisfies DelegateEvent); });
    await flush();
    expect(chatCalls().at(-1)).toMatchObject({ source: "loopback" });
    expect(bean.liveSend).toHaveBeenCalledTimes(1);

    await send("/bean");
    expect(bean.liveStop).toHaveBeenCalledWith("s1", expect.any(String));
    expect(root.textContent).toContain("Claude Code ended (1 turn) → Bean");
    await send("what did claude do?");
    const last = chatCalls().at(-1)!;
    expect(last).toMatchObject({ message: "what did claude do?", source: "typed" });
    expect(last.history.some((t) => t.role === "assistant" && t.content === "[Claude Code] Fixed X in x.ts")).toBe(true);

    await act(async () => { listeners.onReviewBeforeClose!(undefined); });
    await flush();
    const transcript = bean.rememberOnClose!.mock.calls[0]![0] as ChatTurn[];
    // What the user typed to the agent is citable; the agent's final is context only.
    expect(transcript.some((t) => t.source === "live")).toBe(false);
    expect(transcript.some((t) => t.role === "user" && t.source === "typed" && t.content.includes("fix X"))).toBe(true);
    expect(transcript.find((t) => t.content.includes("Fixed X"))).toMatchObject({ role: "assistant" });
    expect(transcript[0]).toMatchObject({ role: "user", content: "hi bean", source: "typed" });
  });

  it("remember X → forget X → close: close catch-up gets X as already handled, so it isn't re-saved", async () => {
    await act(async () => { render(h(ChatWindow, {}), root); });
    await flush();
    const x = { id: "x1", text: "Lives in Seattle", createdAt: "" };
    bean.chat!.mockResolvedValueOnce({ reply: "Got it.", model: "m", remembered: [x] });
    await send("remember that I live in Seattle");
    bean.chat!.mockResolvedValueOnce({ reply: "Forgotten.", model: "m", forgotten: [x] });
    await send("forget that");
    await act(async () => { listeners.onReviewBeforeClose!(undefined); });
    await flush();
    expect(bean.rememberOnClose).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ rejected: ["Lives in Seattle"] }));
  });

  it("a forget turn shows one Forgot row per fact; Undo re-appends the identical row, and a failed append is retryable", async () => {
    await act(async () => { render(h(ChatWindow, {}), root); });
    await flush();
    const x = { id: "x1", text: "Lives in Seattle", createdAt: "2026-07-01T00:00:00.000Z", projectPath: "/p", subjectId: "u1" };
    const y = { id: "y1", text: "Uses zed", createdAt: "2026-07-02T00:00:00.000Z" };
    bean.chat!.mockResolvedValueOnce({ reply: "Forgotten.", model: "m", forgotten: [x, y] });
    await send("forget where I live and my editor");
    const rows = (): HTMLElement[] => [...root.querySelectorAll<HTMLElement>(".bean-status--forgot")];
    expect(rows().map((r) => r.textContent)).toEqual(["🧠 Forgot — Lives in SeattleUndo", "🧠 Forgot — Uses zedUndo"]);

    bean.appendMemories = vi.fn().mockRejectedValueOnce(new Error("UNIQUE constraint failed: memories.id")).mockResolvedValueOnce(undefined);
    const undo = async (row: HTMLElement): Promise<void> => {
      await act(async () => { row.querySelector("button")!.click(); });
      await flush();
    };
    await undo(rows()[0]!);
    expect(rows()[0]!.textContent).toContain("Couldn't restore: a memory with this id already exists");
    await undo(rows()[0]!); // retry
    expect(bean.appendMemories).toHaveBeenLastCalledWith([x]);
    expect(rows()[0]!.textContent).toBe("🧠 Restored — Lives in Seattle");

    // Restored → close catch-up may cite it again; the still-forgotten fact stays rejected.
    await act(async () => { listeners.onReviewBeforeClose!(undefined); });
    await flush();
    expect(bean.rememberOnClose).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ rejected: ["Uses zed"] }));
  });

  it("Bean's hand-off offer: Start runs the /claude handoff once with the ask line; Not now leaves Bean in charge", async () => {
    await act(async () => { render(h(ChatWindow, {}), root); });
    await flush();
    const offer = { reply: "This needs hands-on work.", model: "m", proposedLiveSession: { projectPath: "/scratch-abs", instruction: "Add OAuth login" } };

    bean.chat!.mockResolvedValueOnce(offer);
    await send("build oauth login for me");
    expect(root.textContent).toContain("This looks like a job for Claude Code in scratch. Hand over this chat?");
    await click("Not now");
    expect(bean.liveStart).not.toHaveBeenCalled();
    await send("thanks");
    expect(chatCalls().at(-1)).toMatchObject({ message: "thanks", source: "typed" });

    bean.chat!.mockResolvedValueOnce(offer);
    await send("ok, let's do it");
    const start = [...root.querySelectorAll("button")].filter((b) => b.textContent?.trim() === "Start").at(-1)!;
    await act(async () => { start.click(); start.click(); });
    await flush();
    expect(bean.liveStart).toHaveBeenCalledTimes(1);
    // Same deterministic handoff as /claude: the transcript so far, then the model's ask line.
    // A project Bean doesn't know (core's scratch path) maps to the window's "" scratch.
    expect(bean.liveStart).toHaveBeenCalledWith(expect.objectContaining({ agent: "claude", projectPath: "", ask: "Add OAuth login" }), expect.any(String));
    expect(bean.liveStart!.mock.calls[0]![0].history.map((h: { text: string }) => h.text))
      .toEqual(["build oauth login for me", "This needs hands-on work.", "thanks", "ok", "ok, let's do it", "This needs hands-on work."]);
    await live({ type: "started", projectPath: "/scratch", handedOver: 6 });
    await send("use GitHub as the provider");
    expect(bean.liveSend).toHaveBeenCalledWith("s1", "use GitHub as the provider", expect.any(String));
  });

  it("Continue live on a finished delegate: one session on a double click, sends only the id, next message continues it", async () => {
    bean.liveResume = vi.fn(async () => ({ sessionId: "s1", agent: "claude", projectPath: "/p" }));
    await act(async () => { render(h(ChatWindow, {}), root); });
    await flush();
    bean.chat!.mockResolvedValueOnce({ reply: "on it", model: "m", proposedDelegate: { projectPath: "/p", instruction: "audit", composedPrompt: "audit" } });
    await send("hi bean");
    await click("Delegate");
    const receipt = { label: "claude · sess…", command: "cd '/p' && claude --resume sess-1", sessionId: "sess-1", agent: "claude" as const };
    await act(async () => { listeners.onDelegateEvent!({ taskId: "task1", type: "done", result: "audit ok", receipt } satisfies DelegateEvent); });
    await flush();

    const btn = [...root.querySelectorAll("button")].find((b) => b.textContent?.includes("Continue live"))!;
    await act(async () => { btn.click(); btn.click(); });
    await flush();
    expect(bean.liveResume).toHaveBeenCalledTimes(1);
    expect(bean.liveResume).toHaveBeenCalledWith("sess-1", expect.any(String));
    expect(bean.liveStart).not.toHaveBeenCalled();
    expect(root.querySelector(".bean-agent-banner")?.textContent).toContain("Continuing");
    // Hidden while the session is live.
    expect([...root.querySelectorAll("button")].some((b) => b.textContent?.includes("Continue live"))).toBe(false);
    // Lazy resume: main's `started` must not open a Working bubble before anything is sent.
    await live({ type: "started", projectPath: "/p", handedOver: 0 });
    expect(root.querySelector(".bean-bubble--working")).toBeNull();

    await send("now fix what you found");
    expect(root.querySelector(".bean-bubble--working")).not.toBeNull();
    expect(bean.liveSend).toHaveBeenCalledWith("s1", "now fix what you found", expect.any(String));
  });

  it("a Continue live rejected on its first send hands the typed text back to the composer", async () => {
    bean.liveResume = vi.fn(async () => ({ sessionId: "s1", agent: "claude", projectPath: "/p" }));
    await act(async () => { render(h(ChatWindow, {}), root); });
    await flush();
    bean.chat!.mockResolvedValueOnce({ reply: "on it", model: "m", proposedDelegate: { projectPath: "/p", instruction: "audit", composedPrompt: "audit" } });
    await send("hi bean");
    await click("Delegate");
    const receipt = { label: "l", command: "c", sessionId: "sess-1", agent: "claude" as const };
    await act(async () => { listeners.onDelegateEvent!({ taskId: "task1", type: "done", result: "ok", receipt } satisfies DelegateEvent); });
    await flush();
    await click("Continue live");
    await live({ type: "started", projectPath: "/p", handedOver: 0 });
    await send("what changed?");
    await live({ type: "ended", reason: "failed", error: "Couldn't reopen that session (expired or removed on the host). Nothing was sent." });
    const ta = root.querySelector("textarea.bean-input--composer") as HTMLTextAreaElement;
    expect(ta.value).toBe("what changed?");
    expect(root.textContent).toContain("Couldn't reopen that session");
  });

  it("a refused Continue live reports why and leaves Bean in charge", async () => {
    bean.liveResume = vi.fn(async () => ({ error: "I have no record of that run." }));
    await act(async () => { render(h(ChatWindow, {}), root); });
    await flush();
    bean.chat!.mockResolvedValueOnce({ reply: "on it", model: "m", proposedDelegate: { projectPath: "/p", instruction: "audit", composedPrompt: "audit" } });
    await send("hi bean");
    await click("Delegate");
    await act(async () => { listeners.onDelegateEvent!({ taskId: "task1", type: "failed", message: "x", receipt: { label: "l", command: "c", sessionId: "sess-1", agent: "claude" } } satisfies DelegateEvent); });
    await flush();
    const btn = [...root.querySelectorAll("button")].find((b) => b.textContent?.includes("Continue live"))!;
    await act(async () => { btn.click(); });
    await flush();
    expect(root.textContent).toContain("I have no record of that run.");
    expect(root.querySelector(".bean-agent-banner")).toBeNull();
    await send("ok");
    expect(chatCalls().at(-1)).toMatchObject({ message: "ok", source: "typed" });
  });

  it("closing mid-session asks first, then ends the session and closes", async () => {
    await act(async () => { render(h(ChatWindow, {}), root); });
    await flush();
    await send("/claude go");
    await live({ type: "started", projectPath: "/scratch", handedOver: 0 });
    await act(async () => { listeners.onReviewBeforeClose!(undefined); });
    await flush();
    expect(bean.allowChatClose).not.toHaveBeenCalled();
    expect(root.textContent).toContain("Claude Code is still running");
    await click("End Claude Code session & close");
    expect(bean.liveStop).toHaveBeenCalledWith("s1", expect.any(String));
    expect(bean.allowChatClose).toHaveBeenCalledTimes(1);
  });

  it("a local-core quit closes mid-session without the card and still sends the agent turns to memory (#862)", async () => {
    await act(async () => { render(h(ChatWindow, {}), root); });
    await flush();
    await send("/claude go");
    await live({ type: "started", projectPath: "/scratch", handedOver: 0 });
    await send("my staging db is pg-7");
    await act(async () => { listeners.onReviewBeforeClose!(true); });
    await flush();
    expect(root.textContent).not.toContain("Claude Code is still running");
    const transcript = bean.rememberOnClose!.mock.calls[0]![0] as ChatTurn[];
    expect(transcript.some((t) => t.role === "user" && t.source === "typed" && t.content.includes("pg-7"))).toBe(true);
    expect(bean.allowChatClose).toHaveBeenCalledTimes(1);
  });

  it("an ended live session's row offers Continue live with its CLI session id", async () => {
    bean.liveResume = vi.fn(async () => ({ sessionId: "s2", agent: "claude", projectPath: "/p" }));
    await act(async () => { render(h(ChatWindow, {}), root); });
    await flush();
    await send("/claude go");
    await live({ type: "started", projectPath: "/scratch", handedOver: 0 });
    await live({ type: "session", receipt: { sessionId: "sess-a", agent: "claude", label: "claude · sess…" } });
    await live({ type: "ended", reason: "ended" });
    expect(root.textContent).toContain("Claude Code session ended");
    await click("Continue live");
    expect(bean.liveResume).toHaveBeenCalledWith("sess-a", expect.any(String));
  });

  it("End leaves a Continue live row that waits for the child to exit", async () => {
    await act(async () => { render(h(ChatWindow, {}), root); });
    await flush();
    await send("/claude go");
    await live({ type: "started", projectPath: "/scratch", handedOver: 0 });
    await live({ type: "session", receipt: { sessionId: "sess-a", agent: "claude", label: "claude · sess…" } });
    await click("End");
    expect(bean.liveStop).toHaveBeenCalledWith("s1", expect.any(String));
    const btn = (): HTMLButtonElement => [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Continue live")!;
    expect(btn().disabled).toBe(true);
    await live({ type: "ended", reason: "stopped" });
    expect(btn().disabled).toBe(false);
  });

  it("reports a crash and returns to Bean; an alias for a missing CLI never starts", async () => {
    await act(async () => { render(h(ChatWindow, {}), root); });
    await flush();
    await send("/codex hi");
    expect(bean.liveStart).not.toHaveBeenCalled();
    expect(root.textContent).toContain("Codex isn't installed or is turned off in Settings.");

    await send("/claude go");
    await live({ type: "started", projectPath: "/scratch", handedOver: 0 });
    await live({ type: "ended", reason: "failed", error: "boom (stderr tail)" });
    expect(root.textContent).toContain("Claude Code stopped unexpectedly: boom (stderr tail). Back to Bean.");
    await send("back to you");
    expect(chatCalls().at(-1)).toMatchObject({ message: "back to you", source: "typed" });
  });

  it("type-ahead: the composer stays editable while Bean answers, and Enter keeps the draft until the turn ends", async () => {
    await act(async () => { render(h(ChatWindow, {}), root); });
    await flush();
    let answer!: (v: { reply: string; model: string }) => void;
    bean.chat!.mockImplementationOnce(() => new Promise((r) => { answer = r; }));
    await send("first");
    const ta = root.querySelector("textarea.bean-input--composer") as HTMLTextAreaElement;
    expect(ta.disabled).toBe(false);
    await send("second");
    expect(bean.chat).toHaveBeenCalledTimes(1);
    expect(ta.value).toBe("second");
    await act(async () => { answer({ reply: "ok", model: "m" }); });
    await flush();
    await send("second");
    expect(chatCalls().map((c) => c.message)).toEqual(["first", "second"]);
    expect(ta.value).toBe("");
  });
  // #740: Stop / Esc Esc for Bean's own running turn.
  const esc = async (): Promise<void> => {
    const ta = root.querySelector("textarea.bean-input--composer") as HTMLTextAreaElement;
    await act(async () => { ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  };
  const hint = (): Element | null => root.querySelector(".bean-bubble--working .bean-agent-banner-hint");

  it("Bean's turn: the working row's Stop names that turn, shows Stopping…, then the receipts and Stopped by you.", async () => {
    bean.chatStop = vi.fn();
    await act(async () => { render(h(ChatWindow, {}), root); });
    await flush();
    let answer!: (v: unknown) => void;
    bean.chat!.mockImplementationOnce(() => new Promise((r) => { answer = r; }));
    await send("first");
    const turnId = (bean.chat!.mock.calls[0]![0] as { turnId: string }).turnId;
    await click("Stop");
    expect(bean.chatStop).toHaveBeenCalledWith(expect.any(String), turnId);
    const stopping = [...root.querySelectorAll(".bean-bubble--working button")].find((b) => b.textContent === "Stopping…") as HTMLButtonElement;
    expect(stopping.disabled).toBe(true);
    await act(async () => { answer({ reply: "", model: "m", stopped: true, remembered: [{ id: "x", text: "Lives in Seattle", createdAt: "" }] }); });
    await flush();
    expect(root.querySelector(".bean-bubble--working")).toBeNull();
    expect(root.textContent).toContain("🧠 Remembered — Lives in Seattle");
    expect([...root.querySelectorAll(".bean-status")].at(-1)?.textContent).toBe("Stopped by you.");
    expect(root.textContent).not.toContain("Failed to reach Bean");
    await send("again");
    expect(root.textContent).toContain("ok");
    expect(bean.chatStop).toHaveBeenCalledTimes(1);
  });

  it("Esc Esc stops Bean's turn; an Esc armed for one turn never carries to the queued loopback that follows", async () => {
    bean.chatStop = vi.fn();
    await act(async () => { render(h(ChatWindow, {}), root); });
    await flush();
    bean.chat!.mockResolvedValueOnce({ reply: "on it", model: "m", proposedDelegate: { projectPath: "/p", instruction: "audit", composedPrompt: "audit" } });
    await send("hi bean");
    await click("Delegate");
    let first!: (v: unknown) => void;
    bean.chat!.mockImplementationOnce(() => new Promise((r) => { first = r; }));
    bean.chat!.mockImplementationOnce(() => new Promise(() => {}));
    await send("long one");
    // The delegate finishes mid-turn: its loopback queues behind it.
    await act(async () => { listeners.onDelegateEvent!({ taskId: "task1", type: "done", result: "audit ok" } satisfies DelegateEvent); });
    await flush();
    await esc();
    expect(hint()?.textContent).toBe("Esc again to stop");
    // The turn ends inside the Esc Esc window and the loopback starts in the same tick.
    await act(async () => { first({ reply: "done", model: "m" }); });
    await flush();
    expect(chatCalls().at(-1)).toMatchObject({ source: "loopback" });
    expect(hint()).toBeNull();
    await esc();
    expect(bean.chatStop).not.toHaveBeenCalled();
    await esc();
    expect(bean.chatStop).toHaveBeenCalledWith(expect.any(String), (bean.chat!.mock.calls.at(-1)![0] as { turnId: string }).turnId);
  });

  it("agent mode: /skill runs its composed prompt in the live session — starts one, then steers it; no delegate card", async () => {
    bean.listSkills!.mockResolvedValue([
      { name: "Review PR", description: "review", body: "# Review PR\nCheck it.", target: "terminal" },
      { name: "shop", description: "browse", body: "# Shop\nBuy it.", target: "chat", browser: true },
    ]);
    bean.availableClis!.mockResolvedValue(["claude", "opencode"]);
    await act(async () => { render(h(ChatWindow, {}), root); });
    await flush();
    await send("/claude");

    await send("/review-pr fix X");
    expect(bean.delegateStart).not.toHaveBeenCalled();
    const req = bean.liveStart!.mock.calls[0]![0];
    expect(req).toMatchObject({ agent: "claude", label: "▶ Review PR — fix X" });
    expect(req.ask).toContain("# Review PR");
    expect(req.ask).toContain("fix X");
    expect(root.textContent).toContain("▶ Review PR — fix X");
    expect(root.textContent).not.toContain("Check it.");

    await live({ type: "turn", result: "done" });
    await send("/skill:shop");
    expect(bean.liveSend).toHaveBeenCalledWith("s1", expect.stringContaining("# Shop"), expect.any(String));
    expect(bean.liveStart).toHaveBeenCalledTimes(1);

    // opencode has no browser: a browser skill is refused before anything is sent.
    await send("/opencode");
    await send("/shop");
    expect(root.textContent).toContain(`"shop" needs the browser; opencode can't`);
    expect(bean.liveStart).toHaveBeenCalledTimes(1);
    // An unknown /foo still goes to the CLI as typed.
    await send("/compact");
    expect(bean.liveStart).toHaveBeenLastCalledWith(expect.objectContaining({ agent: "opencode", ask: "/compact" }), expect.any(String));
    expect(bean.liveStart!.mock.calls.at(-1)![0].label).toBeUndefined();
  });
  describe("per-agent project + model (#612)", () => {
    const models = [
      { id: "sonnet", label: "sonnet", availableOn: ["claude"] },
      { id: "anthropic/opus", label: "opus", availableOn: ["claude"] },
      { id: "gpt-5", label: "gpt-5", availableOn: ["codex"] },
    ];
    const chip = (): HTMLElement => root.querySelector(".bean-agent-chip") as HTMLElement;
    const seg = (kind: "agent" | "project" | "model"): HTMLButtonElement =>
      root.querySelector(`.bean-agent-seg--${kind}`) as HTMLButtonElement;
    const openSeg = async (kind: "agent" | "project" | "model"): Promise<void> => {
      await act(async () => { seg(kind).click(); });
      await flush();
    };
    const modelRows = (): HTMLButtonElement[] => [...root.querySelectorAll<HTMLButtonElement>(".bean-chip-menu-row--model")];
    const pickIn = async (kind: "agent" | "project" | "model", label: string): Promise<void> => {
      await openSeg(kind);
      const row = [...root.querySelectorAll<HTMLButtonElement>(".bean-chip-menu-row")].find((b) => b.textContent?.trim().endsWith(label));
      if (!row) throw new Error(`no row "${label}" in ${kind}`);
      await act(async () => { row.click(); });
      await flush();
    };
    const liveSets = (): string[][] => bean.setModelMemory!.mock.calls.filter((c) => /^(live|desktop):/.test(String(c[0]))) as string[][];
    const mount = async (memory: Record<string, string>, customModels = models): Promise<void> => {
      bean.availableClis = vi.fn(async () => ["claude", "codex"]);
      bean.availableModels = vi.fn(async () => customModels);
      bean.listProjects = vi.fn(async () => [{ name: "P", path: "/p" }, { name: "Q", path: "/q" }]);
      bean.getModelMemory = vi.fn(async (k: string) => memory[k]);
      bean.setModelMemory = vi.fn(async () => undefined);
      await act(async () => { render(h(ChatWindow, {}), root); });
      await flush();
    };

    it("Bean mode shows the agent + effort segments with no project picker", async () => {
      await mount({});
      expect(chip().textContent?.trim()).toBe("Bean · default ▾");
      expect(seg("project")).toBeNull();
      await openSeg("agent");
      expect(root.textContent).not.toContain("No project — scratch workspace");
      expect(root.textContent).not.toContain("Agents work in");
    });

    it("Bean mode's effort is per chat: a pick rides on Bean's turns, default sends none", async () => {
      await mount({});
      await openSeg("model");
      const effortBtns = (): HTMLButtonElement[] => [...root.querySelectorAll<HTMLButtonElement>(".bean-effort-btn")];
      expect(effortBtns().map((b) => b.textContent)).toEqual(["default", "none", "low", "med", "high", "xhigh"]);
      await act(async () => { effortBtns().find((b) => b.textContent === "high")!.click(); });
      await flush();
      expect(chip().textContent?.trim()).toBe("Bean · high ▾");
      await send("think hard");
      expect(bean.chat!.mock.calls.at(-1)![0]).toMatchObject({ message: "think hard", effort: "high" });
      expect(bean.setModelMemory).not.toHaveBeenCalledWith(expect.stringContaining("effort"), expect.anything());
      await openSeg("model");
      await act(async () => { effortBtns().find((b) => b.textContent === "default")!.click(); });
      await flush();
      await send("plain");
      expect(bean.chat!.mock.calls.at(-1)![0]).not.toHaveProperty("effort");
    });

    it("first use picks the CLI's first configured model (no Agent default) and remembers model + project", async () => {
      await mount({});
      await send("/claude go");
      expect(bean.liveStart!.mock.calls[0]![0]).toMatchObject({ agent: "claude", projectPath: "", model: "sonnet" });
      expect(chip().textContent?.trim()).toBe("Claude Code · scratch · sonnet ▾");
      expect(liveSets()).toEqual([["live:model:claude", "sonnet"], ["desktop:live:project:claude", ""]]);
    });

    it("/claude <ask> in a new chat launches with Claude's remembered project and model; the chip and banner show them", async () => {
      await mount({ "live:model:claude": "anthropic/opus", "desktop:live:project:claude": "/q" });
      await send("/claude fix it");
      expect(bean.liveStart).toHaveBeenCalledWith(expect.objectContaining({ agent: "claude", projectPath: "/q", model: "anthropic/opus", ask: "fix it" }), expect.any(String));
      expect(chip().textContent?.trim()).toBe("Claude Code · Q · opus ▾");
      expect(root.querySelector(".bean-agent-banner")?.textContent).toContain("Claude Code · Q · opus");
      // While it runs, model rows are disabled; the picked one stays highlighted.
      await openSeg("model");
      expect(modelRows().map((b) => b.disabled)).toEqual([true, true]);
      expect(root.textContent).toContain("End session to change model");
      expect(modelRows().find((b) => b.classList.contains("bean-chip-menu-row--on"))?.textContent).toContain("opus");
    });

    it("a stale model falls back to the first configured model and a removed project is scratch", async () => {
      await mount({ "live:model:claude": "opus-old", "desktop:live:project:claude": "/gone" });
      await send("/claude go");
      expect(bean.liveStart!.mock.calls[0]![0]).toMatchObject({ projectPath: "", model: "sonnet" });
    });

    it("chip picks are per agent: claude → codex → claude keeps the unsent pick; re-picking the agent keeps it", async () => {
      await mount({ "live:model:codex": "gpt-5" });
      await pickIn("agent", "Claude Code");
      await pickIn("project", "P");
      await pickIn("model", "opus");
      expect(chip().textContent?.trim()).toBe("Claude Code · P · opus ▾");
      await openSeg("model");
      expect(modelRows().map((b) => b.textContent?.replace(/^✓ /, ""))).toEqual(["sonnet", "opus"]);
      await openSeg("model"); // the trigger toggles it closed
      await pickIn("agent", "Codex");
      // Codex has no remembered project: the window's stays; its own model comes back.
      expect(chip().textContent?.trim()).toBe("Codex · P · gpt-5 ▾");
      await pickIn("agent", "Claude Code");
      expect(chip().textContent?.trim()).toBe("Claude Code · P · opus ▾");
      await pickIn("agent", "Claude Code");
      expect(chip().textContent?.trim()).toBe("Claude Code · P · opus ▾");
      await send("go");
      expect(bean.liveStart).toHaveBeenCalledWith(expect.objectContaining({ agent: "claude", projectPath: "/p", model: "anthropic/opus" }), expect.any(String));
      expect(liveSets()).toEqual([["live:model:claude", "anthropic/opus"], ["desktop:live:project:claude", "/p"]]);
    });

    it("model + effort popover switches both in one open and remembers per-model effort", async () => {
      const withEfforts = [
        { id: "opus", label: "opus", availableOn: ["claude"], effortsByCli: { claude: { efforts: ["low", "medium", "high", "max"], defaultEffort: "high" } } },
        { id: "haiku", label: "haiku", availableOn: ["claude"], effortsByCli: { claude: { efforts: ["low", "medium", "high"], defaultEffort: "medium" } } },
      ];
      await mount({}, withEfforts as typeof models);
      await pickIn("agent", "Claude Code");
      expect(chip().textContent?.trim()).toBe("Claude Code · scratch · opus · high ▾");
      // Open model+effort once, switch to haiku (menu stays open and adopts haiku's default Medium), pick Low (menu closes).
      await openSeg("model");
      const haikuRow = modelRows().find((b) => b.textContent?.includes("haiku"))!;
      await act(async () => { haikuRow.click(); });
      await flush();
      expect(chip().textContent?.trim()).toBe("Claude Code · scratch · haiku · medium ▴");
      expect(root.querySelectorAll(".bean-effort-btn").length).toBe(3); // popover stayed open with haiku's efforts
      const lowBtn = [...root.querySelectorAll<HTMLButtonElement>(".bean-effort-btn")].find((b) => b.textContent === "low")!;
      await act(async () => { lowBtn.click(); });
      await flush();
      expect(root.querySelector(".bean-chip-menu-panel")).toBeNull();
      expect(chip().textContent?.trim()).toBe("Claude Code · scratch · haiku · low ▾");
      // Switching to opus restores opus's own default (High), not haiku's Low; picking Max on opus
      // then switching back to haiku restores haiku's remembered Low.
      await openSeg("model");
      const opusRow = modelRows().find((b) => b.textContent?.includes("opus"))!;
      await act(async () => { opusRow.click(); });
      await flush();
      expect(chip().textContent?.trim()).toBe("Claude Code · scratch · opus · high ▴");
      const maxBtn = [...root.querySelectorAll<HTMLButtonElement>(".bean-effort-btn")].find((b) => b.textContent === "max")!;
      await act(async () => { maxBtn.click(); });
      await flush();
      expect(chip().textContent?.trim()).toBe("Claude Code · scratch · opus · max ▾");
      await openSeg("model");
      const haikuRow2 = modelRows().find((b) => b.textContent?.includes("haiku"))!;
      await act(async () => { haikuRow2.click(); });
      await flush();
      expect(chip().textContent?.trim()).toBe("Claude Code · scratch · haiku · low ▴");
      // Close popover by clicking haiku again.
      const haikuRow3 = modelRows().find((b) => b.textContent?.includes("haiku"))!;
      await act(async () => { haikuRow3.click(); });
      await flush();
      await send("go");
      expect(bean.liveStart).toHaveBeenCalledWith(expect.objectContaining({ agent: "claude", model: "haiku", effort: "low" }), expect.any(String));
      expect(liveSets()).toEqual([
        ["live:model:claude", "haiku"],
        ["desktop:live:project:claude", ""],
        ["desktop:live:effort:claude:haiku", "low"],
      ]);
    });

    it("an offer: a registered project wins, the card names the effective project and model, and its start isn't remembered", async () => {
      await mount({ "live:model:claude": "sonnet", "desktop:live:project:claude": "/q" });
      bean.chat!.mockResolvedValueOnce({ reply: "Hands-on.", model: "m", proposedLiveSession: { projectPath: "/p", instruction: "Do it" } });
      await send("do it");
      expect(root.textContent).toContain("This looks like a job for Claude Code in P on sonnet. Hand over this chat?");
      await click("Start");
      expect(bean.liveStart).toHaveBeenCalledWith(expect.objectContaining({ agent: "claude", projectPath: "/p", model: "sonnet", ask: "Do it" }), expect.any(String));
      expect(liveSets()).toEqual([]);
    });

    it("an offer with an unregistered project uses Claude's remembered one and first configured model", async () => {
      await mount({ "desktop:live:project:claude": "/q" });
      bean.chat!.mockResolvedValueOnce({ reply: "Hands-on.", model: "m", proposedLiveSession: { projectPath: "/scratch-abs", instruction: "Do it" } });
      await send("do it");
      expect(root.textContent).toContain("This looks like a job for Claude Code in Q on sonnet. Hand over this chat?");
      await click("Start");
      expect(bean.liveStart!.mock.calls[0]![0]).toMatchObject({ projectPath: "/q", model: "sonnet" });
    });

    it("a failed memory write doesn't fail the session", async () => {
      await mount({});
      bean.setModelMemory = vi.fn(async () => { throw new Error("disk full"); });
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      await send("/claude go");
      await live({ type: "started", projectPath: "/scratch", handedOver: 0 });
      expect(root.querySelector(".bean-agent-banner")).not.toBeNull();
      expect(bean.setModelMemory).toHaveBeenCalledTimes(1); // model failed → project not attempted
      err.mockRestore();
    });
  });

  describe("images (#628)", () => {
    const png = (): File => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "shot.png", { type: "image/png" });
    const composer = (): HTMLTextAreaElement => root.querySelector("textarea.bean-input--composer") as HTMLTextAreaElement;
    const drop = async (file: File): Promise<void> => {
      const ev = new Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(ev, "dataTransfer", { value: { files: [file] } });
      await act(async () => { composer().dispatchEvent(ev); });
      await flush();
    };
    const mount = async (): Promise<void> => {
      bean.chatStageImage = vi.fn(async () => "/tmp/bean-images-x/staged.png");
      bean.getPathForFile = vi.fn(() => "");
      await act(async () => { render(h(ChatWindow, {}), root); });
      await flush();
    };

    it("a Finder drop labels the file's own path, a browser drag stages it; the agent gets the paths, the transcript only labels", async () => {
      await mount();
      await send("/claude");
      bean.getPathForFile!.mockReturnValueOnce("/Users/me/finder.png");
      await drop(png());
      expect(bean.chatStageImage).not.toHaveBeenCalled();
      await drop(png());
      await vi.waitFor(() => expect(composer().value).toBe("[Image #1] [Image #2] "));
      expect(bean.chatStageImage).toHaveBeenCalledWith(expect.any(String), "image/png", expect.any(String));
      await send(`compare ${composer().value}`);
      const req = bean.liveStart!.mock.calls[0]![0];
      expect(req.ask).toBe("compare [Image #1] [Image #2]\n\n[Image #1]: /Users/me/finder.png\n[Image #2]: /tmp/bean-images-x/staged.png");
      expect(req.label).toBe("compare [Image #1] [Image #2]");
      await live({ type: "started", projectPath: "/scratch", handedOver: 0 });
      // A label deleted before sending isn't sent; numbers keep increasing.
      await drop(png());
      await vi.waitFor(() => expect(composer().value).toBe("[Image #3] "));
      await send("and [Image #1] only");
      expect(bean.liveSend).toHaveBeenLastCalledWith("s1", "and [Image #1] only\n\n[Image #1]: /Users/me/finder.png", expect.any(String));
      expect(root.textContent).not.toContain("/Users/me/finder.png");
      expect(root.textContent).not.toContain("/tmp/bean-images-x");
      // Back in Bean mode a mapped label is refused inline; the text stays put.
      await send("/bean");
      await send("what about [Image #1]");
      expect(root.textContent).toContain("[Image #1] was attached for Claude Code — attach it again to show Bean.");
      expect(composer().value).toBe("what about [Image #1]");
      expect(bean.chat).not.toHaveBeenCalled();
    });

    it("/claude <ask> carries pending Bean images as labels, and the hand-off marks earlier Bean image turns", async () => {
      await mount();
      await drop(png());
      await send("what is this");
      expect(bean.chat).toHaveBeenCalledTimes(1);
      await drop(png());
      await vi.waitFor(() => expect(root.querySelector(".bean-chat-pending-image")).not.toBeNull());
      await send("/claude fix it");
      await vi.waitFor(() => expect(bean.liveStart).toHaveBeenCalled());
      const req = bean.liveStart!.mock.calls[0]![0];
      expect(req.ask).toBe("fix it [Image #1]\n\n[Image #1]: /tmp/bean-images-x/staged.png");
      expect(req.history[0].text).toBe(`what is this\n${IMAGE_NOT_HANDED}`);
    });

    it("#951: a Finder drop and a paste each get a Bean-mode chip; ✕ and deleting the label remove it; the sent bubble shows thumbnails, never saved", async () => {
      await mount();
      bean.chatThreadSave = vi.fn(async () => undefined);
      await send("/claude");
      const chips = (): string[] => [...root.querySelectorAll(".bean-chat-pending-images .bean-chat-pending-image")].map((c) => c.getAttribute("title") ?? "");
      bean.getPathForFile!.mockReturnValueOnce("/Users/me/finder.png");
      await drop(png());
      const paste = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(paste, "clipboardData", { value: { items: [{ kind: "file", type: "image/png", getAsFile: () => png() }] } });
      await act(async () => { composer().dispatchEvent(paste); });
      await flush();
      await vi.waitFor(() => expect(chips()).toEqual(["[Image #1]", "[Image #2]"]));
      const chip = root.querySelector(".bean-chat-pending-image img") as HTMLImageElement;
      expect(chip.src).toMatch(/^data:image\/png;base64,/);
      // ✕ takes the label out of the composer; deleting the label text drops its chip.
      await act(async () => { (root.querySelector('button[aria-label="Remove [Image #1]"]') as HTMLButtonElement).click(); });
      expect(composer().value).not.toContain("[Image #1]");
      expect(chips()).toEqual(["[Image #2]"]);
      composer().value = "";
      await act(async () => { composer().dispatchEvent(new Event("input", { bubbles: true })); });
      expect(chips()).toEqual([]);
      // A sent bubble shows the thumbnail; it opens the preview overlay.
      await send("look [Image #2]");
      const thumb = root.querySelector(".bean-bubble--user .bean-chat-thumb img") as HTMLImageElement;
      expect(thumb.alt).toBe("[Image #2]");
      expect(chips()).toEqual([]);
      await act(async () => { (thumb.parentElement as HTMLButtonElement).click(); });
      expect(root.querySelector(".bean-image-preview")).not.toBeNull();
      expect(bean.liveStart!.mock.calls[0]![0].ask).toBe("look [Image #2]\n\n[Image #2]: /tmp/bean-images-x/staged.png");
      // Bean's history, the saved thread and the next agent's handoff keep the label only — no bytes,
      // no attachment marker.
      await live({ type: "started", projectPath: "/scratch", handedOver: 0 });
      await send("/bean");
      await send("hi");
      const history = chatCalls().at(-1)!.history;
      expect(history.some((t) => t.content.includes("[image attached]"))).toBe(false);
      await vi.waitFor(() => expect(bean.chatThreadSave).toHaveBeenCalled(), { timeout: 3000 });
      const saved = JSON.stringify(bean.chatThreadSave!.mock.calls.at(-1)![0]);
      expect(saved).toContain("look [Image #2]");
      expect(saved).not.toContain("data:image");
      expect(saved).not.toContain("[image attached");
      await send("/claude again");
      const handoff = bean.liveStart!.mock.calls[1]![0].history.map((x: { text: string }) => x.text);
      expect(handoff).toContain("look [Image #2]");
      expect(JSON.stringify(handoff)).not.toMatch(/data:image|\[image attached/);
    });

    it("#951: a Finder file that can't be read is still labeled, with no chip", async () => {
      await mount();
      await send("/claude");
      bean.getPathForFile!.mockReturnValueOnce("/Users/me/gone.png");
      const failRead = vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(function (this: FileReader) {
        setTimeout(() => this.onerror?.(new ProgressEvent("error") as ProgressEvent<FileReader>), 0);
      });
      try {
        await drop(png());
        await vi.waitFor(() => expect(composer().value).toBe("[Image #1] "));
      } finally { failRead.mockRestore(); }
      expect(root.querySelector(".bean-chat-pending-image")).toBeNull();
      expect(root.textContent).not.toContain("Couldn't read that image.");
    });

    describe("PDFs (#732)", () => {
      const pdf = (): File => new File(["%PDF-1.4\n%%EOF\n"], "r.pdf", { type: "application/pdf" });
      const paste = async (file: File): Promise<void> => {
        const ev = new Event("paste", { bubbles: true, cancelable: true });
        Object.defineProperty(ev, "clipboardData", { value: { items: [{ kind: "file", type: file.type, getAsFile: () => file }] } });
        await act(async () => { composer().dispatchEvent(ev); });
        await flush();
      };
      const pinned = async (path: string): Promise<void> => {
        bean.getPathForFile!.mockReturnValueOnce(path);
        await drop(pdf());
        await vi.waitFor(() => expect(root.querySelector(".bean-chat-pending-file")).not.toBeNull());
      };

      it("agent mode: a Finder drop inserts the path, a paste gets the notice; neither reaches Bean", async () => {
        await mount();
        await send("/claude");
        bean.getPathForFile!.mockReturnValueOnce("/Users/me/r.pdf");
        await drop(pdf());
        expect(composer().value).toBe("/Users/me/r.pdf ");
        composer().value = "";
        await paste(pdf());
        expect(root.textContent).toContain(PDF_NO_PATH);
        expect(composer().value).toBe("");
        expect(bean.chat).not.toHaveBeenCalled();
        expect(bean.liveStart).not.toHaveBeenCalled();
        expect(root.querySelector(".bean-chat-pending-file")).toBeNull();
      });

      it("/claude <ask> carries a pending PDF as its path and unpins it", async () => {
        await mount();
        await pinned("/Users/me/r.pdf");
        await send("/claude sum it up");
        await vi.waitFor(() => expect(bean.liveStart).toHaveBeenCalled());
        expect(bean.liveStart!.mock.calls[0]![0].ask).toBe("/Users/me/r.pdf sum it up");
        await send("/bean");
        expect(root.querySelector(".bean-chat-pending-file")).toBeNull();
        expect(bean.chat).not.toHaveBeenCalled();
      });

      it("/claude <ask> with a pathless pending PDF sends the ask alone, with the notice", async () => {
        await mount();
        await pinned("");
        await send("/claude sum it up");
        await vi.waitFor(() => expect(bean.liveStart).toHaveBeenCalled());
        expect(bean.liveStart!.mock.calls[0]![0].ask).toBe("sum it up");
        expect(root.textContent).toContain(PDF_NO_PATH);
      });

      it("a bare /claude puts a pending PDF's path in the composer; a sent one is marked in the hand-off, never its path", async () => {
        await mount();
        await pinned("/Users/me/r.pdf");
        await send("what is this");
        expect(bean.chat).toHaveBeenCalledTimes(1);
        await send("/claude");
        expect(composer().value).toBe("");
        await send("/bean");
        await pinned("/Users/me/s.pdf");
        await send("/claude");
        expect(composer().value).toBe("/Users/me/s.pdf");
        await send("go");
        const req = bean.liveStart!.mock.calls[0]![0];
        expect(req.history[0].text).toBe("what is this\n[PDF attached: r.pdf — not handed over]");
        expect(JSON.stringify(req.history)).not.toContain("/Users/me");
      });
    });

    it("a bare /claude hands pending Bean images back to the composer as labels", async () => {
      await mount();
      await drop(png());
      await vi.waitFor(() => expect(root.querySelector(".bean-chat-pending-image")).not.toBeNull());
      await send("/claude");
      await vi.waitFor(() => expect(composer().value).toBe("[Image #1] "));
      // The Bean chip became the label's chip (#951): one chip, titled by its label.
      expect([...root.querySelectorAll(".bean-chat-pending-image")].map((c) => c.getAttribute("title"))).toEqual(["[Image #1]"]);
      expect(bean.liveStart).not.toHaveBeenCalled();
    });
  });

  it("#746: a live row is \"Not read yet\" until picked up; pickup mid-turn splits the bubble; refusal and end clear rows", async () => {
    await act(async () => { render(h(ChatWindow, {}), root); });
    await flush();
    const pending = (): string[] => [...root.querySelectorAll(".bean-pending .bean-bubble--user")].map((b) => b.textContent ?? "");
    await send("/claude fix X");
    await live({ type: "started", projectPath: "/scratch", handedOver: 0 });
    expect(pending()).toEqual(["You: fix X (not read yet)"]);
    expect(root.querySelector(".bean-pending-caption")?.textContent).toBe("Not read yet");
    await live({ type: "consumed", count: 1 });
    expect(pending()).toEqual([]);
    await live({ type: "text", text: "Looking around." });
    await live({ type: "output", line: "▸ Bash" });

    // Mid-tool steer: the row waits below the open bubble, then pickup moves the bubble under it.
    await send("also add a test");
    expect(pending()).toHaveLength(1);
    await live({ type: "consumed", count: 1 });
    expect(pending()).toEqual([]);
    await live({ type: "text", text: "Adding the test." });
    await live({ type: "turn", result: "Adding the test.", durationMs: 1000 });
    const order = [...root.querySelectorAll(".bean-bubble--user, .bean-bubble--bean")].map((b) => b.textContent ?? "");
    const at = (s: string): number => order.findIndex((t) => t.includes(s));
    expect(at("fix X")).toBeLessThan(at("Looking around."));
    expect(at("Looking around.")).toBeLessThan(at("also add a test"));
    expect(at("also add a test")).toBeLessThan(at("Adding the test."));
    expect(root.querySelectorAll(".bean-agent-footer")).toHaveLength(1); // only the newest bubble

    // A refused send clears its own row.
    bean.liveSend!.mockResolvedValueOnce("The agent's queue is full.");
    await send("one more");
    expect(pending()).toEqual([]);
    expect(root.textContent).toContain("The agent's queue is full.");

    // Ending the session clears what it never picked up; a late consume from it touches nothing.
    await send("and another");
    expect(pending()).toHaveLength(1);
    await send("/bean");
    expect(pending()).toEqual([]);
  });

  it("#746: a switched-to session's consume clears its row; the old session's late events don't", async () => {
    bean.availableClis!.mockResolvedValue(["claude", "codex"]);
    await act(async () => { render(h(ChatWindow, {}), root); });
    await flush();
    const pending = (): string[] => [...root.querySelectorAll(".bean-pending .bean-bubble--user")].map((b) => b.textContent ?? "");
    await send("/claude first");
    await live({ type: "started", projectPath: "/scratch", handedOver: 0 });
    await send("queued in claude");
    expect(pending()).toHaveLength(2);
    bean.liveStart!.mockResolvedValueOnce({ sessionId: "s2", handedOver: 0 });
    await send("/codex second");
    expect(pending()).toEqual(["You: second (not read yet)"]);
    const ev = async (e: Record<string, unknown>): Promise<void> => {
      await act(async () => { listeners.onLiveEvent!({ seq: 1, ...e }); });
      await flush();
    };
    await ev({ sessionId: "s2", agent: "codex", type: "started", projectPath: "/scratch", handedOver: 0 });
    await ev({ sessionId: "s1", agent: "claude", type: "consumed", count: 1 });
    await ev({ sessionId: "s1", agent: "claude", type: "ended", reason: "stopped" });
    expect(pending()).toEqual(["You: second (not read yet)"]);
    await ev({ sessionId: "s2", agent: "codex", type: "consumed", count: 1 });
    expect(pending()).toEqual([]);
  });
});
