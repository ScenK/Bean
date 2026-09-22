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
  // A few finished runs — two of the same routine on one local day, one on an earlier day, plus
  // a second routine — so the Dashboard rail renders its real routine/day grouping and its
  // cards, not the empty state.
  const routinesPath = join(beanDir, "routines");
  await mkdir(routinesPath, { recursive: true });
  const routine = (name: string, cron: string) => ({
    name, enabled: true, cron, steps: [{ kind: "chat", instruction: "check the build" }], sinks: {},
  });
  await writeFile(join(routinesPath, "nightly.json"), JSON.stringify(routine("nightly", "0 22 * * *"), null, 2), "utf8");
  await writeFile(join(routinesPath, "weekly.json"), JSON.stringify(routine("weekly", "0 8 * * 1"), null, 2), "utf8");
  const run = (startedAt: string, finishedAt: string, ok: boolean) => ({
    startedAt,
    finishedAt,
    status: ok ? "ok" : "failed",
    digest: "## Digest\n\nWhat happened overnight.",
    steps: ok
      ? [{ kind: "chat", ok: true, summary: "build red then green on retry" }]
      : [
          { kind: "chat", ok: true, summary: "build red then green on retry" },
          { kind: "chat", ok: false, summary: "dependency scan could not reach the registry" },
        ],
  });
  await writeFile(
    join(routinesPath, ".state.json"),
    JSON.stringify({
      // Midday UTC so the two Jan 2 runs stay on one *local* day in any plausible TZ — the
      // Dashboard buckets by local date, and a fixture that split them would never render the
      // multi-run spine this is here to cover.
      nightly: {
        lastRun: "2026-01-02T20:00:00.000Z",
        history: [
          run("2026-01-02T20:00:00.000Z", "2026-01-02T20:45:00.000Z", false),
          run("2026-01-02T14:00:00.000Z", "2026-01-02T14:30:00.000Z", true),
          run("2026-01-01T14:00:00.000Z", "2026-01-01T14:30:00.000Z", true),
        ],
      },
      weekly: {
        lastRun: "2026-01-01T15:00:00.000Z",
        history: [run("2026-01-01T15:00:00.000Z", "2026-01-01T15:30:00.000Z", true)],
      },
    }, null, 2),
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
