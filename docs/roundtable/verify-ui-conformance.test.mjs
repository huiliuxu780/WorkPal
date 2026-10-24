import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BRANCH_IDS, MAIN_STAGES, verifyUiConformance } from "./verify-ui-conformance.mjs";

const docsDir = new URL("./", import.meta.url);
const audit = () =>
  JSON.parse(readFileSync(new URL("audits/ui-prototype-conformance.json", docsDir), "utf8"));
const plan = () => readFileSync(new URL("roundtable-implementation-plan.md", docsDir), "utf8");
const always = () => true;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test("main story and branch canonical sets are complete", () => {
  assert.equal(MAIN_STAGES.length, 8);
  assert.equal(BRANCH_IDS.length, 29);
  assert.equal(new Set(BRANCH_IDS).size, 29);
});

test("the committed audit, plan and evidence pass verification", () => {
  const result = verifyUiConformance(audit(), plan(), "audits/evidence", always);
  assert.equal(result.tasks, 31);
  assert.deepEqual(result.classifications, {
    "backend-only": 13,
    "direct-ui": 5,
    "ui-projection-contract": 13,
  });
  assert.equal(result.conflicts, 12);
  assert.equal(result.remediationTasks, 7);
});

test("a missing RT task fails the audit", () => {
  const mutated = audit();
  mutated.tasks = mutated.tasks.filter((task) => task.id !== "RT-17");
  assert.throws(() => verifyUiConformance(mutated, plan(), null, always), /contiguous/);
});

test("a duplicated RT task fails the audit", () => {
  const mutated = audit();
  mutated.tasks.splice(4, 0, clone(mutated.tasks[4]));
  assert.throws(() => verifyUiConformance(mutated, plan(), null, always), /contiguous|duplicate/i);
});

test("direct-ui tasks without prototype references fail", () => {
  const mutated = audit();
  mutated.tasks.find((task) => task.id === "RT-23").prototypeRefs = [];
  assert.throws(
    () => verifyUiConformance(mutated, plan(), null, always),
    /RT-23 \(direct-ui\) must reference prototype/,
  );
});

test("backend-only tasks cannot declare UI surfaces", () => {
  const mutated = audit();
  mutated.tasks.find((task) => task.id === "RT-25").affectedSurfaces.push("right-rail:work");
  assert.throws(
    () => verifyUiConformance(mutated, plan(), null, always),
    /RT-25 is backend-only but declares UI surface/,
  );
});

test("backend-only tasks cannot mark internal terms user-visible", () => {
  const mutated = audit();
  mutated.tasks
    .find((task) => task.id === "RT-25")
    .exposedTerms.push({
      term: "recovering",
      userVisible: true,
    });
  assert.throws(
    () => verifyUiConformance(mutated, plan(), null, always),
    /RT-25 is backend-only but declares internal term/,
  );
});

test("user-visible internal terms require a decision, architecture or prototype anchor", () => {
  const mutated = audit();
  const task = mutated.tasks.find((entry) => entry.id === "RT-20");
  delete task.exposedTerms.find((exposed) => exposed.term === "queued").decisionRef;
  assert.throws(
    () => verifyUiConformance(mutated, plan(), null, always),
    /without a decision\/architecture\/prototype anchor/,
  );
});

test("confirmed conflicts require a remediation owner", () => {
  const mutated = audit();
  mutated.conflicts.find((conflict) => conflict.id === "CF-01").remediationOwner = null;
  assert.throws(
    () => verifyUiConformance(mutated, plan(), null, always),
    /confirmed conflict CF-01 has no remediationOwner/,
  );
});

test("blocking conflicts require a remediation task", () => {
  const mutated = audit();
  mutated.conflicts.find((conflict) => conflict.id === "CF-02").remediationTask = null;
  assert.throws(
    () => verifyUiConformance(mutated, plan(), null, always),
    /blocking conflict CF-02 has no remediationTask/,
  );
});

test("remediation references must resolve", () => {
  const mutated = audit();
  mutated.conflicts.find((conflict) => conflict.id === "CF-01").remediationTask = "FIX-NONE";
  assert.throws(
    () => verifyUiConformance(mutated, plan(), null, always),
    /CF-01 references unknown remediation task/,
  );
});

test("every non-false-positive conflict must be linked from a task", () => {
  const mutated = audit();
  mutated.tasks.find((task) => task.id === "RT-08").conflictIds = [];
  mutated.tasks.find((task) => task.id === "RT-06").conflictIds = [];
  assert.throws(
    () => verifyUiConformance(mutated, plan(), null, always),
    /conflict CF-01 is not linked from any RT task/,
  );
});

test("the evidence manifest must cover all 8 main stages and 29 branches", () => {
  const mutated = audit();
  mutated.evidenceManifest.prototypeStates = mutated.evidenceManifest.prototypeStates.filter(
    (ref) => ref !== "prototype:branch-F-RETRY",
  );
  assert.throws(
    () => verifyUiConformance(mutated, plan(), null, always),
    /missing required prototype state prototype:branch-F-RETRY/,
  );
});

test("evidence refs must resolve to files on disk", () => {
  assert.throws(
    () => verifyUiConformance(audit(), plan(), "audits/evidence", () => false),
    /evidence file missing/,
  );
});

test("reverting the RT-08 plan revision fails", () => {
  const reverted = plan().replace(
    /- 语义化派发痕迹与失败呈现[^\n]*\n/g,
    "- 独立投递状态和失败状态。\n",
  );
  assert.throws(
    () => verifyUiConformance(audit(), reverted, null, always),
    /plan RT-08 still contains deviation-inducing text|plan RT-08 is missing revised constraint/,
  );
});

test("reverting the RT-14 plan revision fails", () => {
  const reverted = plan().replace(
    /- completed Task 保留旧结果，follow-up Run 事实供 UI 呈现“追加复核”；展示位置与结构归 RT-23[^\n]*\n/,
    "- completed Task 保留旧结果并显示“追加复核”。\n",
  );
  assert.throws(
    () => verifyUiConformance(audit(), reverted, null, always),
    /plan RT-14 still contains deviation-inducing text/,
  );
});

test("reverting the RT-25 visibility boundary fails", () => {
  const reverted = plan().replace(
    /\n- 边界：`queued`、lease、fence、409、`recovering`[^\n]*\n/,
    "\n",
  );
  assert.throws(
    () => verifyUiConformance(audit(), reverted, null, always),
    /plan RT-25 is missing revised constraint/,
  );
});
