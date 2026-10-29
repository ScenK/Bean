// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import type { Routine, Skill } from "@bean/core";
import { resolveSlash, slashEntries, slashMenu, slugify, type SlashCatalogs } from "../src/renderer/components/chat/slash-commands.js";
import { ChatWindow } from "../src/renderer/components/chat/ChatWindow.js";

const skill = (name: string, extra: Partial<Skill> = {}): Skill => ({ name, description: `${name} desc`, body: `# ${name}\nDo it.`, target: "chat", ...extra });
const sprout = (name: string, extra: Partial<Routine> = {}): Routine => ({ name, enabled: true, cron: "0 9 * * *", steps: [{ kind: "chat", prompt: "x" }], sinks: { note: true }, ...extra } as Routine);

const catalogs: SlashCatalogs = {
  agents: ["claude"],
  skills: [
    skill("Review Code", { description: "Look over a diff" }),
    skill("deploy", { target: "terminal" }),
    skill("secret", { hidden: true }),
    skill("off", { enabled: false }),
    skill("quiet", { quickLaunch: false }),
    skill("Nightly"), // shadows the sprout below on a bare /nightly
    skill("claude"), // shadowed by the agent alias
  ],
  sprouts: [
    sprout("nightly", { sinks: { chatops: [{ transport: "discord" }], notify: true } }),
    sprout("paused-one", { enabled: false }),
    sprout("pings", { cron: undefined, watch: { kind: "feed", url: "https://x" }, steps: [] } as Partial<Routine>),
  ],
};

describe("slash commands", () => {
  it("slugs names with spaces and mixed case", () => {
    expect(slugify("  Review Code! ")).toBe("review-code");
    expect(resolveSlash("/review-code fix the diff", "bean", catalogs)).toEqual({ kind: "skill", name: "Review Code", rest: "fix the diff" });
    expect(resolveSlash("/Review-Code", "bean", catalogs)).toEqual({ kind: "skill", name: "Review Code", rest: "" });
  });

  it("resolves agents > skills > sprouts on a bare name; qualifiers pick a kind", () => {
    expect(resolveSlash("/claude go", "bean", catalogs)).toEqual({ kind: "agent", name: "claude", rest: "go" });
    expect(resolveSlash("/skill:claude go", "bean", catalogs)).toEqual({ kind: "skill", name: "claude", rest: "go" });
    expect(resolveSlash("/nightly", "bean", catalogs)).toEqual({ kind: "skill", name: "Nightly", rest: "" });
    expect(resolveSlash("/sprout:nightly", "bean", catalogs)).toEqual({ kind: "sprout", name: "nightly", rest: "" });
    expect(resolveSlash("/paused-one now", "bean", catalogs)).toEqual({ kind: "sprout", name: "paused-one", rest: "now" });
  });

  it("menu commands are qualified where a higher kind shadows the slug", () => {
    const cmd = (name: string): string | undefined => slashEntries("bean", catalogs).find((e) => e.name === name)?.command;
    expect(cmd("Review Code")).toBe("/review-code");
    expect(cmd("claude")).toBe("/claude");
    expect(slashEntries("bean", catalogs).filter((e) => e.kind === "skill" && e.name === "claude")[0]?.command).toBe("/skill:claude");
    expect(cmd("nightly")).toBe("/sprout:nightly");
  });

  it("never resolves a slug collision silently, typed or picked from the menu", () => {
    const clash = { ...catalogs, skills: [skill("Foo Bar"), skill("foo-bar")] };
    const res = { kind: "ambiguous", of: "skill", slug: "foo-bar", names: ["Foo Bar", "foo-bar"] };
    expect(resolveSlash("/foo-bar", "bean", clash)).toEqual(res);
    expect(resolveSlash("/skill:Foo-Bar x", "bean", clash)).toEqual(res);
    // A menu pick runs the entry's command, which resolves the same way.
    for (const e of slashMenu("/foo", "bean", clash).entries) expect(resolveSlash(e.command, "bean", clash)).toEqual(res);
  });

  it("unknown bare stays text; unknown qualified is an error; agent mode only knows agents", () => {
    expect(resolveSlash("/nope hi", "bean", catalogs)).toBeUndefined();
    expect(resolveSlash("/skill:nope", "bean", catalogs)).toEqual({ kind: "unknown", of: "skill", slug: "nope" });
    expect(resolveSlash("/sprout:pings", "bean", catalogs)).toEqual({ kind: "unknown", of: "sprout", slug: "pings" });
    expect(resolveSlash("see /review-code", "bean", catalogs)).toBeUndefined();
    expect(resolveSlash("/review-code", "claude", catalogs)).toBeUndefined();
    expect(resolveSlash("/bean", "claude", catalogs)).toEqual({ kind: "agent", name: "bean", rest: "" });
    expect(slashMenu("/", "claude", catalogs).entries.map((e) => e.name)).toEqual(["bean", "claude"]);
    expect(slashMenu("/skill:", "claude", catalogs).entries).toEqual([]);
  });

  it("filters hidden/disabled skills and notify-only watches; terminal skills show disabled", () => {
    const names = slashEntries("bean", catalogs).map((e) => e.name);
    expect(names).toContain("quiet");
    expect(names).not.toContain("secret");
    expect(names).not.toContain("off");
    expect(names).not.toContain("pings");
    expect(resolveSlash("/secret", "bean", catalogs)).toBeUndefined();
    const deploy = slashEntries("bean", catalogs).find((e) => e.name === "deploy");
    expect(deploy).toMatchObject({ caption: "terminal", disabled: "coming next" });
  });

  it("menu: sections in order, prefix before description matches, captions, capped with +N more", () => {
    const all = slashMenu("/", "bean", catalogs);
    expect(all.entries.map((e) => e.kind)).toEqual([...all.entries.map((e) => e.kind)].sort((a, b) => ["agent", "skill", "sprout"].indexOf(a) - ["agent", "skill", "sprout"].indexOf(b)));
    expect(all.entries).toHaveLength(8);
    expect(all.more).toBe(slashEntries("bean", catalogs).length - 8);
    const sprouts = slashMenu("/sprout:", "bean", catalogs).entries;
    expect(sprouts.map((e) => e.caption)).toEqual(["sprout → Discord, notification", "sprout → note · Paused · runs once"]);
    const ranked = slashMenu("/beta", "bean", { agents: [], skills: [skill("alpha", { description: "beta things" }), skill("Beta")], sprouts: [] });
    expect(ranked.entries.map((e) => e.name)).toEqual(["Beta", "alpha"]); // prefix, then description
  });
});

describe("ChatWindow slash commands", () => {
  const listeners: Record<string, (arg: unknown) => void> = {};
  let bean: Record<string, ReturnType<typeof vi.fn>>;
  let root: HTMLDivElement;

  const flush = async (): Promise<void> => { await act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); }); };
  const composer = (): HTMLTextAreaElement => root.querySelector("textarea.bean-input--composer") as HTMLTextAreaElement;
  const type = async (text: string): Promise<void> => {
    const ta = composer();
    ta.value = text;
    await act(async () => { ta.dispatchEvent(new Event("input", { bubbles: true })); });
    await flush();
  };
  const key = async (k: string, init: KeyboardEventInit = {}): Promise<void> => {
    await act(async () => { composer().dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init })); });
    await flush();
  };
  const send = async (text: string): Promise<void> => { composer().value = text; await key("Enter"); };
  const statuses = (): string[] => [...root.querySelectorAll(".bean-status")].map((e) => e.textContent ?? "");

  beforeEach(() => {
    bean = {
      getModel: vi.fn(async () => "m"),
      getTheme: vi.fn(async () => "light"),
      listProjects: vi.fn(async () => []),
      listSkills: vi.fn(async () => catalogs.skills),
      routinesList: vi.fn(async () => catalogs.sprouts),
      availableClis: vi.fn(async () => ["claude"]),
      availableModels: vi.fn(async () => []),
      chat: vi.fn(async () => ({ reply: "ok", model: "m" })),
      routinesRunNow: vi.fn(async () => ({ started: true })),
    };
    (window as unknown as { bean: unknown }).bean = new Proxy(bean, {
      get: (t, k: string) => t[k] ?? (k.startsWith("on") ? (cb: (a: unknown) => void) => { listeners[k] = cb; } : async () => undefined),
    });
    root = document.createElement("div");
    document.body.appendChild(root);
  });
  afterEach(() => { render(null, root); document.body.innerHTML = ""; });

  const mount = async (): Promise<void> => { await act(async () => { render(h(ChatWindow, {}), root); }); await flush(); };

  it("a chat skill runs its composed prompt as a skill turn (no memory tools)", async () => {
    await mount();
    await send("/review-code the auth diff");
    const call = bean.chat!.mock.calls[0]![0];
    expect(call.source).toBe("skill");
    expect(call.message).toContain("# Review Code");
    expect(call.message).toContain("## Task\nthe auth diff");
    expect(root.textContent).toContain("▶ Review Code — the auth diff");
  });

  it("two parallel runs of one sprout each update only their own row; refusals and rejections show", async () => {
    await mount();
    const done: Array<(v: { started: boolean; reason?: string }) => void> = [];
    bean.routinesRunNow!.mockImplementation(() => new Promise((r) => { done.push(r); }));
    await send("/sprout:nightly");
    await send("/sprout:nightly");
    expect(statuses()).toEqual(["🌱 Running nightly…", "🌱 Running nightly…"]);
    await act(async () => { done[1]!({ started: false, reason: "already running" }); });
    await flush();
    expect(statuses()).toEqual(["🌱 Running nightly…", "🌱 nightly didn't run: already running"]);
    await act(async () => { done[0]!({ started: true }); });
    await flush();
    expect(statuses()).toEqual(["🌱 nightly — Run finished · see Dashboard", "🌱 nightly didn't run: already running"]);

    bean.routinesRunNow!.mockImplementation(async () => { throw new Error("ipc down"); });
    await send("/paused-one");
    expect(statuses().at(-1)).toBe("🌱 Couldn't run paused-one: ipc down");
    await send("/paused-one now please");
    expect(statuses().at(-1)).toContain("takes no text");
    expect(bean.routinesRunNow).toHaveBeenCalledTimes(3);
    expect(bean.chat).not.toHaveBeenCalled();
  });

  it("unknown bare goes to Bean; unknown qualified, ambiguous and terminal skills are error rows with no model work", async () => {
    bean.listSkills!.mockResolvedValue([...catalogs.skills, skill("Foo Bar"), skill("foo-bar")]);
    await mount();
    await send("/skill:nope");
    await send("/foo-bar");
    await send("/deploy");
    expect(bean.chat).not.toHaveBeenCalled();
    expect(statuses()).toEqual([
      'No skill "nope" — check the / menu.',
      '/foo-bar matches more than one skill: "Foo Bar", "foo-bar" — rename one in Skills.',
      "\"deploy\" runs in the terminal — that's coming next from chat.",
    ]);
    await send("/nope hi");
    expect(bean.chat!.mock.calls[0]![0]).toMatchObject({ message: "/nope hi", source: "typed" });
  });

  it("commands parse only from the composer — a pushed chat prompt is sent as is", async () => {
    await mount();
    await act(async () => { listeners.onChatPrompt!({ prompt: "/sprout:nightly", label: "x" }); });
    await flush();
    expect(bean.routinesRunNow).not.toHaveBeenCalled();
    expect(bean.chat!.mock.calls[0]![0]).toMatchObject({ message: "/sprout:nightly", source: "skill" });
  });

  it("menu: refreshes catalogs on open, arrows + Enter run a row, Tab completes, Esc closes", async () => {
    await mount();
    const before = bean.routinesList!.mock.calls.length;
    await type("/");
    expect(bean.routinesList!.mock.calls.length).toBe(before + 1);
    expect(root.querySelector(".bean-slash-menu")?.textContent).toContain("Switch to");
    expect(composer().placeholder).toBe("Message Bean… — / for skills & sprouts");

    await type("/sprout:");
    await key("ArrowDown");
    expect(root.querySelector(".bean-chip-menu-row--on")?.textContent).toContain("/paused-one");
    await key("Enter");
    expect(bean.routinesRunNow).toHaveBeenCalledWith("paused-one");
    expect(composer().value).toBe("");

    await type("/rev");
    await key("Tab");
    expect(composer().value).toBe("/review-code ");
    expect(root.querySelector(".bean-slash-menu")).toBeNull();

    await type("/rev");
    await key("Escape");
    expect(root.querySelector(".bean-slash-menu")).toBeNull();

    // IME composition: Enter belongs to the input method.
    await type("/rev");
    await key("Enter", { isComposing: true });
    expect(bean.chat).not.toHaveBeenCalled();
  });
});
