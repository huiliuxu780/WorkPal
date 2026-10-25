#!/usr/bin/env node
/**
 * Machine-checked test inventory.
 *
 * Every tracked `*.test.ts(x)` file must have one explicit execution entry.
 * Ordinary unit tests use the default rule; PostgreSQL, Java, Docker, live,
 * process-level, and specialized tests are listed explicitly so a new external
 * dependency cannot silently land in `test:unit`.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const TEST_FILE_PATTERNS = ["*.test.ts", "*.test.tsx", "*.test.mjs"];
export const ROOT = path.resolve(import.meta.dirname, "../..");

export const CATEGORY_DEFINITIONS = {
  "unit-node": {
    environment: "Node",
    entry: "unit",
    requires: [],
    description: "Pure Node test with no external service or process dependency.",
  },
  "unit-jsdom": {
    environment: "jsdom (Node)",
    entry: "unit",
    requires: [],
    description: "Vitest jsdom environment; no browser process.",
  },
  postgres: {
    environment: "PostgreSQL",
    entry: "postgres",
    requires: ["postgres"],
    description: "Requires VERIFY_DATABASE=1 and a migrated DATABASE_URL.",
  },
  "integration-harness": {
    environment: "PostgreSQL + app + JDK 21 (Testcontainers)",
    entry: "integration",
    requires: ["docker", "jdk", "postgres"],
    description: "Runs through packages/testkit/src/cli/harness.ts --integration.",
  },
  "agentscope-request": {
    environment: "JDK 21 AgentScope runtime",
    entry: "agentscope",
    requires: ["jdk"],
    description: "Runs in the CI agentscope job against the real Java runtime.",
  },
  "computer-replay-java": {
    environment: "JDK 21 + Maven",
    entry: "computer-replay-java",
    requires: ["jdk", "maven"],
    description: "Starts the local Java runtime directly from the test file.",
  },
  "computer-replay-cli": {
    environment: "JDK 21 + Docker",
    entry: "computer-replay-cli",
    requires: ["jdk", "docker"],
    description: "Runs through pnpm test:computer-replay.",
  },
  "docker-manual": {
    environment: "Docker",
    entry: "docker-manual",
    requires: ["docker"],
    description: "Opt-in Docker/Compose check with an explicit local command.",
  },
  "live-canary": {
    environment: "live provider credentials",
    entry: "canary",
    requires: ["live-credentials"],
    description: "Runs through pnpm test:canary with real provider keys.",
  },
  "live-computer": {
    environment: "live model + sandbox credentials",
    entry: "computer",
    requires: ["live-credentials", "sandbox"],
    description: "Runs through pnpm test:computer with a real model and sandbox.",
  },
  process: {
    environment: "local process tools",
    entry: "process",
    requires: ["local-process-tools"],
    description: "Spawns local shells, scripts, PTYs, or helper binaries.",
  },
  "node-test": {
    environment: "Node (node:test)",
    entry: "ci-self-check",
    requires: [],
    description: "Node's built-in test runner outside Vitest.",
  },
};

export const ENTRYPOINTS = {
  unit: {
    command: "pnpm test:unit",
    kind: "script",
    ciJob: "harness",
    requires: [],
    scriptIncludes: "vitest.unit.config.ts",
    configFile: "vitest.unit.config.ts",
  },
  postgres: {
    command: "pnpm test:postgres",
    kind: "script",
    ciJob: "db-postgres",
    requires: ["postgres"],
    scriptIncludes: "run-test-group.mjs postgres",
  },
  process: {
    command: "pnpm test:process",
    kind: "script",
    ciJob: null,
    requires: ["local-process-tools"],
    scriptIncludes: "run-test-group.mjs process",
  },
  integration: {
    command: "pnpm test:integration --spec=<file>",
    kind: "harness",
    ciJob: null,
    source: "packages/testkit/src/cli/harness.ts",
    requires: ["docker", "jdk", "postgres"],
  },
  agentscope: {
    command: "agentscope CI job",
    kind: "ci",
    ciJob: "agentscope",
    requires: ["jdk"],
  },
  "computer-replay-java": {
    command: "pnpm exec vitest run <file>",
    kind: "vitest",
    ciJob: null,
    requires: ["jdk", "maven"],
  },
  "computer-replay-cli": {
    command: "pnpm test:computer-replay",
    kind: "cli",
    ciJob: null,
    source: "packages/testkit/src/cli/computer-replay.ts",
    requires: ["jdk", "docker"],
  },
  canary: {
    command: "pnpm test:canary",
    kind: "cli",
    ciJob: null,
    source: "packages/testkit/src/cli/canary.ts",
    requires: ["live-credentials"],
  },
  computer: {
    command: "pnpm test:computer",
    kind: "cli",
    ciJob: null,
    source: "packages/testkit/src/cli/computer.ts",
    requires: ["live-credentials", "sandbox"],
  },
  "docker-manual": {
    command: "pnpm exec vitest run <file>",
    kind: "vitest",
    ciJob: null,
    requires: ["docker"],
  },
  "ci-self-check": {
    command: "pnpm test:ci-select",
    kind: "script",
    ciJob: "harness",
    requires: [],
    scriptIncludes: ["scripts/ci/*.test.mjs", "scripts/testing/*.test.mjs"],
    filePattern: /^scripts\/(?:ci|testing)\/.+\.test\.mjs$/,
  },
  "docs-verify": {
    command: "pnpm test:docs",
    kind: "script",
    ciJob: null,
    requires: [],
    scriptIncludes: "docs/roundtable/*.test.mjs",
    filePattern: /^docs\/roundtable\/.+\.test\.mjs$/,
  },
};

const CLI_SOURCES = [
  "packages/testkit/src/cli/harness.ts",
  "packages/testkit/src/cli/canary.ts",
  "packages/testkit/src/cli/computer.ts",
  "packages/testkit/src/cli/computer-replay.ts",
];

const POSTGRES_ONLY = [
  "apps/api/src/group-queries.postgres.test.ts",
  "apps/api/src/group-thread-lock.postgres.test.ts",
  "packages/adapters/src/bot-messages-pair.postgres.test.ts",
  "packages/adapters/src/cloud-agent.postgres.test.ts",
  "packages/adapters/src/execution-contract.postgres.test.ts",
  "packages/adapters/src/executor-bot-directory.postgres.test.ts",
  "packages/adapters/src/job-reconciler.postgres.test.ts",
  "packages/adapters/src/lease-loss-recovery.postgres.test.ts",
  "packages/adapters/src/manual-retry-effects.postgres.test.ts",
  "packages/adapters/src/message-group.postgres.test.ts",
  "packages/adapters/src/realtime.postgres.test.ts",
  "packages/adapters/src/result-delivery.postgres.test.ts",
  "packages/adapters/src/run-budget-enforcement.postgres.test.ts",
  "packages/adapters/src/session-checkpoint-lost-input.postgres.test.ts",
  "packages/adapters/src/session-checkpoint-recovery.postgres.test.ts",
  "packages/adapters/src/session-checkpoint-watermark.postgres.test.ts",
  "packages/adapters/src/wakeup.postgres.test.ts",
  "packages/db/src/agent-pairs.postgres.test.ts",
  "packages/db/src/avatar-activity.postgres.test.ts",
  "packages/db/src/avatar-changes.postgres.test.ts",
  "packages/db/src/avatar-migration.postgres.test.ts",
  "packages/db/src/delivery-records.test.ts",
  "packages/db/src/effect-execution-fence.postgres.test.ts",
  "packages/db/src/execution-contract.postgres.test.ts",
  "packages/db/src/execution-fenced-events.postgres.test.ts",
  "packages/db/src/execution-history.postgres.test.ts",
  "packages/db/src/intervention.postgres.test.ts",
  "packages/db/src/manual-retry.postgres.test.ts",
  "packages/db/src/memory-facts.postgres.test.ts",
  "packages/db/src/messaging.postgres.test.ts",
  "packages/db/src/origin-intervention.postgres.test.ts",
  "packages/db/src/repos-avatar.postgres.test.ts",
  "packages/db/src/run-plans.postgres.test.ts",
  "packages/db/src/run-steps.postgres.test.ts",
  "packages/db/src/session-admission.postgres.test.ts",
  "packages/db/src/session-checkpoint.postgres.test.ts",
  "packages/db/src/space-membership.postgres.test.ts",
  "packages/db/src/task-instructions.postgres.test.ts",
  "packages/db/src/usage-stats.test.ts",
  "packages/db/src/wait-timeouts.postgres.test.ts",
  "packages/memory/src/commit.postgres.test.ts",
  "packages/testkit/src/mention-targets.test.ts",
  "packages/testkit/src/messaging.test.ts",
  "packages/testkit/src/runs-list.test.ts",
];

/** These PostgreSQL suites also run inside the integration harness. */
const POSTGRES_INTEGRATION_DUPLICATES = [
  "packages/adapters/src/cloud-agent.postgres.test.ts",
  "packages/adapters/src/job-reconciler.postgres.test.ts",
  "packages/adapters/src/realtime.postgres.test.ts",
  "packages/adapters/src/wakeup.postgres.test.ts",
  "packages/db/src/messaging.postgres.test.ts",
  "packages/db/src/space-membership.postgres.test.ts",
  "packages/memory/src/commit.postgres.test.ts",
];

const HARNESS_TESTKIT_POSTGRES = [
  "packages/testkit/src/agentscope-offline.postgres.test.ts",
  "packages/testkit/src/computer-approval.postgres.test.ts",
  "packages/testkit/src/eval-customer-support.postgres.test.ts",
  "packages/testkit/src/eval-history.postgres.test.ts",
  "packages/testkit/src/scenario-contract.postgres.test.ts",
];

const HARNESS_APP = [
  "packages/testkit/src/attachments.test.ts",
  "packages/testkit/src/authorization.test.ts",
  "packages/testkit/src/bot-secrets.test.ts",
  "packages/testkit/src/connections.test.ts",
  "packages/testkit/src/executor-lifecycle.test.ts",
  "packages/testkit/src/journeys.test.ts",
  "packages/testkit/src/search.test.ts",
  "packages/testkit/src/voice.test.ts",
];

const AGENTSCOPE_REQUEST = [
  "apps/api/src/team-chat-judge.integration.test.ts",
  "packages/adapters/src/agentscope-auxiliary-isolation.integration.test.ts",
  "packages/adapters/src/agentscope-consumers.integration.test.ts",
  "packages/adapters/src/agentscope-provenance.integration.test.ts",
  "packages/adapters/src/agentscope-tool-visibility.integration.test.ts",
  "packages/adapters/src/agentscope-untrusted-content.integration.test.ts",
  "packages/adapters/src/scenario-contract.integration.test.ts",
  "packages/adapters/src/turnpolicy-v2-agentscope.integration.test.ts",
  "packages/testkit/src/prompt-files-baseline.integration.test.ts",
];

const NODE_TEST_CI = [
  "scripts/ci/check-docs.test.mjs",
  "scripts/ci/select-checks.test.mjs",
  "scripts/ci/verify-result.test.mjs",
  "scripts/testing/test-inventory.test.mjs",
];

const NODE_TEST_DOCS = [
  "docs/roundtable/verify-implementation-plan.test.mjs",
  "docs/roundtable/verify-ui-conformance.test.mjs",
];

const PROCESS = [
  ".agents/skills/pr-watch/pr-digest.test.ts",
  "infra/sandboxes/supervisor/src/browser-profile.test.ts",
  "infra/sandboxes/supervisor/src/computer-spec.test.ts",
  "infra/sandboxes/supervisor/src/control-argv.test.ts",
  "infra/sandboxes/supervisor/src/index.test.ts",
  "infra/sandboxes/supervisor/src/local-bin-path.test.ts",
  "infra/sandboxes/supervisor/src/page-browser-helper.test.ts",
  "packages/adapters/src/child-bots.test.ts",
  "packages/adapters/src/composio-catalog-cache.test.ts",
  "packages/adapters/src/computer-idle.test.ts",
  "packages/adapters/src/createos-sandbox.test.ts",
  "packages/core/src/node/desktop-runtime.test.ts",
  "packages/core/src/node/terminal-server.test.ts",
  "packages/testkit/src/backup-scripts.test.ts",
  "packages/testkit/src/compose-installer-smoke.test.ts",
  "packages/testkit/src/deploy-script.test.ts",
  "packages/testkit/src/evals/cli.test.ts",
  "packages/testkit/src/playwright-artifact-publication.test.ts",
];

const DATABASE_MARKERS = [/\bVERIFY_DATABASE\b/, /process\.env\.DATABASE_URL/, /createIsolatedPostgresDatabase/];
const HARNESS_MARKERS = [/\bVERIFY_DATABASE\b/, /\bAGENTSCOPE_URL\b/];
const AGENTSCOPE_MARKERS = [/agentscope/i, /AGENT_RUNTIME/];
const PROCESS_MARKERS = [/from\s+["']node:child_process["']/, /require\s*\(\s*["']node:child_process["']\s*\)/];
const JAVA_MARKERS = [/startJavaRuntime\s*\(/, /\bAGENTSCOPE_URL\b/];

function rule(pathValue, categories, options = {}) {
  return {
    path: pathValue,
    categories,
    markers: options.markers ?? [],
    reason: options.reason ?? "",
    duplicateReason: options.duplicateReason,
    entry: options.entry,
    command: options.command,
  };
}

export const TEST_RULES = [
  ...POSTGRES_ONLY.filter((file) => !POSTGRES_INTEGRATION_DUPLICATES.includes(file)).map((file) =>
    rule(file, ["postgres"], {
      markers: DATABASE_MARKERS,
      reason: "PostgreSQL integration test; runs in the db-postgres job.",
    }),
  ),
  ...POSTGRES_INTEGRATION_DUPLICATES.map((file) =>
    rule(file, ["postgres", "integration-harness"], {
      markers: DATABASE_MARKERS,
      reason: "PostgreSQL suite also exercised by the app integration harness.",
      duplicateReason:
        "Listed in packages/testkit/src/cli/harness.ts as well as the db-postgres job; both entries are useful (standalone DB contract and app-boundary journey).",
    }),
  ),
  ...HARNESS_TESTKIT_POSTGRES.map((file) =>
    rule(file, ["integration-harness"], {
      markers: HARNESS_MARKERS,
      reason: "AgentScope app journey through the integration harness.",
    }),
  ),
  ...HARNESS_APP.map((file) =>
    rule(file, ["integration-harness"], {
      markers: HARNESS_MARKERS,
      reason: "App-boundary integration test through the integration harness.",
    }),
  ),
  ...AGENTSCOPE_REQUEST.map((file) =>
    rule(file, ["agentscope-request"], {
      markers: AGENTSCOPE_MARKERS,
      reason: "AgentScope request integration; runs in the CI agentscope job.",
    }),
  ),
  rule("packages/testkit/src/history-compaction-agentscope.test.ts", ["integration-harness"], {
    markers: HARNESS_MARKERS,
    reason: "AgentScope Java compaction journey through the integration harness.",
  }),
  rule("packages/testkit/src/computer-replay.test.ts", ["computer-replay-java"], {
    markers: JAVA_MARKERS,
    reason: "Starts the Java runtime directly; not a unit test.",
  }),
  rule("packages/testkit/src/computer-recording.test.ts", ["computer-replay-cli"], {
    markers: JAVA_MARKERS,
    reason: "Run by pnpm test:computer-replay with the Java runtime URL.",
  }),
  rule("packages/testkit/src/computer-replay.docker.test.ts", ["computer-replay-cli"], {
    markers: [/RUN_COMPUTER_REPLAY_DOCKER/],
    reason: "Docker replay test; run by pnpm test:computer-replay.",
  }),
  rule("infra/sandboxes/supervisor/src/team-desktops.docker.test.ts", ["docker-manual"], {
    markers: [/VERIFY_DOCKER_TEAM_SCREENS/],
    reason: "Opt-in Docker desktop isolation check.",
    command: "VERIFY_DOCKER_TEAM_SCREENS=1 pnpm exec vitest run <file>",
  }),
  rule("packages/testkit/src/compose.backup.test.ts", ["docker-manual"], {
    markers: [/docker compose/],
    reason: "Requires a running Compose PostgreSQL service and backup scripts.",
  }),
  rule("packages/testkit/src/providers.canary.test.ts", ["live-canary"], {
    markers: [/\bVERIFY_PROVIDERS\b/],
    reason: "Live provider credentials required.",
  }),
  rule("packages/testkit/src/release-watch.canary.test.ts", ["live-canary"], {
    markers: [/\bVERIFY_PROVIDERS\b/],
    reason: "Live provider credentials required.",
  }),
  rule("packages/testkit/src/computer-use.e2e.test.ts", ["live-computer"], {
    markers: [/RUN_COMPUTER_E2E/],
    reason: "Live model and sandbox credentials required.",
  }),
  ...PROCESS.map((file) =>
    rule(file, ["process"], {
      markers: PROCESS_MARKERS,
      reason: "Spawns local processes or runs repository scripts.",
    }),
  ),
  ...NODE_TEST_CI.map((file) =>
    rule(file, ["node-test"], {
      markers: [],
      reason: "Node's built-in test runner; run by pnpm test:ci-select.",
    }),
  ),
  ...NODE_TEST_DOCS.map((file) =>
    rule(file, ["node-test"], {
      markers: [],
      entry: "docs-verify",
      reason: "Roundtable document verifier; run by pnpm test:docs.",
    }),
  ),
  // External-looking text, but the test asserts the environment is empty.
  rule("packages/testkit/src/pin-test-env.test.ts", ["unit-node"], {
    markers: [],
    reason:
      "Asserts DATABASE_URL/VERIFY_DATABASE are unset before the suite; it does not connect to a database.",
  }),
];

const EXTERNAL_SUFFIX = /\.(?:postgres|integration|docker|e2e|canary)\.test\.tsx?$/;
const NODE_TEST_SUFFIX = /\.test\.mjs$/;
const RULE_BY_PATH = new Map(TEST_RULES.map((item) => [normalizePath(item.path), item]));

export function normalizePath(file) {
  return file.replaceAll("\\", "/").replace(/^\.\//, "");
}

export function isTestPath(file) {
  return /\.test\.(?:ts|tsx|mjs)$/.test(normalizePath(file));
}

/** Classification used by CI selection; content-free, so unknown tests are unit. */
export function testPathTraits(file) {
  const normalized = normalizePath(file);
  const testFile = isTestPath(normalized);
  const listed = RULE_BY_PATH.get(normalized);
  const categories = !testFile
    ? []
    : listed
      ? listed.categories
      : EXTERNAL_SUFFIX.test(normalized) || NODE_TEST_SUFFIX.test(normalized)
        ? []
        : ["unit-node"];
  return {
    path: normalized,
    categories: [...categories],
    isTest: testFile,
    isUnit: testFile && categories.some((category) => category.startsWith("unit-")),
    isPostgres:
      testFile && (categories.includes("postgres") || /\.postgres\.test\.tsx?$/.test(normalized)),
    isExternalSuffix: testFile && EXTERNAL_SUFFIX.test(normalized),
  };
}

function nonTypeChildProcessImport(text) {
  return (
    /(?:^|\n)\s*import\s+(?!type\b)[^;]*from\s+["']node:child_process["']/.test(text) ||
    /require\s*\(\s*["']node:child_process["']\s*\)/.test(text)
  );
}

export function detectExternalHints(text) {
  const hints = [];
  if (DATABASE_MARKERS.some((marker) => marker.test(text))) hints.push("PostgreSQL (VERIFY_DATABASE/DATABASE_URL)");
  if (JAVA_MARKERS.some((marker) => marker.test(text))) hints.push("Java AgentScope runtime");
  if (/\bVERIFY_PROVIDERS\b|RUN_COMPUTER_E2E|RUN_COMPUTER_REPLAY_DOCKER/.test(text)) {
    hints.push("live provider or Docker replay");
  }
  if (/PostgreSqlContainer|testcontainers/.test(text)) hints.push("Docker/Testcontainers");
  if (nonTypeChildProcessImport(text)) hints.push("child process");
  return hints;
}

function unique(items) {
  return [...new Set(items)];
}

function entryIdsFor(categories, override) {
  if (override) return [override];
  return unique(
    categories.map((category) => {
      const definition = CATEGORY_DEFINITIONS[category];
      if (!definition) throw new Error(`unknown test category '${category}'`);
      return definition.entry;
    }),
  );
}

/**
 * Classify a tracked file list. Pure enough for temporary fixtures: pass
 * `readText` and `rules` to exercise missing/stale/conflicting cases.
 */
export function classifyTestFiles(files, options = {}) {
  const readText = options.readText ?? (() => "");
  const rules = options.rules ?? TEST_RULES;
  const normalized = unique(files.map(normalizePath)).sort();
  const ruleMap = new Map();
  const errors = [];
  const entries = [];

  for (const item of rules) {
    const file = normalizePath(item.path);
    if (ruleMap.has(file)) errors.push(`${file}: duplicate inventory rule`);
    ruleMap.set(file, item);
  }

  for (const file of ruleMap.keys()) {
    if (!normalized.includes(file)) {
      errors.push(`${file}: inventory entry points at a file that is no longer tracked`);
    }
  }

  for (const file of normalized) {
    const listed = ruleMap.get(file);
    let text;
    try {
      text = readText(file);
    } catch (error) {
      errors.push(`${file}: cannot read test file (${error instanceof Error ? error.message : error})`);
      continue;
    }

    if (listed) {
      const categories = listed.categories;
      if (categories.length === 0) {
        errors.push(`${file}: inventory rule has no category`);
        continue;
      }
      for (const category of categories) {
        if (!CATEGORY_DEFINITIONS[category]) {
          errors.push(`${file}: unknown test category '${category}'`);
        }
      }
      if (categories.length > 1 && !listed.duplicateReason) {
        errors.push(`${file}: multiple execution entries require duplicateReason`);
      }
      if (categories.some((category) => category.startsWith("unit-")) && categories.length > 1) {
        errors.push(`${file}: external tests cannot also belong to unit`);
      }
      if (listed.markers.length > 0 && !listed.markers.some((marker) => marker.test(text))) {
        errors.push(`${file}: inventory markers no longer match; reclassify the test`);
      }
      let entryIds;
      try {
        entryIds = entryIdsFor(categories, listed.entry);
      } catch (error) {
        errors.push(`${file}: ${error instanceof Error ? error.message : error}`);
        continue;
      }
      entries.push({
        path: file,
        categories,
        entryIds,
        environment: unique(categories.map((category) => CATEGORY_DEFINITIONS[category].environment)),
        reason: listed.reason || "explicit inventory rule",
        duplicateReason: listed.duplicateReason,
        command: listed.command,
      });
      continue;
    }

    if (NODE_TEST_SUFFIX.test(file)) {
      errors.push(
        `${file}: node:test file requires an explicit classification in scripts/testing/test-inventory.mjs`,
      );
      continue;
    }

    if (EXTERNAL_SUFFIX.test(file)) {
      errors.push(
        `${file}: external test suffix requires an explicit classification in scripts/testing/test-inventory.mjs`,
      );
      continue;
    }

    const hints = detectExternalHints(text);
    if (hints.length > 0) {
      errors.push(
        `${file}: external dependency detected (${hints.join(", ")}); add an explicit classification`,
      );
      continue;
    }

    const jsdom = /@vitest-environment\s+jsdom/.test(text);
    const category = jsdom ? "unit-jsdom" : "unit-node";
    entries.push({
      path: file,
      categories: [category],
      entryIds: [CATEGORY_DEFINITIONS[category].entry],
      environment: [CATEGORY_DEFINITIONS[category].environment],
      reason: jsdom ? "jsdom unit test via Vitest docblock" : "default pure Node unit test",
    });
  }

  entries.sort((a, b) => a.path.localeCompare(b.path));
  return { files: normalized, entries, errors };
}

function includesPath(source, file) {
  return source.includes(file);
}

export function validateEntrypoints(entries, metadata) {
  const errors = [];
  const used = new Map();
  for (const entry of entries) {
    for (const entryId of entry.entryIds) {
      if (!used.has(entryId)) used.set(entryId, []);
      used.get(entryId).push(entry);
    }
  }

  for (const [entryId, entryFiles] of used) {
    const definition = ENTRYPOINTS[entryId];
    if (!definition) {
      errors.push(`entry '${entryId}' has no definition`);
      continue;
    }
    if (!Array.isArray(definition.requires)) {
      errors.push(`entry '${entryId}' must declare requires[]`);
    }
    if (definition.ciJob && !metadata.ciYaml.includes(`name: ${definition.ciJob}`)) {
      errors.push(`entry '${entryId}' references missing CI job '${definition.ciJob}'`);
    }
    if (definition.kind === "script") {
      const match = definition.command.match(/^pnpm ([a-zA-Z0-9:_-]+)/);
      const scriptName = match?.[1];
      if (!scriptName || !metadata.packageScripts.has(scriptName)) {
        errors.push(`entry '${entryId}' references missing package script '${scriptName ?? "(none)"}'`);
      } else {
        const scriptText = String(metadata.packageScripts.get(scriptName));
        const required =
          definition.scriptIncludes === undefined
            ? []
            : Array.isArray(definition.scriptIncludes)
              ? definition.scriptIncludes
              : [definition.scriptIncludes];
        for (const needle of required) {
          if (!scriptText.includes(needle)) {
            errors.push(`entry '${entryId}' script '${scriptName}' must invoke ${needle}`);
          }
        }
      }
      if (definition.configFile) {
        const configText = metadata.configFiles.get(definition.configFile);
        if (configText === undefined) {
          errors.push(`entry '${entryId}' is missing ${definition.configFile}`);
        } else if (!configText.includes("unitTestFiles")) {
          errors.push(`entry '${entryId}' config must include files from unitTestFiles()`);
        }
      }
    }
    for (const file of entryFiles) {
      if (definition.filePattern && !definition.filePattern.test(file.path)) {
        errors.push(`${file.path}: does not match the pattern for entry '${entryId}'`);
      }
      if (definition.kind === "ci" && !includesPath(metadata.ciYaml, file.path)) {
        errors.push(`${file.path}: not present in CI job '${definition.ciJob}'`);
      }
      if (definition.kind === "harness") {
        const source = metadata.sources[definition.source] ?? "";
        if (!includesPath(source, file.path)) {
          errors.push(`${file.path}: not present in ${definition.source}`);
        }
      }
      if (definition.kind === "cli") {
        const source = metadata.sources[definition.source] ?? "";
        if (!includesPath(source, file.path)) {
          errors.push(`${file.path}: not present in ${definition.source}`);
        }
      }
      if (definition.kind === "vitest") {
        const command = (file.command ?? definition.command).replaceAll("<file>", file.path);
        if (!command.includes(file.path)) {
          errors.push(`${file.path}: entry command does not reference the file`);
        }
      }
      if (file.categories.some((category) => category.startsWith("unit-")) && definition.command !== "pnpm test:unit") {
        errors.push(`${file.path}: unit test is assigned to a non-unit entry`);
      }
    }
  }

  return errors;
}

export function enumerateTestFiles(root = ROOT) {
  const output = execFileSync("git", ["ls-files", ...TEST_FILE_PATTERNS], {
    cwd: root,
    encoding: "utf8",
  });
  return unique(output.split(/\r?\n/).filter(Boolean).map(normalizePath)).sort();
}

function loadMetadata(root) {
  const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const sources = {};
  for (const source of CLI_SOURCES) {
    sources[source] = readFileSync(path.join(root, source), "utf8");
  }
  const configFiles = new Map();
  for (const file of ["vitest.unit.config.ts"]) {
    try {
      configFiles.set(file, readFileSync(path.join(root, file), "utf8"));
    } catch {
      // Missing config is reported by validateEntrypoints.
    }
  }
  return {
    packageScripts: new Map(Object.entries(packageJson.scripts ?? {})),
    ciYaml: readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8"),
    sources,
    configFiles,
  };
}

export function buildInventory(options = {}) {
  const root = options.root ?? ROOT;
  const files = options.files ?? enumerateTestFiles(root);
  const readText =
    options.readText ?? ((file) => readFileSync(path.join(root, file), "utf8"));
  const metadata = options.metadata ?? loadMetadata(root);
  const classified = classifyTestFiles(
    files,
    options.rules ? { readText, rules: options.rules } : { readText },
  );
  const counts = countBy(classified.entries);
  const errors = [
    ...classified.errors,
    ...validateEntrypoints(classified.entries, metadata),
  ];
  if (options.requireAllCategories !== false) {
    for (const category of Object.keys(CATEGORY_DEFINITIONS)) {
      if (!counts.categories[category]) {
        errors.push(`category '${category}' has no tracked test files`);
      }
    }
  }
  return {
    files: classified.files,
    entries: classified.entries,
    errors,
    counts,
  };
}

function countBy(entries) {
  const categories = {};
  const environments = {};
  const entrypoints = {};
  for (const entry of entries) {
    for (const category of entry.categories) categories[category] = (categories[category] ?? 0) + 1;
    for (const environment of entry.environment) environments[environment] = (environments[environment] ?? 0) + 1;
    for (const entrypoint of entry.entryIds) entrypoints[entrypoint] = (entrypoints[entrypoint] ?? 0) + 1;
  }
  return { categories, environments, entrypoints };
}

export function unitTestFiles(options = {}) {
  const inventory = buildInventory(options);
  if (inventory.errors.length > 0) {
    throw new Error(`test inventory is invalid:\n${inventory.errors.join("\n")}`);
  }
  return inventory.entries
    .filter((entry) => entry.categories.some((category) => category.startsWith("unit-")))
    .map((entry) => entry.path);
}

export function filesForGroup(group, options = {}) {
  const inventory = buildInventory(options);
  if (inventory.errors.length > 0) {
    throw new Error(`test inventory is invalid:\n${inventory.errors.join("\n")}`);
  }
  return inventory.entries
    .filter((entry) => entry.entryIds.includes(group))
    .map((entry) => entry.path);
}

export function formatInventorySummary(inventory) {
  const lines = [
    `Test inventory: ${inventory.files.length} tracked test files`,
    `Errors: ${inventory.errors.length}`,
    `Categories: ${Object.entries(inventory.counts.categories)
      .sort((a, b) => b[1] - a[1])
      .map(([key, value]) => `${key}=${value}`)
      .join(", ")}`,
    `Environments: ${Object.entries(inventory.counts.environments)
      .sort((a, b) => b[1] - a[1])
      .map(([key, value]) => `${key}=${value}`)
      .join(", ")}`,
    `Entrypoints: ${Object.entries(inventory.counts.entrypoints)
      .sort((a, b) => b[1] - a[1])
      .map(([key, value]) => `${key}=${value}`)
      .join(", ")}`,
  ];
  if (inventory.errors.length > 0) {
    lines.push("", "Classification errors:", ...inventory.errors.map((error) => `- ${error}`));
  }
  return `${lines.join("\n")}\n`;
}

function isMainModule() {
  return (
    Boolean(process.argv[1]) &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  );
}

if (isMainModule()) {
  try {
    const inventory = buildInventory();
    console.log(formatInventorySummary(inventory));
    process.exit(inventory.errors.length === 0 ? 0 : 1);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
