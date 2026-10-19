import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALL_JOBS,
  CHECK_JOBS,
  ZERO_SHA,
  classifyPath,
  gitNameStatus,
  parseNameStatus,
  resolveGitHubSelection,
  selectChecks,
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
  assert.deepEqual(got, ALL_JOBS.filter((job) => expected.includes(job)));
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
      "packages/adapter-kit/src/background-jobs.ts",
      "apps/web/e2e/worker-chain.spec.ts",
    ]) {
      const jobs = classifyPath(file).jobs;
      assert.ok(jobs.includes("worker-chain"), file);
      assert.equal(jobs.includes("web"), false, file);
    }
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

  it("maps Java execution/recovery sources to worker-chain as well", () => {
    const result = classifyPath(
      "services/agent-runtime/src/main/java/com/workpal/runtime/RuntimeEngine.java",
    );
    assert.ok(result.jobs.includes("worker-chain"));
    assert.ok(result.jobs.includes("agent-runtime-image"));
  });

  it("maps TS adapters to backend + agentscope, not worker-chain", () => {
    const result = classifyPath("packages/adapters/src/executor.ts");
    assert.ok(result.jobs.includes("backend"));
    assert.ok(result.jobs.includes("agentscope"));
    assert.equal(result.jobs.includes("worker-chain"), false);
    assert.equal(result.jobs.includes("web"), false);
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
});
