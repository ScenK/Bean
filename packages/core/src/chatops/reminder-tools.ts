import { randomUUID } from "node:crypto";
import type { ActionTool } from "../converse.js";
import { cancelReminder, loadReminders, updateReminders, type Reminder, type ReminderTarget } from "../reminders.js";

export interface ReminderToolDeps {
  file: string;
  /** From the authenticated ingress (DM → the speaker, channel → this channel), never the model. */
  target: ReminderTarget;
  /** The speaker's platform id. */
  setBy: string;
  /** The owner lists and cancels anyone's; everyone else only their own. */
  isOwner: boolean;
}

/** Per-turn chatops set_reminder / list_reminders / cancel_reminder. `set` collects what this
 * turn saved so the surface can post a receipt with a Cancel button. */
export function makeReminderTools(deps: ReminderToolDeps): { tools: ActionTool[]; set: Reminder[] } {
  const set: Reminder[] = [];
  const mine = (r: Reminder): boolean => deps.isOwner || r.setBy === deps.setBy;
  const tools: ActionTool[] = [
    {
      spec: {
        name: "set_reminder",
        description: "Set a reminder at a specific time. It is delivered where it was asked for: " +
          "this DM, or this channel.",
        parameters: {
          type: "object",
          properties: {
            text: { type: "string", description: "what to remind about" },
            at: { type: "string", description: "when to fire, as an ISO 8601 timestamp with timezone offset" },
          },
          required: ["text", "at"],
        },
      },
      run: async (args) => {
        const { text, at } = (args ?? {}) as { text?: unknown; at?: unknown };
        if (typeof text !== "string" || !text.trim() || typeof at !== "string" || Number.isNaN(Date.parse(at))) {
          return "error: set_reminder needs { text, at } with `at` a valid ISO 8601 timestamp";
        }
        const r: Reminder = { id: randomUUID(), text: text.trim().slice(0, 1000), at, target: deps.target, setBy: deps.setBy };
        await updateReminders(deps.file, (all) => { all.push(r); });
        set.push(r);
        return `reminder saved for ${at} (id ${r.id})`;
      },
    },
    {
      spec: {
        name: "list_reminders",
        description: "List the speaker's pending (not yet fired) reminders.",
        parameters: { type: "object", properties: {} },
      },
      run: async () => {
        const pending = (await loadReminders(deps.file)).filter((r) => !r.firedAt && mine(r))
          .map(({ id, text, at }) => ({ id, text, at }));
        return pending.length === 0 ? "no pending reminders" : JSON.stringify(pending);
      },
    },
    {
      spec: {
        name: "cancel_reminder",
        description: "Cancel one pending reminder by id (from list_reminders).",
        parameters: {
          type: "object",
          properties: { id: { type: "string", description: "the reminder id" } },
          required: ["id"],
        },
      },
      run: async (args) => {
        const { id } = (args ?? {}) as { id?: unknown };
        if (typeof id !== "string" || !id) return "error: cancel_reminder needs { id }";
        const res = await cancelReminder(deps.file, id, deps.isOwner ? undefined : deps.setBy);
        if (res.outcome === "cancelled") return `cancelled: ${res.text ?? id}`;
        return res.outcome === "forbidden" ? "error: that reminder was set by someone else" : "no such pending reminder";
      },
    },
  ];
  return { tools, set };
}
