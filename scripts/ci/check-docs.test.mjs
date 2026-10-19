import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  checkDocs,
  extractRelativeTargets,
  filesFromSelectResult,
  partitionMarkdownFiles,
} from "./check-docs.mjs";

describe("check-docs", () => {
  it("extracts relative links and ignores urls", () => {
    const targets = extractRelativeTargets(
      "See [a](./foo.md) and [b](https://example.com) and [c](#anchor).",
    );
    assert.deepEqual(targets, ["./foo.md"]);
  });

  it("fails on a broken relative link", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ci01-docs-"));
    writeFileSync(path.join(root, "README.md"), "[missing](./nope.md)\n");
    const errors = checkDocs(root, ["README.md"]);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /broken relative link/);
  });

  it("accepts a link to a real file", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ci01-docs-"));
    mkdirSync(path.join(root, "docs"));
    writeFileSync(path.join(root, "docs", "a.md"), "[next](./b.md)\n");
    writeFileSync(path.join(root, "docs", "b.md"), "ok\n");
    const errors = checkDocs(root, ["docs/a.md"]);
    assert.deepEqual(errors, []);
  });

  it("passes a rename when remaining docs do not point at the old path", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ci01-docs-"));
    mkdirSync(path.join(root, "docs"));
    writeFileSync(path.join(root, "docs", "new.md"), "renamed\n");
    writeFileSync(path.join(root, "docs", "index.md"), "[new](./new.md)\n");
    const selected = ["docs/old.md", "docs/new.md"];
    const split = partitionMarkdownFiles(root, selected);
    assert.deepEqual(split.checkFiles, ["docs/new.md"]);
    assert.deepEqual(split.deletedFiles, ["docs/old.md"]);
    assert.deepEqual(checkDocs(root, selected), []);
  });

  it("fails a rename when remaining docs still link to the old path", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ci01-docs-"));
    mkdirSync(path.join(root, "docs"));
    writeFileSync(path.join(root, "docs", "new.md"), "renamed\n");
    writeFileSync(path.join(root, "docs", "index.md"), "[old](./old.md)\n");
    const errors = checkDocs(root, ["docs/old.md", "docs/new.md"]);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /leftover relative link \.\/old\.md to deleted docs\/old\.md/);
  });

  it("passes a delete when remaining docs do not point at the removed path", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ci01-docs-"));
    mkdirSync(path.join(root, "docs"));
    writeFileSync(path.join(root, "docs", "keep.md"), "ok\n");
    assert.deepEqual(checkDocs(root, ["docs/gone.md"]), []);
  });

  it("fails a delete when remaining docs still link to the removed path", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ci01-docs-"));
    mkdirSync(path.join(root, "docs"));
    writeFileSync(path.join(root, "docs", "keep.md"), "[gone](./gone.md)\n");
    const errors = checkDocs(root, ["docs/gone.md"]);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /leftover relative link \.\/gone\.md to deleted docs\/gone\.md/);
  });

  it("keeps rename paths from the selector so leftover refs can be scanned", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ci01-docs-"));
    mkdirSync(path.join(root, "docs"));
    writeFileSync(path.join(root, "docs", "new.md"), "ok\n");
    const files = filesFromSelectResult(
      {
        SELECT_RESULT: JSON.stringify({
          mode: "selective",
          files: ["docs/old.md", "docs/new.md", "apps/web/src/App.tsx"],
        }),
      },
      root,
    );
    assert.deepEqual(files, ["docs/old.md", "docs/new.md"]);
    assert.deepEqual(checkDocs(root, files), []);
  });
});

it("reads the full selection artifact without placing its paths in env", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ci-docs-artifact-"));
  const file = path.join(root, "selection.json");
  writeFileSync(file, JSON.stringify({ mode: "selective", files: ["docs/old.md", "docs/new.md"] }));
  assert.deepEqual(filesFromSelectResult({ SELECT_RESULT_PATH: file }, root), [
    "docs/old.md",
    "docs/new.md",
  ]);
});
