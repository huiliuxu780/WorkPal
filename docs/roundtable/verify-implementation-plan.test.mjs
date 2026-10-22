import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { verifyImplementationPlan } from "./verify-implementation-plan.mjs";

const docsDir = fileURLToPath(new URL("./", import.meta.url));
const prd = readFileSync(`${docsDir}/roundtable-product-requirements.md`, "utf8");
const plan = readFileSync(`${docsDir}/roundtable-implementation-plan.md`, "utf8");

test("accepts the current plan", () => {
  assert.deepEqual(verifyImplementationPlan(prd, plan), {
    tasks: 31,
    acceptance: 39,
    scenarios: 96,
  });
});

test("rejects missing implementation coverage", () => {
  const changed = plan.replace(/^覆盖：.+$/gm, "");
  assert.throws(() => verifyImplementationPlan(prd, changed), /has no implementation owner/);
});

test("rejects a duplicate task", () => {
  const changed = `${plan}\n### RT-01 duplicate\n\n依赖：无。\n`;
  assert.throws(() => verifyImplementationPlan(prd, changed), /duplicate task definitions/);
});

test("rejects unknown coverage ids", () => {
  const changed = plan.replace("覆盖：AC12。场景 F06。", "覆盖：AC12、AC40。场景 F06、U09。");
  assert.throws(() => verifyImplementationPlan(prd, changed), /unknown acceptance id AC40/);
  assert.throws(() => verifyImplementationPlan(prd, changed), /unknown scenario id U09/);
});

test("rejects an unknown dependency", () => {
  const changed = plan.replace("依赖：无。", "依赖：RT-99。");
  assert.throws(() => verifyImplementationPlan(prd, changed), /unknown dependency RT-99/);
});

test("rejects malformed dependency and coverage tokens", () => {
  const badDependency = plan.replace("依赖：无。", "依赖：RT-O1。");
  assert.throws(() => verifyImplementationPlan(prd, badDependency), /invalid dependency syntax/);
  const badCoverage = plan.replace("覆盖：AC12。场景 F06。", "覆盖：AC12、ACX。场景 F06、UX。");
  assert.throws(() => verifyImplementationPlan(prd, badCoverage), /invalid coverage syntax/);
});

test("rejects unknown ids in integration verification", () => {
  const changed = plan.replace(
    "验证覆盖：AC01、AC02",
    "验证覆盖：AC01、AC40、AC02",
  );
  assert.throws(() => verifyImplementationPlan(prd, changed), /unknown acceptance id AC40/);
});

test("rejects integration validation as the sole implementation owner", () => {
  const withoutOwners = plan.replace(/^覆盖：.+$/gm, "");
  const changed = withoutOwners.replace(/^验证覆盖：(.+)$/m, "覆盖：$1\n\n验证覆盖：$1");
  assert.throws(() => verifyImplementationPlan(prd, changed), /cannot claim implementation coverage/);
});

test("rejects integration validation outside the full dependency closure", () => {
  const moved = plan
    .replace(/^验证覆盖：(.+)$/m, "")
    .replace("覆盖：AC12。场景 F06。", "覆盖：AC12。场景 F06。\n\n验证覆盖：AC01。场景 U01。");
  assert.throws(() => verifyImplementationPlan(prd, moved), /integration validation task must be last/);

  const missingLeaf = plan.replace("、RT-29。\n\n验证覆盖：", "。\n\n验证覆盖：");
  assert.throws(
    () => verifyImplementationPlan(prd, missingLeaf),
    /does not depend on implementation task RT-29/,
  );
});

test("rejects moving session recovery scenarios away from their owners", () => {
  const changed = plan
    .replace(
      "覆盖：AC10。场景 C06、P05、F04。",
      "覆盖：AC10。场景 C06、P05。",
    )
    .replace("场景 B01。", "场景 B01、F04。");
  assert.throws(() => verifyImplementationPlan(prd, changed), /RT-26 must own scenario F04/);
});

test("rejects a dependency cycle and forward dependency", () => {
  const changed = plan.replace("依赖：无。", "依赖：RT-01。");
  assert.throws(() => verifyImplementationPlan(prd, changed), /depends on later task RT-01/);
  assert.throws(() => verifyImplementationPlan(prd, changed), /dependency cycle includes/);
});
