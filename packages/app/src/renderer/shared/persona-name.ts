import { useEffect, useState } from "preact/hooks";
import { coreOffline, useCoreStatus } from "./core-status.js";

/** The persona's name — what the main conversation is called (#1001). Read on mount, on every window
 * focus and whenever a remote core (re)attaches (a read before that fails), so a rename shows at the
 * next focus; `getPersona` is a remote op, so it works on a remote core too. "Bean" (the default
 * persona) until a read lands. */
export function usePersonaName(): string {
  const [name, setName] = useState("Bean");
  const offline = coreOffline(useCoreStatus());
  useEffect(() => {
    const read = (): void => {
      Promise.resolve().then(() => window.bean.getPersona())
        .then((p) => { if (typeof p?.name === "string" && p.name.trim()) setName(p.name); }, () => {});
    };
    if (!offline) read();
    window.addEventListener("focus", read);
    return () => window.removeEventListener("focus", read);
  }, [offline]);
  return name;
}
