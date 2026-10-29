import assert from "node:assert/strict";
import { describe, it } from "node:test";
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
