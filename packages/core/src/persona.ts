export const PERSONA_TAGS = ["Warm", "Concise", "Direct", "Playful", "Formal", "Encouraging"] as const;
export type PersonaTag = typeof PERSONA_TAGS[number];

export interface Persona {
  name: string;
  tags: PersonaTag[];
}

export const DEFAULT_PERSONA: Persona = { name: "Bean", tags: ["Warm", "Concise", "Direct"] };

export function isValidPersona(v: unknown): v is Persona {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  if (typeof p.name !== "string" || p.name.trim() === "") return false;
  if (!Array.isArray(p.tags) || p.tags.length === 0) return false;
  return p.tags.every((t) => (PERSONA_TAGS as readonly string[]).includes(t as PersonaTag));
}

export function composePersonaPrompt(persona: Persona): string {
  const tags = persona.tags.map((t) => t.toLowerCase()).join(", ");
  return `You are ${persona.name}, a ${tags} desktop coding companion. Reply in a way that reflects that.`;
}
