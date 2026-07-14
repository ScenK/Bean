#!/usr/bin/env node
// Signs a release asset with the update's Ed25519 private key so Bean's updater can verify
// authenticity before installing (see
// docs/superpowers/specs/2026-07-14-manual-update-check-design.md and
// .memory/project-manual-update-check.md).
import { createPrivateKey, sign, generateKeyPairSync } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";

// A hand-pasted-into-GitHub-Secrets PEM is easy to mangle: a literal "\n" typed instead of
// a real line break (very easy to do when copying multi-line console.log output through an
// intermediate step) is the single most common cause of Node/OpenSSL's opaque
// "DECODER routines::unsupported" error here. Real PEMs always contain a real newline, so
// converting literal "\n" -> real newline only ever fires on already-broken input — it's a
// no-op for a correctly-pasted key.
export function normalizePem(raw) {
  let pem = raw.replace(/\r\n/g, "\n").trim();
  if (!pem.includes("\n") && pem.includes("\\n")) pem = pem.replace(/\\n/g, "\n");
  return `${pem}\n`;
}

export function loadEd25519PrivateKey(raw) {
  const pem = normalizePem(raw);
  if (!pem.startsWith("-----BEGIN PRIVATE KEY-----")) {
    throw new Error(
      `doesn't look like a PKCS8 private key PEM (starts with ${JSON.stringify(pem.slice(0, 27))}). ` +
      `Did you paste the PUBLIC key by mistake? Re-copy the "PRIVATE KEY" block from ` +
      `generateKeyPairSync()'s output, including the BEGIN/END lines.`,
    );
  }
  let key;
  try {
    key = createPrivateKey(pem);
  } catch (err) {
    throw new Error(`couldn't parse as a private key (${err.message}). Re-paste the secret fresh — don't hand-edit it.`);
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(`key is ${key.asymmetricKeyType}, not ed25519.`);
  }
  return key;
}

// ponytail: no test framework wired for this script — a self-check flag is the one
// runnable check for normalizePem/loadEd25519PrivateKey's branching logic.
function selfCheck() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  assert.equal(loadEd25519PrivateKey(privateKey).asymmetricKeyType, "ed25519", "well-formed key parses");
  assert.equal(
    loadEd25519PrivateKey(privateKey.trim().replace(/\n/g, "\\n")).asymmetricKeyType,
    "ed25519",
    "literal backslash-n is normalized",
  );
  assert.equal(
    loadEd25519PrivateKey(privateKey.replace(/\n/g, "\r\n")).asymmetricKeyType,
    "ed25519",
    "CRLF is normalized",
  );
  assert.throws(() => loadEd25519PrivateKey(publicKey), /doesn't look like a PKCS8 private key/, "public key is rejected clearly");
  console.log("self-check OK");
}

if (process.argv[2] === "--self-check") {
  selfCheck();
  process.exit(0);
}

const filePaths = process.argv.slice(2);
if (filePaths.length === 0) {
  console.error("usage: sign-release.mjs <file> [file...]");
  process.exit(1);
}

const rawKey = process.env.UPDATE_ED_PRIVATE_KEY;
if (!rawKey) {
  console.error("error: UPDATE_ED_PRIVATE_KEY env var is not set");
  process.exit(1);
}

let privateKey;
try {
  privateKey = loadEd25519PrivateKey(rawKey);
} catch (err) {
  console.error(`error: UPDATE_ED_PRIVATE_KEY ${err.message}`);
  process.exit(1);
}

for (const filePath of filePaths) {
  const data = readFileSync(filePath);
  const signature = sign(null, data, privateKey);
  writeFileSync(`${filePath}.sig`, signature.toString("base64"), "utf8");
  console.log(`signed ${filePath} -> ${filePath}.sig`);
}
