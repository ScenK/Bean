import { randomUUID } from "node:crypto";
import type { ActionTool } from "../converse.js";
import { cancelReminder, loadReminders, updateReminders, type Reminder, type ReminderTarget } from "../reminders.js";

export interface ReminderToolDeps {
  file: string;
  /** From the authenticated ingress (Discord DM → the speaker, else this conversation), never the model. */
  target: ReminderTarget;
  /** The speaker's platform id. */
  setBy: string;
  /** The owner lists and cancels anyone's; everyone else only their own. */
  isOwner: boolean;
  /** From the authenticated ingress: a 1:1 DM, and this conversation's id. Outside a DM,
   * listing (and the cancel echo) is limited to this conversation's reminders. */
  direct: boolean;
  conversationId: string;
}

// Teams thread ids carry a `;messageid=…` suffix: sibling threads of one channel share a base.
const bareId = (id: string): string => id.split(";")[0] ?? id;

/** Whether `target` delivers into this conversation (same transport, same bare channel id). */
export function reminderInConversation(target: unknown, transport: string, conversationId: string): boolean {
  const t = target as Record<string, unknown> | null | undefined;
  return t?.transport === transport && typeof t.channelId === "string" && bareId(t.channelId) === bareId(conversationId);
}

/** Per-turn chatops set_reminder / list_reminders / cancel_reminder. `set` collects what this
 * turn saved so the surface can post a receipt with a Cancel button. */
export function makeReminderTools(deps: ReminderToolDeps): { tools: ActionTool[]; set: Reminder[] } {
  const set: Reminder[] = [];
  const mine = (r: Reminder): boolean => deps.isOwner || r.setBy === deps.setBy;
  const here = (target: unknown): boolean => deps.direct || reminderInConversation(target, deps.target.transport, deps.conversationId);
  const tools: ActionTool[] = [
    {
      spec: {
        name: "set_reminder",
        description: "Set a reminder at a specific time. It is delivered where it was asked for: " +
          "this conversation (DM, group chat or channel thread).",
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
        description: "List the speaker's pending (not yet fired) reminders; in a channel, only this channel's reminders.",
        parameters: { type: "object", properties: {} },
      },
      run: async () => {
        const pending = (await loadReminders(deps.file)).filter((r) => !r.firedAt && mine(r) && here(r.target))
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
        if (res.outcome === "cancelled") return here(res.target) ? `cancelled: ${res.text ?? id}` : "Reminder cancelled.";
        return res.outcome === "forbidden" ? "error: that reminder was set by someone else" : "no such pending reminder";
      },
    },
  ];
  return { tools, set };
}
