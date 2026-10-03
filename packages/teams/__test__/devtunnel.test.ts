import { expect, test } from "vitest";
import { prepareDevtunnel, type DevtunnelRun } from "../src/devtunnel.js";

const creds = { tenantId: "tid", clientId: "cid", secret: "s3cret" };

function recorder(missing: boolean) {
  const calls: { args: string[]; env?: NodeJS.ProcessEnv }[] = [];
  const run: DevtunnelRun = async (args, env) => {
    calls.push({ args, env });
    if (missing && args.includes("show")) throw new Error("not found");
  };
  return { calls, run };
}

test("logs in as the service principal with the secret in env, never argv", async () => {
  const { calls, run } = recorder(false);
  await prepareDevtunnel("bean-teams", 3978, creds, run);
  expect(calls[0]).toEqual({
    args: ["user", "login", "--sp-tenant-id", "tid", "--sp-client-id", "cid"],
    env: { DEVTUNNELS_SP_SECRET: "s3cret" },
  });
  expect(calls.flatMap((c) => c.args)).not.toContain("s3cret");
});

test("an existing tunnel and port are reused as-is", async () => {
  const { calls, run } = recorder(false);
  await prepareDevtunnel("bean-teams", 3978, creds, run);
  expect(calls.slice(1).map((c) => c.args)).toEqual([["show", "bean-teams"], ["port", "show", "bean-teams", "-p", "3978"]]);
});

test("a tunnel that exists but lacks the port gets the port added", async () => {
  const calls: string[][] = [];
  await prepareDevtunnel("bean-teams", 3978, creds, async (args) => {
    calls.push(args);
    if (args[0] === "port" && args[1] === "show") throw new Error("not found");
  });
  expect(calls.slice(1)).toEqual([
    ["show", "bean-teams"],
    ["port", "show", "bean-teams", "-p", "3978"],
    ["port", "create", "bean-teams", "-p", "3978"],
  ]);
});

test("a missing (or expired) tunnel is recreated with its port", async () => {
  const { calls, run } = recorder(true);
  await prepareDevtunnel("bean-teams", 3978, creds, run);
  expect(calls.slice(1).map((c) => c.args)).toEqual([
    ["show", "bean-teams"],
    ["create", "bean-teams", "--allow-anonymous"],
    ["port", "show", "bean-teams", "-p", "3978"],
    ["port", "create", "bean-teams", "-p", "3978"],
  ]);
});
