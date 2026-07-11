import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Teams server bundle", () => {
  it("keeps ESM top-level await while giving CommonJS dependencies a real require()", () => {
    const config = readFileSync("esbuild.config.mjs", "utf8");

    expect(config).toContain('format: "esm"');
    expect(config).toContain('outfile: "dist/server.js"');
    expect(config).toContain("createRequire(import.meta.url)");
  });
});
