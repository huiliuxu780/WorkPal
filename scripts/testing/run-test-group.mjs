#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { formatInventorySummary, buildInventory } from "./test-inventory.mjs";

const group = process.argv[2];
if (!group) {
  console.error("Usage: node scripts/testing/run-test-group.mjs <postgres|process>");
  process.exit(2);
}

const inventory = buildInventory();
if (inventory.errors.length > 0) {
  console.error(formatInventorySummary(inventory));
  process.exit(1);
}

const files = inventory.entries
  .filter((entry) => entry.entryIds.includes(group))
  .map((entry) => entry.path);
if (files.length === 0) {
  console.error(`No tracked test files are assigned to group '${group}'`);
  process.exit(1);
}

const args = ["exec", "vitest", "run"];
if (group === "postgres") args.push("--no-file-parallelism");
args.push(...files);
const result = spawnSync("pnpm", args, { stdio: "inherit", env: process.env });
if (result.error) console.error(result.error);
process.exit(result.status ?? 1);
