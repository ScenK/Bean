import { expect, test, vi } from "vitest";
import type { OutboxMessage } from "@bean/core";
import { deliverOutboxDm } from "../src/outbox-dm.js";

const msg = (o: Partial<OutboxMessage> = {}): OutboxMessage =>
  ({ id: "m1", transport: "discord", body: "hi", createdAt: "2026-01-01T00:00:00Z", ...o });
const okUser = (sent: string[]) => ({ username: "amy", send: async (t: string) => { sent.push(t); return { channelId: "dm1" }; } });

test("DMs msg.userId when set, else the owner", async () => {
  const fetchUser = vi.fn(async () => okUser([]));
  const notifyOwner = vi.fn(async () => {});
  expect(await deliverOutboxDm(msg({ userId: "u1" }), "hi", { ownerId: "own", fetchUser, notifyOwner })).toBe("dm1");
  await deliverOutboxDm(msg(), "hi", { ownerId: "own", fetchUser, notifyOwner });
  expect(fetchUser.mock.calls.map((c) => (c as unknown[])[0])).toEqual(["u1", "own"]);
  expect(notifyOwner).not.toHaveBeenCalled();
});

test("a failed member DM sends one owner notice; a failed owner DM sends none", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const notifyOwner = vi.fn(async () => {});
  const fetchUser = async () => ({ username: "amy", send: async (): Promise<{ channelId: string }> => { throw new Error("Cannot send messages to this user"); } });
  expect(await deliverOutboxDm(msg({ userId: "u1", title: "Routine: r" }), "hi", { ownerId: "own", fetchUser, notifyOwner })).toBeUndefined();
  expect(notifyOwner.mock.calls).toEqual([['Couldn\'t DM amy "Routine: r": Cannot send messages to this user']]);
  await deliverOutboxDm(msg(), "hi", { ownerId: "own", fetchUser, notifyOwner });
  expect(notifyOwner).toHaveBeenCalledTimes(1);
});
