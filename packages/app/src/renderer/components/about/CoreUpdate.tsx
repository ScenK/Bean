import { useEffect, useRef, useState } from "preact/hooks";
import type { CoreStatus } from "../../../channels.js";
import { useCoreStatus } from "../../shared/core-status.js";

// A remote core's own update (#838), beside the shell's: check → (busy list) → apply → the core
// restarts → on reattach the handshake says whether the new version is the one running.

/** How long a restarting core gets to come back before About says it didn't. */
export const CORE_RETURN_MS = 2 * 60_000;

type Phase =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "predates" }
  | { phase: "up-to-date" }
  | { phase: "available"; latest: string; busy: string[] }
  | { phase: "applying"; from: string }
  | { phase: "updated"; version: string }
  | { phase: "still"; version: string }
  | { phase: "gone"; from: string }
  | { phase: "error"; message: string };

/** An older core answers an op it doesn't know with "<op> is not allowed over a remote attach". */
const predates = (err: unknown): boolean => err instanceof Error && err.message.includes("is not allowed over a remote attach");
const errorText = (err: unknown): string => (err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']*': (Error: )?/, "") : "The core didn't answer.");

/** "delegate a", "delegate b", "sprout X" → "2 delegates, sprout X". */
export function busySummary(busy: readonly string[]): string {
  const kinds = new Map<string, string[]>();
  for (const b of busy) {
    const kind = b.split(" ", 1)[0]!;
    kinds.set(kind, [...(kinds.get(kind) ?? []), b]);
  }
  return [...kinds].map(([kind, items]) => (items.length > 1 ? `${items.length} ${kind}s` : items[0]!)).join(", ");
}

export function CoreUpdate() {
  const status = useCoreStatus();
  if (status.kind !== "remote") return null; // a local core updates with the app
  return <RemoteCoreUpdate status={status} />;
}

function RemoteCoreUpdate({ status }: { status: Extract<CoreStatus, { kind: "remote" }> }) {
  const [version, setVersion] = useState<string | undefined>(undefined);
  const [p, setP] = useState<Phase>({ phase: "idle" });
  const dropped = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const attached = status.state === "attached";

  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!attached) {
      dropped.current = true;
      return;
    }
    void window.bean.handshake().then((h) => {
      setVersion(h.core);
      // Back after an update: the handshake names the version that's running now.
      setP((cur) => {
        if ((cur.phase !== "applying" && cur.phase !== "gone") || !dropped.current) return cur;
        clearTimeout(timer.current);
        return h.core !== cur.from ? { phase: "updated", version: h.core } : { phase: "still", version: h.core };
      });
    }, () => {});
  }, [attached]);

  const check = async (): Promise<void> => {
    setP({ phase: "checking" });
    try {
      const s = await window.bean.coreUpdateStatus();
      setVersion(s.current);
      if (s.error) setP({ phase: "error", message: s.error });
      else setP(s.latest ? { phase: "available", latest: s.latest, busy: s.busy } : { phase: "up-to-date" });
    } catch (err) {
      setP(predates(err) ? { phase: "predates" } : { phase: "error", message: errorText(err) });
    }
  };

  const apply = async (force: boolean, latest: string): Promise<void> => {
    const from = version ?? "";
    setP({ phase: "applying", from });
    dropped.current = false;
    try {
      const r = await window.bean.coreUpdateApply(force);
      if (r.status === "updated") {
        timer.current = setTimeout(() => setP((cur) => (cur.phase === "applying" ? { phase: "gone", from: cur.from } : cur)), CORE_RETURN_MS);
      } else if (r.status === "busy") setP({ phase: "available", latest, busy: r.busy });
      else if (r.status === "up-to-date") setP({ phase: "up-to-date" });
      else setP({ phase: "error", message: r.message });
    } catch (err) {
      setP(predates(err) ? { phase: "predates" } : { phase: "error", message: errorText(err) });
    }
  };

  const command = (cmd: string) => <code class="bean-cores-command">{cmd}</code>;
  const again = <button class="bean-btn bean-btn--ghost" onClick={check} disabled={!attached}>Check again</button>;

  return (
    <div class="bean-about-update bean-about-core">
      <div class="bean-about-version">Core on {status.host}{version ? ` · v${version}` : ""}</div>
      {status.state === "mismatch" && status.command ? (
        <div class="bean-cores-status">Update the core from a terminal: {command(status.command)}</div>
      ) : null}
      {p.phase === "idle" && <button class="bean-btn" onClick={check} disabled={!attached}>Check core for updates</button>}
      {p.phase === "checking" && <button class="bean-btn" disabled>Checking the core…</button>}
      {p.phase === "predates" && (
        <><div class="bean-about-update-msg">This core predates remote update — run install.sh on it once.</div>{again}</>
      )}
      {p.phase === "up-to-date" && (<><div class="bean-about-update-msg">The core is up to date.</div>{again}</>)}
      {p.phase === "available" && (
        <>
          <div class="bean-about-update-msg">Core version {p.latest} is available.</div>
          {p.busy.length === 0 ? (
            <button class="bean-btn" onClick={() => apply(false, p.latest)} disabled={!attached}>Update core</button>
          ) : (
            <>
              <div class="bean-about-update-msg bean-about-core-busy">Running on the core: {busySummary(p.busy)}</div>
              <button class="bean-btn" onClick={() => apply(true, p.latest)} disabled={!attached}>Stop them and update</button>
              <button class="bean-btn bean-btn--ghost" onClick={() => setP({ phase: "idle" })}>Not now</button>
            </>
          )}
        </>
      )}
      {p.phase === "applying" && <button class="bean-btn" disabled>Restarting core…</button>}
      {p.phase === "updated" && (<><div class="bean-about-update-msg">Core updated to v{p.version}.</div>{again}</>)}
      {p.phase === "still" && (
        <>
          <div class="bean-about-update-error">Core still on v{p.version}.</div>
          <button class="bean-btn bean-btn--ghost" onClick={check} disabled={!attached}>Retry</button>
        </>
      )}
      {p.phase === "gone" && (
        <>
          <div class="bean-about-update-error">Core didn't come back after updating.</div>
          {status.cli ? <div class="bean-cores-status">Roll it back from a terminal: {command(`${status.cli} bean-core rollback`)}</div> : null}
        </>
      )}
      {p.phase === "error" && (
        <>
          <div class="bean-about-update-error">{p.message}</div>
          <button class="bean-btn bean-btn--ghost" onClick={check} disabled={!attached}>Retry</button>
        </>
      )}
    </div>
  );
}
