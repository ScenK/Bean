import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { IPC } from "../src/channels.js";
import { buildChatMounts } from "@bean/host";
import { createPush, PUSH_ROUTES } from "../src/push.js";

const A = "a0000000-0000-4000-8000-000000000001";
const B = "b0000000-0000-4000-8000-000000000002";

describe("push routing (#801)", () => {
  it("classifies every channel the preload subscribes to", () => {
    const src = readFileSync(join(__dirname, "../src/preload.ts"), "utf8");
    const subscribed = [...src.matchAll(/ipcRenderer\.on\(IPC\.(\w+)/g)].map((m) => IPC[m[1] as keyof typeof IPC]);
    expect(subscribed.length).toBeGreaterThan(0);
    expect(new Set(subscribed)).toEqual(new Set(Object.keys(PUSH_ROUTES)));
  });

  it("sends a mount-tagged push to the client holding the mount, even after its release; broadcasts reach every live client", () => {
    const mounts = buildChatMounts();
    const client = (id: number) => ({ id, destroyed: false, isDestroyed() { return this.destroyed; }, send: vi.fn() });
    const one = client(1), two = client(2);
    const push = createPush({ clientOfMount: mounts.clientOf, client: (id) => [one, two].find((c) => c.id === id), clients: () => [one, two] });
    mounts.attach(1, A);
    mounts.attach(2, B);
    push.send(A, IPC.liveEvent, { x: 1 });
    mounts.release(2, B);
    push.send(B, IPC.memoryUpdated, { late: 1 }); // a receipt for a chat switched away from
    push.send("never-attached", IPC.liveEvent, { lost: 1 });
    expect(one.send.mock.calls).toEqual([[IPC.liveEvent, { x: 1 }]]);
    expect(two.send.mock.calls).toEqual([[IPC.memoryUpdated, { late: 1 }]]);
    two.destroyed = true;
    push.broadcast(IPC.themeChanged, "graphite");
    push.send(B, IPC.liveEvent, { gone: 1 });
    expect(one.send).toHaveBeenLastCalledWith(IPC.themeChanged, "graphite");
    expect(two.send).toHaveBeenCalledTimes(1);
  });
});
