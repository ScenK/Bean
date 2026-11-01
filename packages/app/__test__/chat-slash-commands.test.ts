// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { availableModels, resolveDelegateSelection, type CliModels, type CliName, type Project, type Routine, type Skill } from "@bean/core";
import {
  resolveSlash, slashEntries, slashMenu, slugify, terminalDestination, type SlashCatalogs, type SlashDelegate,
} from "../src/renderer/components/chat/slash-commands.js";
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
    for (const e of slashMenu("/foo", "bean", clash)) expect(resolveSlash(e.command, "bean", clash)).toEqual(res);
  });

  it("unknown bare stays text; unknown qualified is an error; agent mode only knows agents", () => {
    expect(resolveSlash("/nope hi", "bean", catalogs)).toBeUndefined();
    expect(resolveSlash("/skill:nope", "bean", catalogs)).toEqual({ kind: "unknown", of: "skill", slug: "nope" });
    expect(resolveSlash("/sprout:pings", "bean", catalogs)).toEqual({ kind: "unknown", of: "sprout", slug: "pings" });
    expect(resolveSlash("see /review-code", "bean", catalogs)).toBeUndefined();
    expect(resolveSlash("/review-code", "claude", catalogs)).toBeUndefined();
    expect(resolveSlash("/bean", "claude", catalogs)).toEqual({ kind: "agent", name: "bean", rest: "" });
    expect(slashMenu("/", "claude", catalogs).map((e) => e.name)).toEqual(["bean", "claude"]);
    expect(slashMenu("/skill:", "claude", catalogs)).toEqual([]);
  });

  it("filters hidden/disabled skills and notify-only watches", () => {
    const names = slashEntries("bean", catalogs).map((e) => e.name);
    expect(names).toContain("quiet");
    expect(names).not.toContain("secret");
    expect(names).not.toContain("off");
    expect(names).not.toContain("pings");
    expect(resolveSlash("/secret", "bean", catalogs)).toBeUndefined();
    expect(resolveSlash("/deploy fix it", "bean", catalogs)).toEqual({ kind: "skill", name: "deploy", rest: "fix it" });
  });

  it("terminal destination: assigned project > default skill > first project > scratch; CLI = main's pick", () => {
    const p = (name: string, extra: Partial<Project> = {}): Project => ({ name, path: `/p/${name}`, ...extra });
    const projects = [p("first"), p("dflt", { defaultSkill: "deploy" }), p("mine", { skills: ["deploy"] })];
    const d: SlashDelegate = { projects, clis: ["claude"], models: [], delegateCli: "", lastUsedModels: {} };
    expect(terminalDestination("deploy", d)).toEqual({ projectPath: "/p/mine", projectName: "mine", cli: "claude" });
    expect(terminalDestination("deploy", { ...d, projects: projects.slice(0, 2) })).toMatchObject({ projectPath: "/p/dflt" });
    expect(terminalDestination("other", d)).toMatchObject({ projectPath: "/p/first" });
    expect(terminalDestination("deploy", { ...d, projects: [] })).toMatchObject({ projectPath: "", projectName: "scratch" });
    expect(terminalDestination("deploy", { ...d, clis: [] }).cli).toBeUndefined();
    expect(slashEntries("bean", { ...catalogs, delegate: d }).find((e) => e.name === "deploy")?.caption).toBe("claude · mine");
    expect(slashEntries("bean", { ...catalogs, delegate: { ...d, clis: [], projects: [] } }).find((e) => e.name === "deploy")?.caption)
      .toBe("no coding agent · scratch");

    // The caption's CLI is the one main's resolveDelegateSelection starts, for the remembered model.
    const cliModels: CliModels[] = [{ provider: "claude", models: ["sonnet"] }, { provider: "codex", models: ["gpt-5.6-sol"] }];
    const cases: Array<[CliName[], string, string | undefined]> = [
      [["claude", "codex"], "", undefined], [["claude", "codex"], "codex", undefined], [["codex", "claude"], "codex", "sonnet"],
      [["codex"], "claude", "sonnet"], [["claude", "codex"], "", "gone"],
    ];
    for (const [clis, delegateCli, model] of cases) {
      const dest = terminalDestination("deploy", {
        ...d, clis, delegateCli, models: availableModels(cliModels, clis), lastUsedModels: model ? { deploy: model } : {},
      });
      expect(dest.cli).toBe(resolveDelegateSelection(cliModels, clis, delegateCli, model)?.cli);
      expect(dest.model).toBe(model);
    }
  });

  it("menu: every entry, Skills > Sprouts > Switch to, prefix before description matches, captions", () => {
    const all = slashMenu("/", "bean", catalogs);
    expect(all).toEqual([...slashEntries("bean", catalogs)].sort((a, b) =>
      ["skill", "sprout", "agent"].indexOf(a.kind) - ["skill", "sprout", "agent"].indexOf(b.kind)));
    // No cap: 20 skills all listed, skills first.
    const many = { ...catalogs, skills: Array.from({ length: 20 }, (_, i) => skill(`s${i}`)) };
    const big = slashMenu("/", "bean", many);
    expect(big.filter((e) => e.kind === "skill")).toHaveLength(20);
    expect(big.slice(0, 20).every((e) => e.kind === "skill")).toBe(true);
    const sprouts = slashMenu("/sprout:", "bean", catalogs);
    expect(sprouts.map((e) => e.caption)).toEqual(["sprout → Discord, notification", "sprout → note · Paused · runs once"]);
    const ranked = slashMenu("/beta", "bean", { agents: [], skills: [skill("alpha", { description: "beta things" }), skill("Beta")], sprouts: [] });
    expect(ranked.map((e) => e.name)).toEqual(["Beta", "alpha"]); // prefix, then description
  });

  it("menu: the row a typed command resolves to leads, so Enter on the first row matches resolveSlash", () => {
    const c = { ...catalogs, skills: [...catalogs.skills, skill("claude-review"), skill("night-owl")] };
    // /claude: the agent alias wins resolution, so it (and its section) lead over the claude-review skill.
    expect(slashMenu("/claude", "bean", c).map((e) => e.command)).toEqual(["/claude", "/skill:claude", "/claude-review"]);
    expect(slashMenu("/c", "bean", c)[0]?.kind).toBe("skill"); // no exact match: plain section order
    expect(slashMenu("/nightly", "bean", c)[0]?.name).toBe("Nightly");
    expect(slashMenu("/sprout:nightly", "bean", c)[0]?.name).toBe("nightly");
    for (const t of ["/claude", "/nightly", "/review-code", "/deploy", "/bean"]) {
      const first = slashMenu(t, "bean", c)[0]!;
      const res = resolveSlash(t, "bean", c);
      expect(res && "name" in res ? res.name : undefined).toBe(first.name);
    }
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

  it("unknown bare goes to Bean; unknown qualified and ambiguous are error rows with no model work", async () => {
    bean.listSkills!.mockResolvedValue([...catalogs.skills, skill("Foo Bar"), skill("foo-bar")]);
    await mount();
    await send("/skill:nope");
    await send("/foo-bar");
    expect(bean.chat).not.toHaveBeenCalled();
    expect(statuses()).toEqual([
      'No skill "nope" — check the / menu.',
      '/foo-bar matches more than one skill: "Foo Bar", "foo-bar" — rename one in Skills.',
    ]);
    await send("/nope hi");
    expect(bean.chat!.mock.calls[0]![0]).toMatchObject({ message: "/nope hi", source: "typed" });
  });

  it("a terminal skill opens a pending card at its caption's destination; Start (focused) runs it once", async () => {
    bean.listProjects!.mockResolvedValue([{ name: "Bean", path: "/p/bean", skills: ["deploy"] }]);
    bean.getModelMemory = vi.fn(async (name: string) => (name === "deploy" ? "sonnet" : undefined));
    bean.setModelMemory = vi.fn(async () => {});
    bean.availableModels!.mockResolvedValue([{ id: "sonnet", label: "Sonnet", availableOn: ["claude"] }]);
    bean.getConfig = vi.fn(async () => ({ delegateCli: "claude" }));
    let started!: (taskId: string) => void;
    bean.delegateStart = vi.fn(() => new Promise<string>((r) => { started = r; }));
    await mount();
    await type("/dep");
    expect(root.querySelector(".bean-slash-menu")?.textContent).toContain("/deploy claude · Bean");
    await key("Escape");

    await send("/deploy fix X");
    expect(bean.delegateStart).not.toHaveBeenCalled(); // pending: the user can still change where it runs
    expect(root.textContent).toContain("project · Bean");
    expect(root.textContent).toContain("Sonnet"); // the remembered model
    const startButton = document.activeElement as HTMLButtonElement;
    expect(startButton.closest(".bean-card-actions")).not.toBeNull(); // ↵ ↵ runs it
    const held = new KeyboardEvent("keydown", { key: "Enter", repeat: true, bubbles: true, cancelable: true });
    startButton.dispatchEvent(held);
    expect(held.defaultPrevented).toBe(true); // a held Enter can't press Start

    await act(async () => { startButton.click(); });
    await flush();
    expect(document.activeElement).toBe(composer());
    expect(bean.delegateStart).toHaveBeenCalledTimes(1);
    const req = bean.delegateStart!.mock.calls[0]![0];
    expect(req).toMatchObject({ projectPath: "/p/bean", skillName: "deploy", model: "sonnet", instruction: "deploy — fix X" });
    expect(req.prompt).toContain("## Task\nfix X");
    expect(Object.keys(req).sort()).toEqual(["instruction", "model", "projectPath", "prompt", "skillName"]); // no browser flag
    expect(bean.setModelMemory).toHaveBeenCalledWith("deploy", "sonnet");
    expect(bean.chat).not.toHaveBeenCalled();
    expect(root.textContent).toContain("Starting...");
    const buttons = (): HTMLButtonElement[] => [...root.querySelectorAll<HTMLButtonElement>(".bean-card .bean-card-actions button")];
    expect(buttons()[0]!.disabled).toBe(true);
    expect(root.querySelector(".bean-card .bean-chip-menu-trigger")).toBeNull(); // pickers locked once started

    await act(async () => { started("t1"); });
    await flush();
    bean.delegateCancel = vi.fn();
    await act(async () => { buttons().find((b) => b.textContent === "Cancel")!.click(); });
    expect(bean.delegateCancel).toHaveBeenCalledWith("t1");
    await act(async () => { listeners.onDelegateEvent!({ taskId: "t1", type: "done", result: "fixed" }); });
    await flush();
    expect(bean.chat!.mock.calls[0]![0]).toMatchObject({ source: "loopback" });

    await send("/deploy x");
    expect(bean.delegateStart).toHaveBeenCalledTimes(1); // a new pending card, not a run
    expect(root.querySelectorAll(".bean-card").length).toBe(2);
  });

  it("a terminal skill's card runs where the user picks — another project, then scratch", async () => {
    bean.listProjects!.mockResolvedValue([{ name: "Other", path: "/p/other" }, { name: "Bean", path: "/p/bean", skills: ["deploy"] }]);
    bean.delegateStart = vi.fn(async () => "t2");
    await mount();
    await send("/deploy");
    const trigger = (): HTMLButtonElement => root.querySelector<HTMLButtonElement>(".bean-card .bean-chip-menu-trigger")!;
    await act(async () => { trigger().click(); });
    const rows = (): HTMLButtonElement[] => [...root.querySelectorAll<HTMLButtonElement>(".bean-chip-menu-row")];
    expect(rows().map((r) => r.textContent)).toEqual(["✓ Bean", "Other", "No project — scratch"]); // assigned first
    await act(async () => { rows()[2]!.click(); });
    expect(trigger().className).toContain("bean-chip-menu-trigger--dashed");
    expect(trigger().textContent).toContain("project · scratch");
    await act(async () => { trigger().click(); });
    await act(async () => { rows()[1]!.click(); });
    await act(async () => { (document.activeElement as HTMLButtonElement).click(); });
    await flush();
    expect(bean.delegateStart!.mock.calls[0]![0]).toMatchObject({ projectPath: "/p/other", skillName: "deploy" });
    expect(root.textContent).toContain("project · Other"); // the committed project
  });

  it("a Bean-proposed delegate card gets the project picker but never takes the composer's focus", async () => {
    bean.listProjects!.mockResolvedValue([{ name: "Bean", path: "/p/bean" }]);
    bean.chat!.mockResolvedValue({ reply: "On it?", model: "m", proposedDelegate: { projectPath: "/p/bean", instruction: "check", composedPrompt: "go" } });
    await mount();
    await send("check the repo");
    expect(root.querySelector(".bean-card .bean-chip-menu-trigger")?.textContent).toContain("project · Bean");
    expect(document.activeElement).toBe(composer());
  });

  it("a terminal skill with no project runs in scratch and shows main's no-CLI failure on the card", async () => {
    bean.delegateStart = vi.fn(async () => "t9");
    await mount();
    await send("/deploy");
    await act(async () => { (document.activeElement as HTMLButtonElement).click(); });
    await flush();
    expect(bean.delegateStart!.mock.calls[0]![0]).toMatchObject({ projectPath: "", skillName: "deploy" }); // scratch: main maps ""
    await act(async () => { listeners.onDelegateEvent!({ taskId: "t9", type: "failed", message: "No enabled delegate CLI found — enable one in Settings." }); });
    await flush();
    expect(root.textContent).toContain("No enabled delegate CLI found — enable one in Settings.");
    expect(root.textContent).toContain("project · scratch");
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
    expect(composer().placeholder).toBe("Message Bean · type / for skills");

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
