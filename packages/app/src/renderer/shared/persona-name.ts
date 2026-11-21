import { useEffect, useState } from "preact/hooks";

/** The persona's name — what the main conversation is called (#1001). Read on mount and on every
 * window focus, so a rename shows at the next focus; `getPersona` is a core channel, so it works on
 * a remote core too. "Bean" (the default persona) until the first read lands. */
export function usePersonaName(): string {
  const [name, setName] = useState("Bean");
  useEffect(() => {
    const read = (): void => {
      Promise.resolve().then(() => window.bean.getPersona())
        .then((p) => { if (typeof p?.name === "string" && p.name.trim()) setName(p.name); }, () => {});
    };
    read();
    window.addEventListener("focus", read);
    return () => window.removeEventListener("focus", read);
  }, []);
  return name;
}
