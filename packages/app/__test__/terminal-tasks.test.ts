import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  HIGH_WATERMARK, LOW_WATERMARK, MAX_TABS, STALE_PROJECT_NOTICE, WRITE_LIMIT, commandName, createTerminalTasks, foregroundCommands, terminalLink,
  type PtyProcess, type PtySpawnOptions, type TerminalEvent, type TerminalTasksDeps,
} from "../src/terminal-tasks.js";

const A = { clientId: 1, mountId: "m1" };
const B = { clientId: 1, mountId: "m2" };
const tab = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const T = tab(1);

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
    send: (e) => { events.push(e); },
    shell: "/bin/zsh",
    foreground: async () => new Map(),
    busyPollMs: 60_000,
    ...over,
  });
  return { tasks, ptys, events };
}

describe("terminal tasks", () => {
  it("spawns one login shell in an allowed project with the allowlisted env", async () => {
    const { tasks, ptys } = harness();
    expect(await tasks.start(A, T, "/proj", 80, 24)).toEqual({ cwd: "/proj", shell: "zsh" });
    expect(ptys).toHaveLength(1);
    const p = ptys[0]!;
    expect([p.file, p.args, p.opts.cwd, p.opts.cols, p.opts.rows]).toEqual(["/bin/zsh", ["-l"], "/proj", 80, 24]);
    expect(p.opts.env).toMatchObject({ TERM: "xterm-256color", COLORTERM: "truecolor", PWD: "/proj" });
  });

  it("a double start while projectAllowed is still pending spawns once", async () => {
    let release: (v: boolean) => void = () => {};
    const { tasks, ptys } = harness({ projectAllowed: () => new Promise((r) => { release = r; }) });
    const first = tasks.start(A, T, "/proj", 80, 24);
    expect(await tasks.start(A, T, "/proj", 80, 24)).toEqual({ error: expect.stringMatching(/already has a terminal/) });
    release(true);
    expect(await first).toEqual({ cwd: "/proj", shell: "zsh" });
    expect(ptys).toHaveLength(1);
  });

  it("a release or quit during validation spawns nothing", async () => {
    for (const end of ["stop", "killAll"] as const) {
      let release: (v: boolean) => void = () => {};
      const { tasks, ptys } = harness({ projectAllowed: () => new Promise((r) => { release = r; }) });
      const started = tasks.start(A, T, "/proj", 80, 24);
      if (end === "stop") await tasks.stop(A.mountId, T);
      else tasks.killAll();
      release(true);
      expect(await started).toEqual({ error: expect.stringMatching(/Stopped/) });
      expect(ptys).toHaveLength(0);
    }
    const { tasks, ptys } = harness();
    tasks.killAll();
    expect(await tasks.start(A, T, "", 80, 24)).toEqual({ error: expect.stringMatching(/quitting/) });
    expect(ptys).toHaveLength(0);
  });

  it("never spawns outside the registry: an unknown or stale project opens scratch with a notice", async () => {
    const { tasks, ptys, events } = harness();
    expect(await tasks.start(A, T, "/etc", 80, 24)).toEqual({ cwd: "/scratch", shell: "zsh" });
    expect(ptys[0]!.opts.cwd).toBe("/scratch");
    expect(events).toEqual([{ mountId: "m1", tabId: T, type: "data", data: STALE_PROJECT_NOTICE }]);
    // A failing registry read is treated the same way.
    const h = harness({ projectAllowed: async () => { throw new Error("bad json"); } });
    expect(await h.tasks.start(A, T, "/proj", 80, 24)).toEqual({ cwd: "/scratch", shell: "zsh" });
  });

  it("\"\" opens the scratch workspace without asking the registry or a notice", async () => {
    const projectAllowed = vi.fn(async () => false);
    const { tasks, events } = harness({ projectAllowed });
    expect(await tasks.start(A, T, "", 80, 24)).toEqual({ cwd: "/scratch", shell: "zsh" });
    expect(projectAllowed).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("rejects malformed requests and frees the mount when the spawn throws", async () => {
    const { tasks, ptys } = harness();
    for (const [path, c, r] of [[1, 80, 24], ["", 0, 24], ["", 80, 1.5], ["", 80, 5000], ["", "80", 24]] as const) {
      expect(await tasks.start(A, T, path, c, r)).toEqual({ error: "Invalid terminal request." });
    }
    expect(ptys).toHaveLength(0);
    const bad = harness({ spawn: () => { throw new Error("posix_spawnp failed."); } });
    expect(await bad.tasks.start(A, T, "", 80, 24)).toEqual({ error: expect.stringMatching(/posix_spawnp/) });
    expect(await bad.tasks.start(A, T, "", 80, 24)).toEqual({ error: expect.stringMatching(/posix_spawnp/) }); // not "already has"
  });

  it("writes, resizes (validated, deduplicated), and refuses oversized writes", async () => {
    const { tasks, ptys } = harness();
    expect(tasks.write("m1", T, "ls\r")).toBe(false); // no terminal yet
    await tasks.start(A, T, "", 80, 24);
    const p = ptys[0]!;
    expect(tasks.write("m1", T, "ls\r")).toBe(true);
    expect(tasks.write("m1", T, "x".repeat(WRITE_LIMIT + 1))).toBe(false);
    expect(tasks.write("m1", T, 42)).toBe(false);
    tasks.resize("m1", T, 80, 24);
    tasks.resize("m1", T, 100, 30);
    tasks.resize("m1", T, 100, 30);
    tasks.resize("m1", T, -1, 30);
    tasks.resize("m2", T, 120, 40);
    expect(p.writes).toEqual(["ls\r"]);
    expect(p.sizes).toEqual([[100, 30]]);
  });

  it("pauses the shell above the high watermark and resumes below the low one", async () => {
    const { tasks, ptys, events } = harness();
    await tasks.start(A, T, "", 80, 24);
    const p = ptys[0]!;
    p.emitData("x".repeat(HIGH_WATERMARK));
    expect(p.paused).toBe(0);
    p.emitData("y");
    expect(p.paused).toBe(1);
    p.emitData("z"); // still delivered while paused, never paused twice
    expect(p.paused).toBe(1);
    expect(events.filter((e) => e.type === "data")).toHaveLength(3);
    tasks.ack("m1", T, HIGH_WATERMARK - LOW_WATERMARK); // 16386 left: still above LOW
    expect(p.resumed).toBe(0);
    tasks.ack("m1", T, -5);
    tasks.ack("m1", T, Number.NaN);
    tasks.ack("m1", T, 10);
    expect(p.resumed).toBe(1);
  });

  it("holds up to MAX_TABS shells per chat: a fifth is refused, even two racing behind a slow projectAllowed", async () => {
    const gates: Array<(v: boolean) => void> = [];
    const { tasks, ptys } = harness({ projectAllowed: () => new Promise((r) => { gates.push(r); }) });
    for (let i = 1; i <= MAX_TABS - 1; i++) expect(await tasks.start(A, tab(i), "", 80, 24)).toEqual({ cwd: "/scratch", shell: "zsh" });
    const racing = [tasks.start(A, tab(4), "/proj", 80, 24), tasks.start(A, tab(5), "/proj", 80, 24)];
    gates.forEach((g) => g(true));
    expect(await Promise.all(racing)).toEqual([{ cwd: "/proj", shell: "zsh" }, { error: expect.stringMatching(/at most 4/) }]);
    expect(ptys).toHaveLength(MAX_TABS);
    // Another chat has its own four; a closed tab frees its slot.
    expect(await tasks.start(B, tab(1), "", 80, 24)).toEqual({ cwd: "/scratch", shell: "zsh" });
    ptys[0]!.exit();
    expect(await tasks.start(A, tab(5), "", 80, 24)).toEqual({ cwd: "/scratch", shell: "zsh" });
  });

  it("refuses unknown, malformed and other-mount tab ids", async () => {
    const { tasks, ptys } = harness();
    for (const bad of ["", "tab-1", 42, undefined, `${T}x`]) expect(await tasks.start(A, bad, "", 80, 24)).toEqual({ error: "Invalid terminal request." });
    await tasks.start(A, T, "", 80, 24);
    for (const [m, t] of [["m1", tab(2)], ["m1", "nope"], ["m1", undefined], ["m2", T]] as const) {
      expect(tasks.write(m, t, "ls\r")).toBe(false);
      tasks.resize(m, t, 100, 30);
      await tasks.stop(m, t);
    }
    expect(await tasks.runningCommand("m2")).toEqual([]);
    expect(tasks.write("m1", T, "ls\r")).toBe(true);
    expect([ptys[0]!.writes, ptys[0]!.sizes]).toEqual([["ls\r"], []]);
  });

  it("stopping one tab leaves the others; stopMount and killAll stop every tab, including one still validating", async () => {
    for (const end of ["stopMount", "killAll"] as const) {
      let release: (v: boolean) => void = () => {};
      const { tasks, ptys } = harness({ killGraceMs: 10, projectAllowed: () => new Promise((r) => { release = r; }) });
      await tasks.start(A, tab(1), "", 80, 24);
      await tasks.start(A, tab(2), "", 80, 24);
      await tasks.start(A, tab(3), "", 80, 24);
      const stopped = tasks.stop("m1", tab(1));
      expect(tasks.write("m1", tab(1), "x")).toBe(false);
      expect(tasks.write("m1", tab(2), "x")).toBe(true);
      ptys[0]!.exit();
      await stopped;
      const pending = tasks.start(A, tab(4), "/proj", 80, 24);
      if (end === "stopMount") {
        const all = tasks.stopMount("m1");
        expect([tasks.write("m1", tab(2), "x"), tasks.write("m1", tab(3), "x")]).toEqual([false, false]);
        ptys[1]!.exit();
        ptys[2]!.exit();
        await all;
      } else {
        tasks.killAll();
      }
      release(true);
      expect(await pending).toEqual({ error: expect.stringMatching(/Stopped/) });
      expect(ptys).toHaveLength(3);
    }
  });

  it("pauses and acks each tab independently", async () => {
    const { tasks, ptys } = harness();
    await tasks.start(A, tab(1), "", 80, 24);
    await tasks.start(A, tab(2), "", 80, 24);
    const [p1, p2] = [ptys[0]!, ptys[1]!];
    p1.emitData("x".repeat(HIGH_WATERMARK + 1));
    p2.emitData("y".repeat(HIGH_WATERMARK));
    expect([p1.paused, p2.paused]).toEqual([1, 0]);
    tasks.ack("m1", tab(2), HIGH_WATERMARK);
    expect(p1.resumed).toBe(0);
    tasks.ack("m1", tab(1), HIGH_WATERMARK);
    expect(p1.resumed).toBe(1);
  });

  it("one shared poll: one batched lookup per tick for every tab, busy pushed with the command on change", async () => {
    vi.useFakeTimers();
    try {
      const fg = new Map<number, string>();
      const foreground = vi.fn(async (pids: readonly number[]) => new Map([...fg].filter(([p]) => pids.includes(p))));
      const { tasks, ptys, events } = harness({ foreground, busyPollMs: 1000 });
      await tasks.start(A, tab(1), "", 80, 24);
      await tasks.start(A, tab(2), "", 80, 24);
      await tasks.start(B, tab(1), "", 80, 24);
      fg.set(ptys[1]!.pid, "pnpm");
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(1000); // unchanged: no second push
      fg.set(ptys[1]!.pid, "vim");
      await vi.advanceTimersByTimeAsync(1000);
      fg.delete(ptys[1]!.pid);
      await vi.advanceTimersByTimeAsync(1000);
      expect(foreground.mock.calls).toEqual(Array(4).fill([ptys.map((p) => p.pid)]));
      expect(events.filter((e) => e.type === "busy")).toEqual([
        { mountId: "m1", tabId: tab(2), type: "busy", command: "pnpm" },
        { mountId: "m1", tabId: tab(2), type: "busy", command: "vim" },
        { mountId: "m1", tabId: tab(2), type: "busy" },
      ]);
      // runningCommand is a fresh check of the chat's (or one tab's) shells, idle ones left out.
      fg.set(ptys[0]!.pid, "make").set(ptys[1]!.pid, "pnpm").set(ptys[2]!.pid, "top");
      expect(await tasks.runningCommand("m1")).toEqual(["make", "pnpm"]);
      expect(await tasks.runningCommand("m1", tab(2))).toEqual(["pnpm"]);
      // The poll stops once no shell is left.
      ptys.forEach((p) => p.exit());
      foreground.mockClear();
      await vi.advanceTimersByTimeAsync(5000);
      expect(foreground).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a slow lookup skips ticks instead of overlapping", async () => {
    vi.useFakeTimers();
    try {
      let done: (m: Map<number, string>) => void = () => {};
      const foreground = vi.fn(() => new Promise<Map<number, string>>((r) => { done = r; }));
      const { tasks } = harness({ foreground, busyPollMs: 1000 });
      await tasks.start(A, T, "", 80, 24);
      await vi.advanceTimersByTimeAsync(3000);
      expect(foreground).toHaveBeenCalledTimes(1);
      done(new Map());
      await vi.advanceTimersByTimeAsync(1000);
      expect(foreground).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("exit frees the mount and pushes the code", async () => {
    const { tasks, ptys, events } = harness();
    await tasks.start(A, T, "", 80, 24);
    ptys[0]!.exit(3);
    expect(events).toEqual([{ mountId: "m1", tabId: T, type: "exit", code: 3 }]);
    expect(await tasks.start(A, T, "", 80, 24)).toEqual({ cwd: "/scratch", shell: "zsh" });
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
    await tasks.start(A, T, "", 80, 24);
    const pid = await jobPid!;
    const alive = (p: number): boolean => { try { process.kill(p, 0); return true; } catch { return false; } };
    expect(alive(pid)).toBe(true);
    await tasks.stop("m1", T);
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 3000 });
  });
});

describe("foregroundCommands", () => {
  it("makes two ps calls for any number of shells; idle shells are absent", async () => {
    const ps = vi.fn(async (args: string[]) => args[1] === "pid=,tpgid="
      ? "  10    50\n  11    11\n  12    50\n  13    70\n"
      : "  50 /opt/homebrew/bin/pnpm dev\n");
    expect(await foregroundCommands([10, 11, 12, 13], ps)).toEqual(new Map([[10, "pnpm"], [12, "pnpm"], [13, "A command"]]));
    expect(ps.mock.calls).toEqual([[["-o", "pid=,tpgid=", "-p", "10,11,12,13"]], [["-o", "pid=,command=", "-p", "50,70"]]]);
    ps.mockClear();
    expect(await foregroundCommands([], ps)).toEqual(new Map());
    expect(await foregroundCommands([11], ps)).toEqual(new Map());
    expect(ps).toHaveBeenCalledTimes(1);
  });

  it("names are sanitized (control, bidi and format characters) and capped", () => {
    expect(commandName("/usr/bin/p\u202Enp\x1b[31mm\u2066 --flag")).toBe("pnp[31mm");
    expect(commandName("x".repeat(100))).toBe("x".repeat(64));
    expect(commandName("\x07\u200F")).toBe("A command");
    expect(commandName("")).toBe("A command");
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
