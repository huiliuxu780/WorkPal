import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const docsDir = fileURLToPath(new URL("./", import.meta.url));

const requiredImplementationOwners = new Map([
  ["RT-25", ["F04"]],
  ["RT-26", ["C06", "P05", "F04"]],
]);

function between(text, start, end) {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0) {
    throw new Error(`section not found: ${start} ... ${end}`);
  }
  return text.slice(startIndex, endIndex);
}

function unique(values) {
  return [...new Set(values)];
}

function parseDependencyLine(line) {
  if (line === "无。") return { ids: [] };
  if (!/^RT-\d+(?:、RT-\d+)*。$/.test(line)) {
    return { error: `invalid dependency syntax: ${line}` };
  }
  return { ids: line.slice(0, -1).split("、") };
}

function parseCoverageLine(line, label) {
  const match = /^(AC\d+(?:、AC\d+)*)。场景 ([A-Z]\d+(?:、[A-Z]\d+)*)。$/.exec(line);
  if (!match) return { error: `invalid ${label} syntax: ${line}` };
  return {
    acceptance: match[1].split("、"),
    scenarios: match[2].split("、"),
  };
}

function parseExpected(prd) {
  const acceptanceSection = between(prd, "## 11. 验收标准", "## 12. 代码依据");
  const acceptanceNumbers = [...acceptanceSection.matchAll(/^(\d+)\. /gm)].map((match) =>
    Number(match[1]),
  );
  const expectedAcceptance = acceptanceNumbers.map(
    (number) => `AC${String(number).padStart(2, "0")}`,
  );
  const scenarioSection = between(prd, "## 13. 完整场景矩阵", "## 14. 原型覆盖");
  const expectedScenarios = unique(
    [...scenarioSection.matchAll(/^\| ([A-Z]\d+) \|/gm)].map((match) => match[1]),
  );
  return { expectedAcceptance, expectedScenarios };
}

function parseTasks(plan) {
  const headings = [...plan.matchAll(/^### (RT-\d+) (.+)$/gm)].map((match) => ({
    id: match[1],
    title: match[2],
    index: match.index,
  }));
  return headings.map((heading, index) => {
    const end = headings[index + 1]?.index ?? plan.length;
    const block = plan.slice(heading.index, end);
    const dependencyLines = [...block.matchAll(/^依赖：(.+)$/gm)].map((match) => match[1]);
    const coverageLines = [...block.matchAll(/^覆盖：(.+)$/gm)].map((match) => match[1]);
    const verificationCoverageLines = [...block.matchAll(/^验证覆盖：(.+)$/gm)].map(
      (match) => match[1],
    );
    return {
      ...heading,
      dependencyLines,
      coverageLines,
      verificationCoverageLines,
    };
  });
}

export function verifyImplementationPlan(prd, plan) {
  const errors = [];
  const { expectedAcceptance, expectedScenarios } = parseExpected(prd);
  const tasks = parseTasks(plan);
  const taskIds = tasks.map((task) => task.id);
  const taskSet = new Set(taskIds);

  if (taskIds.length !== taskSet.size) {
    const duplicates = unique(taskIds.filter((id, index) => taskIds.indexOf(id) !== index));
    errors.push(`duplicate task definitions: ${duplicates.join(", ")}`);
  }

  const expectedTaskIds = Array.from({ length: tasks.length }, (_, index) =>
    `RT-${String(index).padStart(2, "0")}`,
  );
  if (taskIds.join(",") !== expectedTaskIds.join(",")) {
    errors.push(`task sequence must be contiguous: ${taskIds.join(", ")}`);
  }

  const order = new Map(taskIds.map((id, index) => [id, index]));
  const graph = new Map(taskIds.map((id) => [id, []]));
  for (const task of tasks) {
    if (task.dependencyLines.length !== 1) {
      errors.push(`${task.id} must declare exactly one dependency line`);
    }
    const parsedDependencies = task.dependencyLines[0]
      ? parseDependencyLine(task.dependencyLines[0])
      : { ids: [] };
    if (parsedDependencies.error) errors.push(`${task.id} ${parsedDependencies.error}`);
    task.dependencies = parsedDependencies.ids ?? [];
    for (const dependency of task.dependencies) {
      if (!taskSet.has(dependency)) {
        errors.push(`${task.id} has unknown dependency ${dependency}`);
        continue;
      }
      if (dependency === task.id) errors.push(`${task.id} depends on itself`);
      graph.get(task.id).push(dependency);
      if (order.get(dependency) >= order.get(task.id)) {
        errors.push(`${task.id} depends on later task ${dependency}`);
      }
    }
  }

  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) {
      errors.push(`dependency cycle includes ${id}`);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of graph.get(id) ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of taskIds) visit(id);

  const expectedAcceptanceSet = new Set(expectedAcceptance);
  const expectedScenarioSet = new Set(expectedScenarios);
  for (const task of tasks) {
    if (task.coverageLines.length > 1) errors.push(`${task.id} has multiple implementation coverage lines`);
    if (task.verificationCoverageLines.length > 1) {
      errors.push(`${task.id} has multiple verification coverage lines`);
    }
    const parsedCoverage = task.coverageLines[0]
      ? parseCoverageLine(task.coverageLines[0], "coverage")
      : { acceptance: [], scenarios: [] };
    const parsedVerification = task.verificationCoverageLines[0]
      ? parseCoverageLine(task.verificationCoverageLines[0], "verification coverage")
      : { acceptance: [], scenarios: [] };
    if (parsedCoverage.error) errors.push(`${task.id} ${parsedCoverage.error}`);
    if (parsedVerification.error) errors.push(`${task.id} ${parsedVerification.error}`);
    task.acceptance = parsedCoverage.acceptance ?? [];
    task.scenarios = parsedCoverage.scenarios ?? [];
    task.verificationAcceptance = parsedVerification.acceptance ?? [];
    task.verificationScenarios = parsedVerification.scenarios ?? [];
  }

  const validationTasks = tasks.filter((task) => task.verificationCoverageLines.length > 0);
  if (validationTasks.length !== 1) {
    errors.push(`expected exactly one integration validation task, found ${validationTasks.length}`);
  }
  const validationTask = validationTasks[0];
  if (validationTask && validationTask.coverageLines.length > 0) {
    errors.push(`${validationTask.id} cannot claim implementation coverage`);
  }
  if (validationTask && validationTask.id !== taskIds.at(-1)) {
    errors.push(`${validationTask.id} integration validation task must be last`);
  }

  const implementationTasks = tasks.filter((task) => task !== validationTask);
  const actualAcceptance = implementationTasks.flatMap((task) => task.acceptance);
  const actualScenarios = implementationTasks.flatMap((task) => task.scenarios);
  const validationAcceptance = tasks.flatMap((task) => task.verificationAcceptance);
  const validationScenarios = tasks.flatMap((task) => task.verificationScenarios);

  for (const [taskId, scenarioIds] of requiredImplementationOwners) {
    const task = implementationTasks.find((candidate) => candidate.id === taskId);
    if (!task) {
      errors.push(`required implementation owner is missing: ${taskId}`);
      continue;
    }
    for (const scenarioId of scenarioIds) {
      if (!task.scenarios.includes(scenarioId)) {
        errors.push(`${taskId} must own scenario ${scenarioId}`);
      }
    }
  }

  if (validationTask) {
    const dependencyClosure = new Set();
    const collectDependencies = (id) => {
      for (const dependency of graph.get(id) ?? []) {
        if (dependencyClosure.has(dependency)) continue;
        dependencyClosure.add(dependency);
        collectDependencies(dependency);
      }
    };
    collectDependencies(validationTask.id);
    for (const task of implementationTasks) {
      if (!dependencyClosure.has(task.id)) {
        errors.push(`${validationTask.id} does not depend on implementation task ${task.id}`);
      }
    }
  }

  for (const id of unique([...actualAcceptance, ...validationAcceptance])) {
    if (!expectedAcceptanceSet.has(id)) errors.push(`unknown acceptance id ${id}`);
  }
  for (const id of unique([...actualScenarios, ...validationScenarios])) {
    if (!expectedScenarioSet.has(id)) errors.push(`unknown scenario id ${id}`);
  }
  for (const id of expectedAcceptance) {
    if (!actualAcceptance.includes(id)) errors.push(`acceptance has no implementation owner: ${id}`);
  }
  for (const id of expectedScenarios) {
    if (!actualScenarios.includes(id)) errors.push(`scenario has no implementation owner: ${id}`);
  }
  for (const id of expectedAcceptance) {
    if (!validationAcceptance.includes(id)) errors.push(`acceptance missing integration verification: ${id}`);
  }
  for (const id of expectedScenarios) {
    if (!validationScenarios.includes(id)) errors.push(`scenario missing integration verification: ${id}`);
  }

  if (errors.length > 0) throw new Error(errors.join("\n"));
  return {
    tasks: taskIds.length,
    acceptance: expectedAcceptance.length,
    scenarios: expectedScenarios.length,
  };
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isCli) {
  const prd = readFileSync(`${docsDir}/roundtable-product-requirements.md`, "utf8");
  const plan = readFileSync(`${docsDir}/roundtable-implementation-plan.md`, "utf8");
  const result = verifyImplementationPlan(prd, plan);
  console.log(
    `roundtable plan verified: ${result.tasks} tasks, ${result.acceptance} acceptance criteria, ${result.scenarios} scenarios`,
  );
}
