import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { launchBean } from "./fixtures/launch-app.js";
import { makeBeanHome } from "./fixtures/bean-home.js";
import { startStubOpenAI } from "./fixtures/stub-openai.js";

// #740: Stop and Esc Esc end Bean's own running turn (modeled on live-stop.e2e.ts). The stub's
// `hang` reply never answers, so only a Stop ends the turn — and it must abort the HTTP request.
async function openChat(app: ElectronApplication): Promise<Page> {
  const avatar = await app.firstWindow();
  const [chat] = await Promise.all([
    app.waitForEvent("window"),
    avatar.evaluate(() => (window as unknown as { bean: { openComponent: (k: string) => void } }).bean.openComponent("chat")),
  ]) as [Page, unknown];
  await chat.waitForLoadState("domcontentloaded");
  return chat;
}

test("Bean's turn: the row's Stop and Esc Esc end it, the next send answers; a single Esc with the overlay open only closes it", async () => {
  const home = await makeBeanHome({ autoMemory: false });
  const stub = await startStubOpenAI();
  const app = await launchBean({ HOME: home.homeDir, OPENAI_BASE_URL: stub.url });
  try {
    const chat = await openChat(app);
    const composer = chat.locator(".bean-input--composer");
    const working = chat.locator(".bean-bubble--working");
    const stop = working.getByRole("button", { name: "Stop", exact: true });
    const stopped = chat.locator(".bean-status", { hasText: "Stopped by you." });
    const send = async (text: string): Promise<void> => { await composer.fill(text); await composer.press("Enter"); };
    const answers = async (text: string): Promise<void> => {
      stub.queue({ content: text });
      await send("still there?");
      await expect(chat.locator(".bean-bubble--bean").last()).toContainText(text);
    };
    // "Stopping…" lasts one IPC round trip — record it rather than race it.
    await chat.evaluate(() => {
      const w = window as unknown as { sawStopping: boolean };
      w.sawStopping = false;
      new MutationObserver(() => {
        if ([...document.querySelectorAll(".bean-bubble--working button")].some((b) => b.textContent === "Stopping…" && (b as HTMLButtonElement).disabled)) w.sawStopping = true;
      }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    });

    // Turn 1 — the working row's Stop.
    stub.queue({ hang: true });
    await send("first");
    await expect(stop).toBeVisible();
    await expect(stop).toHaveAttribute("title", "Stop this turn (Esc Esc)");
    await stop.click();
    await expect(stopped).toHaveCount(1);
    await expect(working).toHaveCount(0);
    expect(await chat.evaluate(() => (window as unknown as { sawStopping: boolean }).sawStopping)).toBe(true);
    await expect.poll(stub.aborted).toBe(1);
    await answers("Back to normal.");

    // Turn 2 — Esc Esc in the composer.
    stub.queue({ hang: true });
    await send("second");
    await expect(stop).toBeVisible();
    await composer.press("Escape");
    await expect(working.getByText("Esc again to stop")).toBeVisible();
    await composer.press("Escape");
    await expect(stopped).toHaveCount(2);
    await expect.poll(stub.aborted).toBe(2);
    await answers("Still fine.");

    // Turn 3 — a single Esc with the history overlay open only closes the overlay.
    stub.queue({ hang: true });
    await send("third");
    await expect(stop).toBeVisible();
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith("/chat.html"))!.setSize(500, 600);
    });
    await chat.getByRole("button", { name: "Show chat history" }).click();
    await expect(chat.locator(".bean-chat-sidebar--overlay")).toBeVisible();
    await composer.focus();
    await composer.press("Escape");
    await expect(chat.locator(".bean-chat-sidebar--overlay")).toHaveCount(0);
    await chat.waitForTimeout(1_200); // past the Esc Esc window
    await expect(working.getByText("Esc again to stop")).toHaveCount(0);
    await expect(stop).toBeVisible();
    await expect(stopped).toHaveCount(2);
    expect(stub.aborted()).toBe(2);
    await stop.click();
    await expect(stopped).toHaveCount(3);
  } finally {
    await Promise.allSettled([app.close(), stub.close(), home.cleanup()]);
  }
});

test("Stop while Bean reads a PDF: no read-failure text, the PDF is unpinned, and the next send answers without it", async () => {
  const home = await makeBeanHome({ autoMemory: false });
  const stub = await startStubOpenAI();
  const app = await launchBean({ HOME: home.homeDir, OPENAI_BASE_URL: stub.url });
  try {
    const chat = await openChat(app);
    const composer = chat.locator(".bean-input--composer");
    await composer.evaluate((el) => {
      const dt = new DataTransfer();
      dt.items.add(new File(["%PDF-1.4\n%%EOF\n"], "report.pdf", { type: "application/pdf" }));
      el.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    await expect(chat.locator(".bean-chat-pending-file")).toContainText("report.pdf");

    stub.queue({ hang: true });
    await composer.fill("what is this?");
    await composer.press("Enter");
    const working = chat.locator(".bean-bubble--working");
    await expect(working).toContainText("Reading report.pdf…");
    await working.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(chat.locator(".bean-status", { hasText: "Stopped by you. 📄 report.pdf unpinned — drop it again to retry." })).toBeVisible();
    await expect(working).toHaveCount(0);
    await expect(chat.locator(".bean-chat-pending-file")).toHaveCount(0);
    await expect(chat.getByText("I couldn't read")).toHaveCount(0);

    stub.queue({ content: "Hello again." });
    await composer.fill("hi");
    await composer.press("Enter");
    await expect(chat.locator(".bean-bubble--bean").last()).toContainText("Hello again.");
    expect(JSON.stringify(stub.requests.at(-1))).not.toContain("input_file");
  } finally {
    await Promise.allSettled([app.close(), stub.close(), home.cleanup()]);
  }
});
