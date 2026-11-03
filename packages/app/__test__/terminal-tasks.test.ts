import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  HIGH_WATERMARK, LOW_WATERMARK, STALE_PROJECT_NOTICE, WRITE_LIMIT, createTerminalTasks, terminalLink,
  type PtyProcess, type PtySpawnOptions, type TerminalEvent, type TerminalTasksDeps,
} from "../src/terminal-tasks.js";

const A = { senderId: 1, mountId: "m1" };

interface FakePty extends PtyProcess {
  file: string; args: string[]; opts: PtySpawnOptions;
  writes: string[]; sizes: [number, number][]; paused: number; resumed: number;
  emitData: (d: string) => void; exit: (code?: number) => void;
}

function harness(over: Partial<TerminalTasksDeps> = {}) {
  const ptys: FakePty[] = [];
  const events: TerminalEvent[] = [];
  const tasks = createTerminalTasks({
    spawn: (file, args, opts) => {
      let onData: (d: string) => void = () => {};
      let onExit: (e: { exitCode: number }) => void = () => {};
      const p: FakePty = {
        pid: 999_999_000 + ptys.length, file, args, opts, writes: [], sizes: [], paused: 0, resumed: 0,
        onData: (cb) => { onData = cb; }, onExit: (cb) => { onExit = cb; },
        write: (d) => { p.writes.push(d); }, resize: (c, r) => { p.sizes.push([c, r]); },
        pause: () => { p.paused++; }, resume: () => { p.resumed++; },
        emitData: (d) => onData(d), exit: (code = 0) => onExit({ exitCode: code }),
      };
      ptys.push(p);
      return p;
    },
    projectAllowed: async (p) => p === "/proj",
    scratchPath: "/scratch",
    send: (_s, e) => { events.push(e); },
    shell: "/bin/zsh",
    hasChild: async () => false,
    busyPollMs: 60_000,
    ...over,
  });
  return { tasks, ptys, events };
}

describe("terminal tasks", () => {
  it("spawns one login shell in an allowed project with the allowlisted env", async () => {
    const { tasks, ptys } = harness();
    expect(await tasks.start(A, "/proj", 80, 24)).toEqual({ cwd: "/proj" });
    expect(ptys).toHaveLength(1);
    const p = ptys[0]!;
    expect([p.file, p.args, p.opts.cwd, p.opts.cols, p.opts.rows]).toEqual(["/bin/zsh", ["-l"], "/proj", 80, 24]);
    expect(p.opts.env).toMatchObject({ TERM: "xterm-256color", COLORTERM: "truecolor", PWD: "/proj" });
  });

  it("a double start while projectAllowed is still pending spawns once", async () => {
    let release: (v: boolean) => void = () => {};
    const { tasks, ptys } = harness({ projectAllowed: () => new Promise((r) => { release = r; }) });
    const first = tasks.start(A, "/proj", 80, 24);
    expect(await tasks.start(A, "/proj", 80, 24)).toEqual({ error: expect.stringMatching(/already has a terminal/) });
    release(true);
    expect(await first).toEqual({ cwd: "/proj" });
    expect(ptys).toHaveLength(1);
  });

  it("a release or quit during validation spawns nothing", async () => {
    for (const end of ["stop", "killAll"] as const) {
      let release: (v: boolean) => void = () => {};
      const { tasks, ptys } = harness({ projectAllowed: () => new Promise((r) => { release = r; }) });
      const started = tasks.start(A, "/proj", 80, 24);
      if (end === "stop") await tasks.stop(A.mountId);
      else tasks.killAll();
      release(true);
      expect(await started).toEqual({ error: expect.stringMatching(/Stopped/) });
      expect(ptys).toHaveLength(0);
    }
    const { tasks, ptys } = harness();
    tasks.killAll();
    expect(await tasks.start(A, "", 80, 24)).toEqual({ error: expect.stringMatching(/quitting/) });
    expect(ptys).toHaveLength(0);
  });

  it("never spawns outside the registry: an unknown or stale project opens scratch with a notice", async () => {
    const { tasks, ptys, events } = harness();
    expect(await tasks.start(A, "/etc", 80, 24)).toEqual({ cwd: "/scratch" });
    expect(ptys[0]!.opts.cwd).toBe("/scratch");
    expect(events).toEqual([{ mountId: "m1", type: "data", data: STALE_PROJECT_NOTICE }]);
    // A failing registry read is treated the same way.
    const h = harness({ projectAllowed: async () => { throw new Error("bad json"); } });
    expect(await h.tasks.start(A, "/proj", 80, 24)).toEqual({ cwd: "/scratch" });
  });

  it("\"\" opens the scratch workspace without asking the registry or a notice", async () => {
    const projectAllowed = vi.fn(async () => false);
    const { tasks, events } = harness({ projectAllowed });
    expect(await tasks.start(A, "", 80, 24)).toEqual({ cwd: "/scratch" });
    expect(projectAllowed).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("rejects malformed requests and frees the mount when the spawn throws", async () => {
    const { tasks, ptys } = harness();
    for (const [path, c, r] of [[1, 80, 24], ["", 0, 24], ["", 80, 1.5], ["", 80, 5000], ["", "80", 24]] as const) {
      expect(await tasks.start(A, path, c, r)).toEqual({ error: "Invalid terminal request." });
    }
    expect(ptys).toHaveLength(0);
    const bad = harness({ spawn: () => { throw new Error("posix_spawnp failed."); } });
    expect(await bad.tasks.start(A, "", 80, 24)).toEqual({ error: expect.stringMatching(/posix_spawnp/) });
    expect(await bad.tasks.start(A, "", 80, 24)).toEqual({ error: expect.stringMatching(/posix_spawnp/) }); // not "already has"
  });

  it("writes, resizes (validated, deduplicated), and refuses oversized writes", async () => {
    const { tasks, ptys } = harness();
    expect(tasks.write("m1", "ls\r")).toBe(false); // no terminal yet
    await tasks.start(A, "", 80, 24);
    const p = ptys[0]!;
    expect(tasks.write("m1", "ls\r")).toBe(true);
    expect(tasks.write("m1", "x".repeat(WRITE_LIMIT + 1))).toBe(false);
    expect(tasks.write("m1", 42)).toBe(false);
    tasks.resize("m1", 80, 24);
    tasks.resize("m1", 100, 30);
    tasks.resize("m1", 100, 30);
    tasks.resize("m1", -1, 30);
    tasks.resize("m2", 120, 40);
    expect(p.writes).toEqual(["ls\r"]);
    expect(p.sizes).toEqual([[100, 30]]);
  });

  it("pauses the shell above the high watermark and resumes below the low one", async () => {
    const { tasks, ptys, events } = harness();
    await tasks.start(A, "", 80, 24);
    const p = ptys[0]!;
    p.emitData("x".repeat(HIGH_WATERMARK));
    expect(p.paused).toBe(0);
    p.emitData("y");
    expect(p.paused).toBe(1);
    p.emitData("z"); // still delivered while paused, never paused twice
    expect(p.paused).toBe(1);
    expect(events.filter((e) => e.type === "data")).toHaveLength(3);
    tasks.ack("m1", HIGH_WATERMARK - LOW_WATERMARK); // 16386 left: still above LOW
    expect(p.resumed).toBe(0);
    tasks.ack("m1", -5);
    tasks.ack("m1", Number.NaN);
    tasks.ack("m1", 10);
    expect(p.resumed).toBe(1);
  });

  it("pushes busy when the shell gains and loses a child process", async () => {
    vi.useFakeTimers();
    try {
      let child = false;
      const { tasks, events } = harness({ hasChild: async () => child, busyPollMs: 1000 });
      await tasks.start(A, "", 80, 24);
      child = true;
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(1000); // unchanged: no second push
      child = false;
      await vi.advanceTimersByTimeAsync(1000);
      expect(events.filter((e) => e.type === "busy")).toEqual([
        { mountId: "m1", type: "busy", busy: true },
        { mountId: "m1", type: "busy", busy: false },
      ]);
      child = true;
      expect(await tasks.isBusy("m1")).toBe(true);
      expect(await tasks.isBusy("m2")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("exit frees the mount and pushes the code", async () => {
    const { tasks, ptys, events } = harness();
    await tasks.start(A, "", 80, 24);
    ptys[0]!.exit(3);
    expect(events).toEqual([{ mountId: "m1", type: "exit", code: 3 }]);
    expect(await tasks.start(A, "", 80, 24)).toEqual({ cwd: "/scratch" });
  });

  it("stop hangs up a real shell and kills its backgrounded child, settling only once it's gone", async () => {
    // A detached "shell" that starts a job in its own process group (as an interactive shell's
    // `cmd &` does), prints the job's pid, then idles.
    const script = "const c=require('child_process').spawn('sleep',['30'],{detached:true,stdio:'ignore'});"
      + "console.log(c.pid);setInterval(()=>{},1000)";
    let jobPid: Promise<number> | undefined;
    const { tasks } = harness({
      killGraceMs: 500,
      spawn: () => {
        const child = spawn(process.execPath, ["-e", script], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
        jobPid = new Promise((r) => child.stdout.once("data", (d: Buffer) => r(Number(d.toString().trim()))));
        return {
          pid: child.pid!,
          onData: () => {}, write: () => {}, resize: () => {}, pause: () => {}, resume: () => {},
          onExit: (cb) => { child.once("exit", (code, signal) => cb({ exitCode: code ?? 0, ...(signal ? { signal: 1 } : {}) })); },
        };
      },
    });
    await tasks.start(A, "", 80, 24);
    const pid = await jobPid!;
    const alive = (p: number): boolean => { try { process.kill(p, 0); return true; } catch { return false; } };
    expect(alive(pid)).toBe(true);
    await tasks.stop("m1");
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 3000 });
  });
});

describe("terminalLink", () => {
  it("opens http(s) only", () => {
    expect(terminalLink("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(terminalLink("http://localhost:3000")).toBe("http://localhost:3000/");
    for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "vscode://x", "ssh://h", "not a url", "", 42, undefined, `https://x/${"a".repeat(9000)}`]) {
      expect(terminalLink(bad)).toBeUndefined();
    }
  });
});
