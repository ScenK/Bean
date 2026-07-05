import { _electron as electron, type ElectronApplication } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url)); // packages/app/e2e/fixtures
const appRoot = join(here, "..", ".."); // packages/app
const mainJs = join(appRoot, "dist", "main.js");

/** Launches the real built Bean app. `env` typically supplies HOME (sandboxed ~/.bean) and
 * OPENAI_BASE_URL (stub server) — see bean-home.ts and stub-openai.ts. */
export async function launchBean(env: Record<string, string>): Promise<ElectronApplication> {
  return electron.launch({
    args: [mainJs],
    cwd: appRoot,
    env: { ...process.env, ...env },
  });
}
