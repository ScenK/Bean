// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import type { MindItem } from "@bean/core";
import { ChatWindow } from "../src/renderer/components/chat/ChatWindow.js";
import { homeSubLabel, isQuietHours, replyCrossed } from "../src/renderer/components/chat/seeds.js";

const seed = (id: string, over: Partial<MindItem> = {}): MindItem => ({
  id, topicKey: id, text: `seed ${id}`, status: "active", version: 1, createdAt: "2026-11-27T10:00:00.000Z", updatedAt: "2026-11-27T10:00:00.000Z", ...over,
});

describe("seeds helpers (#1159)", () => {
  it("labels the Home row by active seeds only, and only when enabled", () => {
    expect(homeSubLabel({ enabled: true, items: [seed("a"), seed("b"), seed("c", { status: "done" })], planting: [] })).toBe("Watching 2 seeds");
    expect(homeSubLabel({ enabled: true, items: [seed("a")], planting: [] })).toBe("Watching 1 seed");
    expect(homeSubLabel({ enabled: true, items: [], planting: [] })).toBe("Superagent");
    expect(homeSubLabel({ enabled: false, items: [seed("a")], planting: [] })).toBe("Superagent");
  });

  it("a reply-crossed seed is a done one the pulse wrote last, not yet seen at that version", () => {
    const t = "2026-11-27T11:00:00.000Z";
    const byPulse = seed("p", { status: "done", version: 2, updatedAt: t, reconciledAt: t });
    const byOwner = seed("o", { status: "done", version: 2, updatedAt: t, reconciledAt: "2026-11-27T10:00:00.000Z" });
    const expired = seed("e", { status: "expired", version: 2, updatedAt: t, reconciledAt: t });
    expect(replyCrossed([byPulse, byOwner, expired], new Set())).toEqual([byPulse]);
    expect(replyCrossed([byPulse], new Set(["p:2"]))).toEqual([]);
  });

  it("quiet hours are 22:00–07:00 local", () => {
    expect(isQuietHours(new Date(2026, 10, 27, 22, 0))).toBe(true);
    expect(isQuietHours(new Date(2026, 10, 27, 6, 59))).toBe(true);
    expect(isQuietHours(new Date(2026, 10, 27, 7, 0))).toBe(false);
  });
});

describe("Home Seeds (#1159)", () => {
  const HOME = "4f1d7c2e-3b4a-4e6f-8a1b-5c2d3e4f5a6b";
  let bean: Record<string, ReturnType<typeof vi.fn>>;
  let root: HTMLDivElement;
  let dial = "medium";
  let list: MindItem[] = [];
  const now = new Date().toISOString();
  const pulse = { id: "c1", sprout: "Bean", body: "Your **flight** moved.", createdAt: now, kind: "pulse" };

  const flush = async (): Promise<void> => { await act(async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); }); };
  const shownChat = (): Element => root.querySelector(".bean-chat:not([hidden])")!;
  const click = async (el: Element | null | undefined): Promise<void> => {
    expect(el).toBeTruthy();
    await act(async () => { (el as HTMLElement).click(); });
    await flush();
  };
  const openHome = async (): Promise<void> => {
    await act(async () => { render(h(ChatWindow, {}), root); });
    await flush();
    await click(root.querySelector(".bean-chat-sidebar-home .bean-chat-sidebar-open"));
  };
  const chip = (): Element | null => shownChat().querySelector(".bean-seeds-chip");

  beforeEach(() => {
    dial = "medium";
    list = [seed("a", { sourceSprout: "Flights", sourceStartedAt: "2026-11-27T09:00:00.000Z" }), seed("b")];
    bean = {
      getModel: vi.fn(async () => "m"),
      listProjects: vi.fn(async () => []),
      listSkills: vi.fn(async () => []),
      availableClis: vi.fn(async () => ["claude"]),
      availableModels: vi.fn(async () => []),
      chat: vi.fn(async () => ({ reply: "ok", model: "m" })),
      chatThreadList: vi.fn(async () => []),
      syncedChatList: vi.fn(async () => []),
      chatThreadSave: vi.fn(async (req: { id: string; title: string }) => ({ id: req.id, title: req.title, updatedAt: new Date().toISOString(), home: true })),
      chatThreadGet: vi.fn(async () => ({ id: HOME, title: "Home", items: [], noteSlug: null, home: { posts: [pulse] } })),
      homePending: vi.fn(async () => 0),
      chatMainSince: vi.fn(async () => ({ rows: [], cursor: 0, trimmed: false })),
      getConfig: vi.fn(async () => ({ proactivity: dial })),
      listSeeds: vi.fn(async () => list),
      routinesList: vi.fn(async () => []),
      resolveSeed: vi.fn(async (id: string, status: string, version: number) => ({ ...list.find((s) => s.id === id)!, status, version: version + 1 })),
      undoSeed: vi.fn(async (id: string, version: number) => ({ ...list.find((s) => s.id === id)!, status: "active", version: version + 1 })),
      openComponent: vi.fn(async () => {}),
    };
    (window as unknown as { bean: unknown }).bean = new Proxy(bean, {
      get: (t, k: string) => t[k] ?? (k.startsWith("on") ? () => {} : async () => undefined),
    });
    root = document.createElement("div");
    document.body.appendChild(root);
  });
  afterEach(() => { render(null, root); document.body.innerHTML = ""; localStorage.clear(); });

  it("renders a check-in as Bean's bubble whose caption opens Seeds; chip and sidebar show the count", async () => {
    await openHome();
    const bubble = shownChat().querySelector(".bean-pulse")!;
    expect(bubble.querySelector("strong")?.textContent).toBe("flight");
    expect(shownChat().querySelector(".bean-post-head")).toBeNull(); // no "🌱 Bean ·" sprout head
    expect(shownChat().textContent).not.toContain("While you were away");
    expect(chip()?.textContent).toBe("Seeds · 2");
    expect(root.querySelector(".bean-chat-sidebar-home-sub")?.textContent).toBe("Watching 2 seeds");
    expect(bean.listSeeds).toHaveBeenCalled();

    await click(bubble.querySelector("button.bean-pulse-caption"));
    expect(bubble.querySelector(".bean-pulse-caption")?.textContent).toMatch(/^Bean noticed · /);
    const pop = shownChat().querySelector(".bean-seeds-pop")!;
    expect(pop.querySelectorAll(".bean-seed")).toHaveLength(2);

    // The source chip opens the run in the Dashboard.
    await click(pop.querySelector(".bean-seed-source"));
    expect(bean.openComponent).toHaveBeenCalledWith("dashboard", { routine: "Flights", startedAt: "2026-11-27T09:00:00.000Z" });
  });

  it("Done strikes through with an Undo toast; Let it go takes a one-tap reason", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await openHome();
      await click(chip());
      await click(shownChat().querySelector('[aria-label="Done: seed a"]'));
      expect(bean.resolveSeed).toHaveBeenCalledWith("a", "done", 1);
      expect(shownChat().querySelector(".bean-seed--fading")?.textContent).toBe("seed a");
      expect(shownChat().querySelector(".bean-seeds-toast")?.textContent).toContain("Crossed off · Undo");
      await act(async () => { vi.advanceTimersByTime(2100); });
      expect(shownChat().querySelector(".bean-seed--fading")).toBeNull();
      await click(shownChat().querySelector(".bean-seeds-toast .bean-seed-link"));
      expect(bean.undoSeed).toHaveBeenCalledWith("a", 2);

      await click(shownChat().querySelector('[aria-label="Let it go: seed b"]'));
      expect(bean.resolveSeed).toHaveBeenCalledTimes(1); // a reason row first, nothing sent yet
      const wrong = [...shownChat().querySelectorAll(".bean-seed-reasons button")].find((b) => b.textContent === "That's wrong");
      await click(wrong);
      expect(bean.resolveSeed).toHaveBeenLastCalledWith("b", "dismissed", 1, "wrong");
    } finally {
      vi.useRealTimers();
    }
  });

  it("Discuss prefills the composer and sends nothing; a changed seed shows the host's message", async () => {
    await openHome();
    await click(chip());
    await click(shownChat().querySelector(".bean-seed-body"));
    const ta = shownChat().querySelector("textarea.bean-input--composer") as HTMLTextAreaElement;
    expect(ta.value).toBe('About "seed a": ');
    expect(document.activeElement).toBe(ta);
    expect(shownChat().querySelector(".bean-seeds-pop")).toBeNull();
    expect(bean.chat).not.toHaveBeenCalled();

    bean.resolveSeed!.mockRejectedValueOnce(new Error("Error invoking remote method 'bean:resolve-seed': Error: That seed just changed — have another look."));
    await click(chip());
    await click(shownChat().querySelector('[aria-label="Done: seed a"]'));
    expect(shownChat().querySelector(".bean-seeds-error")?.textContent).toBe("That seed just changed — have another look.");
  });

  it("empty: the invitation and Choose sprouts…; a reply-crossed seed shows once with Undo", async () => {
    const t = "2026-11-27T11:00:00.000Z";
    list = [seed("r", { status: "done", version: 3, updatedAt: t, reconciledAt: t })];
    await openHome();
    expect(chip()?.textContent).toBe("Seeds");
    expect(root.querySelector(".bean-chat-sidebar-home-sub")?.textContent).toBe("Superagent");
    await click(chip());
    expect(shownChat().querySelector(".bean-seed--crossed")?.textContent).toContain("Crossed off from your reply · Undo");
    await click(shownChat().querySelector(".bean-seed--crossed .bean-seed-link"));
    expect(bean.undoSeed).toHaveBeenCalledWith("r", 3);

    list = [];
    await click(chip()); // close
    await click(chip()); // reopen: shown once only
    expect(shownChat().querySelector(".bean-seed--crossed")).toBeNull();
    expect(shownChat().querySelector(".bean-seeds-empty")?.textContent).toContain("No seeds yet.");
    await click([...shownChat().querySelectorAll(".bean-seeds-empty button")].find((b) => b.textContent === "Choose sprouts…"));
    expect(bean.openComponent).toHaveBeenCalledWith("routines");
  });

  it("empty with a sprout already opted in: says it's waiting, no longer asks to choose", async () => {
    list = [];
    bean.routinesList = vi.fn(async () => [{ name: "Flights", feedBrain: true }, { name: "Other" }]);
    await openHome();
    await click(chip());
    const empty = shownChat().querySelector(".bean-seeds-empty")!;
    expect(empty.textContent).toContain("after Flights's next run");
    expect([...empty.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Sprouts…"]);
  });

  it("dial off: no chip, no popover from the caption, plain sidebar label", async () => {
    dial = "off";
    await openHome();
    expect(chip()).toBeNull();
    expect(shownChat().querySelector("button.bean-pulse-caption")).toBeNull();
    expect(shownChat().querySelector(".bean-pulse-caption")?.textContent).toMatch(/^Bean noticed · /);
    expect(root.querySelector(".bean-chat-sidebar-home-sub")?.textContent).toBe("Superagent");
    expect(bean.listSeeds).not.toHaveBeenCalled();
  });
});
