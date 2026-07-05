import { _electron as electron, type ElectronApplication } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url)); // packages/app/e2e/fixtures
const appRoot = join(here, "..", ".."); // packages/app
const mainJs = join(appRoot, "dist", "main.js");

/** Launches the real built Bean app. `env` typically supplies HOME (sandboxed ~/.bean) and
 * OPENAI_BASE_URL (stub server) — see bean-home.ts and stub-openai.ts.
 *
 * Each launch gets its own `--user-data-dir`, isolating Electron's SingletonLock (and other
 * userData) per test run — HOME alone isolates `~/.bean` but not Electron's own lock file,
 * which is resolved via native OS path APIs and would otherwise collide across parallel
 * workers. The temp dir is removed once the caller's `app.close()` resolves. */
export async function launchBean(env: Record<string, string>): Promise<ElectronApplication> {
  const userDataDir = await mkdtemp(join(tmpdir(), "bean-e2e-userdata-"));
  const app = await electron.launch({
    args: [mainJs, `--user-data-dir=${userDataDir}`],
    cwd: appRoot,
    env: { ...process.env, ...env },
  });
  const originalClose = app.close.bind(app);
  app.close = async () => {
    try {
      await originalClose();
    } finally {
      await rm(userDataDir, { recursive: true, force: true });
    }
  };
  return app;
}
