import type { ConverseDeps } from "../converse.js";

// Discord's thread-name cap.
const MAX_TITLE = 100;

function clip(text: string): string {
  const line = text.split("\n").find((l) => l.trim())?.trim() ?? "";
  const title = line.length > MAX_TITLE ? `${line.slice(0, MAX_TITLE - 1)}…` : line;
  return title || "Bean session";
}

/** A short session title for a new chat thread (like Claude Code's auto-title), from the
 * opening message. One cheap chat call; any failure or empty answer falls back to the
 * message's clipped first line, so thread creation never waits on or fails with the model. */
export async function threadTitle(text: string, deps: ConverseDeps): Promise<string> {
  try {
    const res = await deps.chat({
      model: deps.model,
      messages: [
        {
          role: "system",
          content:
            "Write a short title (at most 8 words) for a chat session that opens with the user's " +
            "message. Reply with the title only: no quotes, no trailing punctuation.",
        },
        { role: "user", content: text.slice(0, 2000) },
      ],
      tools: [],
    });
    return clip(res.content.trim().replace(/^["'`]+|["'`]+$/g, "") || text);
  } catch {
    return clip(text);
  }
}
