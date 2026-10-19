import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { checkDocs, extractRelativeTargets } from "./check-docs.mjs";

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
});
