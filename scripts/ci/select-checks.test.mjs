import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ALL_JOBS,
  CHECK_JOBS,
  classifyPath,
  gitNameStatus,
  parseNameStatus,
  resolveGitHubSelection,
  selectChecks,
  writeGitHubOutput,
  ZERO_SHA,
} from "./select-checks.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

function selected(files) {
  return selectChecks({ files }).selected;
}

function hasExactly(files, jobs) {
  const got = selected(files);
  const expected = [...jobs];
  if (expected.includes("agentscope") || expected.includes("worker-chain")) {
    if (!expected.includes("runtime-jar")) expected.push("runtime-jar");
  }
  assert.deepEqual(
    got,
    ALL_JOBS.filter((job) => expected.includes(job)),
  );
}

describe("classifyPath", () => {
  it("treats root and docs markdown as docs", () => {
    assert.deepEqual(classifyPath("README.md").jobs, ["docs"]);
    assert.deepEqual(classifyPath("docs/privacy.md").jobs, ["docs"]);
    assert.deepEqual(classifyPath("docs/tasks/CI-01.md").jobs, ["docs"]);
    assert.deepEqual(classifyPath(".github/ISSUE_TEMPLATE/bug.yml").jobs, ["docs"]);
  });

  it("does not treat prompts markdown as docs", () => {
    const result = classifyPath("prompts/platform.md");
    assert.ok(result.jobs.includes("agentscope"));
    assert.ok(result.jobs.includes("agent-runtime-image"));
    assert.equal(result.jobs.includes("docs"), false);
    assert.match(result.reason, /runtime source/);
  });

  it("does not classify by the substring agentscope in a docs path", () => {
    assert.deepEqual(classifyPath("docs/notes-about-agentscope.md").jobs, ["docs"]);
  });

  it("maps pure UI paths to web only", () => {
    for (const file of [
      "apps/web/src/App.tsx",
      "packages/ui-web/src/components/ui/button.tsx",
      "packages/ui-tokens/src/tokens.css",
      "packages/chat-ui/src/markdown.web.tsx",
      "apps/web/public/favicon.svg",
    ]) {
      assert.deepEqual(classifyPath(file).jobs, ["web"], file);
    }
  });

  it("maps worker execution paths to backend + worker-chain", () => {
    for (const file of [
      "apps/worker/src/index.ts",
      "packages/adapters/src/job-reconciler.ts",
      "packages/adapters/src/wakeup.postgres.test.ts",
      "packages/adapters/src/result-delivery.ts",
      "packages/db/src/run-lease.ts",
      "packages/db/src/execution-fence.ts",
      "packages/db/src/external-effects.ts",
      "packages/adapter-kit/src/background-jobs.ts",
      "apps/web/e2e/worker-chain.spec.ts",
    ]) {
      const jobs = classifyPath(file).jobs;
      assert.ok(jobs.includes("worker-chain"), file);
      assert.equal(jobs.includes("web"), false, file);
    }
  });

  it("routes effect execution fencing to DB and executor verification", () => {
    for (const file of [
      "packages/db/src/execution-fence.ts",
      "packages/db/src/external-effects.ts",
      "packages/db/src/effect-execution-fence.postgres.test.ts",
    ]) {
      const result = classifyPath(file);
      assert.ok(result.jobs.includes("db-postgres"), file);
      assert.ok(result.jobs.includes("backend"), file);
    }
    const executor = classifyPath("packages/adapters/src/executor-readonly-approval.test.ts");
    assert.ok(executor.jobs.includes("backend"));
    assert.ok(executor.jobs.includes("agentscope"));
  });

  it("unions a changed web spec with its product-path mapping", () => {
    const history = classifyPath("apps/web/e2e/execution-history.spec.ts");
    assert.ok(history.jobs.includes("web"));
    assert.ok(history.webE2e.includes("execution-history.spec.ts"));
    assert.ok(history.webE2e.includes("execution-card.spec.ts"));
    assert.ok(history.webE2e.includes("task-center.spec.ts"));

    const avatar = classifyPath("apps/web/e2e/avatar-studio.spec.ts");
    assert.ok(avatar.jobs.includes("web"));
    assert.ok(avatar.webE2e.includes("avatar-studio.spec.ts"));
    assert.ok(avatar.webE2e.includes("ui-appearance.spec.ts"));
    assert.ok(avatar.webE2e.includes("settings-shell.spec.ts"));

    const approval = classifyPath("apps/web/e2e/approval-resume.spec.ts");
    assert.ok(approval.jobs.includes("web"));
    assert.ok(approval.webE2e.includes("approval-resume.spec.ts"));
    assert.ok(approval.webE2e.includes("ui-appearance.spec.ts"));
    assert.ok(approval.webE2e.includes("settings-shell.spec.ts"));
  });

  it("routes message_group production paths to the closed-loop spec", () => {
    for (const file of [
      "packages/adapters/src/message-group.ts",
      "packages/adapters/src/message-group.postgres.test.ts",
      "packages/core/src/roundtable-contracts.ts",
      "packages/core/src/roundtable-feature-gates.ts",
      "apps/web/src/components/ai/GroupDestinationReceipt.tsx",
    ]) {
      const result = classifyPath(file);
      assert.ok(result.jobs.includes("web"), file);
      assert.ok(result.webE2e.includes("message-group.spec.ts"), file);
    }
    const backend = classifyPath("packages/adapters/src/message-group.ts");
    assert.ok(backend.jobs.includes("backend"));
    assert.ok(backend.jobs.includes("agentscope"));
    assert.ok(backend.jobs.includes("db-postgres"));
    assert.deepEqual(classifyPath("apps/web/src/components/ai/GroupDestinationReceipt.tsx").jobs, [
      "web",
    ]);
  });

  it("keeps AgentScope and Worker exclusive specs off the web E2E mapping", () => {
    for (const file of [
      "apps/web/e2e/agentscope-product.spec.ts",
      "apps/web/e2e/budget-acceptance.spec.ts",
      "apps/web/e2e/capability-rules.spec.ts",
    ]) {
      const result = classifyPath(file);
      assert.deepEqual(result.webE2e, [], file);
      assert.ok(result.jobs.includes("agentscope"), file);
      assert.equal(result.jobs.includes("web"), false, file);
    }
    const worker = classifyPath("apps/web/e2e/worker-chain.spec.ts");
    assert.deepEqual(worker.webE2e, []);
    assert.ok(worker.jobs.includes("worker-chain"));
    assert.equal(worker.jobs.includes("web"), false);
  });

  it("maps Java prompt sources to agentscope + image, not worker-chain", () => {
    const result = classifyPath(
      "services/agent-runtime/src/main/resources/platform-instructions.md",
    );
    assert.ok(result.jobs.includes("agentscope"));
    assert.ok(result.jobs.includes("agent-runtime-image"));
    assert.equal(result.jobs.includes("worker-chain"), false);
    assert.equal(result.jobs.includes("docs"), false);
  });

  it("runs both runtime and Worker checks for shared budget enforcement", () => {
    for (const file of [
      "packages/core/src/run-budget.ts",
      "packages/core/src/run-budget.test.ts",
      "packages/adapters/src/run-budget-enforcement.ts",
      "packages/adapters/src/run-budget-enforcement.postgres.test.ts",
    ]) {
      const result = classifyPath(file);
      assert.ok(result.jobs.includes("backend"), file);
      assert.ok(result.jobs.includes("agentscope"), file);
      assert.ok(result.jobs.includes("worker-chain"), file);
    }
  });

  it("maps Java execution/recovery sources to worker-chain as well", () => {
    for (const file of [
      "services/agent-runtime/src/main/java/com/workpal/runtime/RuntimeEngine.java",
      "services/agent-runtime/src/main/java/com/workpal/runtime/ToolSurfaceRefresh.java",
    ]) {
      const result = classifyPath(file);
      assert.ok(result.jobs.includes("worker-chain"), file);
      assert.ok(result.jobs.includes("agent-runtime-image"), file);
    }
  });

  it("selects the real-postgres constraint job for database and migration changes", () => {
    for (const file of [
      "packages/db/src/groups.ts",
      "packages/db/src/agent-pairs.ts",
      "packages/db/src/agent-pairs.postgres.test.ts",
      "packages/db/src/postgres-test-database.ts",
      "packages/db/src/cancel-runs.ts",
    ]) {
      assert.ok(classifyPath(file).jobs.includes("db-postgres"), file);
    }
    assert.ok(classifyPath("packages/db/prisma/schema.prisma").jobs.includes("db-postgres"));
    assert.ok(
      classifyPath("packages/db/prisma/migrations/20261022000000_agent_pair_chat_groups/migration.sql")
        .jobs.includes("db-postgres"),
    );
    assert.equal(classifyPath("docs/privacy.md").jobs.includes("db-postgres"), false);
  });

  it("maps TS adapters to backend + agentscope, not worker-chain", () => {
    const result = classifyPath("packages/adapters/src/agentscope-runtime.ts");
    assert.ok(result.jobs.includes("backend"));
    assert.ok(result.jobs.includes("agentscope"));
    assert.equal(result.jobs.includes("worker-chain"), false);
    assert.equal(result.jobs.includes("web"), false);
  });

  it("maps the answered-ask resume paths to the Execution Card E2E", () => {
    for (const file of [
      "packages/db/src/task-instructions.ts",
      "packages/db/src/task-instructions.test.ts",
      "packages/db/src/task-instructions.postgres.test.ts",
      "packages/adapters/src/executor.ts",
      "packages/adapters/src/executor.test.ts",
      "packages/adapters/src/scripted-runtime.ts",
      "packages/adapters/src/scripted-runtime.test.ts",
    ]) {
      const result = classifyPath(file);
      assert.ok(result.jobs.includes("web"), `${file} must select the web E2E job`);
      assert.ok(result.webE2e.includes("execution-card.spec.ts"), file);
      assert.equal(result.jobs.includes("worker-chain"), false, file);
    }
    // The instruction envelope keeps the real-postgres constraint job.
    assert.ok(classifyPath("packages/db/src/task-instructions.ts").jobs.includes("db-postgres"));
    // FIX-127 regression: the focused Playwright pattern must actually collect
    // execution-card.spec.ts for these paths, not just list it.
    const selection = selectChecks({ files: ["packages/adapters/src/executor.ts"] });
    assert.ok(selection.selected.includes("web"));
    assert.match(selection.webE2eSpec, /execution-card\.spec\.ts/);
    const instructions = selectChecks({ files: ["packages/db/src/task-instructions.ts"] });
    assert.ok(instructions.selected.includes("web"));
    assert.match(instructions.webE2eSpec, /execution-card\.spec\.ts/);
  });

  it("forces full for contracts, lockfile, CI, and unknown source", () => {
    for (const file of [
      "packages/contracts/src/index.ts",
      "pnpm-lock.yaml",
      ".github/workflows/ci.yml",
      "scripts/ci/select-checks.mjs",
      "mystery/new-tool.rs",
    ]) {
      const jobs = classifyPath(file).jobs;
      for (const job of CHECK_JOBS) assert.ok(jobs.includes(job), `${file} missing ${job}`);
    }
  });
});

describe("selectChecks", () => {
  it("docs-only selects only docs", () => {
    hasExactly(["docs/privacy.md", "README.md"], ["docs"]);
  });

  it("pure UI does not start Worker or AgentScope", () => {
    const result = selectChecks({ files: ["apps/web/src/App.tsx"] });
    assert.ok(result.selected.includes("web"));
    assert.equal(result.selected.includes("worker-chain"), false);
    assert.equal(result.selected.includes("agentscope"), false);
    assert.ok(result.webE2eSpec.includes("ui-appearance.spec.ts"));
  });

  it("avatar UI selects avatar-focused E2E", () => {
    const result = selectChecks({ files: ["packages/ui-web/src/agent-avatar/agent-avatar.tsx"] });
    assert.match(result.webE2eSpec, /avatar-style/);
  });

  it("selects message-group.spec.ts for message_group adapter and receipt changes", () => {
    for (const files of [
      ["packages/adapters/src/message-group.ts"],
      ["packages/core/src/roundtable-contracts.ts"],
      ["apps/web/src/components/ai/GroupDestinationReceipt.tsx"],
    ]) {
      const result = selectChecks({ files });
      assert.match(result.webE2eSpec, /message-group\.spec\.ts/, files.join(","));
    }
  });

  it("includes a changed executable spec in the focused web E2E set", () => {
    const history = selectChecks({ files: ["apps/web/e2e/execution-history.spec.ts"] });
    assert.match(history.webE2eSpec, /execution-history\.spec\.ts/);
    assert.match(history.webE2eSpec, /execution-card\.spec\.ts/);
    assert.match(history.webE2eSpec, /task-center\.spec\.ts/);

    const avatar = selectChecks({ files: ["apps/web/e2e/avatar-studio.spec.ts"] });
    assert.match(avatar.webE2eSpec, /avatar-studio\.spec\.ts/);
    assert.match(avatar.webE2eSpec, /ui-appearance\.spec\.ts/);

    const approval = selectChecks({ files: ["apps/web/e2e/approval-resume.spec.ts"] });
    assert.match(approval.webE2eSpec, /approval-resume\.spec\.ts/);
    assert.match(approval.webE2eSpec, /settings-shell\.spec\.ts/);
  });

  it("collects the changed spec from the focused Playwright pattern", () => {
    const e2eDir = path.join(repoRoot, "apps/web/e2e");
    const names = readdirSync(e2eDir).filter((name) => name.endsWith(".spec.ts"));
    const collect = (webE2eSpec) => {
      const matcher = new RegExp(webE2eSpec);
      return names.filter((name) => matcher.test(name));
    };

    for (const spec of [
      "execution-history.spec.ts",
      "avatar-studio.spec.ts",
      "approval-resume.spec.ts",
      "message-group.spec.ts",
    ]) {
      const result = selectChecks({ files: [`apps/web/e2e/${spec}`] });
      const collected = collect(result.webE2eSpec);
      assert.ok(
        collected.includes(spec),
        `${spec} missing from ${result.webE2eSpec} (collected ${collected.join(", ")})`,
      );
    }

    const agentscope = selectChecks({ files: ["apps/web/e2e/agentscope-product.spec.ts"] });
    assert.equal(agentscope.webE2eSpec, "");
    assert.ok(agentscope.selected.includes("agentscope"));
    assert.equal(agentscope.selected.includes("web"), false);

    const worker = selectChecks({ files: ["apps/web/e2e/worker-chain.spec.ts"] });
    assert.equal(worker.webE2eSpec, "");
    assert.ok(worker.selected.includes("worker-chain"));
    assert.equal(worker.selected.includes("web"), false);
  });

  it("unions multiple classes", () => {
    const result = selectChecks({
      files: ["apps/web/src/App.tsx", "apps/worker/src/index.ts"],
    });
    assert.ok(result.selected.includes("web"));
    assert.ok(result.selected.includes("backend"));
    assert.ok(result.selected.includes("worker-chain"));
    assert.ok(result.selected.includes("runtime-jar"));
  });

  it("rename/delete uses both old and new paths", () => {
    const files = parseNameStatus(
      ["R100\tdocs/old.md\tdocs/new.md", "D\tapps/web/src/gone.tsx"].join("\n"),
    );
    const result = selectChecks({ files });
    assert.ok(result.selected.includes("docs"));
    assert.ok(result.selected.includes("web"));
  });

  it("multi-commit push range is the full before/after file set", () => {
    const files = parseNameStatus(
      ["M\tdocs/a.md", "M\tpackages/contracts/src/index.ts"].join("\n"),
    );
    const result = selectChecks({ files, base: "aaa", head: "ccc" });
    assert.equal(result.mode, "selective");
    for (const job of CHECK_JOBS) assert.ok(result.selected.includes(job));
  });

  it("empty diff is not docs-only success", () => {
    const result = selectChecks({ files: [], mode: "selective" });
    assert.equal(result.mode, "full");
    assert.match(Object.values(result.reasons).join(" "), /no valid changed-file/);
    for (const job of CHECK_JOBS) assert.ok(result.selected.includes(job));
  });

  it("full mode selects every job", () => {
    const result = selectChecks({ mode: "full", forceReason: "daily" });
    assert.deepEqual(result.selected, ALL_JOBS);
  });
});

describe("GitHub events", () => {
  it("pull_request uses three-dot base...head", () => {
    let compared = null;
    const result = resolveGitHubSelection(
      {
        GITHUB_EVENT_NAME: "pull_request",
        PR_BASE: "base123",
        PR_HEAD: "head456",
      },
      {
        nameStatus() {
          throw new Error("push-style diff should not run for PRs");
        },
        threeDot(base, head) {
          compared = `${base}...${head}`;
          return "M\tdocs/privacy.md\n";
        },
      },
    );
    assert.equal(compared, "base123...head456");
    assert.deepEqual(result.selected, ["docs"]);
  });

  it("main push uses before/after, not HEAD~1", () => {
    let compared = null;
    const result = resolveGitHubSelection(
      {
        GITHUB_EVENT_NAME: "push",
        EVENT_BEFORE: "before111",
        EVENT_AFTER: "after222",
      },
      {
        nameStatus(base, head) {
          compared = `${base} ${head}`;
          return "M\tapps/web/src/App.tsx\n";
        },
        threeDot() {
          throw new Error("three-dot should not run for push");
        },
      },
    );
    assert.equal(compared, "before111 after222");
    assert.ok(result.selected.includes("web"));
    assert.equal(result.selected.includes("worker-chain"), false);
  });

  it("zero before SHA on push becomes full, not docs-only", () => {
    const result = resolveGitHubSelection({
      GITHUB_EVENT_NAME: "push",
      EVENT_BEFORE: ZERO_SHA,
      EVENT_AFTER: "abc",
    });
    assert.equal(result.mode, "full");
  });

  it("schedule and dispatch full force every job", () => {
    const scheduled = resolveGitHubSelection({ GITHUB_EVENT_NAME: "schedule", GITHUB_SHA: "abc" });
    assert.equal(scheduled.mode, "full");
    const dispatched = resolveGitHubSelection({
      GITHUB_EVENT_NAME: "workflow_dispatch",
      MODE_INPUT: "full",
      GITHUB_SHA: "abc",
    });
    assert.equal(dispatched.mode, "full");
  });

  it("unreadable PR SHAs throw instead of succeeding as docs", () => {
    assert.throws(
      () =>
        resolveGitHubSelection({
          GITHUB_EVENT_NAME: "pull_request",
          PR_BASE: "",
          PR_HEAD: "",
        }),
      /missing base\/head/,
    );
  });

  it("git diff failure is not converted to docs-only", () => {
    assert.throws(
      () =>
        gitNameStatus("abc", "def", () => {
          throw new Error("fatal: bad revision");
        }),
      /bad revision/,
    );
  });
});

describe("workflow contract", () => {
  const yaml = readFileSync(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8");

  it("push is limited to main so feature-branch pushes do not duplicate PR runs", () => {
    assert.match(yaml, /push:\n\s+branches:\s*\[main\]/);
    assert.doesNotMatch(yaml, /on:\n\s+push:\n\s+pull_request:/);
  });

  it("keeps pull_request, daily schedule, and workflow_dispatch full", () => {
    assert.match(yaml, /pull_request:/);
    assert.match(yaml, /schedule:/);
    assert.match(yaml, /workflow_dispatch:/);
    assert.match(yaml, /cron: "17 3 \* \* \*"/);
  });

  it("cancels only overlapping PR runs", () => {
    assert.match(yaml, /cancel-in-progress: \$\{\{\s*github\.event_name == 'pull_request'\s*\}\}/);
  });

  it("splits worker-chain from agentscope and always exposes CI result", () => {
    assert.match(yaml, /name: CI result/);
    assert.match(yaml, /name: worker-chain/);
    const agentscopeBlock = yaml.split("\n  worker-chain:")[0].split("\n  agentscope:")[1] ?? "";
    assert.equal(agentscopeBlock.includes("pnpm test:worker-chain"), false);
    assert.match(yaml, /pnpm test:worker-chain/);
  });

  it("publishes the runtime image only on in-scope main pushes", () => {
    assert.match(
      yaml,
      /push: \$\{\{\s*github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'\s*\}\}/,
    );
  });

  it("runs the effect execution fence suites in backend and DB jobs", () => {
    const backend = yaml.split("\n  backend:")[1]?.split("\n  db-postgres:")[0] ?? "";
    for (const file of [
      "approval-effect.test.ts",
      "executor-effect-idempotency.test.ts",
      "executor-readonly-approval.test.ts",
      "manual-retry-reuse.test.ts",
    ]) {
      assert.match(backend, new RegExp(`packages/adapters/src/${file.replaceAll(".", "\\.")}`));
    }
  });

  it("runs every DB postgres suite against a real postgres service", () => {
    const block = yaml.split("\n  db-postgres:")[1]?.split("\n  runtime-jar:")[0] ?? "";
    assert.match(block, /image: postgres:16/);
    assert.match(block, /VERIFY_DATABASE: "1"/);
    assert.match(block, /pnpm --filter @rakazo\/db exec prisma migrate deploy/);
    assert.match(block, /packages\/db\/src\/\*\.postgres\.test\.ts/);
    assert.match(block, /--no-file-parallelism/);
    assert.match(yaml, /RESULT_DB_POSTGRES: \$\{\{\s*needs\.db-postgres\.result\s*\}\}/);
  });
});

describe("large selection transport", () => {
  it("keeps job env bounded while preserving every path in the artifact", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ci-selection-"));
    try {
      const files = Array.from({ length: 3000 }, (_, i) => `docs/${"long-path-".repeat(8)}${i}.md`);
      const result = selectChecks({ files, mode: "selective" });
      const file = path.join(dir, "selection.json");
      const block = writeGitHubOutput(result, { SELECT_RESULT_PATH: file });
      const payload = block.split("result<<__CI01_RESULT__\n")[1].split("\n__CI01_RESULT__")[0];
      assert.ok(Buffer.byteLength(payload) < 2048);
      assert.deepEqual(JSON.parse(payload).selected, result.selected);
      assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).files, files);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
