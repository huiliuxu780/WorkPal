#!/usr/bin/env node
/**
 * Fixed-name CI result aggregator.
 *
 * Selected jobs must be success. Skipped/cancelled/failure of a selected job
 * fails this check. Unselected jobs may be skipped. Selector failure never
 * counts as success. Schedule-only jobs are required exactly when the workflow
 * asked for them, so their skip never fails an unrelated PR run and their
 * failure never passes the run that requested them.
 */
import { ALL_JOBS } from "./select-checks.mjs";

const RESULT_ENV = {
  docs: "RESULT_DOCS",
  harness: "RESULT_HARNESS",
  web: "RESULT_WEB",
  backend: "RESULT_BACKEND",
  "db-postgres": "RESULT_DB_POSTGRES",
  "runtime-jar": "RESULT_RUNTIME_JAR",
  agentscope: "RESULT_AGENTSCOPE",
  "worker-chain": "RESULT_WORKER_CHAIN",
  "agent-runtime-image": "RESULT_AGENT_RUNTIME_IMAGE",
  "visual-web": "RESULT_VISUAL_WEB",
};

export function verifyResult({
  selectResult,
  selectChecksOutcome,
  jobResults,
  requiredConditional = {},
}) {
  if (selectChecksOutcome !== "success") {
    return {
      ok: false,
      message: `select-checks ended as ${selectChecksOutcome}; selector failure cannot pass CI result`,
    };
  }

  let parsed;
  try {
    parsed = typeof selectResult === "string" ? JSON.parse(selectResult) : selectResult;
  } catch {
    return { ok: false, message: "select-checks output was not valid JSON" };
  }

  if (!parsed || !Array.isArray(parsed.selected)) {
    return { ok: false, message: "select-checks output is missing selected[]" };
  }

  const selected = new Set(parsed.selected);
  const failures = [];

  for (const job of ALL_JOBS) {
    const outcome = jobResults[job] ?? "missing";
    if (selected.has(job)) {
      if (outcome !== "success") {
        failures.push(`selected job ${job} was ${outcome}`);
      }
    } else if (outcome === "failure" || outcome === "cancelled") {
      failures.push(`unselected job ${job} was ${outcome}`);
    }
  }

  for (const [job, required] of Object.entries(requiredConditional)) {
    const outcome = jobResults[job] ?? "missing";
    if (required) {
      if (outcome !== "success") {
        failures.push(`scheduled job ${job} was ${outcome}`);
      }
    } else if (outcome === "failure" || outcome === "cancelled") {
      failures.push(`unscheduled job ${job} was ${outcome}`);
    }
  }

  if (failures.length) {
    return { ok: false, message: failures.join("; ") };
  }
  return {
    ok: true,
    message: `selected ${[...selected].join(", ")} all succeeded`,
  };
}

function readJobResults(env) {
  const jobResults = {};
  for (const [job, name] of Object.entries(RESULT_ENV)) {
    jobResults[job] = env[name] ?? "missing";
  }
  return jobResults;
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("verify-result.mjs")) {
  const verdict = verifyResult({
    selectResult: process.env.SELECT_RESULT ?? "",
    selectChecksOutcome: process.env.RESULT_SELECT_CHECKS ?? "missing",
    jobResults: readJobResults(process.env),
    requiredConditional: {
      "visual-web": process.env.VISUAL_WEB_REQUIRED === "true",
    },
  });
  console.log(verdict.message);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `\n## CI result\n\n${verdict.ok ? "passed" : "failed"}: ${verdict.message}\n`,
    );
  }
  process.exit(verdict.ok ? 0 : 1);
}
