import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

/** The installer drops the CLI in ~/bin, which the app's resolved PATH often misses. */
const installed = join(homedir(), "bin", "devtunnel");
const DEVTUNNEL = existsSync(installed) ? installed : "devtunnel";

export interface DevtunnelCreds { tenantId: string; clientId: string; secret: string; }
export type DevtunnelRun = (args: string[], env?: NodeJS.ProcessEnv) => Promise<void>;

const execFileAsync = promisify(execFile);
const run: DevtunnelRun = async (args, env) => {
  try {
    await execFileAsync(DEVTUNNEL, args, { env: { ...process.env, ...env } });
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr?.trim();
    throw new Error(`devtunnel ${args[0]} failed: ${stderr || (err as Error).message}`);
  }
};

/** Log in as the bot's own service principal (no browser, no session that expires — the
 * reason this exists: a `devtunnel user login` session lapses and silently takes the bot
 * offline), then make sure the named tunnel and its port exist. The secret travels via the env
 * var the CLI documents, never argv, so it stays out of `ps` and error messages. Each check is
 * independent so a half-provisioned tunnel (port create failed, or the port changed) heals on
 * the next start. Expiry is 30 days *unused* (sliding), so a hosted tunnel never lapses; one
 * that did is recreated, but with a new URL — the tunnel ID isn't part of it. */
export async function prepareDevtunnel(name: string, port: number, creds: DevtunnelCreds, exec: DevtunnelRun = run): Promise<void> {
  await exec(["user", "login", "--sp-tenant-id", creds.tenantId, "--sp-client-id", creds.clientId], { DEVTUNNELS_SP_SECRET: creds.secret });
  try {
    await exec(["show", name]);
  } catch {
    await exec(["create", name, "--allow-anonymous"]);
    console.error(`devtunnel: created tunnel ${name} — its URL is new, update the Azure Bot messaging endpoint`);
  }
  try {
    await exec(["port", "show", name, "-p", String(port)]);
  } catch {
    await exec(["port", "create", name, "-p", String(port)]);
  }
}

const MAX_HOST_FAILURES = 3;
const HOST_READY_TIMEOUT_MS = 60_000;

/** Spawn `devtunnel host`; resolves once it is forwarding, rejects if it exits (or stays silent
 * past HOST_READY_TIMEOUT_MS) before that. */
function hostOnce(name: string, onExit: (lastErr: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(DEVTUNNEL, ["host", name], { stdio: ["ignore", "pipe", "pipe"] });
    let lastErr = "";
    let ready = false;
    const timer = setTimeout(() => {
      if (ready) return;
      child.kill("SIGKILL"); // a silent host may also ignore SIGTERM
      reject(new Error(`devtunnel host failed: ${lastErr || "not ready in time"}`));
    }, HOST_READY_TIMEOUT_MS);
    // readline, not raw "data": a chunk boundary can split the ready line.
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (ready || !/connect via browser/i.test(line)) return;
      console.log(`devtunnel: ${line.trim()}`);
      // Tell the desktop app (Settings shows it); a no-op when run standalone.
      const url = /https:\/\/\S+/.exec(line)?.[0];
      if (url && process.send && process.connected) process.send({ type: "tunnel", url }, undefined, {}, () => {});
      ready = true;
      clearTimeout(timer);
      resolve();
    });
    child.stderr.on("data", (chunk: Buffer) => { lastErr = chunk.toString().trim() || lastErr; });
    const killHost = (): void => { child.kill(); };
    process.on("exit", killHost);
    // Spawn failure (no CLI) may never emit "exit", so reject here too; a settled promise ignores the repeat.
    child.on("error", (err) => { lastErr = err.message; if (!ready) { clearTimeout(timer); reject(new Error(`devtunnel host failed: ${err.message}`)); } });
    child.on("exit", (code) => {
      process.off("exit", killHost);
      clearTimeout(timer);
      const why = lastErr || `code ${code}`;
      if (ready) onExit(why);
      else reject(new Error(`devtunnel host failed: ${why}`));
    });
  });
}

/** Host the tunnel for as long as this server lives. Startup waits until the host is actually
 * forwarding, so a failure throws and Settings shows it. If a working host later dies (token
 * refresh, network), log in again and re-host rather than taking the bot down mid-run — but
 * after MAX_HOST_FAILURES straight failed re-hosts, exit so Settings stops claiming "running"
 * and the app's bounded retry takes over.
 * A previous server that was SIGKILLed can't run its exit hook, so any leftover host for this
 * tunnel is killed before starting ours. ponytail: until then the orphan only forwards to the
 * local port (Bot Framework JWT still gates it); a parent-liveness wrapper if that matters. */
export async function startDevtunnel(name: string, port: number, creds: DevtunnelCreds): Promise<void> {
  await execFileAsync("pkill", ["-f", `devtunnel host ${name}$`]).catch(() => { /* none running */ });
  await prepareDevtunnel(name, port, creds);
  let failures = 0;
  const onExit = (why: string): void => {
    console.error(`devtunnel host exited (${why}) — logging in again`);
    const retry = (): void => {
      setTimeout(() => {
        prepareDevtunnel(name, port, creds)
          .then(() => hostOnce(name, onExit))
          .then(() => { failures = 0; }, (err: Error) => {
            console.error(err.message);
            if (++failures >= MAX_HOST_FAILURES) process.exit(1);
            retry();
          });
      }, 5_000);
    };
    retry();
  };
  await hostOnce(name, onExit);
}
