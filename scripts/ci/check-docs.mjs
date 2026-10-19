#!/usr/bin/env node
/**
 * Lightweight docs check: no pnpm install, no database, no image build.
 * Verifies relative markdown links exist. Used by the docs CI job.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LINK_RE = /\[[^\]]*\]\(([^)]+)\)/g;
const SKIP_HREF = /^(https?:|mailto:|tel:|#|data:)/i;

export function extractRelativeTargets(markdown) {
  const targets = [];
  for (const match of markdown.matchAll(LINK_RE)) {
    const href = match[1].trim().replace(/^<|>$/g, "");
    if (!href || SKIP_HREF.test(href)) continue;
    const [filePart] = href.split("#");
    if (!filePart) continue;
    targets.push(filePart);
  }
  return targets;
}

export function checkMarkdownFile(repoRoot, file) {
  const abs = path.join(repoRoot, file);
  if (!existsSync(abs)) return [`missing markdown file ${file}`];
  const markdown = readFileSync(abs, "utf8");
  const errors = [];
  for (const target of extractRelativeTargets(markdown)) {
    if (target.startsWith("/")) {
      errors.push(`${file}: absolute link ${target} (use a repo-relative path)`);
      continue;
    }
    const resolved = path.normalize(path.join(path.dirname(abs), target));
    if (!resolved.startsWith(path.normalize(repoRoot))) {
      errors.push(`${file}: link escapes the repo (${target})`);
      continue;
    }
    if (!existsSync(resolved)) {
      errors.push(`${file}: broken relative link ${target}`);
    }
  }
  return errors;
}

export function listMarkdown(repoRoot, roots = ["docs"]) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const abs = path.join(dir, entry);
      const rel = path.relative(repoRoot, abs);
      if (statSync(abs).isDirectory()) {
        if (entry === "node_modules" || entry === ".git") continue;
        walk(abs);
      } else if (/\.(md|markdown)$/i.test(entry)) {
        files.push(rel);
      }
    }
  };
  for (const root of roots) {
    const abs = path.join(repoRoot, root);
    if (existsSync(abs) && statSync(abs).isDirectory()) walk(abs);
    else if (existsSync(abs)) files.push(root);
  }
  for (const name of ["README.md", "CHANGELOG.md", "CONTRIBUTING.md", "AGENTS.md", "SECURITY.md", "VISION.md"]) {
    if (existsSync(path.join(repoRoot, name))) files.push(name);
  }
  return [...new Set(files)];
}

export function checkDocs(repoRoot, files) {
  const errors = [];
  for (const file of files) {
    if (!/\.(md|markdown)$/i.test(file)) continue;
    errors.push(...checkMarkdownFile(repoRoot, file));
  }
  return errors;
}

function filesFromSelectResult(env, repoRoot) {
  if (!env.SELECT_RESULT) return listMarkdown(repoRoot);
  const parsed = JSON.parse(env.SELECT_RESULT);
  const files = (parsed.files ?? []).filter((file) => /\.(md|markdown)$/i.test(file));
  if (parsed.mode === "full" || files.length === 0) return listMarkdown(repoRoot);
  return files;
}

function parseFiles(argv, repoRoot, env = process.env) {
  const explicit = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--files") continue;
    else if (argv[i] === "--from-select") return filesFromSelectResult(env, repoRoot);
    else if (argv[i] === "--all") return listMarkdown(repoRoot);
    else if (!argv[i].startsWith("-")) explicit.push(argv[i]);
  }
  return explicit.length ? explicit : listMarkdown(repoRoot);
}

function isMainModule() {
  return Boolean(process.argv[1]) && process.argv[1].replaceAll("\\", "/").endsWith("check-docs.mjs");
}

if (isMainModule()) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const files = parseFiles(process.argv.slice(2), repoRoot);
  if (files.length === 0) {
    console.log("No markdown files to check.");
    process.exit(0);
  }
  const errors = checkDocs(repoRoot, files);
  if (errors.length) {
    for (const error of errors) console.error(error);
    process.exit(1);
  }
  console.log(`Checked ${files.length} markdown file(s); relative links ok.`);
}
