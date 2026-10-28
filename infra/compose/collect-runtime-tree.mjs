#!/usr/bin/env node
// RUNTIME-RELIABILITY-01: assemble the production runtime tree from an explicit
// allow-list. Anything not named here stays in the build stage, so repository
// control documents, task and evidence docs, Java sources, dev tooling and test
// sources cannot reach the final image. Deny-by-default: a new top-level path is
// absent from production until it is added to this list.
import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const [sourceRoot, targetRoot] = process.argv.slice(2);
if (!sourceRoot || !targetRoot) {
  console.error("usage: collect-runtime-tree.mjs <source-root> <target-root>");
  process.exit(2);
}

// pnpm resolves the workspace from these three, tsx runs the TypeScript sources
// directly (there is no compiled server bundle), and tsconfig.base.json carries
// the shared compiler options the per-package configs extend.
const ROOT_FILES = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.base.json"];

// Every path pnpm-workspace.yaml declares and pnpm-lock.yaml records as an
// importer must stay present, or the workspace graph no longer matches the
// lockfile. `infra/updater` is declared by the workspace globs but has no
// directory and no lockfile importer, so it is not collected.
const COPY_DIRS = ["apps", "packages", "prompts", "infra/sandboxes/supervisor"];

// No production package imports @rakazo/testkit and no package.json declares it;
// it is reached only through the root test scripts. Keep the manifest so the
// workspace graph still matches the lockfile, drop the harness sources.
const MANIFEST_ONLY = new Set(["packages/testkit"]);
const MANIFEST_ONLY_FILES = ["package.json", "tsconfig.json"];

// Test-only sources. Restricted to names that never carry runtime code in this
// repository; a runtime directory named `test` would be a review surprise, not
// something this list should silently tolerate.
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const TEST_DIR = new Set(["__fixtures__", "__tests__", "e2e"]);

function manifestOnlyOwner(relative) {
  for (const owner of MANIFEST_ONLY) {
    if (relative.startsWith(`${owner}/`)) return owner;
  }
  return null;
}

function isExcluded(absolute) {
  const relative = path.relative(sourceRoot, absolute);
  if (!relative || relative.startsWith("..")) return false;
  const posix = relative.split(path.sep).join("/");
  // Keep the manifest-only package directory itself, or the walk never descends
  // far enough to copy the manifest that keeps the lockfile importers matched.
  if (MANIFEST_ONLY.has(posix)) return false;
  if (posix.split("/").some((segment) => TEST_DIR.has(segment))) return true;
  const owner = manifestOnlyOwner(posix);
  if (owner) return !MANIFEST_ONLY_FILES.includes(path.basename(relative));
  return TEST_FILE.test(path.basename(relative));
}

mkdirSync(targetRoot, { recursive: true });

for (const file of ROOT_FILES) {
  const from = path.join(sourceRoot, file);
  if (!existsSync(from)) {
    console.error(`missing required runtime file: ${file}`);
    process.exit(1);
  }
  cpSync(from, path.join(targetRoot, file));
}

for (const dir of COPY_DIRS) {
  const from = path.join(sourceRoot, dir);
  if (!existsSync(from)) {
    console.error(`missing required runtime directory: ${dir}`);
    process.exit(1);
  }
  cpSync(from, path.join(targetRoot, dir), {
    recursive: true,
    // Workspace links are relative (../../../node_modules/.pnpm/...); keep them
    // as links so the copied tree resolves against the runtime node_modules.
    verbatimSymlinks: true,
    dereference: false,
    filter: (source) => !isExcluded(source),
  });
}

// Fail loudly rather than shipping an image that quietly lost its Prisma
// migrations, the generated client or the web bundle.
const REQUIRED = [
  "packages/db/prisma/schema.prisma",
  "packages/db/prisma/migrations",
  "apps/api/src/index.ts",
  "apps/worker/src/index.ts",
  "apps/web/dist",
  "infra/sandboxes/supervisor/package.json",
];
for (const required of REQUIRED) {
  if (!existsSync(path.join(targetRoot, required))) {
    console.error(`runtime tree is missing a required resource: ${required}`);
    process.exit(1);
  }
}

// The control documents the harness injects from the working directory must not
// survive into the runtime tree, whatever the build stage contained.
const FORBIDDEN = ["AGENTS.md", "CLAUDE.md", "docs", "services", "scripts", "biome.json"];
for (const forbidden of FORBIDDEN) {
  if (existsSync(path.join(targetRoot, forbidden))) {
    console.error(`runtime tree must not contain: ${forbidden}`);
    process.exit(1);
  }
}

console.log(`runtime tree assembled at ${targetRoot}`);
