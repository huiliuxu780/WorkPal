#!/usr/bin/env node
/**
 * AG-04 generator: the prompts/ Markdown tree → packages/core/src/prompt-texts.generated.ts
 *
 * The Markdown files under /prompts are the ONLY editing surface for fixed
 * prompt text. This script inlines them as typed constants so every TS package
 * (including web-imported @rakazo/core modules) loads prompt text with no
 * filesystem access and no cwd assumptions. The generated file is committed
 * and CI fails when regeneration produces a diff — it is never a second
 * editing entry. Java loads the same files as classpath resources packaged by
 * Maven (see services/agent-runtime/pom.xml `prompts.source.dir`).
 *
 * Text contract: a segment's value is the file content minus exactly ONE
 * trailing newline (files end with a single \n). Internal newlines and all
 * other bytes are preserved verbatim. The Java loader applies the same rule.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const promptsDir = join(repoRoot, "prompts");
const outFile = join(repoRoot, "packages", "core", "src", "prompt-texts.generated.ts");

function collect(dir) {
  const out = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collect(full));
    else if (entry.endsWith(".md") && entry !== "README.md") out.push(full);
  }
  return out;
}

const files = collect(promptsDir);
if (files.length === 0) throw new Error("no prompt segment files found under prompts/");

const entries = files.map((file) => {
  const id = relative(promptsDir, file).replace(/\.md$/, "").split(join("/")).join("/");
  let text = readFileSync(file, "utf8");
  if (text.endsWith("\r\n")) throw new Error(`${id}: CRLF line endings are not allowed`);
  if (!text.endsWith("\n")) throw new Error(`${id}: segment file must end with exactly one newline`);
  text = text.slice(0, -1);
  if (text.endsWith("\n")) throw new Error(`${id}: segment file must not end with a blank line`);
  return [id.split("\\").join("/"), text];
});

const ids = entries.map(([id]) => id);
const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
if (duplicates.length > 0) throw new Error(`duplicate segment ids: ${duplicates.join(", ")}`);

const body = entries
  .map(([id, text]) => `  ${JSON.stringify(id)}: ${JSON.stringify(text)},`)
  .join("\n");

const output = `/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Source of truth: the /prompts Markdown tree (AG-04). Regenerate:
 *   node scripts/generate-prompt-texts.mjs
 * CI verifies regeneration is a no-op; edit the Markdown files instead.
 * Segment value = file content minus exactly one trailing newline.
 */
export const PROMPT_TEXTS = {
${body}
} as const;

export type PromptSegmentId = keyof typeof PROMPT_TEXTS;

export const PROMPT_SEGMENT_IDS = Object.keys(PROMPT_TEXTS) as PromptSegmentId[];
`;

writeFileSync(outFile, output, "utf8");
console.log(`generated ${relative(repoRoot, outFile)} with ${entries.length} segments`);
