import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** A core on another machine, reached over SSH (#811): `ssh <host> bean-core attach`, or through
 * `docker exec -i <container>` on that host. Never holds a key or password — SSH key auth only. */
export interface RemoteCore { id: string; host: string; container?: string }

/** Which core the shell runs against, in Electron userData (#810, #811): `"local"` = the in-process
 * core on this machine, a remote core's id, or `null` = none attached (boot shows Add a core). */
export interface CoreChoice { selected: string | null; cores: RemoteCore[] }

export function coreFile(userDataDir: string): string {
  return join(userDataDir, "cores.json");
}

// `[user@]host` — an ssh_config alias works too. No leading `-` (it would read as an ssh option) and
// no spaces or shell characters: the remote command line is joined by the remote shell.
const HOST = /^(?:[A-Za-z0-9_][A-Za-z0-9._-]*@)?[A-Za-z0-9][A-Za-z0-9.-]*$/;
// Docker's own container-name rule.
const CONTAINER = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** A user's `user@host` + optional container, checked; an error message when either is malformed. */
export function parseRemoteCore(host: unknown, container: unknown): Omit<RemoteCore, "id"> | { error: string } {
  const h = typeof host === "string" ? host.trim() : "";
  const c = typeof container === "string" ? container.trim() : "";
  if (h.length > 255 || !HOST.test(h)) return { error: "Enter the core's host as user@host (letters, digits, dots, dashes)." };
  if (c && (c.length > 128 || !CONTAINER.test(c))) return { error: "That isn't a valid Docker container name." };
  return c ? { host: h, container: c } : { host: h };
}

export const coreLabel = (c: Pick<RemoteCore, "host" | "container">): string => (c.container ? `${c.host} · ${c.container}` : c.host);

const isCore = (v: unknown): v is RemoteCore => {
  if (typeof v !== "object" || v === null) return false;
  const { id, host, container } = v as Record<string, unknown>;
  const parsed = parseRemoteCore(host, container);
  return typeof id === "string" && id.length > 0 && !("error" in parsed) && parsed.host === host && parsed.container === container;
};

/** No file (first run) or an unreadable one: a Mac runs its local core, as before; elsewhere none. A
 * selected id that names no saved core (removed, or written by a newer shell), or "local" off macOS, is
 * no core. Malformed
 * core entries are dropped. */
export async function loadCoreChoice(file: string, platform: NodeJS.Platform): Promise<CoreChoice> {
  try {
    const raw = JSON.parse(await readFile(file, "utf8")) as { selected?: unknown; cores?: unknown };
    const cores = Array.isArray(raw.cores) ? raw.cores.filter(isCore) : [];
    if (raw.selected !== undefined) {
      // Local is a macOS-only core: a cores.json carried to another OS falls back to no core.
      const local = raw.selected === "local" && platform === "darwin";
      const selected = local || cores.some((c) => c.id === raw.selected) ? raw.selected as string : null;
      return { selected, cores };
    }
    return { selected: platform === "darwin" ? "local" : null, cores };
  } catch { /* first run or corrupt: the default */ }
  return { selected: platform === "darwin" ? "local" : null, cores: [] };
}

export async function saveCoreChoice(file: string, choice: CoreChoice): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(choice), "utf8");
}

/** Adds a core (an identical one is reused) and returns it with the new choice; selection unchanged. */
export function addCore(choice: CoreChoice, core: Omit<RemoteCore, "id">): { choice: CoreChoice; core: RemoteCore } {
  const same = choice.cores.find((c) => c.host === core.host && c.container === core.container);
  if (same) return { choice, core: same };
  const added = { id: randomUUID(), ...core };
  return { choice: { ...choice, cores: [...choice.cores, added] }, core: added };
}

/** The ssh argv for a core: fixed (no shell on this side), key auth only, host keys checked. */
export function sshArgs(core: Pick<RemoteCore, "host" | "container">): string[] {
  const remote = core.container ? ["docker", "exec", "-i", core.container, "bean-core", "attach"] : ["bean-core", "attach"];
  return [
    "-T",
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    "-o", "ConnectTimeout=15",
    "--", core.host, ...remote,
  ];
}

/** The one-time command to run in a terminal when ssh can't attach unattended: it asks to accept the
 * host key and installs this machine's SSH key on the core host. Windows' OpenSSH has no ssh-copy-id,
 * so there it's the PowerShell equivalent (an existing ed25519 key; `ssh-keygen` makes one). */
export const oneTimeCommand = (core: Pick<RemoteCore, "host">, platform: NodeJS.Platform = process.platform): string =>
  platform === "win32"
    ? `type $env:USERPROFILE\\.ssh\\id_ed25519.pub | ssh ${core.host} "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"`
    : `ssh-copy-id ${core.host}`;
