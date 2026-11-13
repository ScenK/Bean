import { useEffect, useState } from "preact/hooks";
import type { CoreListing, Theme } from "../../../channels.js";
import { useCoreStatus } from "../../shared/core-status.js";

/** The Cores panel (#810, #811): what the avatar opens while no core is attached, and the tray's
 * Add Core…. Shell-only — it never calls a core channel. Picking a core restarts Bean on it (after the
 * chat window's Keep/Stop review). Remote cores are reached with `ssh <host> bean-core attach`, key auth
 * only. */
export function CoresWindow() {
  const [theme, setTheme] = useState<Theme>("hearth");
  const [listing, setListing] = useState<CoreListing | undefined>(undefined);
  const [host, setHost] = useState("");
  const [container, setContainer] = useState("");
  const [error, setError] = useState("");
  const [switching, setSwitching] = useState<string | undefined>(undefined);
  const status = useCoreStatus();

  const refresh = (): void => { window.bean.coreList().then(setListing, () => {}); };
  useEffect(() => {
    window.bean.getTheme().then(setTheme);
    window.bean.onThemeChanged(setTheme);
    refresh();
  }, []);

  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);

  const use = (id: string): void => {
    setSwitching(id);
    window.bean.coreSwitch(id);
  };
  const add = async (e: Event): Promise<void> => {
    e.preventDefault();
    setError("");
    const r = await window.bean.coreAdd(host, container || undefined);
    if ("error" in r) { setError(r.error); return; }
    setHost("");
    setContainer("");
    refresh();
  };
  const remove = async (id: string): Promise<void> => {
    await window.bean.coreRemove(id);
    refresh();
  };
  const selected = listing?.selected ?? null;

  return (
    <div class="bean-dashboard">
      <div class="bean-about bean-cores">
        <div class="bean-about-name">{selected === null ? "Add a core" : "Cores"}</div>
        <p class="bean-about-desc">
          {selected === null
            ? "Bean isn't attached to a core. The core is the part that chats, remembers, and runs your sprouts."
            : "The core is the part that chats, remembers, and runs your sprouts. Switching restarts Bean."}
        </p>
        {status.kind === "remote" && status.state !== "attached" ? (
          <div class="bean-cores-status" role="status">
            {status.state === "revoked" ? "Attached from another machine." : status.state === "mismatch" ? status.message
              : `Connecting to ${status.host}…${status.message ? ` ${status.message}` : ""}`}
            {status.command ? <>{" "}Run once in Terminal: <code class="bean-cores-command">{status.command}</code></> : null}
          </div>
        ) : null}
        <ul class="bean-cores-list">
          {listing?.canUseLocal ? (
            <li class="bean-cores-row">
              <span class="bean-cores-label">This Mac</span>
              {selected === "local" ? <span class="bean-cores-current">In use</span> : (
                <button class="bean-btn" disabled={switching !== undefined} onClick={() => use("local")}>
                  {switching === "local" ? "Restarting Bean…" : "Use this Mac"}
                </button>
              )}
            </li>
          ) : null}
          {listing?.cores.map((c) => (
            <li class="bean-cores-row" key={c.id}>
              <span class="bean-cores-label">{c.label}</span>
              {selected === c.id ? <span class="bean-cores-current">In use</span> : (
                <>
                  <button class="bean-btn" disabled={switching !== undefined} onClick={() => use(c.id)}>
                    {switching === c.id ? "Restarting Bean…" : "Use"}
                  </button>
                  <button class="bean-btn bean-btn--ghost" aria-label={`Remove ${c.label}`} onClick={() => void remove(c.id)}>Remove</button>
                </>
              )}
            </li>
          ))}
        </ul>
        <form class="bean-cores-add" onSubmit={(e) => void add(e)}>
          <input class="bean-input" aria-label="Host" placeholder="user@host" value={host}
            onInput={(e) => setHost((e.target as HTMLInputElement).value)} />
          <input class="bean-input" aria-label="Docker container (optional)" placeholder="container (optional)" value={container}
            onInput={(e) => setContainer((e.target as HTMLInputElement).value)} />
          <button class="bean-btn" type="submit" disabled={!host.trim()}>Add core</button>
        </form>
        {error ? <div class="bean-about-update-error">{error}</div> : null}
        <div class="bean-about-update-msg">Bean reaches it with <code>ssh &lt;host&gt; bean-core attach</code> — SSH keys only.</div>
      </div>
    </div>
  );
}
