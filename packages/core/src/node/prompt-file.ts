import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Shared prompt-file loader (MR-01 / AG-04).
 *
 * Default directory is `packages/core/src/prompts`. AG-04 can pass the
 * repo-root `prompts/` directory as `baseDir` without inventing a second
 * loader. `name` is a relative path; parent segments are rejected.
 */
const DEFAULT_PROMPTS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../prompts",
);

export function defaultPromptsDir(): string {
  return DEFAULT_PROMPTS_DIR;
}

export function loadPromptFile(name: string, baseDir = DEFAULT_PROMPTS_DIR): string {
  if (!name || name.includes("\0") || path.isAbsolute(name)) {
    throw new Error("prompt file name must be a relative path");
  }
  const root = path.resolve(baseDir);
  const resolved = path.resolve(root, name);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("prompt path escapes prompts directory");
  }
  return readFileSync(resolved, "utf8");
}
