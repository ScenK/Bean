import { connect, createServer, type Server as NetServer, type Socket } from "node:net";
import { chmodSync, lstatSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  checkFact, composePrompt, selectRelevantMemories, resolveTodoRoutine,
  type Memory, type Note, type NoteDraft, type Project, type Routine, type RoutineState, type Skill,
} from "@bean/core";
import { MCP_SOCKET_NAME, MCP_TOOLS } from "./mcp-tools.js";
import { isActive, type McpRun, type McpRuns } from "./mcp-runs.js";
import type { DelegateStartRequest } from "./delegate-tasks.js";

// Bean as a local MCP server (#225): Bean.app listens on a user-only unix socket in ~/.bean and
// serves one MCP Server per connection; each client's stdio shim (mcp-shim.ts) pipes to it. It
// exposes Bean's data and actions — never converse() — through the explicit allowlist in
// mcp-tools.ts. Same OS user = trusted (.memory/convention-one-install-one-trust-domain.md).

export interface McpHandlerDeps {
  searchNotes: (query: string, limit: number) => Promise<Note[]>;
  saveNote: (draft: NoteDraft) => Promise<string>;
  loadNotes: () => Promise<Note[]>;
  loadMemories: () => Promise<Memory[]>;
  deleteMemories: (ids: string[]) => Promise<number>;
  /** Appends and merges into the live Undo batch; returns the merged batch size. */
  rememberIntoBatch: (additions: Memory[]) => Promise<number>;
  loadProjects: () => Promise<Project[]>;
  loadSkills: () => Promise<Skill[]>;
  loadRoutines: () => Promise<Routine[]>;
  loadRoutineStates: () => Promise<Record<string, RoutineState>>;
  isRoutineRunning: (name: string) => boolean;
  /** Starts without awaiting the run; `onFinish` fires when it ends. */
  startRoutine: (name: string, onFinish: (o: { status: "done" | "failed"; digest: string }) => void) => Promise<{ started: boolean; reason?: string }>;
  addTodo: (routine: string, text: string) => Promise<void>;
  /** Configured model ids of the enabled CLIs. */
  models: () => string[];
  scratchPath: string;
  /** The MCP-only delegate-tasks instance (closing the chat window never cancels it). */
  delegates: { start: (req: DelegateStartRequest) => Promise<string>; cancel: (taskId: string) => void };
  runs: McpRuns;
  /** Short `done` avatar bubble; `id` coalesces repeats. */
  bubble: (id: string, kind: "memory" | "routine", name: string, line: string) => void;
  /** The remembered-batch bubble (reuses memory:batch), with the merged count. */
  memoryBubble: (count: number) => void;
  now?: () => number;
  /** How long cancel_delegate waits for the child to confirm it's gone. */
  cancelWaitMs?: number;
}

export interface McpCallContext {
  client: string;
  /** Memory ids this connection got from recall_memories — the only ones it may forget. */
  known: Set<string>;
  signal?: AbortSignal;
}

export const MAX_RUNNING_DELEGATES = 4;
const BUBBLE_WINDOW_MS = 10_000; // matches task-status FINISHED_LINGER_MS

class ToolError extends Error {}

const ok = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
const fail = (message: string): CallToolResult => ({ content: [{ type: "text", text: message }], isError: true });

function str(args: Record<string, unknown>, key: string, max: number, required: true): string;
function str(args: Record<string, unknown>, key: string, max: number, required?: false): string | undefined;
function str(args: Record<string, unknown>, key: string, max: number, required = false): string | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === "") {
    if (required) throw new ToolError(`${key} is required.`);
    return undefined;
  }
  if (typeof v !== "string") throw new ToolError(`${key} must be a string.`);
  if (v.length > max) throw new ToolError(`${key} is longer than ${max} characters.`);
  return v;
}

function int(args: Record<string, unknown>, key: string, min: number, max: number, fallback: number): number {
  const v = args[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new ToolError(`${key} must be an integer from ${min} to ${max}.`);
  return v;
}

const ID = /^[A-Za-z0-9-]{1,64}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,119}$/;

/** initialize.clientInfo.name is untrusted display text: printable, ≤40 chars. */
export function clientLabel(name: unknown): string {
  const s = typeof name === "string" ? name.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim() : "";
  return s ? s.slice(0, 40) : "an AI app";
}

function findProject(projects: Project[], ref: string): Project {
  const p = projects.find((x) => x.name === ref || x.path === ref);
  if (!p) throw new ToolError(`Unknown project "${ref}". Registered projects: ${projects.map((x) => x.name).join(", ") || "none"}.`);
  return p;
}

const runView = (r: McpRun, now: number) => ({
  id: r.id, kind: r.kind, state: r.state, client: r.client, instruction: r.instruction, project: r.project,
  startedAt: r.startedAt, startedAgo: ago(now - Date.parse(r.startedAt)),
  ...(r.tail.length && isActive(r) ? { tail: r.tail } : {}),
  ...(r.result !== undefined ? { result: r.result } : {}),
  ...(r.message !== undefined ? { message: r.message } : {}),
  ...(r.receipt ? { resume: r.receipt.command } : {}),
  ...(r.by ? { by: r.by, cancelledBy: r.cancelledBy } : {}),
});

function ago(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

export function createMcpHandlers(deps: McpHandlerDeps) {
  const now = deps.now ?? Date.now;
  const counts = new Map<string, { n: number; at: number }>();
  /** "Saved 3 notes · via Claude Code" — one bubble per client+kind, counting within its linger. */
  const coalesced = (client: string, key: "note" | "todo" | "forget", line: (n: number) => string): void => {
    const id = `mcp:${client}:${key}`;
    const prev = counts.get(id);
    const n = prev && now() - prev.at < BUBBLE_WINDOW_MS ? prev.n + 1 : 1;
    counts.set(id, { n, at: now() });
    // kind only picks the click action: a memory bubble opens Persona (where Undo lives).
    const name = key === "note" ? "Notes" : key === "todo" ? "Todos" : "Memory";
    deps.bubble(id, key === "forget" ? "memory" : "routine", name, `${line(n)} · via ${client}`);
  };
  const plural = (n: number, one: string, many: string): string => (n === 1 ? `1 ${one}` : `${n} ${many}`);

  const tools: Record<string, (args: Record<string, unknown>, ctx: McpCallContext) => Promise<CallToolResult>> = {
    async search_notes(args) {
      const query = str(args, "query", 500, true);
      const notes = await deps.searchNotes(query, int(args, "limit", 1, 10, 5));
      return ok(notes.map((n) => ({
        slug: n.slug, title: n.title, version: n.version, updated: n.updated, ...(n.project ? { project: n.project } : {}),
        body: n.body.length > 8000 ? `${n.body.slice(0, 8000)}\n…[truncated]` : n.body,
      })));
    },

    async save_note(args, ctx) {
      const title = str(args, "title", 200, true);
      const body = str(args, "body", 100_000) ?? "";
      const slug = str(args, "slug", 120);
      if (slug !== undefined && !SLUG.test(slug)) throw new ToolError("slug must be lowercase letters, digits and dashes.");
      const projectRef = str(args, "project", 1000);
      const project = projectRef ? findProject(await deps.loadProjects(), projectRef).path : undefined;
      if (!title.trim()) throw new ToolError("title is required.");
      const saved = await deps.saveNote({ title, body, source: "chat", ...(slug ? { slug } : {}), ...(project ? { project } : {}) });
      const version = (await deps.loadNotes()).find((n) => n.slug === saved)?.version ?? 1;
      coalesced(ctx.client, "note", (n) => `Saved ${plural(n, "note", "notes")}`);
      return ok({ slug: saved, version });
    },

    async recall_memories(args, ctx) {
      const query = str(args, "query", 500) ?? "";
      const limit = int(args, "limit", 1, 50, 12);
      const all = await deps.loadMemories();
      const picked = query.trim()
        ? selectRelevantMemories(all, query, undefined, limit, 0)
        : [...all].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
      for (const m of picked) ctx.known.add(m.id);
      return ok(picked.map((m) => ({ id: m.id, text: m.text, createdAt: m.createdAt, ...(m.projectPath ? { project: m.projectPath } : {}) })));
    },

    async remember(args) {
      const text = str(args, "text", 500, true);
      const projectRef = str(args, "project", 1000);
      const projects = await deps.loadProjects();
      const projectPath = projectRef ? findProject(projects, projectRef).path : undefined;
      // An MCP call carries no typed-user provenance (and never claims it), so only the
      // fact-shape rejects apply: no instructions, no secrets, registered projects only.
      const c = checkFact(text, projectPath, projects);
      if (typeof c === "string") throw new ToolError(`Not remembered — ${c}`);
      const existing = await deps.loadMemories();
      if (existing.some((m) => m.text.trim().toLowerCase() === c.text.toLowerCase())) return ok({ remembered: false, reason: "already remembered" });
      const m: Memory = { id: randomUUID(), text: c.text, projectPath: c.projectPath, createdAt: new Date(now()).toISOString() };
      const count = await deps.rememberIntoBatch([m]);
      deps.memoryBubble(count);
      return ok({ remembered: true, id: m.id, text: m.text });
    },

    async forget_memory(args, ctx) {
      const raw = args.ids;
      if (!Array.isArray(raw) || raw.length === 0 || raw.length > 50) throw new ToolError("ids must be a list of 1–50 memory ids.");
      const ids = raw.filter((id): id is string => typeof id === "string" && ctx.known.has(id));
      if (ids.length === 0) throw new ToolError("No matching memories — ids must come from recall_memories in this session.");
      const n = await deps.deleteMemories(ids);
      for (const id of ids) ctx.known.delete(id);
      if (n > 0) coalesced(ctx.client, "forget", (k) => `Forgot ${plural(k, "memory", "memories")}`);
      return ok({ forgotten: n });
    },

    async add_todo(args, ctx) {
      const routine = str(args, "routine", 200, true);
      const text = str(args, "text", 4000, true);
      if (!text.trim()) throw new ToolError("text is required.");
      try {
        resolveTodoRoutine(await deps.loadRoutines(), routine);
      } catch (err) {
        throw new ToolError(err instanceof Error ? err.message : String(err));
      }
      await deps.addTodo(routine, text);
      coalesced(ctx.client, "todo", (n) => `Added ${plural(n, "todo", "todos")}`);
      return ok({ added: true, routine });
    },

    async list_routines() {
      const [routines, states] = await Promise.all([deps.loadRoutines(), deps.loadRoutineStates()]);
      return ok(routines.map((r) => {
        const last = states[r.name]?.history[0];
        return {
          name: r.name, ...(r.description ? { description: r.description } : {}), enabled: r.enabled,
          trigger: r.watch ? "watch" : `cron ${r.cron ?? ""}`.trim(), takesTodos: Boolean(r.todoDriven),
          running: deps.isRoutineRunning(r.name),
          ...(last ? { lastRun: { finishedAt: last.finishedAt, status: last.status } } : {}),
        };
      }));
    },

    async run_routine(args, ctx) {
      const name = str(args, "name", 200, true);
      const id = randomUUID();
      // Recorded before the start so a run that ends instantly still lands its outcome.
      deps.runs.add({ id, kind: "routine", client: ctx.client, instruction: name, project: "", startedAt: new Date(now()).toISOString() });
      const res = await deps.startRoutine(name, (o) => {
        deps.runs.finish(id, o.status, o.status === "done" ? { result: o.digest } : { message: o.digest });
      });
      if (!res.started) {
        deps.runs.finish(id, "failed", { message: res.reason ?? "not started" });
        return ok({ started: false, reason: res.reason ?? "not started" });
      }
      return ok({ started: true, runId: id });
    },

    async start_delegate(args, ctx) {
      const instruction = str(args, "instruction", 20_000, true);
      if (!instruction.trim()) throw new ToolError("instruction is required.");
      const projectRef = str(args, "project", 1000);
      const skillName = str(args, "skill", 200);
      const model = str(args, "model", 200);
      const [projects, skills] = await Promise.all([deps.loadProjects(), skillName ? deps.loadSkills() : Promise.resolve([])]);
      const project = projectRef ? findProject(projects, projectRef) : undefined;
      let skill: Skill | undefined;
      if (skillName) {
        const usable = skills.filter((s) => s.enabled !== false && !s.hidden && s.target !== "chat");
        skill = usable.find((s) => s.name === skillName);
        if (!skill) throw new ToolError(`Unknown or disabled skill "${skillName}". Enabled skills: ${usable.map((s) => s.name).join(", ") || "none"}.`);
      }
      if (model !== undefined && !deps.models().includes(model)) {
        throw new ToolError(`Unknown model "${model}". Configured models: ${deps.models().join(", ") || "none"}.`);
      }
      if (deps.runs.list("delegate").filter(isActive).length >= MAX_RUNNING_DELEGATES) {
        throw new ToolError(`${MAX_RUNNING_DELEGATES} Bean delegates are already running — wait for one to finish or cancel one.`);
      }
      const taskId = await deps.delegates.start({
        projectPath: project?.path ?? deps.scratchPath,
        prompt: skill ? composePrompt(skill, instruction) : instruction,
        instruction,
        ...(model ? { model } : {}),
        ...(skill ? { skillName: skill.name } : {}),
      });
      // "started" is emitted synchronously inside start(); a refused start (busy project, no
      // CLI) reports its failure on the next turn instead.
      if (!deps.runs.get(taskId)) {
        await new Promise((r) => setImmediate(r));
        throw new ToolError(deps.runs.takeRejection(taskId) ?? "The delegate couldn't start.");
      }
      deps.runs.setClient(taskId, ctx.client);
      return ok({ taskId, state: "running", project: project?.name ?? "workspace" });
    },

    async delegate_status(args, ctx) {
      const id = str(args, "id", 64, true);
      const run = ID.test(id) ? deps.runs.get(id) : undefined;
      if (!run) throw new ToolError(`Unknown id "${id}" — only runs started through this server since Bean last started are tracked; see list_delegates.`);
      const deadline = now() + int(args, "wait_seconds", 0, 45, 30) * 1000;
      while (isActive(run) && now() < deadline && !ctx.signal?.aborted) {
        await deps.runs.wait(id, deadline - now(), ctx.signal);
      }
      return ok(runView(run, now()));
    },

    async list_delegates() {
      return ok(deps.runs.list("delegate").map((r) => runView(r, now())));
    },

    async cancel_delegate(args, ctx) {
      const id = str(args, "taskId", 64, true);
      const run = ID.test(id) ? deps.runs.get(id) : undefined;
      if (!run || run.kind !== "delegate") {
        throw new ToolError(`Unknown taskId "${id}" — only delegates started through this server since Bean last started can be cancelled; call list_delegates.`);
      }
      if (deps.runs.requestCancel(id, ctx.client)) deps.delegates.cancel(id);
      // Wait (bounded) for the child's confirmed exit; a disconnect only ends this wait.
      const deadline = now() + (deps.cancelWaitMs ?? 6000);
      while (run.state === "cancelling" && now() < deadline && !ctx.signal?.aborted) {
        await deps.runs.wait(id, deadline - now(), ctx.signal);
      }
      return ok(runView(run, now()));
    },
  };

  return {
    async call(name: string, args: unknown, ctx: McpCallContext): Promise<CallToolResult> {
      const handler = Object.hasOwn(tools, name) ? tools[name] : undefined;
      if (!handler) return fail(`Unknown tool "${name}".`);
      if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) return fail("Arguments must be an object.");
      try {
        return await handler((args ?? {}) as Record<string, unknown>, ctx);
      } catch (err) {
        if (err instanceof ToolError) return fail(err.message);
        // Never echo payloads into logs — the tool name is enough to find it.
        console.error(`bean: mcp tool ${name} failed:`, err instanceof Error ? err.message : String(err));
        return fail(`Bean couldn't complete ${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}

export type McpHandlers = ReturnType<typeof createMcpHandlers>;

// --- Socket listener ----------------------------------------------------------------------

export const MAX_CONNECTIONS = 8;
export const MAX_IN_FLIGHT = 8;
export const MAX_FRAME_BYTES = 1024 * 1024;

export interface McpListenerOptions {
  dir: string;
  version: string;
  handlers: McpHandlers;
}

const probe = (path: string): Promise<boolean> =>
  new Promise((resolve) => {
    const s = connect(path);
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("error", () => resolve(false));
  });

/** Refuses to serve from a dir someone else owns or can write, and never unlinks a symlink, a
 * non-socket, or a socket some live process still answers on. */
async function claimSocketPath(dir: string): Promise<string> {
  const st = lstatSync(dir);
  const uid = process.getuid?.();
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`${dir} isn't a directory`);
  if (uid !== undefined && st.uid !== uid) throw new Error(`${dir} isn't owned by this user`);
  if (st.mode & 0o022) throw new Error(`${dir} is writable by other users`);
  const path = join(dir, MCP_SOCKET_NAME);
  let existing;
  try { existing = lstatSync(path); } catch { return path; }
  if (!existing.isSocket()) throw new Error(`${path} exists and isn't a socket — not touching it`);
  if (await probe(path)) throw new Error(`another process is already serving ${path}`);
  unlinkSync(path);
  return path;
}

function serveConnection(socket: Socket, opts: McpListenerOptions): () => void {
  const server = new Server({ name: "bean", version: opts.version }, { capabilities: { tools: {} } });
  const known = new Set<string>();
  let inFlight = 0;
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: MCP_TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    if (inFlight >= MAX_IN_FLIGHT) return fail("Too many Bean calls in flight on this connection — retry in a moment.");
    inFlight++;
    try {
      return await opts.handlers.call(req.params.name, req.params.arguments, {
        client: clientLabel(server.getClientVersion()?.name), known, signal: extra.signal,
      });
    } finally {
      inFlight--;
    }
  });
  const transport = new StdioServerTransport(socket, socket, { maxBufferSize: MAX_FRAME_BYTES });
  // An oversize frame or a socket error ends this connection only.
  transport.onerror = () => socket.destroy();
  const close = (): void => {
    socket.destroy();
    server.close().catch(() => {});
  };
  socket.on("error", () => socket.destroy());
  socket.once("close", () => { server.close().catch(() => {}); });
  server.connect(transport).catch(() => socket.destroy());
  return close;
}

/** Starts listening on ~/.bean/mcp.sock (mode 0600). Returns a stop() for before-quit/relaunch. */
export async function startMcpListener(opts: McpListenerOptions): Promise<{ stop: () => void; path: string }> {
  const path = await claimSocketPath(opts.dir);
  const conns = new Set<() => void>();
  const server: NetServer = createServer((socket) => {
    if (conns.size >= MAX_CONNECTIONS) { socket.destroy(); return; }
    const close = serveConnection(socket, opts);
    conns.add(close);
    socket.once("close", () => conns.delete(close));
  });
  server.maxConnections = MAX_CONNECTIONS;
  await new Promise<void>((resolve, reject) => {
    // The socket is born 0600: bind() happens synchronously inside listen(), under this umask.
    const prev = process.umask(0o177);
    try {
      server.once("error", reject);
      server.listen(path, () => { server.off("error", reject); resolve(); });
    } finally {
      process.umask(prev);
    }
  });
  chmodSync(path, 0o600);
  server.on("error", (err) => console.error("bean: mcp listener error:", err.message));
  return {
    path,
    stop: () => {
      for (const close of [...conns]) close();
      server.close(); // also unlinks the socket file
    },
  };
}
