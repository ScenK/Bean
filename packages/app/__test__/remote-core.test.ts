import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachStdio, buildHandshake, createAttachments, encodeFrame, listenRemote, type HostHandlers } from "@bean/host";
import type { CoreStatus } from "../src/channels.js";
import { IPC } from "../src/channels.js";
import { createRemoteCore, registerRemoteIpc, type SshChild } from "../src/remote-core.js";

const SHELL_A = "3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b";
const SHELL_B = "4a2d3c5b-6e7f-4a81-9bac-1d2e3f4a5b6c";
const MOUNT = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";

// `ssh <host> bean-core attach`, minus ssh: the child's stdio is `bean-core attach`'s.
function bridge(path: string): SshChild & { closed: Promise<void> } {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const onClose: (() => void)[] = [];
  let done = false;
  const exit = (): void => { if (!done) { done = true; for (const fn of onClose) fn(); } };
  const closed = attachStdio(path, stdin, stdout).catch(() => {}).then(exit);
  return {
    stdin, stdout, stderr, closed,
    on: (event: string, fn: () => void) => { if (event === "close") onClose.push(fn); },
    // ssh killed / the network gone: the child exits; the core only notices by the missing heartbeat.
    kill: () => { stdin.destroy(); stdout.destroy(); exit(); },
  } as unknown as SshChild & { closed: Promise<void> };
}

const until = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(cond()).toBe(true);
};

describe("remote core over the attach bridge (#811)", () => {
  let dir: string;
  let close: (() => void) | undefined;
  afterEach(() => {
    close?.();
    close = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  async function serve() {
    dir = mkdtempSync(join(tmpdir(), "bean-remote-core-"));
    chmodSync(dir, 0o700);
    const mounts = new Map<string, number>();
    const attachments = createAttachments({
      holder: (id) => mounts.get(id),
      ofClient: (c) => [...mounts].filter(([, v]) => v === c).map(([k]) => k),
      abortTurn: () => {}, expire: () => {}, release: (c) => { for (const [k, v] of mounts) if (v === c) mounts.delete(k); },
    });
    const push = attachments.push(() => {});
    const released: string[] = [];
    const handlers = {
      chat: {
        attach: (c: number, m: string) => { mounts.set(m, c); },
        release: (_c: number, m: string) => { released.push(m); mounts.delete(m); },
        chat: async (c: number, m: string, req: { message: string }) => {
          if (mounts.get(m) !== c) throw new Error("not your chat");
          push(m, "delegate", { taskId: "t1", type: "started", mountId: m });
          return { reply: `echo: ${req.message}` };
        },
      },
      getModel: () => "gpt-test",
    } as unknown as HostHandlers;
    const server = await listenRemote(dir, { handshake: buildHandshake("1.0.0", "linux", []), attachments, handlers });
    close = server.close;
    return { path: server.path, push, released };
  }

  function shell(path: string, shellId: string) {
    const statuses: CoreStatus[] = [];
    const pushes: Array<{ mountId: string; kind: string; payload: unknown }> = [];
    const working: boolean[] = [];
    const children: Array<ReturnType<typeof bridge>> = [];
    const core = createRemoteCore({
      label: "me@box",
      spawn: () => { const c = bridge(path); children.push(c); return c; },
      shellId,
      setupCommand: "ssh-copy-id me@box",
      onPush: (mountId, kind, payload) => pushes.push({ mountId, kind, payload }),
      onStatus: (s) => statuses.push(s),
      onWorking: (w) => working.push(w),
      retryMs: [20],
    });
    const state = (): string | undefined => (core.status() as { state?: string }).state;
    return { core, statuses, pushes, working, children, state };
  }

  it("attaches, runs a chat turn, gets its events, and holds keep-awake while work runs", async () => {
    const { path } = await serve();
    const a = shell(path, SHELL_A);
    a.core.connect();
    await until(() => a.state() === "attached");
    expect(a.core.handshake()).toMatchObject({ core: "1.0.0", platform: "linux" });
    await a.core.call("chatAttach", [MOUNT]);
    expect(await a.core.call("chat", [{ history: [], message: "hi" }, MOUNT])).toEqual({ reply: "echo: hi" });
    await until(() => a.pushes.length === 1);
    expect(a.pushes[0]).toMatchObject({ mountId: MOUNT, kind: "delegate", payload: { taskId: "t1", type: "started" } });
    expect(a.working).toEqual([true]);
    await expect(a.core.call("getConfig", [])).rejects.toThrow(/not allowed/);
    a.core.detach();
  });

  it("a killed tunnel shows reconnecting, fails calls at once, and resumes with the missed events", async () => {
    const { path, push } = await serve();
    const a = shell(path, SHELL_A);
    a.core.connect();
    await until(() => a.state() === "attached");
    await a.core.call("chatAttach", [MOUNT]);
    a.children[0]!.kill();
    await until(() => a.statuses.some((s) => s.kind === "remote" && s.state === "reconnecting"));
    // Never attached before → no setup hint once it has been; it was attached, so none here.
    expect(a.statuses.find((s) => s.kind === "remote" && s.state === "reconnecting")).not.toHaveProperty("command");
    push(MOUNT, "delegate", { taskId: "t2", type: "done", mountId: MOUNT });
    await until(() => a.state() === "attached");
    await until(() => a.pushes.some((p) => (p.payload as { taskId?: string }).taskId === "t2"));
    a.core.detach();
  });

  it("a second shell displaces the first, which waits for Take back", async () => {
    const { path } = await serve();
    const a = shell(path, SHELL_A);
    const b = shell(path, SHELL_B);
    a.core.connect();
    await until(() => a.state() === "attached");
    b.core.connect();
    await until(() => a.state() === "revoked");
    await until(() => b.state() === "attached");
    await new Promise((r) => setTimeout(r, 100));
    expect(a.state()).toBe("revoked"); // no reconnect of its own
    expect(a.children).toHaveLength(1);
    a.core.takeBack();
    await until(() => a.state() === "attached");
    await until(() => b.state() === "revoked");
    a.core.detach();
    b.core.detach();
  });

  it("a never-attached host shows ssh's error and the one-time setup command", async () => {
    const stderr = new PassThrough();
    const onClose: (() => void)[] = [];
    const child = {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr,
      on: (event: string, fn: () => void) => { if (event === "close") onClose.push(fn); },
      kill: () => {},
    } as unknown as SshChild;
    const statuses: CoreStatus[] = [];
    const core = createRemoteCore({
      label: "me@box", spawn: () => child, shellId: SHELL_A, setupCommand: "ssh-copy-id me@box",
      onPush: () => {}, onStatus: (s) => statuses.push(s), onWorking: () => {}, retryMs: [60_000],
    });
    core.connect();
    stderr.write("me@box: Permission denied (publickey).\n");
    await new Promise((r) => setTimeout(r, 0));
    for (const fn of onClose) fn();
    expect(core.status()).toEqual({
      kind: "remote", host: "me@box", state: "reconnecting",
      message: "me@box: Permission denied (publickey).", command: "ssh-copy-id me@box",
    });
    core.detach();
  });

  it("a contract version mismatch is a blocking state, not a retry loop", async () => {
    const stdout = new PassThrough();
    let spawned = 0;
    const core = createRemoteCore({
      label: "me@box",
      spawn: () => {
        spawned++;
        return { stdin: new PassThrough(), stdout, stderr: new PassThrough(), on: () => {}, kill: () => {} } as unknown as SshChild;
      },
      shellId: SHELL_A, setupCommand: "x", onPush: () => {}, onStatus: () => {}, onWorking: () => {}, retryMs: [1],
    });
    core.connect();
    stdout.write(encodeFrame({ type: "error", handshake: { contract: 999, core: "9", platform: "linux", capabilities: [] }, message: "mismatch" })!);
    await new Promise((r) => setTimeout(r, 20));
    expect(core.status()).toMatchObject({ state: "mismatch", message: expect.stringContaining("v999") });
    expect(spawned).toBe(1);
  });
});

describe("registerRemoteIpc", () => {
  it("sends remote-safe ops over the wire, tracks chat mounts, and refuses the rest", async () => {
    const handles = new Map<string, (e: { sender: { id: number } }, ...a: unknown[]) => unknown>();
    const ons = new Map<string, (e: { sender: { id: number } }, ...a: unknown[]) => unknown>();
    const call = vi.fn(async (op: string) => (op === "getModel" ? "gpt" : undefined));
    const mounts = new Map<string, number>();
    const remote = registerRemoteIpc(
      { handle: (c, f) => { handles.set(c, f); }, on: (c, f) => { ons.set(c, f); } },
      { core: { call, handshake: () => undefined }, mounts },
    );
    const e = { sender: { id: 7 } };
    expect(await handles.get(IPC.getModel)!(e)).toBe("gpt");
    ons.get(IPC.chatAttach)!(e, MOUNT);
    expect(mounts.get(MOUNT)).toBe(7);
    await expect(Promise.resolve().then(() => handles.get(IPC.listNotes)!(e))).rejects.toThrow(/remote core/);
    await expect(Promise.resolve().then(() => handles.get(IPC.handshake)!(e))).rejects.toThrow(/reconnecting/);
    // Host-bound channels fail the contract (no capabilities), before anything is sent.
    await expect(Promise.resolve().then(() => handles.get(IPC.chatOpenPath)!(e, "/x", MOUNT))).rejects.toThrow(/capability/);
    call.mockClear();
    remote.reattach();
    expect(call).toHaveBeenCalledWith("chatAttach", [MOUNT]);
    remote.releaseClient(7);
    expect(call).toHaveBeenCalledWith("chatRelease", [MOUNT]);
    expect(mounts.size).toBe(0);
  });
});
