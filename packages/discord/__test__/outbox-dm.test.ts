import { expect, test, vi } from "vitest";
import type { OutboxMessage } from "@bean/core";
import { deliverOutboxDm } from "../src/outbox-dm.js";

const msg = (o: Partial<OutboxMessage> = {}): OutboxMessage =>
  ({ id: "m1", transport: "discord", body: "hi", createdAt: "2026-01-01T00:00:00Z", ...o });
const groups = { record: () => {} };
const okUser = (sent: string[]) => ({ send: async (t: string) => { sent.push(t); return { channelId: "dm1", id: `m${sent.length}` }; } });

test("DMs msg.userId when set, else the owner", async () => {
  const fetchUser = vi.fn(async () => okUser([]));
  expect(await deliverOutboxDm(msg({ userId: "u1" }), "hi", { ownerId: "own", fetchUser, groups })).toBe("dm1");
  await deliverOutboxDm(msg(), "hi", { ownerId: "own", fetchUser, groups });
  expect(fetchUser.mock.calls.map((c) => (c as unknown[])[0])).toEqual(["u1", "own"]);
});

test("a failed DM throws so the outbox drain can retry it", async () => {
  const fetchUser = async () => ({ send: async (): Promise<{ channelId: string; id: string }> => { throw new Error("Cannot send messages to this user"); } });
  await expect(deliverOutboxDm(msg({ userId: "u1" }), "hi", { ownerId: "own", fetchUser, groups })).rejects.toThrow("Cannot send messages");
});
