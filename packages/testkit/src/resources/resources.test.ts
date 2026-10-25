import { mkdtemp, readFile, rm } from "node:fs/promises";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDoctor } from "./doctor-main.js";
import {
  allocateResources,
  cleanupResources,
  closeReservedSockets,
  inspectResources,
  type ProcessProbe,
  readLeases,
  recoverResources,
  releaseResources,
} from "./leases.js";
import {
  assertWorkpalE2eDatabaseUrl,
  composeProjectFor,
  databaseNameFor,
  type PortRole,
  taskIdFor,
  taskIdFromSlug,
  volumeNamesFor,
} from "./plan.js";

const roots: string[] = [];

type ScriptedProbe = ProcessProbe & {
  setSelf: (next: { pid: number; startedAt: string }) => void;
  kill: (pid: number) => void;
  killAll: () => void;
};

function scriptedProbe(
  initial: { pid: number; startedAt: string } = { pid: 41001, startedAt: "start-a" },
): ScriptedProbe {
  let self = initial;
  const alive = new Map<number, string>([[initial.pid, initial.startedAt]]);
  return {
    self: () => ({ ...self }),
    lookup: (pid) => alive.get(pid) ?? null,
    setSelf(next) {
      self = next;
      alive.set(next.pid, next.startedAt);
    },
    kill(pid) {
      alive.delete(pid);
    },
    killAll() {
      alive.clear();
    },
  };
}

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "wp-lease-"));
  roots.push(root);
  return root;
}

function env(root: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { WORKPAL_RESOURCE_STATE_DIR: root, ...extra };
}

async function dispose(root: string, probe: ScriptedProbe): Promise<void> {
  probe.killAll();
  for (const purpose of ["e2e", "dev", "compose"] as const) {
    await cleanupResources({
      purpose,
      stateDir: root,
      taskSlug: "alpha",
      env: env(root),
      probe,
      composeActivity: () => false,
    }).catch(() => undefined);
    await cleanupResources({
      purpose,
      stateDir: root,
      taskSlug: "beta",
      env: env(root),
      probe,
      composeActivity: () => false,
    }).catch(() => undefined);
  }
  await rm(root, { recursive: true, force: true });
}

afterEach(async () => {
  await closeReservedSockets();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("worktree resource ids", () => {
  it("keeps ids stable, legal, bounded, and distinct for different paths", () => {
    const alpha = taskIdFor({ cwd: "/tmp/workpal-wt-alpha" });
    const beta = taskIdFor({ cwd: "/tmp/workpal-wt-beta" });
    const again = taskIdFor({ cwd: "/tmp/workpal-wt-alpha" });
    expect(alpha).toBe(again);
    expect(alpha).not.toBe(beta);
    for (const id of [alpha, beta, taskIdFromSlug("h4-verify")]) {
      expect(id).toMatch(/^[a-z0-9-]+$/);
      expect(id.length).toBeLessThanOrEqual(40);
    }
    expect(taskIdFromSlug(`${"x".repeat(180)}-tail`)).toMatch(/^[a-z0-9-]+$/);
    expect(taskIdFromSlug(`${"x".repeat(180)}-tail`).length).toBeLessThanOrEqual(40);
  });

  it("does not leak an account name or absolute path", async () => {
    const account = os.userInfo().username;
    const users = "Use" + "rs";
    const home = path.join("/", users, account, "Documents", "WorkPal-worktrees");
    const rooted = taskIdFor({ cwd: path.join(home, "h4-verify-a") });
    const other = taskIdFor({ cwd: path.join(home, "h4-verify-b") });
    expect(rooted).not.toBe(other);
    expect(rooted).not.toContain(account);
    expect(rooted.includes(`/${users}/`)).toBe(false);
    expect(() => taskIdFromSlug(`${account}-box`)).toThrow(/unsupported/);
    const root = await freshRoot();
    const result = await runDoctor(["--json"], {
      PATH: process.env.PATH,
      WORKPAL_RESOURCE_STATE_DIR: root,
    });
    const output = `${result.stdout}${result.stderr}`;
    expect(output).not.toContain(account);
    expect(output.includes(`/${users}/`)).toBe(false);
    expect(result.stdout).toContain("leaseDir");
    expect(result.stdout).toContain('"leaseDir":"leases"');
  });
});

describe("worktree leases", () => {
  it("allocates distinct ports under concurrency and repeats the same lease", async () => {
    const root = await freshRoot();
    const probe = scriptedProbe();
    const calls = Array.from({ length: 8 }, (_, index) =>
      allocateResources({
        purpose: "e2e",
        taskSlug: `slot-${index}`,
        stateDir: root,
        env: env(root),
        probe,
        composeActivity: () => false,
      }),
    );
    const leases = await Promise.all(calls);
    const ports = leases.flatMap((lease) => [lease.ports.api, lease.ports.web]);
    expect(new Set(ports).size).toBe(ports.length);
    const again = await allocateResources({
      purpose: "e2e",
      taskSlug: "slot-0",
      stateDir: root,
      env: env(root),
      probe,
      composeActivity: () => false,
    });
    expect(again.ports).toEqual(leases[0]?.ports);
    expect(again.key).toBe(leases[0]?.key);
    await dispose(root, probe);
  });

  it("rejects an active lease and recovers only a stale one", async () => {
    const root = await freshRoot();
    const probe = scriptedProbe({ pid: 42001, startedAt: "alive" });
    const first = await allocateResources({
      purpose: "e2e",
      taskSlug: "alpha",
      stateDir: root,
      env: env(root),
      probe,
      composeActivity: () => false,
    });
    probe.setSelf({ pid: 42002, startedAt: "other" });
    await expect(
      allocateResources({
        purpose: "e2e",
        taskSlug: "alpha",
        stateDir: root,
        env: env(root),
        probe,
        composeActivity: () => false,
      }),
    ).rejects.toThrow(/lease:/);
    probe.kill(42001);
    const report = await inspectResources({
      taskSlug: "alpha",
      stateDir: root,
      env: env(root),
      probe,
      composeActivity: () => false,
    });
    expect(report.staleLeases).toContain(first.key);
    expect(report.recovery).toBe("pnpm agent:doctor --recover");
    const beta = await allocateResources({
      purpose: "dev",
      taskSlug: "beta",
      stateDir: root,
      env: env(root),
      probe,
      composeActivity: () => false,
    });
    const recovered = await recoverResources({
      taskSlug: "alpha",
      stateDir: root,
      env: env(root),
      probe,
      composeActivity: () => false,
    });
    expect(recovered.recovered).toEqual([first.key]);
    const remaining = await readLeases(root);
    expect(remaining.map((lease) => lease.key)).toEqual([beta.key]);
    probe.setSelf({ pid: 42003, startedAt: "restart" });
    const restarted = await allocateResources({
      purpose: "e2e",
      taskSlug: "alpha",
      stateDir: root,
      env: env(root),
      probe,
      composeActivity: () => false,
    });
    expect(restarted.pid).toBe(42003);
    expect(restarted.ports.api).not.toBe(beta.ports.api);
    const second = await recoverResources({
      taskSlug: "alpha",
      stateDir: root,
      env: env(root),
      probe,
      composeActivity: () => false,
    });
    expect(second.recovered).toEqual([]);
    expect(second.active.length).toBeGreaterThan(0);
    await dispose(root, probe);
  });

  it("rejects a non-workpal_e2e database and a database held by another lease", async () => {
    expect(() => assertWorkpalE2eDatabaseUrl("postgresql://127.0.0.1:5432/rakazo", "e2e")).toThrow(
      /workpal_e2e_/,
    );
    expect(() =>
      assertWorkpalE2eDatabaseUrl("postgresql://127.0.0.1:5432/workpal_e2e_ok", "integration"),
    ).toThrow(/E2E mode/);
    const root = await freshRoot();
    const probe = scriptedProbe();
    const holder = await allocateResources({
      purpose: "e2e",
      taskSlug: "alpha",
      stateDir: root,
      env: env(root),
      probe,
      composeActivity: () => false,
    });
    probe.setSelf({ pid: 43002, startedAt: "beta" });
    await expect(
      allocateResources({
        purpose: "e2e",
        taskSlug: "beta",
        stateDir: root,
        env: env(root, {
          WORKPAL_E2E_DATABASE_URL: `postgresql://127.0.0.1:5432/${holder.databaseName}`,
        }),
        probe,
        composeActivity: () => false,
      }),
    ).rejects.toThrow(new RegExp(`database:${holder.databaseName}`));
    const report = await inspectResources({
      taskSlug: "beta",
      stateDir: root,
      env: env(root, { WORKPAL_E2E_DATABASE_URL: "postgresql://127.0.0.1:5432/not_e2e" }),
      probe,
      composeActivity: () => false,
    });
    expect(report.conflicts.join(",")).toContain("database:not_e2e rejected");
    await dispose(root, probe);
  });

  it("isolates compose projects, volumes, and ports, and cleanup leaves the other lease", async () => {
    const root = await freshRoot();
    const probe = scriptedProbe({ pid: 44001, startedAt: "one" });
    const other = scriptedProbe({ pid: 44002, startedAt: "two" });
    const alpha = await allocateResources({
      purpose: "compose",
      taskSlug: "alpha",
      stateDir: root,
      env: env(root),
      probe,
      composeActivity: () => false,
    });
    const beta = await allocateResources({
      purpose: "compose",
      taskSlug: "beta",
      stateDir: root,
      env: env(root),
      probe: other,
      composeActivity: () => false,
    });
    expect(alpha.composeProject).not.toBe(beta.composeProject);
    expect(alpha.volumes.pgdata).toBe(`${alpha.composeProject}_pgdata`);
    expect(alpha.volumes.pgdata).not.toBe(beta.volumes.pgdata);
    expect(alpha.volumes.agentstate).not.toBe(beta.volumes.agentstate);
    for (const role of [
      "apiHost",
      "webHost",
      "postgresHost",
    ] as const satisfies readonly PortRole[]) {
      expect(alpha.ports[role]).not.toBe(beta.ports[role]);
    }
    expect(alpha.databaseName.startsWith("workpal_e2e_")).toBe(true);
    expect(alpha.databaseName).not.toBe(beta.databaseName);
    await cleanupResources({
      purpose: "compose",
      taskSlug: "alpha",
      stateDir: root,
      env: env(root),
      probe,
      composeActivity: () => false,
    });
    await cleanupResources({
      purpose: "compose",
      taskSlug: "alpha",
      stateDir: root,
      env: env(root),
      probe,
      composeActivity: () => false,
    });
    const remaining = await readLeases(root);
    expect(remaining.map((lease) => lease.key)).toEqual([beta.key]);
    const conflict = await inspectResources({
      taskSlug: "gamma",
      purpose: "compose",
      stateDir: root,
      env: env(root, {
        COMPOSE_PROJECT_NAME: beta.composeProject,
        API_HOST_PORT: String(beta.ports.apiHost),
      }),
      probe: other,
      composeActivity: () => false,
    });
    expect(conflict.conflicts).toContain("composeProject");
    expect(conflict.conflicts).toContain("port:apiHost");
    await dispose(root, probe);
    await dispose(root, other);
  });

  it("keeps a compose lease active while its project is running and restarts after a crash", async () => {
    const root = await freshRoot();
    const probe = scriptedProbe({ pid: 45001, startedAt: "compose" });
    const lease = await allocateResources({
      purpose: "compose",
      taskSlug: "alpha",
      stateDir: root,
      env: env(root),
      probe,
      composeActivity: () => true,
    });
    probe.kill(45001);
    const running = await recoverResources({
      taskSlug: "alpha",
      stateDir: root,
      env: env(root),
      probe,
      composeActivity: (project) => project === lease.composeProject,
    });
    expect(running.recovered).toEqual([]);
    expect(running.active).toEqual([lease.key]);
    const crashed = await inspectResources({
      taskSlug: "alpha",
      stateDir: root,
      env: env(root),
      probe,
      composeActivity: () => false,
    });
    expect(crashed.staleLeases).toContain(lease.key);
    expect(crashed.recovery).toBe("pnpm agent:doctor --recover");
    await recoverResources({
      taskSlug: "alpha",
      stateDir: root,
      env: env(root),
      probe,
      composeActivity: () => false,
    });
    probe.setSelf({ pid: 45002, startedAt: "next" });
    const restarted = await allocateResources({
      purpose: "compose",
      taskSlug: "alpha",
      stateDir: root,
      env: env(root),
      probe,
      composeActivity: () => false,
    });
    expect(restarted.key).toBe(lease.key);
    expect(restarted.pid).toBe(45002);
    await releaseResources(restarted, { stateDir: root, env: env(root), probe });
    await releaseResources(restarted, { stateDir: root, env: env(root), probe });
    expect(await readLeases(root)).toEqual([]);
  });
});

describe("dev process env", () => {
  it("gives the leased dev ports to Turbo and the web proxy", async () => {
    const turbo = JSON.parse(await readFile(path.resolve("turbo.json"), "utf8")) as {
      tasks: { dev: { passThroughEnv?: string[] } };
    };
    const passed = turbo.tasks.dev.passThroughEnv ?? [];
    for (const name of [
      "API_PORT",
      "WEB_PORT",
      "API_URL",
      "WEB_ORIGIN",
      "BETTER_AUTH_URL",
      "API_PROXY_TARGET",
    ]) {
      expect(passed).toContain(name);
    }
    const launcher = await readFile(path.resolve("scripts/dev-workpal.mjs"), "utf8");
    expect(launcher).toContain("API_PROXY_TARGET");
  });
});

describe("dev compose contract", () => {
  it("consumes the planner project, host ports, and volume names", async () => {
    const compose = await readFile(path.resolve("infra/compose/docker-compose.yml"), "utf8");
    const overlay = await readFile(
      path.resolve("infra/compose/docker-compose.postgres-host.yml"),
      "utf8",
    );
    const variable = (name: string) => `$\u007b${name}\u007d`;
    expect(compose).toContain(`name: ${variable("COMPOSE_PROJECT_NAME:-workpal")}`);
    expect(compose).toContain(variable("API_HOST_PORT:-3100"));
    expect(compose).toContain(variable("WEB_HOST_PORT:-5173"));
    expect(compose).toContain(variable("WORKPAL_COMPOSE_DATA_DIR:-../../data"));
    expect(compose).toContain(`name: ${variable("COMPOSE_PROJECT_NAME:-workpal")}_pgdata`);
    expect(compose).toContain(`name: ${variable("COMPOSE_PROJECT_NAME:-workpal")}_agentstate`);
    expect(overlay).toContain(variable("POSTGRES_HOST_PORT:-5433"));
    const task = taskIdFor({ taskSlug: "compose-a" });
    const project = composeProjectFor(task);
    const volumes = volumeNamesFor(project);
    expect(volumes.pgdata).not.toBe(
      volumeNamesFor(composeProjectFor(taskIdFor({ taskSlug: "compose-b" }))).pgdata,
    );
    expect(databaseNameFor(task).startsWith("workpal_e2e_")).toBe(true);
  });
});
