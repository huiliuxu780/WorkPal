import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const docsDir = fileURLToPath(new URL("./", import.meta.url));

export const CLASSIFICATIONS = ["backend-only", "direct-ui", "ui-projection-contract"];
export const CONFLICT_KINDS = [
  "confirmed",
  "missing-requirement",
  "intentional-non-ui",
  "ambiguous",
  "false-positive",
];
export const SEVERITIES = ["P1", "P2", "P3"];

export const MAIN_STAGES = Array.from({ length: 8 }, (_, index) => `main-stage-${index + 1}`);
export const BRANCH_IDS = [
  "U-ACTIVE",
  "U-MULTI",
  "U-CONFLICT",
  "U-STOP",
  "A-ACTIVE",
  "A-BACKGROUND",
  "A-COMPLETED",
  "A-AMBIGUOUS",
  "X-GROUP",
  "X-BOT",
  "X-GROUP-FAIL",
  "X-RETURN",
  "Q-REVERSE",
  "Q-MULTI",
  "Q-ORIGINS",
  "Q-UNAVAILABLE",
  "C-MULTI",
  "C-DUAL",
  "C-ROOTS",
  "C-LATE",
  "P-SCOPED",
  "P-ALLOW",
  "P-DENY",
  "P-STALE",
  "F-OFFLINE",
  "F-RETRY",
  "F-DEDUPE",
  "F-PARTIAL",
];

const INTERACTION_FILES = {
  "prototype:interaction:work-tab": "work-tab-stage5.png",
  "prototype:interaction:task-detail": "work-task-detail.png",
  "prototype:interaction:amend-chip": "work-detail-amend.png",
  "prototype:interaction:receipt-expanded": "branch-Q-MULTI-expanded.png",
  "prototype:interaction:pair-float": "pair-float-open.png",
  "prototype:interaction:rail-details": "rail-details.png",
  "prototype:interaction:rail-library": "rail-library.png",
  "prototype:interaction:rail-members": "rail-members.png",
  "prototype:interaction:narrow-main": "narrow-main-collapsed.png",
  "prototype:interaction:narrow-overlay": "narrow-details-overlay.png",
  "prototype:interaction:narrow-capsule-opens-work": "narrow-capsule-opens-work.png",
};

const BACKEND_SURFACES = new Set([
  "api",
  "db",
  "worker",
  "runtime",
  "core",
  "contracts",
  "adapters",
  "locale",
]);
const UI_SURFACES = new Set([
  "chat-message",
  "chat-header",
  "receipt",
  "pair-float",
  "activity-capsule",
  "approval-card",
  "composer",
  "task-detail",
  "sidebar",
  "all",
  "e2e",
  "right-rail:details",
  "right-rail:work",
  "right-rail:library",
  "right-rail:members",
  "right-rail:work(占位)",
  "group-chat",
  "work-tree",
]);
const INTERNAL_TERMS = new Set([
  "queued",
  "running",
  "completed",
  "cancelled",
  "attempt",
  "lease",
  "fence",
  "409",
  "recovering",
  "revision",
  "seq",
  "delivery key",
  "steering",
  "run",
  "support run",
  "pairkey",
  "runtimetaskid",
  "backgroundagenttask",
  "executionthreadid",
  "presentationthreadid",
  "pairthreadid",
  "agent_pair",
  "checkpoint",
  "suspensionkey",
  "background_continuation",
  "allowlist",
  "hop",
  "run_subagent",
  "bot_message_sent",
]);

function expectedTaskIds(count) {
  return Array.from({ length: count }, (_, index) => `RT-${String(index).padStart(2, "0")}`);
}

function normalizeTerm(term) {
  return term.trim().toLowerCase();
}

export function evidencePathFor(ref, evidenceRoot) {
  if (ref.startsWith("prototype:main-stage-")) {
    return `${evidenceRoot}/prototype/${ref.slice("prototype:".length)}.png`;
  }
  if (ref.startsWith("prototype:branch-")) {
    return `${evidenceRoot}/prototype/branch-${ref.slice("prototype:branch-".length)}.png`;
  }
  if (INTERACTION_FILES[ref]) {
    return `${evidenceRoot}/prototype/${INTERACTION_FILES[ref]}`;
  }
  if (ref.startsWith("main-app:")) {
    return `${evidenceRoot}/main-app/${ref.slice("main-app:".length)}.png`;
  }
  return null;
}

export function verifyUiConformance(audit, plan, evidenceRoot, fileExists = existsSync) {
  const errors = [];

  // 1. RT-00..RT-30 无遗漏、无重复、顺序连续。
  const tasks = audit.tasks ?? [];
  const taskIds = tasks.map((task) => task.id);
  const expected = expectedTaskIds(tasks.length);
  if (tasks.length !== 31) {
    errors.push(`expected 31 tasks RT-00..RT-30, found ${tasks.length}`);
  }
  if (taskIds.join(",") !== expected.join(",")) {
    errors.push(`task sequence must be contiguous RT-00..RT-30: ${taskIds.join(", ")}`);
  }
  const _taskById = new Map(tasks.map((task) => [task.id, task]));

  // 2. 证据清单：8 主线 + 28 分支 + 交互/应用证据必须存在且落盘。
  const manifest = audit.evidenceManifest ?? {};
  const expectedPrototypeStates = [
    ...MAIN_STAGES.map((stage) => `prototype:${stage}`),
    ...BRANCH_IDS.map((branch) => `prototype:branch-${branch}`),
  ];
  const listedStates = manifest.prototypeStates ?? [];
  for (const ref of expectedPrototypeStates) {
    if (!listedStates.includes(ref)) {
      errors.push(`evidenceManifest is missing required prototype state ${ref}`);
    }
  }
  for (const extra of listedStates) {
    if (!expectedPrototypeStates.includes(extra)) {
      errors.push(`unknown prototype state in evidenceManifest: ${extra}`);
    }
  }
  const knownRefs = new Set([
    ...(manifest.prototypeStates ?? []),
    ...(manifest.interactionStates ?? []),
    ...(manifest.mainAppSurfaces ?? []),
  ]);
  if (evidenceRoot) {
    for (const ref of knownRefs) {
      const path = evidencePathFor(ref, evidenceRoot);
      if (path && !fileExists(path)) {
        errors.push(`evidence file missing for ${ref}: ${path}`);
      }
    }
  }

  // 3. 分类与原型引用：direct-ui / ui-projection-contract 必须引用具体原型状态或 DESIGN 条款。
  for (const task of tasks) {
    const id = task.id;
    if (!CLASSIFICATIONS.includes(task.classification)) {
      errors.push(`${id} has invalid classification ${task.classification}`);
      continue;
    }
    if (task.classification === "backend-only") {
      for (const ref of task.prototypeRefs ?? []) {
        errors.push(`${id} is backend-only but declares prototypeRef ${ref}`);
      }
      for (const surface of task.affectedSurfaces ?? []) {
        if (UI_SURFACES.has(surface)) {
          errors.push(`${id} is backend-only but declares UI surface ${surface}`);
        }
        if (!BACKEND_SURFACES.has(surface) && !UI_SURFACES.has(surface)) {
          errors.push(`${id} declares unknown surface ${surface}`);
        }
      }
      for (const exposed of task.exposedTerms ?? []) {
        if (exposed.userVisible) {
          errors.push(
            `${id} is backend-only but declares internal term "${exposed.term}" as user-visible`,
          );
        }
      }
    } else {
      const refs = task.prototypeRefs ?? [];
      if (refs.length === 0) {
        errors.push(
          `${id} (${task.classification}) must reference prototype states or DESIGN clauses`,
        );
      }
      for (const ref of refs) {
        if (ref.startsWith("DESIGN.md:L")) {
          const line = Number(ref.slice("DESIGN.md:L".length));
          if (!Number.isInteger(line) || line < 1 || line > 26) {
            errors.push(`${id} cites invalid DESIGN clause ${ref}`);
          }
        } else if (ref.startsWith("prototype:branch-")) {
          const branch = ref.slice("prototype:branch-".length);
          if (!BRANCH_IDS.includes(branch)) {
            errors.push(`${id} cites unknown prototype branch ${ref}`);
          }
        } else if (ref.startsWith("prototype:main-stage-")) {
          const stage = ref.slice("prototype:main-stage-".length);
          if (!MAIN_STAGES.includes(`main-stage-${stage}`)) {
            errors.push(`${id} cites unknown prototype stage ${ref}`);
          }
        } else if (ref.startsWith("prototype:interaction:")) {
          if (!INTERACTION_FILES[ref]) {
            errors.push(`${id} cites unknown interaction state ${ref}`);
          }
        } else {
          errors.push(`${id} cites unsupported prototype ref ${ref}`);
        }
      }
    }
    // 4. 内部术语可见性：声明为 user-visible 必须给出裁决或权威依据；不做全局禁词扫描。
    for (const exposed of task.exposedTerms ?? []) {
      const isInternal = INTERNAL_TERMS.has(normalizeTerm(exposed.term));
      if (exposed.userVisible && !isInternal && !exposed.note) {
        errors.push(`${id} marks "${exposed.term}" user-visible without rationale note`);
      }
      if (exposed.userVisible && isInternal) {
        const ref = exposed.decisionRef ?? "";
        const anchored =
          ref.startsWith("D1") ||
          ref.startsWith("D2") ||
          ref.startsWith("architecture:") ||
          ref.startsWith("prototype:");
        if (!anchored) {
          errors.push(
            `${id} marks internal term "${exposed.term}" user-visible without a decision/architecture/prototype anchor`,
          );
        }
      }
    }
  }

  // 5. 冲突：编号唯一、枚举合法；confirmed 必须有归属，阻断性冲突必须有修复任务。
  const conflicts = audit.conflicts ?? [];
  const conflictIds = conflicts.map((conflict) => conflict.id);
  if (conflictIds.length !== new Set(conflictIds).size) {
    errors.push("duplicate conflict ids");
  }
  const remediationTasks = new Set((audit.remediationPlan ?? []).map((entry) => entry.taskId));
  const remediationTaskIds = audit.remediationPlan ?? [];
  if (remediationTasks.size !== remediationTaskIds.length) {
    errors.push("duplicate remediation task ids");
  }
  for (const conflict of conflicts) {
    const id = conflict.id;
    if (!CONFLICT_KINDS.includes(conflict.kind)) {
      errors.push(`${id} has invalid kind ${conflict.kind}`);
    }
    if (!SEVERITIES.includes(conflict.severity)) {
      errors.push(`${id} has invalid severity ${conflict.severity}`);
    }
    if (!conflict.currentFact || !conflict.prototypeEvidence || !conflict.whyConflict) {
      errors.push(`${id} must record currentFact, prototypeEvidence and whyConflict`);
    }
    if (!Array.isArray(conflict.locations) || conflict.locations.length === 0) {
      errors.push(`${id} must cite at least one location (task/PR/file/line)`);
    }
    if (conflict.kind === "confirmed" && !conflict.remediationOwner) {
      errors.push(`confirmed conflict ${id} has no remediationOwner`);
    }
    if (conflict.blocksDevelopment && !conflict.remediationTask) {
      errors.push(`blocking conflict ${id} has no remediationTask`);
    }
    if (conflict.remediationTask && !remediationTasks.has(conflict.remediationTask)) {
      errors.push(`${id} references unknown remediation task ${conflict.remediationTask}`);
    }
    if (conflict.decisionId) {
      const decision = (audit.decisions ?? []).find((entry) => entry.id === conflict.decisionId);
      if (!decision) {
        errors.push(`${id} references unknown decision ${conflict.decisionId}`);
      } else if (decision.status !== "open" && !decision.resolution) {
        errors.push(`decision ${decision.id} is closed but records no resolution`);
      }
    }
  }

  // 6. 每个冲突必须被至少一个任务感知（conflictIds 反向链接一致）。
  const linked = new Set(tasks.flatMap((task) => task.conflictIds ?? []));
  for (const conflict of conflicts) {
    if (conflict.kind === "false-positive") continue;
    if (!linked.has(conflict.id)) {
      errors.push(`conflict ${conflict.id} is not linked from any RT task`);
    }
  }
  for (const task of tasks) {
    for (const conflictId of task.conflictIds ?? []) {
      if (!conflictIds.includes(conflictId)) {
        errors.push(`${task.id} links unknown conflict ${conflictId}`);
      }
    }
  }

  // 7. 计划修订：针对性检查修订后的任务块（不做全局禁词扫描）。
  if (plan) {
    const blocks = parsePlanTaskBlocks(plan);
    const requireChanged = (taskId, tests) => {
      const block = blocks.get(taskId);
      if (!block) {
        errors.push(`plan has no task block for ${taskId}`);
        return;
      }
      for (const test of tests) {
        if (test.absent?.test(block)) {
          errors.push(`plan ${taskId} still contains deviation-inducing text: ${test.absent}`);
        }
        if (test.present && !test.present.test(block)) {
          errors.push(`plan ${taskId} is missing revised constraint: ${test.present}`);
        }
      }
    };
    requireChanged("RT-08", [
      { absent: /独立投递状态和失败状态/ },
      { present: /语义化派发痕迹与失败呈现/ },
      { present: /不得展示 `?queued`?、`?running`?、`?completed`? 等执行状态/ },
      { present: /不打开 pair 对话视图/ },
    ]);
    requireChanged("RT-14", [
      { absent: /并显示“追加复核”/ },
      { present: /展示位置与结构归 RT-23/ },
    ]);
    requireChanged("RT-03", [
      { present: /服务端排除行为/ },
      { present: /不新增任何页面、入口或界面元素/ },
    ]);
    requireChanged("RT-25", [
      { present: /禁止成为产品文案或 UI 状态标签/ },
      { present: /只允许 RT-20 `GroupWorkState`/ },
    ]);
    requireChanged("RT-24", [{ present: /裁决 D1/ }, { present: /不得引入这些实现术语/ }]);
    requireChanged("RT-20", [{ present: /只允许 `GroupWorkState`/ }]);
    requireChanged("RT-09", [{ present: /不新增侧边栏会话入口/ }]);
    requireChanged("RT-22", [
      { present: /悬停更多操作入口/ },
      { present: /顶部「工作」窄入口的挂点/ },
    ]);
    requireChanged("RT-11", [{ present: /已接手 · 正在推进/ }]);
  }

  if (errors.length > 0) throw new Error(errors.join("\n"));
  return {
    tasks: tasks.length,
    classifications: {
      "backend-only": tasks.filter((task) => task.classification === "backend-only").length,
      "direct-ui": tasks.filter((task) => task.classification === "direct-ui").length,
      "ui-projection-contract": tasks.filter(
        (task) => task.classification === "ui-projection-contract",
      ).length,
    },
    conflicts: conflicts.length,
    remediationTasks: remediationTaskIds.length,
    evidence: knownRefs.size,
  };
}

function parsePlanTaskBlocks(plan) {
  const blocks = new Map();
  const headings = [...plan.matchAll(/^### (RT-\d+) (.+)$/gm)];
  for (const [index, heading] of headings.entries()) {
    const start = heading.index;
    const end = headings[index + 1]?.index ?? plan.length;
    blocks.set(heading[1], plan.slice(start, end));
  }
  return blocks;
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isCli) {
  const audit = JSON.parse(readFileSync(`${docsDir}/audits/ui-prototype-conformance.json`, "utf8"));
  const plan = readFileSync(`${docsDir}/roundtable-implementation-plan.md`, "utf8");
  const result = verifyUiConformance(audit, plan, `${docsDir}audits/evidence`, existsSync);
  console.log(
    `roundtable UI conformance verified: ${result.tasks} tasks (backend-only ${result.classifications["backend-only"]}, direct-ui ${result.classifications["direct-ui"]}, ui-projection-contract ${result.classifications["ui-projection-contract"]}), ${result.conflicts} conflicts, ${result.remediationTasks} remediation tasks, ${result.evidence} evidence refs`,
  );
}
