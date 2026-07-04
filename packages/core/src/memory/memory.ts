export interface Memory {
  id: string;
  text: string;
  projectPath?: string;
  createdAt: string;
}

export interface MemoryCandidate {
  text: string;
  projectPath?: string;
}

export function isValidMemory(v: unknown): v is Memory {
  if (typeof v !== "object" || v === null) return false;
  const m = v as Record<string, unknown>;
  if (typeof m.id !== "string" || m.id.trim() === "") return false;
  if (typeof m.text !== "string" || m.text.trim() === "") return false;
  if (typeof m.createdAt !== "string" || m.createdAt.trim() === "") return false;
  if (m.projectPath !== undefined && typeof m.projectPath !== "string") return false;
  return true;
}
