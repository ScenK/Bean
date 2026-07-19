import { chmod, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface BeanHome {
  homeDir: string;
  projectPath: string;
  cleanup: () => Promise<void>;
}

interface BeanHomeOptions {
  disabledClis?: string[];
}

/**
 * Creates a throwaway `~/.bean` fixture: a fake config + one fixture project. No skill fixture
 * files are needed — main.ts also layers in the repo's own `.bean/skills/*.md` as "builtin"
 * skills regardless of HOME, and those already include both a `target: chat` skill
 * (draft-reply) and a `target: terminal` skill (review-pr) for the proposal-flow tests.
 */
export async function makeBeanHome(options: BeanHomeOptions = {}): Promise<BeanHome> {
  const homeDir = await mkdtemp(join(tmpdir(), "bean-e2e-home-"));
  const projectPath = await mkdtemp(join(tmpdir(), "bean-e2e-project-"));
  const beanDir = join(homeDir, ".bean");
  await mkdir(beanDir, { recursive: true });
  await writeFile(
    join(beanDir, "config.json"),
    JSON.stringify({
      openaiApiKey: "sk-test-fixture",
      model: "gpt-4o-mini",
      disabledClis: options.disabledClis ?? [],
    }, null, 2),
    "utf8",
  );
  await writeFile(
    join(beanDir, "projects.json"),
    JSON.stringify([{ name: "demo", path: projectPath }], null, 2),
    "utf8",
  );
  return {
    homeDir,
    projectPath,
    cleanup: async () => {
      await rm(homeDir, { recursive: true, force: true });
      await rm(projectPath, { recursive: true, force: true });
    },
  };
}

/** Install a harmless executable in this fixture's HOME and return its bin directory. Tests
 * prepend the result to PATH so CLI detection never depends on tools installed on the host. */
export async function installFakeCli(homeDir: string, cli: "opencode" | "claude" | "codex"): Promise<string> {
  const binDir = join(homeDir, "fake-bin");
  await mkdir(binDir, { recursive: true });
  const executable = join(binDir, cli);
  await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(executable, 0o755);
  return binDir;
}
