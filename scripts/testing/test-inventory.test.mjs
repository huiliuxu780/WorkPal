import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  buildInventory,
  classifyTestFiles,
  ENTRYPOINTS,
  enumerateTestFiles,
  filesForGroup,
  ROOT,
  testPathTraits,
  unitTestFiles,
} from "./test-inventory.mjs";

const HARNESS_SOURCE = "packages/testkit/src/cli/harness.ts";
const UNIT_CONFIG = "vitest.unit.config.ts";
const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

function tempRoot(prefix = "workpal-inventory-") {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(root);
  return root;
}

function write(root, file, text) {
  const target = path.join(root, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, text);
}

const UNIT_TEXT = 'import { expect, it } from "vitest";\nit("unit", () => expect(1).toBe(1));\n';
const JSDOM_TEXT = `// @vitest-environment jsdom\n${UNIT_TEXT}`;
const POSTGRES_TEXT = 'process.env.VERIFY_DATABASE = "1";\nprocess.env.DATABASE_URL = "postgres://x";\n';

function pgRule(file, extra = {}) {
  return {
    path: file,
    categories: ["postgres"],
    markers: [/\bVERIFY_DATABASE\b/],
    reason: "fixture postgres",
    ...extra,
  };
}

function classify(testFiles, rules = []) {
  return classifyTestFiles(Object.keys(testFiles), {
    readText: (file) => testFiles[file] ?? "",
    rules,
  });
}

function fixtureOptions({
  testFiles = {},
  rules = [],
  scripts = {},
  jobs = ["harness", "db-postgres"],
  sources = {},
  configText = `import { unitTestFiles } from "./scripts/testing/test-inventory.mjs";\nunitTestFiles();\n`,
  requireAllCategories = false,
} = {}) {
  const root = tempRoot();
  const scriptMap = {
    "test:unit": "vitest run --config vitest.unit.config.ts",
    "test:postgres": "node scripts/testing/run-test-group.mjs postgres",
    "test:process": "node scripts/testing/run-test-group.mjs process",
    ...scripts,
  };
  const presentScripts = Object.fromEntries(
    Object.entries(scriptMap).filter(([, value]) => typeof value === "string"),
  );
  write(root, "package.json", JSON.stringify({ scripts: presentScripts }));
  const ciYaml = ["jobs:", ...jobs.map((job) => `  ${job}:\n    name: ${job}`)].join("\n");
  write(root, ".github/workflows/ci.yml", `${ciYaml}\n`);
  if (configText !== null) write(root, UNIT_CONFIG, configText);
  for (const [file, text] of Object.entries(testFiles)) write(root, file, text);
  for (const [file, text] of Object.entries(sources)) write(root, file, text);

  const options = {
    root,
    files: Object.keys(testFiles),
    rules,
    metadata: {
      packageScripts: new Map(Object.entries(presentScripts)),
      ciYaml: `${ciYaml}\n`,
      sources,
      configFiles:
        configText === null ? new Map() : new Map([[UNIT_CONFIG, configText]]),
    },
    requireAllCategories,
  };
  return { root, options };
}

function errorsFor(options) {
  return buildInventory(options).errors;
}

describe("default classification", () => {
  it("defaults ordinary tests to Node and honors the jsdom docblock", () => {
    const result = classify({
      "packages/core/src/plain.test.ts": UNIT_TEXT,
      "apps/web/src/widget.test.tsx": JSDOM_TEXT,
    });
    assert.deepEqual(result.errors, []);
    assert.equal(result.entries[0].categories[0], "unit-jsdom");
    assert.equal(result.entries[1].categories[0], "unit-node");
    assert.deepEqual(result.entries[0].entryIds, ["unit"]);
    assert.deepEqual(result.entries[1].entryIds, ["unit"]);
  });

  it("rejects an unclassified external suffix", () => {
    const result = classify({ "packages/db/src/new.postgres.test.ts": POSTGRES_TEXT });
    assert.equal(result.entries.length, 0);
    assert.match(result.errors.join("\n"), /external test suffix requires an explicit classification/);
  });

  it("rejects an unclassified node:test file", () => {
    const result = classify({ "scripts/ci/new.test.mjs": 'import test from "node:test";\n' });
    assert.equal(result.entries.length, 0);
    assert.match(result.errors.join("\n"), /node:test file requires an explicit classification/);
  });

  it("accepts an explicit node:test rule with an entry override", () => {
    const file = "docs/roundtable/verify.test.mjs";
    const result = classify({ [file]: 'import test from "node:test";\n' }, [
      { path: file, categories: ["node-test"], markers: [], reason: "fixture", entry: "docs-verify" },
    ]);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.entries[0].entryIds, ["docs-verify"]);
  });

  it("rejects an ordinary-looking test that reaches PostgreSQL", () => {
    const result = classify({ "packages/db/src/new-db.test.ts": POSTGRES_TEXT });
    assert.equal(result.entries.length, 0);
    assert.match(result.errors.join("\n"), /external dependency detected \(PostgreSQL/);
  });

  it("rejects a child process test without an explicit rule", () => {
    const result = classify({
      "packages/core/src/spawn.test.ts": 'import { spawn } from "node:child_process";\nspawn("true");\n',
    });
    assert.equal(result.entries.length, 0);
    assert.match(result.errors.join("\n"), /external dependency detected \(child process\)/);
  });

  it("keeps type-only child_process imports inside unit tests", () => {
    const result = classify({
      "packages/core/src/type-only.test.ts":
        'import type { ChildProcess } from "node:child_process";\nconst x: ChildProcess | null = null;\nvoid x;\n',
    });
    assert.deepEqual(result.errors, []);
    assert.equal(result.entries[0].categories[0], "unit-node");
  });

  it("accepts an explicit external rule whose marker still matches", () => {
    const result = classify(
      { "packages/db/src/new.postgres.test.ts": POSTGRES_TEXT },
      [pgRule("packages/db/src/new.postgres.test.ts")],
    );
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.entries[0].categories, ["postgres"]);
    assert.deepEqual(result.entries[0].entryIds, ["postgres"]);
  });

  it("fails when an explicit marker no longer matches", () => {
    const result = classify(
      { "packages/db/src/new.postgres.test.ts": UNIT_TEXT },
      [pgRule("packages/db/src/new.postgres.test.ts")],
    );
    assert.match(result.errors.join("\n"), /inventory markers no longer match/);
  });

  it("fails when an inventory entry points at a file no longer tracked", () => {
    const result = classify({}, [pgRule("packages/db/src/deleted.postgres.test.ts")]);
    assert.match(result.errors.join("\n"), /no longer tracked/);
  });

  it("fails on duplicate rules", () => {
    const result = classify(
      { "packages/db/src/new.postgres.test.ts": POSTGRES_TEXT },
      [pgRule("packages/db/src/new.postgres.test.ts"), pgRule("packages/db/src/new.postgres.test.ts")],
    );
    assert.match(result.errors.join("\n"), /duplicate inventory rule/);
  });

  it("requires a reason for multiple execution entries", () => {
    const file = "packages/db/src/new.postgres.test.ts";
    const missing = classify({ [file]: POSTGRES_TEXT }, [
      pgRule(file, { categories: ["postgres", "integration-harness"] }),
    ]);
    assert.match(missing.errors.join("\n"), /multiple execution entries require duplicateReason/);

    const explained = classify({ [file]: POSTGRES_TEXT }, [
      pgRule(file, {
        categories: ["postgres", "integration-harness"],
        duplicateReason: "standalone DB contract and app journey",
      }),
    ]);
    assert.deepEqual(explained.errors, []);
    assert.deepEqual(explained.entries[0].entryIds, ["postgres", "integration"]);
  });

  it("refuses external tests that also claim unit", () => {
    const file = "packages/db/src/new.postgres.test.ts";
    const result = classify({ [file]: POSTGRES_TEXT }, [
      pgRule(file, {
        categories: ["unit-node", "postgres"],
        duplicateReason: "should still fail",
      }),
    ]);
    assert.match(result.errors.join("\n"), /external tests cannot also belong to unit/);
  });

  it("fails on unknown or empty categories", () => {
    const unknown = classify({ "packages/core/src/a.test.ts": UNIT_TEXT }, [
      {
        path: "packages/core/src/a.test.ts",
        categories: ["unit-browser"],
        markers: [],
        reason: "fixture",
      },
    ]);
    assert.match(unknown.errors.join("\n"), /unknown test category 'unit-browser'/);

    const empty = classify({ "packages/core/src/a.test.ts": UNIT_TEXT }, [
      { path: "packages/core/src/a.test.ts", categories: [], markers: [], reason: "fixture" },
    ]);
    assert.match(empty.errors.join("\n"), /inventory rule has no category/);
  });
});

describe("inventory entrypoints", () => {
  const unitFile = "packages/core/src/a.test.ts";
  const jsdomFile = "apps/web/src/b.test.tsx";
  const pgFile = "packages/db/src/c.postgres.test.ts";

  function validFixture(overrides = {}) {
    return fixtureOptions({
      testFiles: {
        [unitFile]: UNIT_TEXT,
        [jsdomFile]: JSDOM_TEXT,
        [pgFile]: POSTGRES_TEXT,
      },
      rules: [pgRule(pgFile)],
      ...overrides,
    });
  }

  it("accepts a complete fixture and selects unit files only", () => {
    const { options } = validFixture();
    const inventory = buildInventory(options);
    assert.deepEqual(inventory.errors, []);
    assert.deepEqual(unitTestFiles(options), [jsdomFile, unitFile]);
    assert.deepEqual(filesForGroup("postgres", options), [pgFile]);
    assert.deepEqual(filesForGroup("unit", options), [jsdomFile, unitFile]);
  });

  it("fails when the unit script is missing", () => {
    const { options } = validFixture({ scripts: { "test:unit": null } });
    assert.match(errorsFor(options).join("\n"), /missing package script 'test:unit'/);
  });

  it("fails when the unit script does not use the unit config", () => {
    const { options } = validFixture({ scripts: { "test:unit": "vitest run" } });
    assert.match(errorsFor(options).join("\n"), /must invoke vitest\.unit\.config\.ts/);
  });

  it("fails when the unit config is missing", () => {
    const { options } = validFixture({ configText: null });
    assert.match(errorsFor(options).join("\n"), /missing vitest\.unit\.config\.ts/);
  });

  it("fails when the unit config does not use unitTestFiles()", () => {
    const { options } = validFixture({ configText: "export default {};\n" });
    assert.match(errorsFor(options).join("\n"), /must include files from unitTestFiles/);
  });

  it("fails when the postgres runner script is degraded", () => {
    const { options } = validFixture({ scripts: { "test:postgres": "vitest run" } });
    assert.match(errorsFor(options).join("\n"), /run-test-group\.mjs postgres/);
  });

  it("fails when the harness CI job is missing", () => {
    const { options } = validFixture({ jobs: ["db-postgres"] });
    assert.match(errorsFor(options).join("\n"), /missing CI job 'harness'/);
  });

  it("fails when a harness suite is no longer listed", () => {
    const harnessFile = "packages/testkit/src/journey.test.ts";
    const { options } = fixtureOptions({
      testFiles: { [harnessFile]: POSTGRES_TEXT },
      rules: [
        {
          path: harnessFile,
          categories: ["integration-harness"],
          markers: [/\bVERIFY_DATABASE\b/],
          reason: "fixture journey",
        },
      ],
      sources: { [HARNESS_SOURCE]: 'const suites = [];\n' },
    });
    assert.match(errorsFor(options).join("\n"), new RegExp(`${harnessFile}: not present in`));

    const { options: fixed } = fixtureOptions({
      testFiles: { [harnessFile]: POSTGRES_TEXT },
      rules: [
        {
          path: harnessFile,
          categories: ["integration-harness"],
          markers: [/\bVERIFY_DATABASE\b/],
          reason: "fixture journey",
        },
      ],
      sources: { [HARNESS_SOURCE]: `const suites = ["${harnessFile}"];\n` },
    });
    assert.deepEqual(errorsFor(fixed), []);
  });

  it("fails when the agentscope CI job stops listing a suite", () => {
    const file = "packages/adapters/src/journey.integration.test.ts";
    const rule = {
      path: file,
      categories: ["agentscope-request"],
      markers: [/agentscope/i],
      reason: "fixture agentscope",
    };
    const { options: missing } = fixtureOptions({
      testFiles: { [file]: 'process.env.AGENTSCOPE_URL = "http://x";\n' },
      rules: [rule],
      jobs: ["harness", "agentscope"],
    });
    assert.match(errorsFor(missing).join("\n"), /not present in CI job 'agentscope'/);

    const { options: present } = fixtureOptions({
      testFiles: { [file]: 'process.env.AGENTSCOPE_URL = "http://x";\n' },
      rules: [rule],
      jobs: ["harness", "agentscope"],
    });
    assert.deepEqual(
      errorsFor({
        ...present,
        metadata: {
          ...present.metadata,
          ciYaml: `${present.metadata.ciYaml}      run: vitest run ${file}\n`,
        },
      }),
      [],
    );
  });

  it("reports categories with no tracked files", () => {
    const { options } = fixtureOptions({
      testFiles: { [unitFile]: UNIT_TEXT },
      requireAllCategories: true,
    });
    const errors = buildInventory(options).errors.join("\n");
    assert.match(errors, /category 'postgres' has no tracked test files/);
    assert.match(errors, /category 'integration-harness' has no tracked test files/);
  });

  it("refuses to build a unit list from an invalid inventory", () => {
    const { options } = fixtureOptions({
      testFiles: { "packages/db/src/new.postgres.test.ts": POSTGRES_TEXT },
    });
    assert.throws(() => unitTestFiles(options), /test inventory is invalid/);
  });
});

describe("tracked repository", () => {
  const files = enumerateTestFiles(ROOT);
  const readText = (file) => readFileSync(path.join(ROOT, file), "utf8");
  const result = classifyTestFiles(files, { readText });

  it("enumerates every tracked test file and classifies all of them", () => {
    assert.ok(files.length > 500, `expected >500 test files, found ${files.length}`);
    for (const file of files) assert.match(file, /\.test\.(?:ts|tsx|mjs)$/);
    assert.deepEqual(result.errors, []);
    assert.equal(result.entries.length, files.length);
    assert.ok(files.includes("scripts/ci/select-checks.test.mjs"));
    assert.ok(files.includes("scripts/testing/test-inventory.test.mjs"));
  });

  it("keeps ordinary-suffix external tests out of unit", () => {
    const byPath = new Map(result.entries.map((entry) => [entry.path, entry]));
    const replay = byPath.get("packages/testkit/src/computer-replay.test.ts");
    assert.ok(replay);
    assert.deepEqual(replay.categories, ["computer-replay-java"]);
    assert.deepEqual(replay.entryIds, ["computer-replay-java"]);
    assert.equal(testPathTraits("packages/testkit/src/computer-replay.test.ts").isUnit, false);

    for (const file of [
      "packages/db/src/delivery-records.test.ts",
      "packages/db/src/usage-stats.test.ts",
      "packages/testkit/src/messaging.test.ts",
      "packages/testkit/src/mention-targets.test.ts",
      "packages/testkit/src/runs-list.test.ts",
    ]) {
      const entry = byPath.get(file);
      assert.ok(entry, file);
      assert.deepEqual(entry.categories, ["postgres"], file);
      assert.equal(testPathTraits(file).isPostgres, true, file);
    }
  });

  it("builds the real unit and group lists from inventory", () => {
    const unit = unitTestFiles();
    assert.ok(unit.length > 400, `unit files: ${unit.length}`);
    assert.ok(unit.some((file) => file.endsWith(".test.tsx")), "jsdom tests are included");
    assert.equal(unit.includes("packages/testkit/src/computer-replay.test.ts"), false);
    assert.equal(unit.some((file) => file.endsWith(".postgres.test.ts")), false);
    assert.equal(unit.some((file) => file.endsWith(".test.mjs")), false);

    const postgres = filesForGroup("postgres");
    assert.ok(postgres.length >= 44, `postgres files: ${postgres.length}`);
    for (const file of [
      "packages/db/src/delivery-records.test.ts",
      "packages/testkit/src/messaging.test.ts",
      "packages/testkit/src/mention-targets.test.ts",
      "packages/testkit/src/runs-list.test.ts",
    ]) {
      assert.ok(postgres.includes(file), file);
    }
    assert.equal(postgres.includes("packages/testkit/src/computer-replay.test.ts"), false);
    assert.ok(filesForGroup("process").length >= 18);
    assert.ok(filesForGroup("ci-self-check").includes("scripts/ci/select-checks.test.mjs"));
    assert.ok(filesForGroup("ci-self-check").includes("scripts/testing/test-inventory.test.mjs"));
    assert.ok(
      filesForGroup("docs-verify").includes(
        "docs/roundtable/verify-implementation-plan.test.mjs",
      ),
    );
  });

  it("uses every declared category and gives every file a real environment", () => {
    const { entries } = result;
    const counts = {};
    for (const entry of entries) {
      for (const category of entry.categories) counts[category] = (counts[category] ?? 0) + 1;
    }
    for (const category of [
      "unit-node",
      "unit-jsdom",
      "postgres",
      "integration-harness",
      "agentscope-request",
      "computer-replay-java",
      "computer-replay-cli",
      "docker-manual",
      "live-canary",
      "live-computer",
      "process",
      "node-test",
    ]) {
      assert.ok(counts[category] > 0, `${category} has no files`);
    }
    for (const entry of entries) {
      assert.ok(entry.environment.length > 0, entry.path);
      assert.ok(entry.entryIds.length > 0, entry.path);
      for (const entryId of entry.entryIds) assert.ok(ENTRYPOINTS[entryId], entryId);
    }
    const unitCount = result.entries.filter((entry) =>
      entry.categories.some((category) => category.startsWith("unit-")),
    ).length;
    assert.equal(unitCount, counts["unit-node"] + counts["unit-jsdom"]);
  });
});

describe("git enumeration", () => {
  it("fails when a new tracked external test is not classified", () => {
    const root = tempRoot("workpal-inventory-git-");
    execFileSync("git", ["init", "-q"], { cwd: root });
    write(root, "packages/core/src/ok.test.ts", UNIT_TEXT);
    write(root, "packages/db/src/new.postgres.test.ts", POSTGRES_TEXT);
    execFileSync("git", ["add", "."], { cwd: root });
    const tracked = enumerateTestFiles(root);
    assert.deepEqual(tracked, [
      "packages/core/src/ok.test.ts",
      "packages/db/src/new.postgres.test.ts",
    ]);
    const result = classifyTestFiles(tracked, {
      readText: (file) => {
        try {
          return execFileSync("git", ["show", `:${file}`], { cwd: root, encoding: "utf8" });
        } catch {
          return "";
        }
      },
    });
    assert.match(
      result.errors.join("\n"),
      /packages\/db\/src\/new\.postgres\.test\.ts: external test suffix/,
    );
  });
});
