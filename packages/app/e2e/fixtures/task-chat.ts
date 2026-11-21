import { expect, type Page } from "@playwright/test";

/** The avatar opens the main conversation (#1001); a spec about a separate chat starts one the way the
 * user does, with "+ New task chat" — once the main conversation is shown, so its late arrival can't
 * switch back. */
export async function startTaskChat(chat: Page): Promise<void> {
  const main = chat.locator(".bean-chat-sidebar-home");
  await expect(main).toHaveClass(/bean-chat-sidebar-home--active/);
  await chat.locator(".bean-chat-sidebar-new").click();
  await expect(main).not.toHaveClass(/bean-chat-sidebar-home--active/);
}
