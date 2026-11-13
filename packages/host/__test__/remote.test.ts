import { chmodSync, lstatSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAttachments } from "../src/attachments.js";
import { buildHandshake, CONTRACT_VERSION } from "../src/contract.js";
import type { HostHandlers } from "../src/host.js";
import { attachStdio, encodeFrame, frameReader, listenRemote, MAX_FRAME_BYTES, requestUpdate, type RemoteDeps } from "../src/remote.js";
import type { CoreUpdateResult } from "../src/core-update.js";

const SHELL = "3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b";

describe("frames", () => {
  it("splits a stream into frames across any chunking", () => {
    const got: unknown[] = [];
    const read = frameReader((m) => got.push(m), () => { throw new Error("no error expected"); });
    const bytes = Buffer.concat([encodeFrame({ a: 1 })!, encodeFrame("two")!, encodeFrame([3])!]);
    for (const b of bytes) read(Buffer.from([b]));
    read(Buffer.concat([encodeFrame(4)!, encodeFrame(null)!]));
    expect(got).toEqual([{ a: 1 }, "two", [3], 4, null]);
  });

  it("refuses an oversized frame on its header, before buffering the body", () => {
    const onFrame = vi.fn();
    const onError = vi.fn();
    const read = frameReader(onFrame, onError);
    const head = Buffer.alloc(4);
    head.writeUInt32BE(MAX_FRAME_BYTES + 1);
    read(head);
    expect(onError).toHaveBeenCalledWith(expect.stringMatching(/over the .* cap/));
    read(encodeFrame({ later: true })!); // dead after a failure
    expect(onFrame).not.toHaveBeenCalled();
    expect(encodeFrame("x".repeat(MAX_FRAME_BYTES))).toBeUndefined();
  });

  it("refuses a malformed body", () => {
    const onError = vi.fn();
    const body = Buffer.from("{nope");
    const head = Buffer.alloc(4);
    head.writeUInt32BE(body.length);
    frameReader(() => {}, onError)(Buffer.concat([head, body]));
    expect(onError).toHaveBeenCalledWith("malformed frame");
  });
});

// A shell on the other end of `bean-core attach`: frames in through the bridge's stdin, out of its stdout.
function shellOverBridge(path: string) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const frames: Record<string, unknown>[] = [];
  const waiters: (() => void)[] = [];
  stdout.on("data", frameReader((m) => {
    frames.push(m as Record<string, unknown>);
    for (const w of waiters.splice(0)) w();
  }, (why) => { throw new Error(why); }));
  const closed = attachStdio(path, stdin, stdout);
  const next = async (pred: (m: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> => {
    for (;;) {
      const i = frames.findIndex(pred);
      if (i >= 0) return frames.splice(i, 1)[0]!;
      await new Promise<void>((r) => waiters.push(r));
    }
  };
  let id = 0;
  return {
    send: (m: unknown) => stdin.write(encodeFrame(m)!),
    next,
    call: async (op: string, ...args: unknown[]) => {
      const n = ++id;
      stdin.write(encodeFrame({ type: "call", id: n, op, args })!);
      return next((m) => m.type === "result" && m.id === n);
    },
    end: () => stdin.end(),
    closed,
  };
}

describe("remote attach over the unix socket", () => {
  let dir: string;
  let close: (() => void) | undefined;
  afterEach(() => {
    close?.();
    close = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  async function serve(extra: Partial<RemoteDeps> = {}) {
    dir = mkdtempSync(join(tmpdir(), "bean-remote-"));
    chmodSync(dir, 0o700);
    // A stand-in host: one chat per client, a turn that pushes an event before it answers.
    const mounts = new Map<string, number>();
    const getConfig = vi.fn(() => ({ openaiApiKey: "sk-secret", model: "m", apiKeySet: true }));
    const applyConfig = vi.fn(async () => {});
    const projectDir = mkdtempSync(join(tmpdir(), "bean-remote-proj-"));
    const listProjects = vi.fn(async () => [{ name: "old", path: "/gone/elsewhere" }]);
    const saveProjects = vi.fn(async () => {});
    let push: (mountId: string, kind: "delegate", payload: unknown) => void = () => {};
    const attachments = createAttachments({
      holder: (id) => mounts.get(id),
      ofClient: (c) => [...mounts].filter(([, v]) => v === c).map(([k]) => k),
      abortTurn: () => {}, expire: () => {}, release: (c) => { for (const [k, v] of mounts) if (v === c) mounts.delete(k); },
    });
    const send = attachments.push(() => {});
    push = send;
    const getModel = vi.fn(() => "gpt-test");
    const handlers = {
      chat: {
        attach: (c: number, m: string) => { mounts.set(m, c); },
        chat: async (c: number, m: string, req: { message: string }) => {
          if (mounts.get(m) !== c) throw new Error("not your chat");
          push(m, "delegate", { taskId: "t1", type: "started", mountId: m });
          return { reply: `echo: ${req.message}` };
        },
      },
      getConfig,
      applyConfig,
      listProjects,
      saveProjects,
      getModel,
    } as unknown as HostHandlers;
    const server = await listenRemote(dir, { handshake: buildHandshake("1.0.0", "linux", []), attachments, handlers, ...extra });
    close = server.close;
    return { path: server.path, getConfig, applyConfig, saveProjects, projectDir, getModel, attachments };
  }

  // #837: `bean-core update` asks the running core, which answers before it exits.
  it("answers one update request without attaching, and exits only after an \"updated\" answer is out", async () => {
    dir = mkdtempSync(join(tmpdir(), "bean-remote-"));
    chmodSync(dir, 0o700);
    const answers: CoreUpdateResult[] = [
      { status: "busy", version: "0.2.0", busy: [{ kind: "delegate", name: "bean" }] },
      { status: "updated", from: "0.1.0", version: "0.2.0", stopped: [{ kind: "delegate", name: "bean" }] },
    ];
    const update = vi.fn(async (_force: boolean) => answers.shift()!);
    const onUpdated = vi.fn();
    const attach = vi.fn();
    const server = await listenRemote(dir, {
      handshake: buildHandshake("0.1.0", "linux", []), attachments: { attach } as never, handlers: {} as HostHandlers, update, onUpdated,
    });
    close = server.close;
    expect(await requestUpdate(server.path, false)).toMatchObject({ status: "busy" });
    expect(onUpdated).not.toHaveBeenCalled();
    expect(await requestUpdate(server.path, true)).toMatchObject({ status: "updated", version: "0.2.0" });
    expect(update.mock.calls).toEqual([[false], [true]]);
    await vi.waitFor(() => expect(onUpdated).toHaveBeenCalledOnce());
    expect(attach).not.toHaveBeenCalled();
  });

  // #838: an attached shell's About — status, then an apply that must keep this contract.
  it("updates from an attached shell: labelled busy list, contract pinned, exits once the answer is out", async () => {
    const update = vi.fn(async (force: boolean, _contract?: number): Promise<CoreUpdateResult> => (force
      ? { status: "updated", from: "1.0.0", version: "1.1.0", stopped: [{ kind: "routine", name: "nightly" }] }
      : { status: "busy", version: "1.1.0", busy: [{ kind: "delegate", name: "bean" }, { kind: "routine", name: "nightly" }] }));
    const updateStatus = vi.fn(async () => ({ current: "1.0.0", latest: "1.1.0", busy: ["delegate bean"] }));
    const onUpdated = vi.fn();
    const { path } = await serve({ update, updateStatus, onUpdated });
    const shell = shellOverBridge(path);
    shell.send({ type: "attach", shellId: SHELL, contract: CONTRACT_VERSION });
    await shell.next((m) => m.type === "attached");
    expect(await shell.call("coreUpdateStatus")).toMatchObject({ ok: true, value: { current: "1.0.0", latest: "1.1.0", busy: ["delegate bean"] } });
    expect(await shell.call("coreUpdateApply", "yes")).toMatchObject({ ok: false, error: expect.stringMatching(/Malformed/) });
    expect(await shell.call("coreUpdateApply", false)).toMatchObject({ ok: true, value: { status: "busy", busy: ["delegate bean", "sprout nightly"] } });
    expect(onUpdated).not.toHaveBeenCalled();
    expect(await shell.call("coreUpdateApply", true)).toMatchObject({ ok: true, value: { status: "updated", version: "1.1.0", stopped: ["sprout nightly"] } });
    expect(update.mock.calls).toEqual([[false, CONTRACT_VERSION], [true, CONTRACT_VERSION]]);
    await vi.waitFor(() => expect(onUpdated).toHaveBeenCalledOnce());
    await shell.closed;
  });

  it("a core without the self-update refuses the update ops", async () => {
    const { path } = await serve();
    const shell = shellOverBridge(path);
    shell.send({ type: "attach", shellId: SHELL, contract: CONTRACT_VERSION });
    await shell.next((m) => m.type === "attached");
    expect(await shell.call("coreUpdateStatus")).toMatchObject({ ok: false, error: expect.stringMatching(/can't update itself/) });
    expect(await shell.call("coreUpdateApply", true)).toMatchObject({ ok: false, error: expect.stringMatching(/can't update itself/) });
    shell.end();
    await shell.closed;
  });

  it("requestUpdate: no core listening is undefined (the in-process path)", async () => {
    dir = mkdtempSync(join(tmpdir(), "bean-remote-"));
    expect(await requestUpdate(join(dir, "core.sock"), false)).toBeUndefined();
  });

  it("runs a chat turn through `bean-core attach` and receives its events", async () => {
    const { path } = await serve();
    const shell = shellOverBridge(path);
    shell.send({ type: "attach", shellId: SHELL, contract: CONTRACT_VERSION });
    const hello = await shell.next((m) => m.type === "attached");
    expect(hello.handshake).toMatchObject({ contract: CONTRACT_VERSION, core: "1.0.0", capabilities: [] });
    expect(await shell.call("chatAttach", "m1")).toMatchObject({ ok: true });
    shell.send({ type: "resume", acks: {} });
    const result = await shell.call("chat", { history: [], message: "hi", source: "typed" }, "m1");
    expect(result).toMatchObject({ ok: true, value: { reply: "echo: hi" } });
    const event = await shell.next((m) => m.type === "push");
    expect(event).toMatchObject({ mountId: "m1", seq: 1, kind: "delegate", payload: { taskId: "t1", type: "started" } });
    expect(await shell.call("getModel")).toMatchObject({ ok: true, value: "gpt-test" });
    shell.send({ type: "detach" });
    await shell.closed;
  });

  it("refuses operations outside the allowlist even when called directly", async () => {
    const { path, getConfig } = await serve();
    const shell = shellOverBridge(path);
    shell.send({ type: "attach", shellId: SHELL, contract: CONTRACT_VERSION });
    await shell.next((m) => m.type === "attached");
    for (const op of ["launch", "terminalStart", "chatOpenPath", "revealInFinder", "pickProjectFolder", "__proto__", "constructor"]) {
      expect(await shell.call(op)).toMatchObject({ ok: false, error: expect.stringContaining("not allowed") });
    }
    expect(getConfig).not.toHaveBeenCalled();
    expect(await shell.call("chat", { message: 1 }, "m1")).toMatchObject({ ok: false, error: expect.stringMatching(/Malformed/) });
    expect(await shell.call("chat", { history: [], message: "hi" }, "m1")).toMatchObject({ ok: false, error: "not your chat" });
    shell.end();
    await shell.closed;
  });

  it("Settings over a remote attach (#812): the key never leaves, a save is a patch, typed project paths are checked", async () => {
    const { path, getConfig, applyConfig, saveProjects, projectDir } = await serve();
    const shell = shellOverBridge(path);
    shell.send({ type: "attach", shellId: SHELL, contract: CONTRACT_VERSION });
    await shell.next((m) => m.type === "attached");
    const view = await shell.call("getConfig");
    expect(getConfig).toHaveBeenCalled();
    expect(view).toMatchObject({ ok: true, value: { openaiApiKey: "", apiKeySet: true, model: "m" } });
    expect(JSON.stringify(view)).not.toContain("sk-secret");
    expect(await shell.call("saveConfig", { model: "gpt-5" })).toMatchObject({ ok: true });
    expect(applyConfig).toHaveBeenCalledWith({ model: "gpt-5" });
    expect(await shell.call("saveConfig", { openaiApiKey: 42 })).toMatchObject({ ok: false, error: expect.stringMatching(/Malformed/) });
    // A saved path that's gone passes; a new one must be a directory on the core.
    const kept = { name: "old", path: "/gone/elsewhere" };
    expect(await shell.call("saveProjects", [kept, { name: "x", path: "/no/such/dir" }]))
      .toMatchObject({ ok: false, error: expect.stringContaining("No folder at") });
    expect(await shell.call("saveProjects", [kept, { name: "x", path: "relative/dir" }])).toMatchObject({ ok: false });
    expect(saveProjects).not.toHaveBeenCalled();
    expect(await shell.call("saveProjects", [kept, { name: "x", path: projectDir }])).toMatchObject({ ok: true });
    expect(saveProjects).toHaveBeenCalledTimes(1);
    rmSync(projectDir, { recursive: true, force: true });
    shell.end();
    await shell.closed;
  });

  it("requires the handshake as the first frame and a matching contract", async () => {
    const { path } = await serve();
    const a = shellOverBridge(path);
    a.send({ type: "call", id: 1, op: "getModel", args: [] });
    expect(await a.next((m) => m.type === "error")).toMatchObject({ message: expect.stringMatching(/first frame/) });
    await a.closed;
    const b = shellOverBridge(path);
    b.send({ type: "attach", shellId: SHELL, contract: CONTRACT_VERSION + 1 });
    expect(await b.next((m) => m.type === "error")).toMatchObject({ handshake: { contract: CONTRACT_VERSION } });
    await b.closed;
  });

  it("a frame that throws closes only its own connection, never the core", async () => {
    const { path } = await serve();
    const a = shellOverBridge(path);
    a.send({ type: "attach", shellId: SHELL, contract: CONTRACT_VERSION });
    await a.next((m) => m.type === "attached");
    a.send({ type: { toString: 0 } }); // String() of this throws
    a.send({ type: "call", id: 1, op: { toString: 0 }, args: [] });
    expect(await a.next((m) => m.type === "error")).toMatchObject({ message: "unknown frame type" });
    await a.closed;
    const b = shellOverBridge(path);
    b.send({ type: "attach", shellId: SHELL, contract: CONTRACT_VERSION });
    await b.next((m) => m.type === "attached");
    expect(await b.call("getModel")).toMatchObject({ ok: true, value: "gpt-test" });
    expect(await b.call({ toString: 0 } as unknown as string)).toMatchObject({ ok: false, error: expect.stringContaining("not allowed") });
    b.end();
    await b.closed;
  });

  it("ignores frames after a refusal, even in the same chunk", async () => {
    const { path, getModel } = await serve();
    const stdin = new PassThrough();
    const closed = attachStdio(path, stdin, new PassThrough());
    stdin.write(Buffer.concat([
      encodeFrame({ type: "nope" })!,
      encodeFrame({ type: "attach", shellId: SHELL, contract: CONTRACT_VERSION })!,
      encodeFrame({ type: "call", id: 1, op: "getModel", args: [] })!,
    ]));
    await closed;
    expect(getModel).not.toHaveBeenCalled();
  });

  it("listens only inside the 0700 directory, on a 0600 socket, and no TCP port", async () => {
    const { path } = await serve();
    expect(path).toBe(join(dir, "core.sock"));
    const st = lstatSync(path);
    expect(st.isSocket()).toBe(true);
    expect(st.mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["core.sock"]);
    // A second core on the same data dir doesn't steal a live socket.
    await expect(listenRemote(dir, { handshake: buildHandshake("1", "linux", []), attachments: {} as never, handlers: {} as never }))
      .rejects.toThrow(/already serving/);
  });

  it("refuses a directory others can read", async () => {
    dir = mkdtempSync(join(tmpdir(), "bean-remote-"));
    chmodSync(dir, 0o755);
    await expect(listenRemote(dir, { handshake: buildHandshake("1", "linux", []), attachments: {} as never, handlers: {} as never }))
      .rejects.toThrow(/private \(0700\)/);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("attachStdio", () => {
  it("resolves only after a slow output has written everything the core sent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bean-bridge-"));
    const path = join(dir, "s.sock");
    const payload = Buffer.alloc(512 * 1024, 7);
    const server = createServer((sock) => sock.end(payload));
    await new Promise<void>((r) => server.listen(path, r));
    let got = 0;
    const slow = new Writable({
      highWaterMark: 1024,
      write: (chunk: Buffer, _enc, cb) => { setTimeout(() => { got += chunk.length; cb(); }, 20); },
    });
    try {
      await attachStdio(path, new PassThrough(), slow);
      expect(got).toBe(payload.length);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
