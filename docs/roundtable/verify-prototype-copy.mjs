import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const prototypePath = fileURLToPath(new URL("./prototype/index.html", import.meta.url));

// 用户可见文案不得暴露执行器名称或内部状态。CSS/JS 里的 `.run` 状态类不算文案，
// 因此 Run / Attempt 按首字母大写匹配；其余术语大小写不敏感。
export const FORBIDDEN_COPY_TERMS = [
  { label: "AgentScope", pattern: /agentscope/i },
  { label: "Run", pattern: /\bRun\b/ },
  { label: "Attempt", pattern: /\battempt\b/i },
  { label: "recovering", pattern: /\brecovering\b/i },
  { label: "lease", pattern: /\blease\b/i },
  { label: "fence", pattern: /\bfence\b/i },
  { label: "steering", pattern: /\bsteering\b/i },
];

// 失败、重试、部分完成与连接失败必须保留用户可判断、可行动的信息。
export const REQUIRED_COPY_ANCHORS = [
  { scenario: "branch-F-OFFLINE", text: "暂时连接不上" },
  { scenario: "branch-F-OFFLINE", text: "这项复核没有开始" },
  { scenario: "branch-F-RETRY", text: "第 2 次尝试" },
  { scenario: "branch-F-RETRY", text: "第 2 / 3 次" },
  { scenario: "branch-F-PARTIAL", text: "有条件收尾" },
  { scenario: "branch-F-PARTIAL", text: "部分完成" },
  { scenario: "branch-X-GROUP-APPROVE", text: "加入并继续" },
  { scenario: "branch-X-GROUP-APPROVE", text: "暂不加入" },
  { scenario: "branch-X-GROUP-FAIL", text: "无成员管理权限" },
  { scenario: "branch-X-GROUP-FAIL", text: "请群主或管理员处理" },
  { scenario: "main-stage-7", text: "允许一次" },
];

export function findForbiddenTerms(content) {
  return FORBIDDEN_COPY_TERMS.filter((term) => term.pattern.test(content)).map(
    (term) => term.label,
  );
}

export function findMissingAnchors(content) {
  return REQUIRED_COPY_ANCHORS.filter((anchor) => !content.includes(anchor.text)).map(
    (anchor) => `${anchor.scenario}: ${anchor.text}`,
  );
}

// D1 二轮裁决：有权限审批（X-GROUP-APPROVE）与无权限失败（X-GROUP-FAIL）是互斥场景。
// 无权限分支不得渲染审批卡；有权限分支必须渲染审批卡。
export function scenarioBlock(content, id) {
  const start = content.indexOf(`id: "${id}"`);
  if (start < 0) return null;
  const next = content.indexOf('id: "', start + 1);
  return content.slice(start, next < 0 ? undefined : next);
}

export function findScenarioExclusivityErrors(content) {
  const errors = [];
  const noPermission = scenarioBlock(content, "X-GROUP-FAIL");
  const withPermission = scenarioBlock(content, "X-GROUP-APPROVE");
  if (!noPermission || !withPermission) {
    return ["prototype is missing the X-GROUP-APPROVE / X-GROUP-FAIL scenario split"];
  }
  if (noPermission.includes("approval-title") || noPermission.includes("加入并继续")) {
    errors.push("X-GROUP-FAIL (no permission) must not render the join approval card");
  }
  if (!withPermission.includes("approval-title") || !withPermission.includes("加入并继续")) {
    errors.push("X-GROUP-APPROVE (with permission) must render the join approval card");
  }
  return errors;
}

// 二轮裁决：活动胶囊状态点必须按状态类型输出；旧的无条件绿色动点（.spinner）不得回归。
const REQUIRED_DOT_CLASSES = [
  ".activity-pill .dot.running",
  ".activity-pill .dot.waiting",
  ".activity-pill .dot.done",
  ".activity-pill .dot.error",
  ".activity-pill .dot.stopped",
];

export function findActivityDotErrors(content) {
  const errors = [];
  if (content.includes("spinner")) {
    errors.push("prototype still renders unconditional green spinner dots");
  }
  for (const selector of REQUIRED_DOT_CLASSES) {
    if (!content.includes(selector)) {
      errors.push(`prototype is missing activity dot status style ${selector}`);
    }
  }
  return errors;
}

export function verifyPrototypeCopy(content) {
  const errors = [];
  for (const term of findForbiddenTerms(content)) {
    errors.push(`prototype copy contains forbidden term: ${term}`);
  }
  for (const missing of findMissingAnchors(content)) {
    errors.push(`prototype copy is missing required anchor: ${missing}`);
  }
  errors.push(...findScenarioExclusivityErrors(content));
  errors.push(...findActivityDotErrors(content));
  if (errors.length > 0) throw new Error(errors.join("\n"));
  return {
    forbiddenTerms: FORBIDDEN_COPY_TERMS.length,
    anchors: REQUIRED_COPY_ANCHORS.length,
  };
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isCli) {
  const result = verifyPrototypeCopy(readFileSync(prototypePath, "utf8"));
  console.log(
    `roundtable prototype copy verified: 0/${result.forbiddenTerms} forbidden terms, ${result.anchors} required anchors present`,
  );
}
