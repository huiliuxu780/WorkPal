#!/usr/bin/env node
/**
 * Installs the local pre-commit reminder for the current checkout. The hook is
 * a convenience; `scripts/ci/check-repo-hygiene.mjs` in CI is the gate.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

function git(args, cwd) {
  return execFileSync("git", args, { encoding: "utf8", cwd }).trim();
}

const repoRoot = git(["rev-parse", "--show-toplevel"]);
const hooksDir = path.resolve(repoRoot, git(["rev-parse", "--git-path", "hooks"], repoRoot));
const source = path.join(repoRoot, "scripts", "hooks", "pre-commit");

if (!existsSync(source)) {
  console.error(`missing hook source ${path.relative(repoRoot, source)}`);
  process.exit(1);
}

mkdirSync(hooksDir, { recursive: true });
const target = path.join(hooksDir, "pre-commit");
if (existsSync(target)) {
  const existing = readFileSync(target, "utf8");
  if (!existing.includes("check-repo-hygiene.mjs")) {
    console.error(
      `${path.relative(repoRoot, target)} already exists and is not the WorkPal hygiene hook; ` +
        "resolve it manually instead of letting this script overwrite it",
    );
    process.exit(1);
  }
}

copyFileSync(source, target);
chmodSync(target, 0o755);
console.log(`installed pre-commit hook at ${path.relative(repoRoot, target)}`);
