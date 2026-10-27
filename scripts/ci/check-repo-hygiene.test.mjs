import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkRepoHygiene,
  HARD_SIZE_LIMIT_BYTES,
  inspectEntry,
  inspectWorktrees,
  parseWorktreeList,
  SIZE_LIMIT_BYTES,
} from "./check-repo-hygiene.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const checkScript = path.join(here, "check-repo-hygiene.mjs");
const installScript = path.join(here, "..", "hooks", "install.mjs");

function rulesFor(file, size = 10) {
  return inspectEntry({ path: file, size }).map((v) => v.rule);
}

describe("inspectEntry", () => {
  it("rejects tracked environment files but allows the committed examples", () => {
    assert.deepEqual(rulesFor(".env"), ["credential-file"]);
    assert.deepEqual(rulesFor(".env.local"), ["credential-file"]);
    assert.deepEqual(rulesFor("apps/api/.env.production"), ["credential-file"]);
    assert.deepEqual(rulesFor(".env.example"), []);
    assert.deepEqual(rulesFor("infra/compose/.env.images.example"), []);
  });

  it("rejects key material and does not flag source files about secrets", () => {
    assert.deepEqual(rulesFor("keys/server.pem"), ["key-material"]);
    assert.deepEqual(rulesFor("keys/id_rsa"), ["key-material"]);
    assert.deepEqual(rulesFor("packages/adapters/src/secrets.ts"), []);
    assert.deepEqual(rulesFor("docs/bot-secrets.md"), []);
  });

  it("rejects restricted directories of a web-only product", () => {
    for (const file of [
      "apps/mobile/lib/i18n.ts",
      "apps/www/index.tsx",
      "apps/desktop/main.ts",
      "node_modules/left-pad/index.js",
    ]) {
      assert.deepEqual(rulesFor(file), ["restricted-path"], file);
    }
    assert.deepEqual(rulesFor("apps/web/src/main.tsx"), []);
  });

  it("rejects unexpectedly large files while allowing normal assets", () => {
    assert.deepEqual(rulesFor("docs/evidence/screenshot.png", 512 * 1024), []);
    assert.deepEqual(rulesFor("docs/evidence/new-recording.mp4", SIZE_LIMIT_BYTES + 1), [
      "file-too-large",
    ]);
  });

  it("keeps the committed large-asset baseline working and bounded", () => {
    assert.deepEqual(rulesFor("docs/screenshots/demo.mp4", SIZE_LIMIT_BYTES + 1), []);
    assert.deepEqual(rulesFor("docs/screenshots/demo.mp4", HARD_SIZE_LIMIT_BYTES + 1), [
      "file-too-large",
    ]);
  });

  it("skips the size rule when the file is gone from the working tree", () => {
    assert.deepEqual(
      inspectEntry({ path: "big.bin", size: null }).map((v) => v.rule),
      [],
    );
  });
});

describe("inspectWorktrees", () => {
  const root = "/repo/WorkPal";

  it("flags worktrees nested inside the checkout", () => {
    const violations = inspectWorktrees(
      [root, "/repo/WorkPal/.qoder/worktrees/fix-1", "/repo/WorkPal/sub/.codex/worktrees/x"],
      root,
    );
    assert.deepEqual(
      violations.map((v) => v.rule),
      ["nested-worktree", "nested-worktree"],
    );
    assert.match(violations[0].message, /git worktree remove/);
  });

  it("allows the checkout itself and sibling worktrees outside it", () => {
    assert.deepEqual(
      inspectWorktrees([root, "/repo/WorkPal-worktrees/h3", "/repo/other"], root),
      [],
    );
  });

  it("parses porcelain worktree list output", () => {
    const parsed = parseWorktreeList(
      [
        "worktree /repo/WorkPal",
        "HEAD abc",
        "branch refs/heads/main",
        "",
        "worktree /repo/wt-a",
        "HEAD def",
      ].join("\n"),
    );
    assert.deepEqual(parsed, ["/repo/WorkPal", "/repo/wt-a"]);
  });
});

describe("checkRepoHygiene", () => {
  it("is ok for a clean entry set", () => {
    const result = checkRepoHygiene({
      entries: [{ path: "apps/web/src/main.tsx", size: 10 }],
      worktreePaths: ["/repo/WorkPal"],
      repoRoot: "/repo/WorkPal",
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.violations, []);
  });
});

describe("repository fixture", () => {
  let repo;

  const git = (args, options = {}) =>
    spawnSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        ...options.env,
      },
    });

  const runCheck = (args) =>
    spawnSync(process.execPath, [checkScript, ...args], { cwd: repo, encoding: "utf8" });

  const write = (relative, contents) => {
    const target = path.join(repo, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
  };

  before(() => {
    repo = mkdtempSync(path.join(tmpdir(), "workpal-hygiene-"));
    const init = git(["init", "-b", "main"]);
    assert.equal(init.status, 0, init.stderr);
    git(["config", "user.email", "hygiene-fixture@example.invalid"]);
    git(["config", "user.name", "Hygiene Fixture"]);
    git(["config", "commit.gpgsign", "false"]);
    // The hook resolves the checker relative to its own repository, so the
    // fixture needs a real copy of both scripts rather than a stub.
    for (const source of [
      checkScript,
      installScript,
      path.join(here, "..", "hooks", "pre-commit"),
    ]) {
      const target = path.join(
        repo,
        "scripts",
        path.basename(path.dirname(source)),
        path.basename(source),
      );
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(source, target);
    }
    chmodSync(path.join(repo, "scripts", "hooks", "pre-commit"), 0o755);
  });

  after(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  it("blocks a synthetic restricted set staged in a repository without any hook", () => {
    // Synthetic values only: no real credential, host, or user identity.
    write(".env", "DATABASE_URL=postgresql://fixture:fixture@127.0.0.1:5432/fixture\n");
    write(".env.example", "DATABASE_URL=postgresql://user:password@127.0.0.1:5432/workpal\n");
    write("apps/mobile/lib/i18n.ts", "export const locales = [];\n");
    write("packages/adapters/src/secrets.ts", "export const secretStore = {};\n");
    write("docs/assets/allowed-shot.png", Buffer.alloc(64 * 1024, 1));
    write("docs/evidence/oversized-recording.bin", Buffer.alloc(SIZE_LIMIT_BYTES + 2048, 7));

    const add = git(["add", "-A"]);
    assert.equal(add.status, 0, add.stderr);

    const result = runCheck(["--staged", "--format", "json"]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const report = JSON.parse(result.stdout);
    const byPath = new Map(report.violations.map((v) => [v.path, v.rule]));
    assert.deepEqual(
      [...byPath.entries()].sort(),
      [
        [".env", "credential-file"],
        ["apps/mobile/lib/i18n.ts", "restricted-path"],
        ["docs/evidence/oversized-recording.bin", "file-too-large"],
      ],
      "allowed assets and secret-named source must not be rejected",
    );
  });

  it("accepts the same tree once the violations are removed", () => {
    const removed = git(["rm", "-f", "-q", ".env", "apps/mobile/lib/i18n.ts"]);
    assert.equal(removed.status, 0, removed.stderr);
    write("docs/evidence/oversized-recording.bin", Buffer.alloc(64 * 1024, 7));
    const add = git(["add", "-A"]);
    assert.equal(add.status, 0, add.stderr);

    const result = runCheck(["--staged"]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /no violations/);
  });

  it("reports tracked violations in --base/--head mode after they are committed", () => {
    const first = git(["commit", "-q", "-m", "clean baseline"]);
    assert.equal(first.status, 0, first.stderr);
    const base = git(["rev-parse", "HEAD"]).stdout.trim();

    write(".env", "OPENROUTER_API_KEY=fixture-not-a-real-key\n");
    git(["add", "-A"]);
    const second = git(["commit", "-q", "-m", "add a credential file"]);
    assert.equal(second.status, 0, second.stderr);
    const head = git(["rev-parse", "HEAD"]).stdout.trim();

    const result = runCheck(["--base", base, "--head", head, "--format", "json"]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.deepEqual(
      JSON.parse(result.stdout).violations.map((v) => [v.path, v.rule]),
      [[".env", "credential-file"]],
    );
  });

  it("blocks the commit when the reminder hook is installed", () => {
    const install = spawnSync(process.execPath, [installScript], { cwd: repo, encoding: "utf8" });
    assert.equal(install.status, 0, install.stdout + install.stderr);
    assert.match(install.stdout, /installed pre-commit hook/);

    write("apps/www/index.tsx", "export default function Home() { return null; }\n");
    git(["add", "-A"]);
    const blocked = git(["commit", "-m", "restricted path should be blocked"]);
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stdout + blocked.stderr, /restricted-path/);
    assert.match(blocked.stdout + blocked.stderr, /repository hygiene blocked this commit/);
  });
});
