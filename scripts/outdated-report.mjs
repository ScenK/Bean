#!/usr/bin/env node
// Groups `pnpm outdated -r` results by workspace package, labeling each bump major/minor/patch.
import { execSync } from "node:child_process";

function run() {
  try {
    return execSync("pnpm outdated -r --format json", { encoding: "utf8" });
  } catch (err) {
    // pnpm exits 1 when outdated deps exist; stdout still has the JSON.
    return err.stdout ?? "{}";
  }
}

function bumpKind(current, latest) {
  const [cMajor, cMinor] = current.split(".").map(Number);
  const [lMajor, lMinor] = latest.split(".").map(Number);
  if (lMajor > cMajor) return "major";
  if (lMinor > cMinor) return "minor";
  return "patch";
}

const data = JSON.parse(run() || "{}");
const byPackage = new Map();

for (const [name, info] of Object.entries(data)) {
  for (const dep of info.dependentPackages ?? [{ name: "<root>" }]) {
    if (!byPackage.has(dep.name)) byPackage.set(dep.name, []);
    byPackage.get(dep.name).push({ name, ...info });
  }
}

if (byPackage.size === 0) {
  console.log("Everything up to date across the workspace.");
  process.exit(0);
}

for (const [pkg, deps] of [...byPackage.entries()].sort()) {
  console.log(`\n${pkg}: ${deps.length} outdated`);
  for (const dep of deps.sort((a, b) => a.name.localeCompare(b.name))) {
    const kind = bumpKind(dep.current, dep.latest);
    console.log(`  ${dep.name.padEnd(24)} ${dep.current} => ${dep.latest}   ${kind}`);
  }
}
