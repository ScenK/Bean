#!/usr/bin/env node
// Signs a release asset with the update's Ed25519 private key so Bean's updater can verify
// authenticity before installing (see
// docs/superpowers/specs/2026-07-14-manual-update-check-design.md and
// .memory/project-manual-update-check.md).
import { createPrivateKey, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const filePaths = process.argv.slice(2);
if (filePaths.length === 0) {
  console.error("usage: sign-release.mjs <file> [file...]");
  process.exit(1);
}

const privateKeyPem = process.env.UPDATE_ED_PRIVATE_KEY;
if (!privateKeyPem) {
  console.error("error: UPDATE_ED_PRIVATE_KEY env var is not set");
  process.exit(1);
}

const privateKey = createPrivateKey(privateKeyPem);
for (const filePath of filePaths) {
  const data = readFileSync(filePath);
  const signature = sign(null, data, privateKey);
  writeFileSync(`${filePath}.sig`, signature.toString("base64"), "utf8");
  console.log(`signed ${filePath} -> ${filePath}.sig`);
}
