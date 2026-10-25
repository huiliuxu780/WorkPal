import { execFileSync } from "node:child_process";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import {
  allocateResources,
  cleanupResources,
  type DoctorReport,
  formatReport,
  formatReportJson,
  inspectResources,
  readLeases,
  recoverResources,
  releaseResources,
} from "./leases.js";
import {
  composeDataDirValue,
  composeProjectFor,
  isPurpose,
  type Purpose,
  redactText,
  taskIdFor,
  taskSlugFrom,
} from "./plan.js";

type Flags = {
  json: boolean;
  hold: boolean;
  allocate: boolean;
  recover: boolean;
  cleanup: boolean;
  composeUp: boolean;
  composeDown: boolean;
  purpose?: Purpose;
  parentPid?: number;
};

function parseFlags(argv: readonly string[]): Flags {
  const flags: Flags = {
    json: false,
    hold: false,
    allocate: false,
    recover: false,
    cleanup: false,
    composeUp: false,
    composeDown: false,
  };
  for (const arg of argv) {
    if (arg === "--json") flags.json = true;
    else if (arg === "--hold") flags.hold = true;
    else if (arg === "--allocate") flags.allocate = true;
    else if (arg === "--recover") flags.recover = true;
    else if (arg === "--cleanup") flags.cleanup = true;
    else if (arg === "--compose-up") flags.composeUp = true;
    else if (arg === "--compose-down") flags.composeDown = true;
    else if (arg.startsWith("--purpose=")) {
      const purpose = arg.slice("--purpose=".length);
      if (!isPurpose(purpose)) throw new Error("purpose:invalid");
      flags.purpose = purpose;
    } else if (arg.startsWith("--parent-pid=")) {
      const pid = Number(arg.slice("--parent-pid=".length));
      if (!Number.isInteger(pid) || pid <= 0) throw new Error("parent pid is invalid");
      flags.parentPid = pid;
    } else if (arg.startsWith("--task=")) {
    } else if (arg.startsWith("-")) {
      throw new Error("unsupported doctor argument");
    }
  }
  return flags;
}

function render(report: DoctorReport, json: boolean): string {
  return json ? formatReportJson(report) : formatReport(report);
}

function composeFiles(): string[] {
  return [
    "-f",
    "infra/compose/docker-compose.yml",
    "-f",
    "infra/compose/docker-compose.postgres-host.yml",
  ];
}

function composeEnvironment(
  env: NodeJS.ProcessEnv,
  plan: {
    taskId: string;
    composeProject: string;
    databaseName: string;
    ports: { apiHost?: number; webHost?: number; postgresHost?: number };
  },
): NodeJS.ProcessEnv {
  return {
    ...env,
    COMPOSE_PROJECT_NAME: plan.composeProject,
    API_HOST_PORT: String(plan.ports.apiHost ?? env.API_HOST_PORT ?? ""),
    WEB_HOST_PORT: String(plan.ports.webHost ?? env.WEB_HOST_PORT ?? ""),
    POSTGRES_HOST_PORT: String(plan.ports.postgresHost ?? env.POSTGRES_HOST_PORT ?? ""),
    POSTGRES_DB: plan.databaseName,
    WORKPAL_COMPOSE_DATA_DIR: composeDataDirValue(plan.taskId),
    POSTGRES_PASSWORD: env.POSTGRES_PASSWORD?.trim() || "workpal-dev-only",
    POSTGRES_USER: env.POSTGRES_USER?.trim() || "workpal",
    SANDBOX_SUPERVISOR_TOKEN: env.SANDBOX_SUPERVISOR_TOKEN?.trim() || "workpal-dev-only",
    SCREEN_PROXY_SECRET: env.SCREEN_PROXY_SECRET?.trim() || "workpal-dev-only",
  };
}

function runCompose(project: string, args: string[], env: NodeJS.ProcessEnv): string {
  try {
    return execFileSync("docker", ["compose", "-p", project, ...composeFiles(), ...args], {
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr =
      typeof error === "object" && error !== null && "stderr" in error
        ? String(error.stderr ?? "")
        : "";
    const message = error instanceof Error ? error.message : "compose failed";
    throw new Error(redactText(`${message}\n${stderr}`));
  }
}

async function composeUp(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  json: boolean,
): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  const lease = await allocateResources({
    purpose: "compose",
    cwd: process.cwd(),
    taskSlug: taskSlugFrom(argv, env),
    env,
    handoff: true,
  });
  try {
    runCompose(
      lease.composeProject,
      ["up", "-d", "postgres"],
      composeEnvironment(env, {
        taskId: lease.taskId,
        composeProject: lease.composeProject,
        databaseName: lease.databaseName,
        ports: lease.ports,
      }),
    );
  } catch (error) {
    await releaseResources(lease, { env });
    throw error;
  }
  const report = await inspectResources({
    cwd: process.cwd(),
    taskSlug: taskSlugFrom(argv, env),
    env,
    purpose: "compose",
  });
  return { code: 0, stdout: render(report, json), stderr: "" };
}

async function composeDown(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  const taskSlug = taskSlugFrom(argv, env);
  const taskId = taskIdFor({ cwd: process.cwd(), taskSlug });
  const root = env.WORKPAL_RESOURCE_STATE_DIR?.trim() || "/tmp/workpal-resources";
  const leases = await readLeases(root);
  const own = leases.find((lease) => lease.taskId === taskId && lease.purpose === "compose");
  const project = own?.composeProject ?? composeProjectFor(taskId);
  const ownedByOther = leases.some(
    (lease) =>
      lease.purpose === "compose" && lease.composeProject === project && lease.taskId !== taskId,
  );
  if (ownedByOther) throw new Error("composeProject");
  try {
    runCompose(
      project,
      ["down", "-v", "--remove-orphans"],
      composeEnvironment(env, {
        taskId,
        composeProject: project,
        databaseName: own?.databaseName ?? "",
        ports: own?.ports ?? {},
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/no such|not found/i.test(message)) throw error;
  }
  await cleanupResources({
    purpose: "compose",
    cwd: process.cwd(),
    taskSlug,
    env,
  });
  return { code: 0, stdout: redactText(`cleaned: ${taskId}:compose\n`), stderr: "" };
}

export type DoctorResult = {
  code: number;
  stdout: string;
  stderr: string;
  hold?: { key: string; taskId: string; purpose: Purpose };
};

export async function runDoctor(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<DoctorResult> {
  try {
    const flags = parseFlags(argv);
    const taskSlug = taskSlugFrom(argv, env);
    const base = {
      cwd: process.cwd(),
      taskSlug,
      env,
      purpose: flags.purpose ?? "e2e",
    } as const;
    if (flags.composeUp) return await composeUp(argv, env, flags.json);
    if (flags.composeDown) return await composeDown(argv, env);
    if (flags.recover) {
      const result = await recoverResources({ ...base, purpose: flags.purpose });
      if (result.recovered.length === 0 && result.active.length > 0) {
        return {
          code: 1,
          stdout: "",
          stderr: redactText(`lease:${result.active.join(",")} is active\n`),
        };
      }
      return {
        code: 0,
        stdout: redactText(`recovered: ${result.recovered.join(",") || "none"}\n`),
        stderr: "",
      };
    }
    if (flags.cleanup) {
      await cleanupResources(base);
      return { code: 0, stdout: redactText(`cleaned: ${base.purpose}\n`), stderr: "" };
    }
    if (flags.allocate || flags.hold) {
      const lease = await allocateResources({ ...base, handoff: true });
      const report = await inspectResources(base);
      if (!flags.hold) await releaseResources(lease, { env });
      const stdout = render(report, flags.json || flags.hold);
      return {
        code: report.conflicts.length > 0 ? 1 : 0,
        stdout,
        stderr: "",
        hold: flags.hold
          ? { key: lease.key, taskId: lease.taskId, purpose: lease.purpose }
          : undefined,
      };
    }
    const report = await inspectResources(base);
    return {
      code: report.conflicts.length > 0 ? 1 : 0,
      stdout: render(report, flags.json),
      stderr: "",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { code: 1, stdout: "", stderr: `${redactText(message)}\n` };
  }
}

function waitForHolderStop(): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearInterval(timer);
      resolve();
    };
    process.once("SIGTERM", finish);
    process.once("SIGINT", finish);
    const parent = process.ppid;
    // The timer must stay referenced. An unref'd timer lets Node exit and
    // abandon the lease before the holder is signalled.
    timer = setInterval(() => {
      try {
        process.kill(parent, 0);
      } catch {
        finish();
      }
    }, 500);
  });
}

function loadEnvQuietly(): void {
  const write = console.log;
  const info = console.info;
  console.log = () => undefined;
  console.info = () => undefined;
  try {
    loadRootEnv();
  } finally {
    console.log = write;
    console.info = info;
  }
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  loadEnvQuietly();
  const result = await runDoctor(argv, process.env);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.hold) {
    await waitForHolderStop();
    await releaseResources(result.hold, { env: process.env });
  }
  process.exitCode = result.code;
}
