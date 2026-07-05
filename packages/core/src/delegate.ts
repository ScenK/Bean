import type { CliName } from "./launcher.js";

export interface DelegateRequest {
  cli: CliName;
  projectPath: string;
  prompt: string;
}

// Headless one-shot delegation, unlike launcher.ts's interactive TUI launches.
export function delegateCommand(req: DelegateRequest): { command: string; args: string[] } {
  if (req.cli === "claude") {
    return {
      command: "claude",
      args: [
        "-p", req.prompt,
        "--output-format", "stream-json",
        "--verbose",
        "--allowedTools", "Bash,Edit,Write,Read,Glob,Grep",
      ],
    };
  }
  return { command: "opencode", args: ["run", req.prompt] };
}

export function claudeTailLine(event: unknown): string | undefined {
  const e = event as { type?: unknown; message?: { content?: unknown } } | null;
  if (e?.type !== "assistant" || !Array.isArray(e.message?.content)) return undefined;

  const parts: string[] = [];
  for (const block of e.message.content as { type?: unknown; text?: unknown; name?: unknown }[]) {
    if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) parts.push(block.text.trim());
    else if (block?.type === "tool_use" && typeof block.name === "string") parts.push(`▸ ${block.name}`);
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

export function claudeResult(event: unknown): string | undefined {
  const e = event as { type?: unknown; result?: unknown } | null;
  return e?.type === "result" && typeof e.result === "string" ? e.result : undefined;
}
