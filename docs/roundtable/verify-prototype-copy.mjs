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
  { scenario: "branch-X-GROUP-FAIL", text: "加入并继续" },
  { scenario: "branch-X-GROUP-FAIL", text: "暂不加入" },
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

export function verifyPrototypeCopy(content) {
  const errors = [];
  for (const term of findForbiddenTerms(content)) {
    errors.push(`prototype copy contains forbidden term: ${term}`);
  }
  for (const missing of findMissingAnchors(content)) {
    errors.push(`prototype copy is missing required anchor: ${missing}`);
  }
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
