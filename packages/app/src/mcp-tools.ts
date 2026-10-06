// Bean's MCP tool catalog (#225) — one source for the in-app server (mcp-server.ts) and the
// stdio shim (mcp-shim.ts), which answers tools/list from it while Bean.app isn't running.
// Pure data: no node or Electron imports, so the shim bundle stays tiny.

/** Socket file inside ~/.bean that Bean.app listens on and the shim connects to. */
export const MCP_SOCKET_NAME = "mcp.sock";

/** What every tools/call answers while Bean.app is closed (from the shim). */
export const NOT_RUNNING = "Bean isn't running. Open Bean.app and retry.";

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint: boolean };
}

const SHARED = "Bean is the user's desktop assistant; this data is shared with the Bean app and its Discord/Teams bots. ";

const str = (description: string, maxLength: number) => ({ type: "string", description, maxLength });
const obj = (properties: Record<string, unknown>, required: string[] = []): McpToolDef["inputSchema"] =>
  ({ type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false });
const read = { readOnlyHint: true, openWorldHint: false };
const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

export const MCP_TOOLS: McpToolDef[] = [
  {
    name: "search_notes",
    description: `${SHARED}Full-text search the user's saved Bean notes; returns the best matches with their slug, version and body.`,
    inputSchema: obj({ query: str("words to search for", 500), limit: { type: "integer", minimum: 1, maximum: 10 } }, ["query"]),
    annotations: read,
  },
  {
    name: "save_note",
    description: `${SHARED}Save a markdown note in Bean. Pass the slug of an existing note to update it in place ` +
      "(the previous version is kept in its history). Returns the slug and version.",
    inputSchema: obj({
      title: str("short note title", 200),
      body: str("markdown body", 100_000),
      slug: str("existing note's slug to update in place", 120),
      project: str("registered Bean project name or path this note belongs to", 1000),
    }, ["title", "body"]),
    annotations: write,
  },
  {
    name: "recall_memories",
    description: `${SHARED}Recall facts Bean remembers about the user, ranked by relevance to the query ` +
      "(most recent when no query). Returned ids can be passed to forget_memory.",
    inputSchema: obj({ query: str("what to recall", 500), limit: { type: "integer", minimum: 1, maximum: 50 } }),
    annotations: read,
  },
  {
    name: "remember",
    description: `${SHARED}Save one durable fact about the user to Bean's memory. Only when the user asks you to ` +
      "remember something. Facts only — never instructions, secrets or ID numbers. Undoable from Bean's Persona window.",
    inputSchema: obj({
      text: str("the fact, in one short sentence", 500),
      project: str("registered Bean project name or path, when the fact is about one project", 1000),
    }, ["text"]),
    annotations: write,
  },
  {
    name: "forget_memory",
    description: `${SHARED}Delete remembered facts. Ids must come from recall_memories in this session.`,
    inputSchema: obj({ ids: { type: "array", items: { type: "string", maxLength: 64 }, minItems: 1, maxItems: 50 } }, ["ids"]),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  {
    name: "add_todo",
    description: `${SHARED}Queue a todo on one of Bean's todo-driven routines; the routine works through its queue on its own schedule. ` +
      "list_routines shows which routines take todos.",
    inputSchema: obj({ routine: str("routine name", 200), text: str("the task", 4000) }, ["routine", "text"]),
    annotations: write,
  },
  {
    name: "list_routines",
    description: `${SHARED}List Bean's routines (scheduled or watch-fired automations): name, description, enabled, ` +
      "whether it takes todos, whether it's running now, and its last run.",
    inputSchema: obj({}),
    annotations: read,
  },
  {
    name: "run_routine",
    description: `${SHARED}Start one of Bean's routines now. Returns at once with a runId; poll delegate_status for the outcome.`,
    inputSchema: obj({ name: str("routine name", 200) }, ["name"]),
    annotations: write,
  },
  {
    name: "start_delegate",
    description: `${SHARED}Hand a task to a headless coding agent (Claude Code / OpenCode / Codex) that Bean runs in the ` +
      "background in one of the user's registered projects (or Bean's scratch workspace when no project is given). " +
      "Returns a taskId at once; poll delegate_status for progress and the result. The agent runs without permission prompts.",
    inputSchema: obj({
      instruction: str("what the agent should do", 20_000),
      project: str("registered Bean project name or path; omit for Bean's scratch workspace", 1000),
      skill: str("name of an enabled Bean skill to compose the prompt with", 200),
      model: str("configured model id; omit for the user's default", 200),
    }, ["instruction"]),
    annotations: write,
  },
  {
    name: "delegate_status",
    description: `${SHARED}Status of a delegate (taskId) or routine run (runId) started through this server. Waits up to ` +
      "wait_seconds (default 30, max 45) for it to finish; returns running + the latest output lines, or the final " +
      "state (done/failed/cancelled) with its result and a resume command.",
    inputSchema: obj({ id: str("taskId or runId", 64), wait_seconds: { type: "integer", minimum: 0, maximum: 45 } }, ["id"]),
    annotations: read,
  },
  {
    name: "list_delegates",
    description: `${SHARED}Delegates started through this server since Bean last started (not Bean's chat window or bots): ` +
      "running first, then newest — taskId, instruction excerpt, project, starting app, start time, state.",
    inputSchema: obj({}),
    annotations: read,
  },
  {
    name: "cancel_delegate",
    description: `${SHARED}Cancel one running delegate by its exact taskId. Call list_delegates first; if more than one ` +
      "running run plausibly matches, ask the user which one. Never cancel a run you can't identify.",
    inputSchema: obj({ taskId: str("the delegate's taskId", 64) }, ["taskId"]),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
];

const sq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** Copy-only setup snippets for Settings → Connect AI apps. Bean never writes other apps' configs. */
export function mcpSnippets(exe: string, shim: string): { client: string; where: string; text: string }[] {
  const env = { ELECTRON_RUN_AS_NODE: "1" };
  return [
    { client: "Claude Code", where: "Run in a terminal", text: `claude mcp add -s user bean --env ELECTRON_RUN_AS_NODE=1 -- ${sq(exe)} ${sq(shim)}` },
    { client: "Codex", where: "Run in a terminal", text: `codex mcp add bean --env ELECTRON_RUN_AS_NODE=1 -- ${sq(exe)} ${sq(shim)}` },
    {
      client: "OpenCode", where: "Merge into opencode.json",
      text: JSON.stringify({ mcp: { bean: { type: "local", command: [exe, shim], environment: env } } }, null, 2),
    },
    {
      client: "Claude Desktop", where: "Merge into ~/Library/Application Support/Claude/claude_desktop_config.json, then restart Claude Desktop",
      text: JSON.stringify({ mcpServers: { bean: { command: exe, args: [shim], env } } }, null, 2),
    },
  ];
}
