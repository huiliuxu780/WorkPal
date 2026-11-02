import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ALL_JOBS } from "./select-checks.mjs";
import { verifyResult } from "./verify-result.mjs";

const successJobs = {
  docs: "success",
  harness: "skipped",
  web: "skipped",
  backend: "skipped",
  "db-postgres": "skipped",
  "runtime-jar": "skipped",
  agentscope: "skipped",
  "worker-chain": "skipped",
  "agent-runtime-image": "skipped",
};

describe("verifyResult", () => {
  it("passes when every selected job succeeded and others skipped", () => {
    const verdict = verifyResult({
      selectChecksOutcome: "success",
      selectResult: { selected: ["docs"] },
      jobResults: successJobs,
    });
    assert.equal(verdict.ok, true);
  });

  it("fails when a selected job is skipped or cancelled", () => {
    const skipped = verifyResult({
      selectChecksOutcome: "success",
      selectResult: { selected: ["docs", "web"] },
      jobResults: successJobs,
    });
    assert.equal(skipped.ok, false);
    const cancelled = verifyResult({
      selectChecksOutcome: "success",
      selectResult: { selected: ["docs"] },
      jobResults: { ...successJobs, docs: "cancelled" },
    });
    assert.equal(cancelled.ok, false);
  });

  it("fails when a selected job failed", () => {
    const verdict = verifyResult({
      selectChecksOutcome: "success",
      selectResult: { selected: ["docs"] },
      jobResults: { ...successJobs, docs: "failure" },
    });
    assert.equal(verdict.ok, false);
  });

  it("does not treat selector failure as success", () => {
    const verdict = verifyResult({
      selectChecksOutcome: "failure",
      selectResult: { selected: ["docs"] },
      jobResults: successJobs,
    });
    assert.equal(verdict.ok, false);
    assert.match(verdict.message, /selector failure/);
  });

  it("does not treat invalid selector JSON as success", () => {
    const verdict = verifyResult({
      selectChecksOutcome: "success",
      selectResult: "not-json",
      jobResults: successJobs,
    });
    assert.equal(verdict.ok, false);
  });

  it("allows unselected jobs to stay skipped", () => {
    const verdict = verifyResult({
      selectChecksOutcome: "success",
      selectResult: { selected: ["docs"] },
      jobResults: successJobs,
    });
    assert.equal(verdict.ok, true);
  });

  it("fails when the selected db-postgres job was skipped or failed", () => {
    for (const outcome of ["skipped", "failure", "cancelled"]) {
      const verdict = verifyResult({
        selectChecksOutcome: "success",
        selectResult: { selected: ["docs", "db-postgres"] },
        jobResults: { ...successJobs, "db-postgres": outcome },
      });
      assert.equal(verdict.ok, false, outcome);
      assert.match(verdict.message, /db-postgres/);
    }
  });

  it("allows an unselected db-postgres job to be skipped", () => {
    const verdict = verifyResult({
      selectChecksOutcome: "success",
      selectResult: { selected: ["docs"] },
      jobResults: { ...successJobs, "db-postgres": "skipped" },
    });
    assert.equal(verdict.ok, true);
  });

  it("fails when the selected harness job was skipped or failed", () => {
    for (const outcome of ["skipped", "failure", "cancelled", "missing"]) {
      const verdict = verifyResult({
        selectChecksOutcome: "success",
        selectResult: { selected: ["docs", "harness"] },
        jobResults: { ...successJobs, harness: outcome },
      });
      assert.equal(verdict.ok, false, outcome);
      assert.match(verdict.message, /harness/);
    }
  });
});

const allSucceeded = Object.fromEntries([
  ...Object.keys(successJobs).map((job) => [job, "success"]),
  ["visual-web", "skipped"],
]);

describe("verifyResult selection matrix", () => {
  it("passes a docs-only selection without demanding web or backend", () => {
    const verdict = verifyResult({
      selectChecksOutcome: "success",
      selectResult: { selected: ["docs"] },
      jobResults: { ...allSucceeded, docs: "success", web: "skipped", backend: "skipped" },
    });
    assert.equal(verdict.ok, true, verdict.message);
  });

  it("fails when a selected web or backend job never ran", () => {
    for (const [selected, job] of [
      [["docs", "harness", "web"], "web"],
      [["docs", "harness", "backend"], "backend"],
    ]) {
      for (const outcome of ["skipped", "missing", "cancelled", "failure"]) {
        const verdict = verifyResult({
          selectChecksOutcome: "success",
          selectResult: { selected },
          jobResults: { ...allSucceeded, [job]: outcome },
        });
        assert.equal(verdict.ok, false, `${job} ${outcome}`);
        assert.match(verdict.message, new RegExp(job));
      }
    }
  });

  it("passes a full selection only when every job succeeded", () => {
    const ok = verifyResult({
      selectChecksOutcome: "success",
      selectResult: { selected: [...ALL_JOBS] },
      jobResults: Object.fromEntries([
        ...ALL_JOBS.map((job) => [job, "success"]),
        ["visual-web", "skipped"],
      ]),
    });
    assert.equal(ok.ok, true, ok.message);

    for (const job of ALL_JOBS) {
      const verdict = verifyResult({
        selectChecksOutcome: "success",
        selectResult: { selected: [...ALL_JOBS] },
        jobResults: {
          ...Object.fromEntries(ALL_JOBS.map((other) => [other, "success"])),
          [job]: "skipped",
        },
      });
      assert.equal(verdict.ok, false, `full selection with ${job} skipped`);
    }
  });
});

describe("verifyResult scheduled visual job", () => {
  it("fails when the daily visual run was requested and did not succeed", () => {
    for (const outcome of ["failure", "cancelled", "skipped", "missing"]) {
      const verdict = verifyResult({
        selectChecksOutcome: "success",
        selectResult: { selected: [...ALL_JOBS] },
        jobResults: { ...allSucceeded, "visual-web": outcome },
        requiredConditional: { "visual-web": true },
      });
      assert.equal(verdict.ok, false, outcome);
      assert.match(verdict.message, /visual-web/);
    }
  });

  it("does not fail an unrelated run for a skipped daily visual job", () => {
    const verdict = verifyResult({
      selectChecksOutcome: "success",
      selectResult: { selected: ["docs"] },
      jobResults: { ...allSucceeded, "visual-web": "skipped" },
      requiredConditional: { "visual-web": false },
    });
    assert.equal(verdict.ok, true, verdict.message);
  });

  it("still reports a daily visual failure on a run that did not request it", () => {
    const verdict = verifyResult({
      selectChecksOutcome: "success",
      selectResult: { selected: ["docs"] },
      jobResults: { ...allSucceeded, "visual-web": "failure" },
      requiredConditional: { "visual-web": false },
    });
    assert.equal(verdict.ok, false);
    assert.match(verdict.message, /visual-web was failure/);
  });
});
