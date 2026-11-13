import { randomUUID } from "node:crypto";
import {
  extractPageText, loadReminders, retrieveNoteTool, safeFetch, searchNotes, systemControlTool, updateReminders,
  type ActionTool,
} from "@bean/core";

/** The action tools converse()'s tool loop runs for the desktop chat and routine chat steps:
 * reminders (fired by the scheduler's reminder loop), note retrieval, `fetch_url`, and system
 * control (gated per call on the live Settings toggle, so flipping it needs no restart). */
export function buildActionTools(deps: { remindersFile: string; dbFile: string; systemControls: () => boolean }): ActionTool[] {
  return [
    {
      spec: {
        name: "set_reminder",
        description: "Set a desktop-notification reminder for the user at a specific time.",
        parameters: {
          type: "object",
          properties: {
            text: { type: "string", description: "what to remind the user about" },
            at: { type: "string", description: "when to fire, as an ISO 8601 timestamp with timezone offset" },
          },
          required: ["text", "at"],
        },
      },
      run: async (args) => {
        const { text, at } = (args ?? {}) as { text?: unknown; at?: unknown };
        if (typeof text !== "string" || typeof at !== "string" || Number.isNaN(Date.parse(at))) {
          return "error: set_reminder needs { text, at } with `at` a valid ISO 8601 timestamp";
        }
        await updateReminders(deps.remindersFile, (all) => { all.push({ id: randomUUID(), text, at }); });
        return `reminder saved for ${at}`;
      },
    },
    {
      spec: {
        name: "list_reminders",
        description: "List the user's pending (not yet fired) reminders.",
        parameters: { type: "object", properties: {} },
      },
      run: async () => {
        const pending = (await loadReminders(deps.remindersFile)).filter((r) => !r.firedAt);
        return pending.length === 0 ? "no pending reminders" : JSON.stringify(pending);
      },
    },
    retrieveNoteTool((q) => searchNotes(deps.dbFile, q)),
    {
      spec: {
        name: "fetch_url",
        description:
          "Fetch a web page and return its readable text. Use whenever you need the actual " +
          "content behind an http(s) URL (summarizing, explaining, extracting from a page).",
        parameters: {
          type: "object",
          properties: { url: { type: "string", description: "the http(s) URL to fetch" } },
          required: ["url"],
        },
      },
      run: async (args, ctx) => {
        const { url } = (args ?? {}) as { url?: unknown };
        let parsed: URL;
        try {
          parsed = new URL(typeof url === "string" ? url : "");
        } catch {
          return "error: fetch_url needs a valid absolute URL";
        }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          return `error: only http(s) URLs can be fetched, got ${parsed.protocol}`;
        }
        try {
          // safeFetch refuses loopback/LAN/metadata addresses (also after redirects) and caps the body.
          const res = await safeFetch(parsed.toString(), { timeoutMs: 15_000, maxBytes: 5 * 1024 * 1024, signal: ctx?.signal });
          if (!res.ok) return `error: fetch failed with HTTP ${res.status}`;
          const text = extractPageText(res.body);
          return text || "error: page had no readable text";
        } catch (err) {
          return `error: fetch failed — ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    systemControlTool(deps.systemControls),
  ];
}
