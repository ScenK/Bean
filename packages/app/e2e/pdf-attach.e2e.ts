import { test, expect, type Page } from "@playwright/test";
import { launchBean } from "./fixtures/launch-app.js";
import { makeBeanHome } from "./fixtures/bean-home.js";
import { startStubOpenAI } from "./fixtures/stub-openai.js";

// #731: a PDF dropped on the Bean-mode composer becomes a chip, is pinned to the chat, and rides
// as an `input_file` on the attaching turn and every turn after it.
test("chat: a dropped PDF is pinned and sent as input_file on consecutive turns", async () => {
  const home = await makeBeanHome({ autoMemory: false });
  const stub = await startStubOpenAI();
  stub.queue({ content: "It's a tiny PDF." });
  stub.queue({ content: "Still the same PDF." });
  const app = await launchBean({ HOME: home.homeDir, OPENAI_BASE_URL: stub.url });
  try {
    const avatar = await app.firstWindow();
    const [chat] = await Promise.all([
      app.waitForEvent("window"),
      avatar.evaluate(() => (window as unknown as { bean: { openComponent: (k: string) => void } }).bean.openComponent("chat")),
    ]) as [Page, unknown];
    await chat.waitForLoadState("domcontentloaded");
    const composer = chat.locator(".bean-input--composer");
    await composer.evaluate((el) => {
      const dt = new DataTransfer();
      dt.items.add(new File(["%PDF-1.4\n%%EOF\n"], "report.pdf", { type: "application/pdf" }));
      el.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    await expect(chat.locator(".bean-chat-pending-file")).toContainText("report.pdf");
    await expect(chat.getByRole("button", { name: "Remove report.pdf" })).toBeVisible();

    await composer.fill("what is this?");
    await composer.press("Enter");
    await expect(chat.locator(".bean-bubble--user .bean-chat-file")).toContainText("report.pdf");
    await expect(chat.locator(".bean-bubble--bean").last()).toContainText("It's a tiny PDF.");
    await composer.fill("and again?");
    await composer.press("Enter");
    await expect(chat.locator(".bean-bubble--bean").last()).toContainText("Still the same PDF.");

    const files = stub.requests.map((body) => JSON.stringify(body).match(/"type":"input_file","filename":"report\.pdf","file_data":"data:application\/pdf;base64,/g)?.length ?? 0);
    expect(files).toEqual([1, 1]);
    // Only the attaching turn shows the file chip; the pin stays on the composer.
    await expect(chat.locator(".bean-bubble--user .bean-chat-file")).toHaveCount(1);
    await expect(chat.locator(".bean-chat-pending-file")).toContainText("report.pdf");
  } finally {
    await Promise.allSettled([app.close(), stub.close(), home.cleanup()]);
  }
});
