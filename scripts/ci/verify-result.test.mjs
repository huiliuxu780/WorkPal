import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { verifyResult } from "./verify-result.mjs";

const successJobs = {
  docs: "success",
  web: "skipped",
  backend: "skipped",
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
});
