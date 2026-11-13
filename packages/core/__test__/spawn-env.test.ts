// packages/core/__test__/spawn-env.test.ts
import { readFileSync, readdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { defaultDelegateSpawn } from "../src/delegate.js";
import { isPrivateAddress, safeFetch } from "../src/safe-fetch.js";
import { spawnEnv } from "../src/spawn-env.js";
import { execWatchCommand } from "../src/watch-io.js";

const SECRETS = { OPENAI_API_KEY: "sk-parent", DISCORD_TOKEN: "discord-parent" };

describe("spawnEnv", () => {
  afterEach(() => { for (const k of Object.keys(SECRETS)) delete process.env[k]; });

  it("keeps allowlisted names, drops everything else, and layers extra on top", () => {
    const env = spawnEnv({ PWD: "/w" }, { HOME: "/h", PATH: "/bin", CLAUDE_CODE_OAUTH_TOKEN: "t", ...SECRETS });
    expect(env).toEqual({ HOME: "/h", PATH: "/bin", CLAUDE_CODE_OAUTH_TOKEN: "t", PWD: "/w" });
  });

  it("a real delegate spawn and a watch command never see the parent's secrets", async () => {
    Object.assign(process.env, SECRETS);
    const child = defaultDelegateSpawn("/usr/bin/env", [], process.cwd());
    let out = "";
    child.stdout?.on("data", (c: Buffer) => { out += c.toString(); });
    await new Promise((r) => child.on("close", r));
    const watchOut = await execWatchCommand(process.env.PATH ?? "")("env");
    expect(out).toContain("GIT_AUTHOR_NAME=Bean");
    for (const text of [out, watchOut]) expect(text).not.toMatch(/OPENAI_API_KEY|DISCORD_TOKEN/);
  });

  it("no spawn site spreads the full process.env", () => {
    // Each package checks its own src (a test reads only its own package's files); see
    // spawn-env.test.ts in host, app, discord and teams.
    const dir = join(import.meta.dirname, "..", "src");
    const offenders = (readdirSync(dir, { recursive: true }) as string[])
      .filter((f) => f.endsWith(".ts") && readFileSync(join(dir, f), "utf8").includes("...process.env"));
    expect(offenders).toEqual([]);
  });
});

describe("safeFetch", () => {
  let server: Server;
  let port = 0;
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/to-metadata") { res.writeHead(302, { location: "http://169.254.169.254/latest" }); res.end(); return; }
      if (req.url === "/to-localhost") { res.writeHead(302, { location: `http://localhost:${port}/ok` }); res.end(); return; }
      if (req.url === "/big") { res.end("x".repeat(2048)); return; }
      res.end("hello");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => { server.close(); });

  const opts = { timeoutMs: 5_000, maxBytes: 1024 };
  // Pretend 127.0.0.1 is a public host so the server can play the "public URL" that redirects.
  const only127 = { ...opts, isBlocked: (a: string) => a !== "127.0.0.1" };

  it("classifies addresses", () => {
    for (const a of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:a9fe:a9fe"]) {
      expect(isPrivateAddress(a), a).toBe(true);
    }
    for (const a of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) expect(isPrivateAddress(a), a).toBe(false);
  });

  it("refuses metadata, loopback, and localhost by name", async () => {
    await expect(safeFetch("http://169.254.169.254/", opts)).rejects.toThrow(/refusing/);
    await expect(safeFetch(`http://127.0.0.1:${port}/`, opts)).rejects.toThrow(/refusing/);
    await expect(safeFetch(`http://[::1]:${port}/`, opts)).rejects.toThrow(/refusing/);
    await expect(safeFetch(`http://localhost:${port}/`, opts)).rejects.toThrow(/refusing/);
  });

  it("refuses a redirect to a private address, and a name with any private address", async () => {
    await expect(safeFetch(`http://127.0.0.1:${port}/to-metadata`, only127)).rejects.toThrow(/refusing/);
    await expect(safeFetch(`http://127.0.0.1:${port}/to-localhost`, { ...opts, isBlocked: () => false }))
      .resolves.toMatchObject({ ok: true, body: "hello" });
  });

  it("fetches an allowed address and caps the body", async () => {
    await expect(safeFetch(`http://127.0.0.1:${port}/`, only127)).resolves.toMatchObject({ ok: true, status: 200, body: "hello" });
    await expect(safeFetch(`http://127.0.0.1:${port}/big`, only127)).rejects.toThrow(/larger than/);
  });

  it("an aborted caller signal rejects; the private-address and size guards still hold with a signal", async () => {
    const signal = new AbortController().signal;
    await expect(safeFetch(`http://127.0.0.1:${port}/`, { ...only127, signal: AbortSignal.abort() })).rejects.toThrow(/abort/i);
    await expect(safeFetch(`http://127.0.0.1:${port}/`, { ...opts, signal })).rejects.toThrow(/refusing/);
    await expect(safeFetch(`http://127.0.0.1:${port}/to-metadata`, { ...only127, signal })).rejects.toThrow(/refusing/);
    await expect(safeFetch(`http://127.0.0.1:${port}/big`, { ...only127, signal })).rejects.toThrow(/larger than/);
    await expect(safeFetch(`http://127.0.0.1:${port}/`, { ...only127, signal })).resolves.toMatchObject({ body: "hello" });
  });
});
