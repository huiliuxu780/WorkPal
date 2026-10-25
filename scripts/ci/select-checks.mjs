#!/usr/bin/env node
/**
 * Central CI check selector. Path → consumer → jobs lives here, not in workflow `if:`s.
 *
 *   node scripts/ci/select-checks.mjs --files README.md apps/web/src/App.tsx
 *   node scripts/ci/select-checks.mjs --base <sha> --head <sha>
 *   node scripts/ci/select-checks.mjs --github
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { testPathTraits } from "../testing/test-inventory.mjs";

export const ZERO_SHA = "0".repeat(40);

/** Jobs a developer can see as selected/skipped. runtime-jar is implied. */
export const CHECK_JOBS = [
  "docs",
  "harness",
  "web",
  "backend",
  "db-postgres",
  "agentscope",
  "worker-chain",
  "agent-runtime-image",
];

export const ALL_JOBS = [...CHECK_JOBS, "runtime-jar"];

const FULL_JOBS = [...ALL_JOBS];

const DEFAULT_WEB_E2E = ["ui-appearance.spec.ts", "settings-shell.spec.ts"];
const AVATAR_WEB_E2E = [
  "avatar-style.spec.ts",
  "avatar-group.spec.ts",
  "avatar-motion.spec.ts",
  "avatar-studio.spec.ts",
  "avatar-bot-change.spec.ts",
];
const EXECUTION_WEB_E2E = ["execution-card.spec.ts", "task-center.spec.ts"];
const MESSAGE_GROUP_WEB_E2E = ["message-group.spec.ts", ...DEFAULT_WEB_E2E];
const ONBOARDING_WEB_E2E = [
  "onboarding-conversation.spec.ts",
  "onboarding-model-auto-skip.spec.ts",
  "login-card.spec.ts",
];

const ROOT_DOC_FILES = new Set([
  "README.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "AGENTS.md",
  "CLAUDE.md",
  "LICENSE",
  "SECURITY.md",
  "SETUP_PROMPT.md",
  "VISION.md",
  "bot-context-assembly.png",
]);

const GLOBAL_BUILD_FILES = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "turbo.json",
  "tsconfig.base.json",
  "biome.json",
  "vitest.config.ts",
  "skills-lock.json",
]);

const SOURCE_EXT =
  /\.(?:ts|tsx|js|jsx|mjs|cjs|java|json|ya?ml|xml|sql|prisma|css|scss|html|vue|toml|properties|proto|gradle|kts|lock|sh|ps1|Dockerfile)$/i;

const WORKER_ADAPTER_STEMS = [
  "packages/adapters/src/job-reconciler",
  "packages/adapters/src/wakeup",
  "packages/adapters/src/wakeup-graphile-host",
  "packages/adapters/src/result-delivery",
  "packages/adapters/src/background-job-handlers",
  "packages/adapters/src/lease-loss-recovery",
  "packages/adapters/src/worker-artifacts",
];

const WORKER_DB_STEMS = [
  "packages/db/src/run-lease",
  "packages/db/src/delivery-records",
  "packages/db/src/retry-runs",
  "packages/db/src/cancel-runs",
  "packages/db/src/cancel-child-runs",
  "packages/db/src/promote-run",
  "packages/db/src/background-task-registration",
  "packages/db/src/wait-timeouts",
  "packages/db/src/execution-revocations",
  "packages/db/src/execution-fence",
  "packages/db/src/external-effects",
];

const CORE_WEB_STEMS = [
  "packages/core/src/avatar-motion",
  "packages/core/src/avatar-shape",
  "packages/core/src/bot-avatar-colors",
  "packages/core/src/bot-avatar-shapes",
  "packages/core/src/composer-mention-picker",
  "packages/core/src/composer-mentions",
  "packages/core/src/composer-slash",
  "packages/core/src/markdown-plain",
  "packages/core/src/text-direction",
  "packages/core/src/message-quote",
  "packages/core/src/message-reactions",
  "packages/core/src/message-visibility",
  "packages/core/src/message-pages",
];

const CORE_RUNTIME_STEMS = [
  "packages/core/src/run-budget",
  "packages/core/src/run-state",
  "packages/core/src/retry-policy",
  "packages/core/src/action-approval",
  "packages/core/src/capability-rules",
  "packages/core/src/events",
  "packages/core/src/screen-lease",
  "packages/core/src/sandbox-command",
  "packages/core/src/approval-effect-key",
  "packages/core/src/agent-skill",
  "packages/core/src/teach-playbook",
  "packages/core/src/teach-recording",
];

const JAVA_WORKER_FILES = new Set([
  "services/agent-runtime/pom.xml",
  "services/agent-runtime/Dockerfile",
  "services/agent-runtime/src/main/java/com/workpal/runtime/RuntimeEngine.java",
  "services/agent-runtime/src/main/java/com/workpal/runtime/RuntimeServer.java",
  "services/agent-runtime/src/main/java/com/workpal/runtime/InterruptibleTaskRepository.java",
  "services/agent-runtime/src/main/java/com/workpal/runtime/ToolBridgeClient.java",
  "services/agent-runtime/src/main/java/com/workpal/runtime/ToolSurfaceRefresh.java",
  "services/agent-runtime/src/main/java/com/workpal/runtime/RuntimeHealthcheck.java",
]);

export function normalizePath(file) {
  return file.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

export function isUnder(file, dir) {
  const p = normalizePath(file);
  const d = normalizePath(dir);
  return p === d || p.startsWith(`${d}/`);
}

export function stemMatch(file, stem) {
  const p = normalizePath(file);
  const s = normalizePath(stem);
  return p === s || p.startsWith(`${s}.`);
}

function anyStem(file, stems) {
  return stems.some((stem) => stemMatch(file, stem));
}

function isSourceLike(file) {
  const base = path.posix.basename(file);
  if (base === "Dockerfile" || base.startsWith("Dockerfile.")) return true;
  if (SOURCE_EXT.test(base)) return true;
  if (isUnder(file, "scripts") || isUnder(file, "infra") || isUnder(file, "services")) return true;
  return false;
}

/**
 * Classify one path. First matching rule wins. Unknown source forces full.
 * @returns {{ jobs: string[], reason: string, webE2e: string[] }}
 */
export function classifyPath(file) {
  const p = normalizePath(file);

  if (
    isUnder(p, ".github/workflows") ||
    isUnder(p, ".github/actions") ||
    isUnder(p, "scripts/ci")
  ) {
    return full("CI selector or workflow change forces full verification");
  }

  if (GLOBAL_BUILD_FILES.has(p)) {
    return full("global lockfile or build setting");
  }

  if (isUnder(p, "packages/contracts")) {
    return full("shared contracts expand to every consumer");
  }

  if (isUnder(p, "packages/db/prisma")) {
    return full("database schema/migrations are cross-layer");
  }

  if (isUnder(p, "prompts")) {
    return {
      jobs: ["agentscope", "agent-runtime-image"],
      reason: "prompts/ is runtime source, not documentation",
      webE2e: [],
    };
  }

  if (
    p === "apps/web/e2e/worker-chain.spec.ts" ||
    p === "packages/testkit/src/cli/worker-chain.ts"
  ) {
    return {
      jobs: ["backend", "worker-chain"],
      reason: "Worker production-chain harness",
      webE2e: [],
    };
  }

  if (
    p === "packages/testkit/src/cli/harness.ts" ||
    p === "packages/testkit/src/cli/process.ts" ||
    p === "packages/testkit/src/cli/java-runtime.ts"
  ) {
    return full("shared test harness used by every execution job");
  }

  if (
    stemMatch(p, "packages/adapters/src/agentscope") ||
    stemMatch(p, "packages/adapters/src/turnpolicy-v2-agentscope") ||
    stemMatch(p, "packages/testkit/src/agentscope") ||
    stemMatch(p, "packages/testkit/src/history-compaction-agentscope") ||
    p === "apps/web/e2e/agentscope-product.spec.ts" ||
    p === "apps/web/e2e/budget-acceptance.spec.ts" ||
    p === "apps/web/e2e/capability-rules.spec.ts"
  ) {
    return {
      jobs: ["backend", "agentscope"],
      reason: "AgentScope request integration, PG journey, or product E2E spec",
      webE2e: [],
    };
  }

  if (
    stemMatch(p, "packages/core/src/run-budget") ||
    stemMatch(p, "packages/adapters/src/run-budget-enforcement")
  ) {
    return {
      jobs: ["backend", "agentscope", "worker-chain"],
      reason: "budget enforcement is consumed by both executor and standalone Worker",
      webE2e: [],
    };
  }

  if (
    isUnder(p, "apps/worker") ||
    anyStem(p, WORKER_ADAPTER_STEMS) ||
    anyStem(p, WORKER_DB_STEMS)
  ) {
    return {
      jobs: ["backend", "worker-chain", "db-postgres"],
      reason: "Worker process, lease, outbox, or Graphile handoff",
      webE2e: [],
    };
  }

  if (stemMatch(p, "packages/adapter-kit/src/background-jobs")) {
    return {
      jobs: ["backend", "worker-chain"],
      reason: "job keys consumed by the standalone Worker",
      webE2e: [],
    };
  }

  if (JAVA_WORKER_FILES.has(p)) {
    return {
      jobs: ["agentscope", "worker-chain", "agent-runtime-image"],
      reason: "Java runtime execution/recovery path and image context",
      webE2e: [],
    };
  }

  if (isUnder(p, "services/agent-runtime")) {
    return {
      jobs: ["agentscope", "agent-runtime-image"],
      reason: "Java AgentScope runtime or its image build context",
      webE2e: [],
    };
  }

  // The cross-session group handoff only exists behind the message_group gate;
  // its receipt, contract, and adapter paths must run the closed-loop spec.
  if (
    stemMatch(p, "packages/adapters/src/message-group") ||
    stemMatch(p, "packages/core/src/roundtable-contracts") ||
    stemMatch(p, "packages/core/src/roundtable-feature-gates")
  ) {
    return {
      jobs: ["backend", "agentscope", "db-postgres", "web"],
      reason: "message_group delivery, receipt, and return path",
      webE2e: MESSAGE_GROUP_WEB_E2E,
    };
  }

  if (
    isUnder(p, "apps/web") ||
    isUnder(p, "packages/ui-web") ||
    isUnder(p, "packages/ui-tokens") ||
    isUnder(p, "packages/chat-ui")
  ) {
    return {
      jobs: ["web"],
      reason: "pure UI surface (web / ui-web / ui-tokens / chat-ui)",
      webE2e: webE2eFor(p),
    };
  }

  if (anyStem(p, CORE_WEB_STEMS)) {
    return {
      jobs: ["web"],
      reason: "core helper consumed by the web UI",
      webE2e: webE2eFor(p),
    };
  }

  if (
    anyStem(p, CORE_RUNTIME_STEMS) ||
    isUnder(p, "packages/core/src/product-harness") ||
    isUnder(p, "packages/core/src/node")
  ) {
    return {
      jobs: ["backend", "agentscope"],
      reason: "core runtime/execution helper",
      webE2e: [],
    };
  }

  if (isUnder(p, "packages/core")) {
    return {
      jobs: ["web", "backend"],
      reason: "shared core helper used by UI and backend",
      webE2e: DEFAULT_WEB_E2E,
    };
  }

  if (isUnder(p, "packages/db/src") && p.includes("avatar")) {
    return {
      jobs: ["web", "backend"],
      reason: "avatar persistence consumed by web and API",
      webE2e: AVATAR_WEB_E2E,
    };
  }

  // FIX-127: the Task instruction envelope pins what a resumed Run re-reads
  // after an answered ask, and the executor's ask/resume path (including the
  // scripted fixtures it plays back) decides whether the resumed Run asks
  // again or continues. Those regressions are only caught by the Execution
  // Card ask flow, so they must select it (issue #127 CI blind spot).
  if (
    stemMatch(p, "packages/db/src/task-instructions") ||
    stemMatch(p, "packages/adapters/src/executor") ||
    stemMatch(p, "packages/adapters/src/scripted-runtime")
  ) {
    const jobs = stemMatch(p, "packages/db/src/task-instructions")
      ? ["backend", "agentscope", "db-postgres", "web"]
      : ["backend", "agentscope", "web"];
    return {
      jobs,
      reason: "answered-ask resume path drives the Execution Card ask flow",
      webE2e: EXECUTION_WEB_E2E,
    };
  }

  if (isUnder(p, "packages/db")) {
    return {
      jobs: ["backend", "agentscope", "db-postgres"],
      reason: "database access layer used by API, Worker, and journeys",
      webE2e: [],
    };
  }

  if (
    isUnder(p, "packages/testkit/src/resources") ||
    isUnder(p, "packages/testkit/src/cli/resources")
  ) {
    return {
      jobs: ["harness", "backend", "agentscope"],
      reason: "worktree resource planner and agent doctor",
      webE2e: [],
    };
  }

  if (
    isUnder(p, "packages/adapters") ||
    isUnder(p, "packages/adapter-kit") ||
    isUnder(p, "apps/api") ||
    isUnder(p, "packages/auth") ||
    isUnder(p, "packages/memory") ||
    isUnder(p, "packages/logging") ||
    isUnder(p, "packages/testkit")
  ) {
    return {
      jobs: ["backend", "agentscope"],
      reason: "TS adapter, API, auth, memory, or testkit — AgentScope request path",
      webE2e: [],
    };
  }

  if (isUnder(p, ".github/ISSUE_TEMPLATE") || isUnder(p, "docs") || ROOT_DOC_FILES.has(p)) {
    return {
      jobs: ["docs"],
      reason: "documentation or non-build explanation file",
      webE2e: [],
    };
  }

  if (isUnder(p, "infra") || isUnder(p, "scripts") || isUnder(p, ".github")) {
    return full("infra/scripts/github path is not a narrow consumer; run full");
  }

  if (isSourceLike(p)) {
    return full(`unclassified source ${p} — add a rule in scripts/ci/select-checks.mjs`);
  }

  if (/\.(?:md|markdown|txt|png|jpe?g|gif|webp)$/i.test(p)) {
    return {
      jobs: ["docs"],
      reason: "unclassified documentation or media outside a runtime consumer",
      webE2e: [],
    };
  }

  return full(`unclassified path ${p} — add a rule in scripts/ci/select-checks.mjs`);
}

function full(reason) {
  return { full: true, jobs: [...FULL_JOBS], reason, webE2e: [...DEFAULT_WEB_E2E] };
}

const WEB_E2E_DIR = "apps/web/e2e";
const WEB_E2E_FIXTURES = "apps/web/e2e/fixtures";
const EXCLUSIVE_WEB_SPECS = new Set([
  "agentscope-product.spec.ts",
  "budget-acceptance.spec.ts",
  "capability-rules.spec.ts",
  "worker-chain.spec.ts",
]);

/** Basename of a scripted-runtime web spec. AgentScope/Worker/fixtures/helpers return null. */
export function executableWebSpecName(file) {
  const p = normalizePath(file);
  if (!isUnder(p, WEB_E2E_DIR) || isUnder(p, WEB_E2E_FIXTURES)) return null;
  if (!/\.spec\.tsx?$/.test(p)) return null;
  const name = path.posix.basename(p);
  if (EXCLUSIVE_WEB_SPECS.has(name)) return null;
  return name;
}

function mappedWebE2e(file) {
  if (
    isUnder(file, "packages/ui-web/src/agent-avatar") ||
    stemMatch(file, "packages/ui-web/src/bot-avatar") ||
    stemMatch(file, "packages/ui-web/src/group-avatar") ||
    isUnder(file, "docs/avatar")
  ) {
    return AVATAR_WEB_E2E;
  }
  if (file.includes("GroupDestinationReceipt")) return MESSAGE_GROUP_WEB_E2E;
  if (
    isUnder(file, "apps/web/src/components/ai") ||
    file.includes("execution") ||
    file.includes("task-center")
  ) {
    return EXECUTION_WEB_E2E;
  }
  if (file.includes("onboarding") || isUnder(file, "apps/web/src/pages")) {
    return ONBOARDING_WEB_E2E;
  }
  return DEFAULT_WEB_E2E;
}

/**
 * Product-path mapping, unioned with the changed executable spec itself.
 * AgentScope and Worker exclusive specs never reach this (classified earlier).
 */
function webE2eFor(file) {
  const mapped = mappedWebE2e(file);
  const specName = executableWebSpecName(file);
  if (!specName) return mapped;
  return unique([specName, ...mapped]);
}

export function parseNameStatus(text) {
  const files = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const status = parts[0] ?? "";
    if (status.startsWith("R") || status.startsWith("C")) {
      if (parts[1]) files.push(normalizePath(parts[1]));
      if (parts[2]) files.push(normalizePath(parts[2]));
      continue;
    }
    if (parts[1]) files.push(normalizePath(parts[1]));
  }
  return unique(files);
}

export function unique(items) {
  return [...new Set(items)];
}

function implyRuntimeJar(jobs) {
  const set = new Set(jobs);
  if (set.has("agentscope") || set.has("worker-chain")) set.add("runtime-jar");
  return [...ALL_JOBS].filter((job) => set.has(job));
}

/**
 * @param {{ files?: string[], mode?: "selective" | "full", forceReason?: string, base?: string, head?: string }} input
 */
export function selectChecks(input) {
  const base = input.base ?? null;
  const head = input.head ?? null;

  if (input.mode === "full") {
    const reason = input.forceReason ?? "full verification requested";
    return buildResult({
      mode: "full",
      files: input.files ?? [],
      selected: [...FULL_JOBS],
      reasons: { "*": reason },
      webE2e: [...DEFAULT_WEB_E2E],
      base,
      head,
      harnessMode: "full",
    });
  }

  const files = unique((input.files ?? []).map(normalizePath));
  if (files.length === 0) {
    return buildResult({
      mode: "full",
      files,
      selected: [...FULL_JOBS],
      reasons: {
        "*": "no valid changed-file list; refusing to treat that as docs-only",
      },
      webE2e: [...DEFAULT_WEB_E2E],
      base,
      head,
      harnessMode: "full",
    });
  }

  const selected = new Set();
  const reasons = {};
  const webE2e = new Set();
  const fileReasons = [];
  let harnessMode = null;
  let sawUnitChange = false;
  let forceHarnessFull = false;

  for (const file of files) {
    const classified = classifyPath(file);
    const traits = testPathTraits(file);
    const jobs = [...classified.jobs];
    if (traits.isPostgres && !jobs.includes("db-postgres")) jobs.push("db-postgres");
    for (const job of jobs) selected.add(job);
    for (const spec of classified.webE2e) webE2e.add(spec);
    fileReasons.push({ file, jobs, reason: classified.reason });
    if (!reasons[jobs.join("+")]) {
      reasons[jobs.join("+")] = `${file}: ${classified.reason}`;
    }
    if (classified.full) forceHarnessFull = true;
    if (traits.isUnit) sawUnitChange = true;
    const docsOnly = jobs.length === 1 && jobs[0] === "docs";
    if (!docsOnly || traits.isTest) {
      selected.add("harness");
      harnessMode = harnessMode ?? "inventory";
    }
  }
  if (harnessMode) {
    harnessMode = forceHarnessFull ? "full" : sawUnitChange ? "unit" : "inventory";
  }

  return buildResult({
    mode: "selective",
    files,
    selected: implyRuntimeJar([...selected]),
    reasons,
    webE2e: [...webE2e],
    base,
    head,
    fileReasons,
    harnessMode,
  });
}

function buildResult({
  mode,
  files,
  selected,
  reasons,
  webE2e,
  base,
  head,
  fileReasons,
  harnessMode,
}) {
  const selectedSet = new Set(implyRuntimeJar(selected));
  const selectedJobs = ALL_JOBS.filter((job) => selectedSet.has(job));
  const skippedJobs = ALL_JOBS.filter((job) => !selectedSet.has(job));
  const webE2eSpec = selectedSet.has("web")
    ? (webE2e.length ? unique(webE2e) : DEFAULT_WEB_E2E).join("|")
    : "";

  const result = {
    mode,
    base,
    head,
    files,
    selected: selectedJobs,
    skipped: skippedJobs,
    reasons,
    fileReasons: fileReasons ?? [],
    webE2eSpec,
    harnessMode: selectedSet.has("harness") ? (harnessMode ?? "inventory") : null,
    flags: Object.fromEntries(ALL_JOBS.map((job) => [job, selectedSet.has(job)])),
  };
  result.summary = formatSummary(result);
  return result;
}

export function formatSummary(result) {
  const lines = [
    `## CI check selection`,
    ``,
    `- Mode: \`${result.mode}\``,
    `- Compare: \`${result.base ?? "(none)"}\` → \`${result.head ?? "(none)"}\``,
    `- Changed files: ${result.files.length}`,
    `- Selected: ${result.selected.join(", ") || "(none)"}`,
    `- Skipped: ${result.skipped.join(", ") || "(none)"}`,
  ];
  if (result.webE2eSpec) lines.push(`- Focused web E2E: \`${result.webE2eSpec}\``);
  if (result.harnessMode) lines.push(`- H1 harness mode: \`${result.harnessMode}\``);
  lines.push(``, `### Why`);
  for (const [key, reason] of Object.entries(result.reasons)) {
    lines.push(`- **${key}**: ${reason}`);
  }
  if (result.fileReasons?.length) {
    lines.push(
      ``,
      `<details><summary>Per-file mapping (${result.fileReasons.length})</summary>`,
      ``,
    );
    for (const row of result.fileReasons.slice(0, 80)) {
      lines.push(`- \`${row.file}\` → ${row.jobs.join(", ")} — ${row.reason}`);
    }
    if (result.fileReasons.length > 80) {
      lines.push(`- … ${result.fileReasons.length - 80} more`);
    }
    lines.push(``, `</details>`);
  }
  return `${lines.join("\n")}\n`;
}

export function isZeroSha(sha) {
  return !sha || /^0+$/.test(sha);
}

export function gitNameStatus(base, head, run = runGit) {
  if (isZeroSha(base)) {
    throw new Error("refusing empty/zero before SHA (new branch or missing history)");
  }
  if (!head) throw new Error("missing head SHA");
  try {
    return run(["diff", "--name-status", "-M", base, head]);
  } catch (first) {
    try {
      run(["fetch", "--no-tags", "--depth=1", "origin", base, head]);
    } catch {
      throw first;
    }
    return run(["diff", "--name-status", "-M", base, head]);
  }
}

export function gitNameStatusThreeDot(base, head, run = runGit) {
  if (isZeroSha(base)) {
    throw new Error("refusing empty/zero base SHA");
  }
  if (!head) throw new Error("missing head SHA");
  try {
    return run(["diff", "--name-status", "-M", `${base}...${head}`]);
  } catch (first) {
    try {
      run(["fetch", "--no-tags", "--depth=1", "origin", base, head]);
    } catch {
      throw first;
    }
    return run(["diff", "--name-status", "-M", `${base}...${head}`]);
  }
}

function runGit(args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

/**
 * Resolve what to compare from GitHub Actions env.
 * Fail closed: unknown events and unreadable SHAs become full or throw.
 */
export function resolveGitHubSelection(
  env,
  git = { nameStatus: gitNameStatus, threeDot: gitNameStatusThreeDot },
) {
  const event = env.GITHUB_EVENT_NAME ?? env.EVENT_NAME ?? "";
  const modeInput = env.MODE_INPUT || "";
  const sha = env.GITHUB_SHA ?? env.EVENT_AFTER ?? "";

  if (
    event === "schedule" ||
    modeInput === "full" ||
    (event === "workflow_dispatch" && modeInput !== "selective")
  ) {
    const reason =
      event === "schedule"
        ? "daily scheduled full verification"
        : "workflow_dispatch full verification";
    return selectChecks({ mode: "full", forceReason: reason, base: null, head: sha || null });
  }

  if (event === "pull_request" || event === "pull_request_target") {
    const base = env.PR_BASE ?? "";
    const head = env.PR_HEAD ?? sha;
    if (isZeroSha(base) || !head) {
      throw new Error("pull_request event is missing base/head SHA");
    }
    const files = parseNameStatus(git.threeDot(base, head));
    return selectChecks({ files, mode: "selective", base, head });
  }

  if (event === "push") {
    const before = env.EVENT_BEFORE ?? env.GITHUB_EVENT_BEFORE ?? "";
    const after = env.EVENT_AFTER ?? sha;
    if (isZeroSha(before)) {
      return selectChecks({
        mode: "full",
        forceReason: "push has a zero before SHA (first branch commit); running full",
        base: before || ZERO_SHA,
        head: after || null,
      });
    }
    const files = parseNameStatus(git.nameStatus(before, after));
    return selectChecks({ files, mode: "selective", base: before, head: after });
  }

  if (event === "workflow_dispatch" && modeInput === "selective") {
    const base = env.MAIN_SHA ?? "";
    const head = sha;
    if (isZeroSha(base) || !head) {
      throw new Error("selective dispatch needs MAIN_SHA and GITHUB_SHA");
    }
    const files = parseNameStatus(git.threeDot(base, head));
    return selectChecks({ files, mode: "selective", base, head });
  }

  throw new Error(`unrecognized GitHub event '${event}' — refusing to guess docs-only`);
}

export function writeGitHubOutput(result, env = process.env) {
  const outputPath = env.GITHUB_OUTPUT;
  const summaryPath = env.GITHUB_STEP_SUMMARY;
  const flags = result.flags;
  const kv = ALL_JOBS.map((job) => `${job.replaceAll("-", "_")}=${flags[job] ? "true" : "false"}`);
  const block = [
    ...kv,
    `mode=${result.mode}`,
    `harness_mode=${result.harnessMode ?? ""}`,
    `web_e2e_spec=${result.webE2eSpec}`,
    `result<<__CI01_RESULT__`,
    JSON.stringify({ mode: result.mode, selected: result.selected, flags: result.flags }),
    `__CI01_RESULT__`,
    "",
  ].join("\n");
  if (env.SELECT_RESULT_PATH) writeFileSync(env.SELECT_RESULT_PATH, JSON.stringify(result));
  if (outputPath) appendFileSync(outputPath, block);
  if (summaryPath) appendFileSync(summaryPath, result.summary);
  return block;
}

function parseArgs(argv) {
  const args = { files: [], base: null, head: null, github: false, format: "json" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--github") args.github = true;
    else if (arg === "--format") args.format = argv[++i];
    else if (arg === "--base") args.base = argv[++i];
    else if (arg === "--head") args.head = argv[++i];
    else if (arg === "--files") continue;
    else if (arg.startsWith("-")) throw new Error(`unknown flag ${arg}`);
    else args.files.push(arg);
  }
  return args;
}

function main(argv = process.argv.slice(2), env = process.env, stdout = console) {
  const args = parseArgs(argv);
  let result;
  if (args.github) {
    result = resolveGitHubSelection(env);
  } else if (args.base || args.head) {
    if (!args.base || !args.head) throw new Error("--base and --head are both required");
    const files = parseNameStatus(gitNameStatus(args.base, args.head));
    result = selectChecks({ files, mode: "selective", base: args.base, head: args.head });
  } else {
    result = selectChecks({ files: args.files, mode: "selective" });
  }
  if (args.github) writeGitHubOutput(result, env);
  if (args.format === "summary") stdout.log(result.summary);
  else stdout.log(JSON.stringify(result, null, 2));
  return result;
}

function isMainModule() {
  return (
    Boolean(process.argv[1]) &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  );
}

if (isMainModule()) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

export { main };
