import { expect, type Page } from "@playwright/test";

/** The avatar opens the main conversation (#1001); a spec about a separate chat starts one the way the
 * user does, with "+ New task chat" — once the main conversation is shown, so its late arrival can't
 * switch back. */
export async function startTaskChat(chat: Page): Promise<void> {
  const main = chat.locator(".bean-chat-sidebar-home");
  await expect(main).toHaveClass(/bean-chat-sidebar-home--active/);
  await chat.locator(".bean-chat-sidebar-new").click();
  await expect(main).not.toHaveClass(/bean-chat-sidebar-home--active/);
  // The new chat focuses its composer in an effect that runs after paint — later than the class flip
  // above. Waited for, so it can't take focus from whatever the spec focuses next (a sidebar rename).
  await expect(chat.locator(".bean-chat:not([hidden]) .bean-input--composer")).toBeFocused();
}
