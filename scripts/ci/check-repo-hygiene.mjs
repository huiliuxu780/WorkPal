#!/usr/bin/env node
/**
 * Repository hygiene gate: credential files, restricted paths, worktrees
 * nested inside the checkout, and unexpectedly large files.
 *
 * CI runs this on every event, so a clone without the local hook is still
 * blocked. `scripts/hooks/pre-commit` is a reminder, never the gate.
 *
 *   node scripts/ci/check-repo-hygiene.mjs                     # every tracked file
 *   node scripts/ci/check-repo-hygiene.mjs --staged            # git index (hook mode)
 *   node scripts/ci/check-repo-hygiene.mjs --base <sha> --head <sha>
 */
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const SIZE_LIMIT_BYTES = 1024 * 1024;
export const HARD_SIZE_LIMIT_BYTES = 5 * 1024 * 1024;

/**
 * Files already over SIZE_LIMIT_BYTES when this gate landed. Each entry is a
 * committed design/demo asset; new large files must be added here explicitly
 * with a reason instead of slipping through a global threshold. HARD_SIZE_LIMIT_BYTES
 * still applies to them, so the baseline cannot grow into multi-megabyte blobs.
 */
export const LARGE_FILE_BASELINE = new Map([
  ["docs/screenshots/demo.mp4", "recorded product demo referenced by README"],
  ["packages/ui-web/src/agent-avatar/assets/compare.gif", "avatar motion comparison asset"],
  ["docs/avatar/source/final/assets/compare.gif", "frozen avatar design evidence"],
  ["packages/ui-tokens/assets/Rakazo.icon/Assets/orange-bot.png", "iconset source asset"],
  ["bot-context-assembly.png", "README architecture diagram"],
]);

/** Paths that must not exist in a web-only product or inside the checkout. */
export const RESTRICTED_DIRS = [
  "apps/mobile",
  "apps/www",
  "apps/desktop",
  "node_modules",
  ".qoder/worktrees",
  ".codex/worktrees",
];

const ENV_FILE = /(?:^|\/)\.env(?:\..+)?$/;
const KEY_MATERIAL = /\.(?:pem|p12|pfx|keystore|jks)$/i;
const PRIVATE_KEY_NAMES = new Set(["id_rsa", "id_ed25519", "id_ecdsa", "id_dsa"]);

export function normalizePath(file) {
  return file.replaceAll("\\", "/").replace(/^\.\//, "");
}

function isUnder(file, dir) {
  const p = normalizePath(file);
  const d = normalizePath(dir);
  return p === d || p.startsWith(`${d}/`);
}

/**
 * Classify one tracked path. Pure so tests can drive it without a repository.
 * @returns {{ path: string, rule: string, message: string }[]}
 */
export function inspectEntry(entry) {
  const p = normalizePath(entry.path);
  const base = path.posix.basename(p);
  const violations = [];

  if (ENV_FILE.test(p) && !p.endsWith(".example")) {
    violations.push({
      path: p,
      rule: "credential-file",
      message: "environment file with credentials must stay untracked; commit a .example instead",
    });
  }

  if (KEY_MATERIAL.test(base) || PRIVATE_KEY_NAMES.has(base)) {
    violations.push({
      path: p,
      rule: "key-material",
      message: "private key or certificate material must not be committed",
    });
  }

  for (const dir of RESTRICTED_DIRS) {
    if (isUnder(p, dir)) {
      violations.push({
        path: p,
        rule: "restricted-path",
        message: `${dir}/ is restricted in this repository`,
      });
      break;
    }
  }

  const size = Number.isFinite(entry.size) ? entry.size : null;
  if (size !== null) {
    if (size > HARD_SIZE_LIMIT_BYTES) {
      violations.push({
        path: p,
        rule: "file-too-large",
        message: `${size} bytes exceeds the hard limit of ${HARD_SIZE_LIMIT_BYTES} bytes`,
      });
    } else if (size > SIZE_LIMIT_BYTES && !LARGE_FILE_BASELINE.has(p)) {
      violations.push({
        path: p,
        rule: "file-too-large",
        message:
          `${size} bytes exceeds ${SIZE_LIMIT_BYTES} bytes; add it to LARGE_FILE_BASELINE ` +
          "in scripts/ci/check-repo-hygiene.mjs with a reason, or shrink it",
      });
    }
  }

  return violations;
}

/**
 * A worktree nested inside the repository pollutes lint, the test inventory,
 * and CI path selection. Removal must go through `git worktree remove`.
 */
export function inspectWorktrees(worktreePaths, repoRoot) {
  const root = path.resolve(repoRoot);
  const violations = [];
  for (const entry of worktreePaths) {
    const resolved = path.resolve(entry);
    if (resolved === root) continue;
    if (resolved.startsWith(`${root}${path.sep}`)) {
      violations.push({
        path: path.relative(root, resolved) || resolved,
        rule: "nested-worktree",
        message:
          "worktree is nested inside the repository; create it outside the checkout and " +
          "remove it with `git worktree remove`",
      });
    }
  }
  return violations;
}

export function parseWorktreeList(porcelain) {
  const paths = [];
  for (const line of porcelain.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) paths.push(line.slice("worktree ".length).trim());
  }
  return paths;
}

function runGit(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function trackedPaths() {
  return runGit(["ls-files", "-z"])
    .split("\0")
    .filter(Boolean)
    .map((file) => {
      let size = null;
      try {
        size = statSync(file).size;
      } catch {
        size = null; // deleted in the working tree; size rule does not apply
      }
      return { path: file, size };
    });
}

function stagedPaths() {
  const files = runGit(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"])
    .split("\0")
    .filter(Boolean);
  return files.map((file) => {
    let size = null;
    try {
      size = statSync(file).size;
    } catch {
      size = null;
    }
    return { path: file, size };
  });
}

function diffPaths(base, head) {
  const files = runGit(["diff", "--name-only", "--diff-filter=ACMR", "-z", base, head])
    .split("\0")
    .filter(Boolean);
  return files.map((file) => {
    let size = null;
    try {
      size = Number(runGit(["cat-file", "-s", `${head}:${file}`]).trim());
    } catch {
      size = null;
    }
    return { path: file, size };
  });
}

export function collectEntries({ staged = false, base = null, head = null } = {}) {
  if (staged) return stagedPaths();
  if (base && head) return diffPaths(base, head);
  return trackedPaths();
}

export function checkRepoHygiene({ entries, worktreePaths, repoRoot }) {
  const violations = [];
  for (const entry of entries) violations.push(...inspectEntry(entry));
  violations.push(...inspectWorktrees(worktreePaths ?? [], repoRoot ?? "."));
  return { ok: violations.length === 0, violations };
}

export function formatReport(result) {
  if (result.ok) return "repository hygiene: no violations";
  const lines = [`repository hygiene: ${result.violations.length} violation(s)`];
  for (const v of result.violations) lines.push(`  [${v.rule}] ${v.path} — ${v.message}`);
  return lines.join("\n");
}

function parseArgs(argv) {
  const args = { staged: false, base: null, head: null, format: "text" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--staged") args.staged = true;
    else if (arg === "--base") args.base = argv[++i];
    else if (arg === "--head") args.head = argv[++i];
    else if (arg === "--format") args.format = argv[++i];
    else throw new Error(`unknown flag ${arg}`);
  }
  if ((args.base && !args.head) || (!args.base && args.head)) {
    throw new Error("--base and --head are both required");
  }
  return args;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const entries = collectEntries(args);
  const repoRoot = runGit(["rev-parse", "--show-toplevel"]).trim();
  const worktreePaths = parseWorktreeList(runGit(["worktree", "list", "--porcelain"]));
  const result = checkRepoHygiene({ entries, worktreePaths, repoRoot });
  if (args.format === "json") console.log(JSON.stringify(result, null, 2));
  else console.log(formatReport(result));
  process.exit(result.ok ? 0 : 1);
}

function isMainModule() {
  return (
    Boolean(process.argv[1]) &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  );
}

if (isMainModule()) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
