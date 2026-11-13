import { expect, test } from "vitest";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { compareVersions, checkForUpdate, checkForCoreUpdate, checkCorePreflight, verifyUpdateSignature } from "../src/updater.js";
import type { GithubReleaseInfo } from "../src/updater.js";

test("compareVersions orders by major, then minor, then patch", () => {
  expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  expect(compareVersions("1.2.0", "1.1.9")).toBeGreaterThan(0);
  expect(compareVersions("1.1.9", "1.2.0")).toBeLessThan(0);
  expect(compareVersions("2.0.0", "1.99.99")).toBeGreaterThan(0);
});

test("compareVersions strips a leading v", () => {
  expect(compareVersions("v0.8.13", "0.8.12")).toBeGreaterThan(0);
  expect(compareVersions("0.8.12", "v0.8.12")).toBe(0);
});

function release(overrides: Partial<GithubReleaseInfo> = {}): GithubReleaseInfo {
  return {
    tagName: "v0.8.13",
    body: "## What's Changed\n* fix: something",
    assets: [
      { name: "Bean-0.8.13-arm64-mac.zip", browserDownloadUrl: "https://example.com/zip" },
      { name: "Bean-0.8.13-arm64-mac.zip.sig", browserDownloadUrl: "https://example.com/sig" },
      { name: "Bean-0.8.13-arm64.dmg", browserDownloadUrl: "https://example.com/dmg" },
    ],
    ...overrides,
  };
}

test("checkForUpdate reports up-to-date when the release isn't newer", () => {
  expect(checkForUpdate("0.8.13", release())).toEqual({ status: "up-to-date" });
  expect(checkForUpdate("0.8.14", release())).toEqual({ status: "up-to-date" });
});

test("checkForUpdate reports the zip+sig asset URLs when a newer release exists", () => {
  expect(checkForUpdate("0.8.12", release())).toEqual({
    status: "available",
    version: "0.8.13",
    notes: "## What's Changed\n* fix: something",
    zipUrl: "https://example.com/zip",
    sigUrl: "https://example.com/sig",
  });
});

test("checkForUpdate ignores the bean-core tarball attached to the same release", () => {
  const r = release();
  r.assets.unshift(
    { name: "bean-core-0.8.13.tar.gz", browserDownloadUrl: "https://example.com/core" },
    { name: "bean-core-0.8.13.tar.gz.sig", browserDownloadUrl: "https://example.com/core-sig" },
  );
  expect(checkForUpdate("0.8.12", r)).toMatchObject({ zipUrl: "https://example.com/zip", sigUrl: "https://example.com/sig" });
});

test("checkForUpdate errors when the release has no arm64 mac zip asset", () => {
  const r = release({ assets: [{ name: "Bean-0.8.13-arm64.dmg", browserDownloadUrl: "https://example.com/dmg" }] });
  expect(checkForUpdate("0.8.12", r)).toEqual({
    status: "error",
    message: "Release v0.8.13 has no arm64 mac zip asset.",
  });
});

test("checkForUpdate errors when the zip has no matching .sig asset", () => {
  const r = release({ assets: [{ name: "Bean-0.8.13-arm64-mac.zip", browserDownloadUrl: "https://example.com/zip" }] });
  expect(checkForUpdate("0.8.12", r)).toEqual({
    status: "error",
    message: "Release v0.8.13 is missing its update signature.",
  });
});

function testKeypair() {
  return generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
}

test("verifyUpdateSignature accepts a signature made with the matching private key", () => {
  const { publicKey, privateKey } = testKeypair();
  const data = Buffer.from("Bean update payload");
  const signature = cryptoSign(null, data, privateKey).toString("base64");
  expect(verifyUpdateSignature(data, signature, publicKey)).toBe(true);
});

test("verifyUpdateSignature rejects a signature made with a different private key", () => {
  const { publicKey } = testKeypair();
  const { privateKey: otherPrivateKey } = testKeypair();
  const data = Buffer.from("Bean update payload");
  const signature = cryptoSign(null, data, otherPrivateKey).toString("base64");
  expect(verifyUpdateSignature(data, signature, publicKey)).toBe(false);
});

test("verifyUpdateSignature rejects tampered data", () => {
  const { publicKey, privateKey } = testKeypair();
  const signature = cryptoSign(null, Buffer.from("original"), privateKey).toString("base64");
  expect(verifyUpdateSignature(Buffer.from("tampered"), signature, publicKey)).toBe(false);
});

test("verifyUpdateSignature returns false instead of throwing on a malformed public key", () => {
  expect(verifyUpdateSignature(Buffer.from("x"), "not-base64!!", "not a pem key")).toBe(false);
});

test("checkForCoreUpdate picks the bean-core tarball and its signature (#837)", () => {
  const r = release({
    assets: [
      ...release().assets,
      { name: "bean-core-0.8.13.tar.gz", browserDownloadUrl: "https://example.com/core" },
      { name: "bean-core-0.8.13.tar.gz.sig", browserDownloadUrl: "https://example.com/core-sig" },
    ],
  });
  expect(checkForCoreUpdate("0.8.12", r)).toEqual({ status: "available", version: "0.8.13", tarUrl: "https://example.com/core", sigUrl: "https://example.com/core-sig" });
  expect(checkForCoreUpdate("0.8.13", r)).toEqual({ status: "up-to-date", version: "0.8.13" });
  expect(checkForCoreUpdate("0.9.0", r)).toEqual({ status: "up-to-date", version: "0.8.13" });
});

test("checkForCoreUpdate refuses a release without the tarball or its signature, or with an unsafe tag", () => {
  expect(checkForCoreUpdate("0.8.12", release())).toMatchObject({ status: "error", message: expect.stringContaining("bean-core-0.8.13.tar.gz") });
  const noSig = release({ assets: [{ name: "bean-core-0.8.13.tar.gz", browserDownloadUrl: "https://example.com/core" }] });
  expect(checkForCoreUpdate("0.8.12", noSig)).toMatchObject({ status: "error", message: expect.stringContaining(".sig") });
  for (const tagName of ["v../../x", "..", "1.0/2"]) expect(checkForCoreUpdate("0.0.1", release({ tagName }))).toMatchObject({ status: "error" });
});

test("checkCorePreflight wants the promised version, and the same contract only when asked", () => {
  expect(checkCorePreflight("bean-core 0.8.13 contract 1\n", { version: "0.8.13", contract: 1 })).toBeUndefined();
  expect(checkCorePreflight("bean-core 0.8.13 contract 2\n", { version: "0.8.13" })).toBeUndefined();
  expect(checkCorePreflight("bean-core 0.8.13 contract 2", { version: "0.8.13", contract: 1 })).toMatch(/contract v2/);
  expect(checkCorePreflight("bean-core 0.8.12 contract 1", { version: "0.8.13" })).toMatch(/0\.8\.12, not 0\.8\.13/);
  expect(checkCorePreflight("Error: boom", { version: "0.8.13" })).toMatch(/printed "Error: boom"/);
});
