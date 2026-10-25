import { execFileSync } from "node:child_process";
import { mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import {
  assertWorkpalE2eDatabaseUrl,
  databaseNameFor,
  dataDirLabelFor,
  explicitPort,
  type PlannedIdentity,
  PORT_ROLES,
  type PortRole,
  PURPOSE_PORTS,
  type Purpose,
  planIdentity,
  redactText,
  taskIdFor,
  volumeNamesFor,
} from "./plan.js";

export type ProcessIdentity = { pid: number; startedAt: string };

export type ProcessProbe = {
  self: () => ProcessIdentity;
  lookup: (pid: number) => string | null;
};

export type ComposeActivity = (project: string) => boolean;

export type LeaseRecord = PlannedIdentity & {
  key: string;
  purpose: Purpose;
  pid: number;
  startedAt: string;
  ports: Partial<Record<PortRole, number>>;
  createdAt: string;
};

export type ResourceLease = LeaseRecord & {
  servers: Partial<Record<PortRole, Server>>;
};

const heldServers = new Map<string, Partial<Record<PortRole, Server>>>();
const allocTails = new Map<string, Promise<unknown>>();

function stateDirectory(env: NodeJS.ProcessEnv): string {
  const configured = env.WORKPAL_RESOURCE_STATE_DIR?.trim();
  return configured && configured.length > 0 ? configured : "/tmp/workpal-resources";
}

function leasePath(root: string, key: string): string {
  return path.join(root, "leases", `${key.replaceAll(":", "--")}.json`);
}

function lockPath(root: string): string {
  return path.join(root, "alloc.lock");
}

export function systemProcessProbe(): ProcessProbe {
  let cached: ProcessIdentity | undefined;
  return {
    self() {
      if (cached && cached.pid === process.pid) return cached;
      const startedAt = lookupProcessStart(process.pid);
      if (!startedAt) throw new Error("process start time is unavailable");
      cached = { pid: process.pid, startedAt };
      return cached;
    },
    lookup: lookupProcessStart,
  };
}

function lookupProcessStart(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const stdout = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const text = stdout.trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

export function dockerComposeProjectRunning(project: string): boolean {
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(project)) return false;
  try {
    const stdout = execFileSync(
      "docker",
      ["ps", "--filter", `label=com.docker.compose.project=${project}`, "--format", "{{.ID}}"],
      { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] },
    );
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

export function leaseIsActive(
  lease: LeaseRecord,
  probe: ProcessProbe,
  composeActivity: ComposeActivity,
): boolean {
  if (probe.lookup(lease.pid) === lease.startedAt) return true;
  return lease.purpose === "compose" && composeActivity(lease.composeProject);
}

async function readLeaseFile(file: string): Promise<LeaseRecord | undefined> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as LeaseRecord;
    if (!parsed || typeof parsed.key !== "string" || typeof parsed.taskId !== "string")
      return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export async function readLeases(root: string): Promise<LeaseRecord[]> {
  const directory = path.join(root, "leases");
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
  const records: LeaseRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const record = await readLeaseFile(path.join(directory, name));
    if (record) records.push(record);
  }
  return records;
}

async function writeLeaseFile(root: string, record: LeaseRecord): Promise<void> {
  const target = leasePath(root, record.key);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp`;
  await writeFile(temporary, JSON.stringify(record));
  await rename(temporary, target);
}

async function removeLeaseFile(root: string, record: LeaseRecord): Promise<void> {
  await rm(leasePath(root, record.key), { force: true });
  await closeHeld(record.key);
}

function isEnoent(error: unknown): boolean {
  return isCode(error, "ENOENT");
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function readLockOwner(file: string): Promise<ProcessIdentity | undefined> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as ProcessIdentity;
    if (!parsed || typeof parsed.pid !== "number" || typeof parsed.startedAt !== "string")
      return undefined;
    return parsed;
  } catch (error) {
    if (isEnoent(error)) return undefined;
    return undefined;
  }
}

async function withAllocLock<T>(
  root: string,
  probe: ProcessProbe,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = allocTails.get(root) ?? Promise.resolve();
  let releaseTail: () => void = () => undefined;
  const tail = new Promise<void>((resolve) => {
    releaseTail = resolve;
  });
  allocTails.set(
    root,
    previous.then(
      () => tail,
      () => tail,
    ),
  );
  await previous.catch(() => undefined);
  try {
    await mkdir(root, { recursive: true });
    const deadline = Date.now() + 10_000;
    const file = lockPath(root);
    for (;;) {
      try {
        const handle = await open(file, "wx");
        try {
          await handle.writeFile(JSON.stringify(probe.self()));
        } finally {
          await handle.close();
        }
        try {
          return await fn();
        } finally {
          await rm(file, { force: true });
        }
      } catch (error) {
        if (!isCode(error, "EEXIST")) throw error;
        const owner = await readLockOwner(file);
        const alive = owner ? probe.lookup(owner.pid) === owner.startedAt : false;
        if (!alive && Date.now() > deadline - 9_000) {
          // An empty or abandoned lock is stale once the creator has had a chance to write it.
          if (!owner || probe.lookup(owner.pid) !== owner.startedAt)
            await rm(file, { force: true });
        }
        if (Date.now() > deadline) throw new Error("lease:lock busy");
        await delay(alive ? 20 : 10);
      }
    }
  } finally {
    releaseTail();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ResourceConflictError extends Error {
  readonly conflicts: string[];

  constructor(conflicts: string[]) {
    super(conflicts.join(","));
    this.name = "ResourceConflictError";
    this.conflicts = conflicts;
  }
}

export function findConflicts(
  intended: {
    taskId: string;
    purpose: Purpose;
    ports: Partial<Record<PortRole, number>>;
    composeProject: string;
    databaseName?: string;
  },
  leases: readonly LeaseRecord[],
  probe: ProcessProbe,
  composeActivity: ComposeActivity,
): string[] {
  const conflicts: string[] = [];
  const others = leases.filter(
    (lease) => lease.taskId !== intended.taskId && leaseIsActive(lease, probe, composeActivity),
  );
  for (const role of PORT_ROLES) {
    const port = intended.ports[role];
    if (port === undefined) continue;
    const held = others.some((lease) => Object.values(lease.ports).includes(port));
    if (held) conflicts.push(`port:${role}`);
  }
  if (others.some((lease) => lease.composeProject === intended.composeProject)) {
    conflicts.push("composeProject");
  }
  if (
    intended.databaseName &&
    others.some((lease) => lease.databaseName === intended.databaseName)
  ) {
    conflicts.push(`database:${intended.databaseName}`);
  }
  return conflicts;
}

function databaseConflict(
  value: string,
  leases: readonly LeaseRecord[],
  taskId: string,
  probe: ProcessProbe,
  composeActivity: ComposeActivity,
): string[] {
  let name: string;
  try {
    name = assertWorkpalE2eDatabaseUrl(value, "e2e");
  } catch {
    const raw = (() => {
      try {
        const url = new URL(value);
        return decodeURIComponent(url.pathname.replace(/^\//, "").split("/")[0] ?? "") || "invalid";
      } catch {
        return "invalid";
      }
    })();
    return [`database:${raw} rejected`];
  }
  const held = leases.some(
    (lease) =>
      lease.taskId !== taskId &&
      lease.databaseName === name &&
      leaseIsActive(lease, probe, composeActivity),
  );
  return held ? [`database:${name} held`] : [];
}

async function bindPort(port: number): Promise<Server> {
  const server = createServer();
  server.unref();
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.close();
      reject(error);
    };
    server.once("error", onError);
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
      server.off("error", onError);
      resolve();
    });
  });
  return server;
}

async function bindFreePort(reserved: Set<number>): Promise<{ server: Server; port: number }> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const server = await bindPort(0);
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("port:unassigned");
    }
    if (!reserved.has(address.port)) return { server, port: address.port };
    // The OS handed back a port an active lease already owns. Drop it and ask again.
    await closeServer(server);
  }
  throw new Error("port:unassigned");
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function closeHeld(key: string, roles?: readonly PortRole[]): Promise<void> {
  const servers = heldServers.get(key);
  if (!servers) return;
  const selected = roles ?? PORT_ROLES;
  for (const role of selected) {
    await closeServer(servers[role]);
    delete servers[role];
  }
  if (PORT_ROLES.every((role) => !servers[role])) heldServers.delete(key);
}

async function allocateRolePorts(
  roles: readonly PortRole[],
  env: NodeJS.ProcessEnv,
  reserved: Set<number>,
): Promise<{
  ports: Partial<Record<PortRole, number>>;
  servers: Partial<Record<PortRole, Server>>;
}> {
  const ports: Partial<Record<PortRole, number>> = {};
  const servers: Partial<Record<PortRole, Server>> = {};
  try {
    for (const role of roles) {
      const requested = explicitPort(env, role);
      if (requested !== undefined) {
        if (reserved.has(requested)) throw new ResourceConflictError([`port:${role}`]);
        try {
          servers[role] = await bindPort(requested);
        } catch {
          throw new ResourceConflictError([`port:${role}`]);
        }
        ports[role] = requested;
        reserved.add(requested);
        continue;
      }
      const bound = await bindFreePort(reserved);
      servers[role] = bound.server;
      ports[role] = bound.port;
      reserved.add(bound.port);
    }
    return { ports, servers };
  } catch (error) {
    for (const server of Object.values(servers)) await closeServer(server);
    throw error;
  }
}

export type LeaseOptions = {
  cwd?: string;
  taskSlug?: string;
  env?: NodeJS.ProcessEnv;
  purpose: Purpose;
  stateDir?: string;
  probe?: ProcessProbe;
  composeActivity?: ComposeActivity;
  /** Close reserved sockets before return. The lease file still reserves the numbers. */
  handoff?: boolean;
};

function resolveOptions(options: LeaseOptions): {
  env: NodeJS.ProcessEnv;
  root: string;
  probe: ProcessProbe;
  composeActivity: ComposeActivity;
  identity: PlannedIdentity;
} {
  const env = options.env ?? process.env;
  const probe = options.probe ?? systemProcessProbe();
  const composeActivity = options.composeActivity ?? dockerComposeProjectRunning;
  const override = env.COMPOSE_PROJECT_NAME?.trim();
  const identity = planIdentity({
    cwd: options.cwd,
    taskSlug: options.taskSlug,
    composeProject: override,
  });
  return { env, root: options.stateDir ?? stateDirectory(env), probe, composeActivity, identity };
}

export async function allocateResources(options: LeaseOptions): Promise<ResourceLease> {
  const { env, root, probe, composeActivity, identity } = resolveOptions(options);
  return withAllocLock(root, probe, async () => {
    const self = probe.self();
    const key = `${identity.taskId}:${options.purpose}`;
    const leases = await readLeases(root);
    const existing = leases.find((lease) => lease.key === key);
    if (existing && leaseIsActive(existing, probe, composeActivity)) {
      if (existing.pid === self.pid && existing.startedAt === self.startedAt) {
        return { ...existing, servers: heldServers.get(key) ?? {} };
      }
      throw new ResourceConflictError([`lease:${key}`]);
    }
    if (existing) await removeLeaseFile(root, existing);

    const externalDatabase = env.WORKPAL_E2E_DATABASE_URL?.trim();
    const databaseConflicts = externalDatabase
      ? databaseConflict(externalDatabase, leases, identity.taskId, probe, composeActivity)
      : [];
    if (databaseConflicts.length > 0) throw new ResourceConflictError(databaseConflicts);
    const externalName =
      externalDatabase && options.purpose === "e2e"
        ? assertWorkpalE2eDatabaseUrl(externalDatabase, "e2e")
        : undefined;
    const claimedDatabase =
      options.purpose === "e2e" ? (externalName ?? identity.databaseName) : undefined;
    const conflicts = findConflicts(
      {
        taskId: identity.taskId,
        purpose: options.purpose,
        ports: explicitPorts(env, PURPOSE_PORTS[options.purpose]),
        composeProject: identity.composeProject,
        databaseName: claimedDatabase,
      },
      leases.filter((lease) => lease.key !== key),
      probe,
      composeActivity,
    );
    if (conflicts.length > 0) throw new ResourceConflictError(conflicts);

    const reserved = new Set<number>();
    for (const lease of leases) {
      if (lease.key === key || !leaseIsActive(lease, probe, composeActivity)) continue;
      for (const port of Object.values(lease.ports)) {
        if (typeof port === "number") reserved.add(port);
      }
    }
    const allocated = await allocateRolePorts(PURPOSE_PORTS[options.purpose], env, reserved);
    const record: LeaseRecord = {
      ...identity,
      databaseName: claimedDatabase ?? identity.databaseName,
      volumes: volumeNamesFor(identity.composeProject),
      key,
      purpose: options.purpose,
      pid: self.pid,
      startedAt: self.startedAt,
      ports: allocated.ports,
      createdAt: new Date().toISOString(),
    };
    heldServers.set(key, allocated.servers);
    try {
      await writeLeaseFile(root, record);
    } catch (error) {
      await closeHeld(key);
      throw error;
    }
    if (options.handoff) await closeHeld(key);
    return { ...record, servers: heldServers.get(key) ?? {} };
  });
}

function explicitPorts(
  env: NodeJS.ProcessEnv,
  roles: readonly PortRole[],
): Partial<Record<PortRole, number>> {
  const ports: Partial<Record<PortRole, number>> = {};
  for (const role of roles) {
    const port = explicitPort(env, role);
    if (port !== undefined) ports[role] = port;
  }
  return ports;
}

export async function handoffPorts(key: string, roles: readonly PortRole[]): Promise<void> {
  await closeHeld(key, roles);
}

export async function closeReservedSockets(): Promise<void> {
  for (const key of [...heldServers.keys()]) await closeHeld(key);
}

export async function releaseResources(
  lease: Pick<LeaseRecord, "key" | "taskId" | "purpose">,
  options: {
    env?: NodeJS.ProcessEnv;
    stateDir?: string;
    probe?: ProcessProbe;
  } = {},
): Promise<void> {
  const env = options.env ?? process.env;
  const root = options.stateDir ?? stateDirectory(env);
  const probe = options.probe ?? systemProcessProbe();
  await withAllocLock(root, probe, async () => {
    const leases = await readLeases(root);
    const existing = leases.find((item) => item.key === lease.key);
    await closeHeld(lease.key);
    if (!existing) return;
    if (existing.taskId !== lease.taskId) return;
    const self = probe.self();
    const owner = existing.pid === self.pid && existing.startedAt === self.startedAt;
    if (owner || !leaseIsActive(existing, probe, () => false))
      await removeLeaseFile(root, existing);
  });
}

export async function recoverResources(options: {
  cwd?: string;
  taskSlug?: string;
  env?: NodeJS.ProcessEnv;
  purpose?: Purpose;
  stateDir?: string;
  probe?: ProcessProbe;
  composeActivity?: ComposeActivity;
}): Promise<{ recovered: string[]; active: string[] }> {
  const env = options.env ?? process.env;
  const root = options.stateDir ?? stateDirectory(env);
  const probe = options.probe ?? systemProcessProbe();
  const composeActivity = options.composeActivity ?? dockerComposeProjectRunning;
  const taskId = taskIdFor({ cwd: options.cwd, taskSlug: options.taskSlug });
  return withAllocLock(root, probe, async () => {
    const leases = await readLeases(root);
    const own = leases.filter(
      (lease) =>
        lease.taskId === taskId &&
        (options.purpose === undefined || lease.purpose === options.purpose),
    );
    const recovered: string[] = [];
    const active: string[] = [];
    for (const lease of own) {
      if (leaseIsActive(lease, probe, composeActivity)) {
        active.push(lease.key);
        continue;
      }
      await removeLeaseFile(root, lease);
      recovered.push(lease.key);
    }
    return { recovered, active };
  });
}

export async function cleanupResources(options: LeaseOptions): Promise<void> {
  const { root, probe, composeActivity, identity } = resolveOptions(options);
  const key = `${identity.taskId}:${options.purpose}`;
  await withAllocLock(root, probe, async () => {
    const leases = await readLeases(root);
    const existing = leases.find((lease) => lease.key === key);
    await closeHeld(key);
    if (!existing || existing.taskId !== identity.taskId) return;
    const self = probe.self();
    const owner = existing.pid === self.pid && existing.startedAt === self.startedAt;
    if (owner || !leaseIsActive(existing, probe, composeActivity))
      await removeLeaseFile(root, existing);
  });
}

export type DoctorReport = {
  taskId: string;
  ports: Record<PortRole, number | "unassigned">;
  composeProject: string;
  volumes: { pgdata: string; agentstate: string };
  databaseName: string;
  dataDirLabel: string;
  leaseDir: "leases";
  conflicts: string[];
  staleLeases: string[];
  recovery: string;
};

function portView(
  ports: Partial<Record<PortRole, number>>,
): Record<PortRole, number | "unassigned"> {
  return {
    api: ports.api ?? "unassigned",
    web: ports.web ?? "unassigned",
    apiHost: ports.apiHost ?? "unassigned",
    webHost: ports.webHost ?? "unassigned",
    postgresHost: ports.postgresHost ?? "unassigned",
  };
}

export async function inspectResources(options: {
  cwd?: string;
  taskSlug?: string;
  env?: NodeJS.ProcessEnv;
  purpose?: Purpose;
  stateDir?: string;
  probe?: ProcessProbe;
  composeActivity?: ComposeActivity;
}): Promise<DoctorReport> {
  const env = options.env ?? process.env;
  const root = options.stateDir ?? stateDirectory(env);
  const probe = options.probe ?? systemProcessProbe();
  const composeActivity = options.composeActivity ?? dockerComposeProjectRunning;
  let identity: PlannedIdentity;
  const conflicts: string[] = [];
  try {
    identity = planIdentity({
      cwd: options.cwd,
      taskSlug: options.taskSlug,
      composeProject: env.COMPOSE_PROJECT_NAME,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "composeProject:invalid";
    const taskId = taskIdFor({ cwd: options.cwd, taskSlug: options.taskSlug });
    identity = {
      taskId,
      composeProject: "invalid",
      databaseName: databaseNameFor(taskId),
      dataDirLabel: dataDirLabelFor(taskId),
      volumes: { pgdata: "invalid", agentstate: "invalid" },
    };
    conflicts.push(message.startsWith("composeProject") ? message : "composeProject:invalid");
  }
  const leases = await readLeases(root);
  const stale = leases.filter((lease) => !leaseIsActive(lease, probe, composeActivity));
  const own = leases.filter((lease) => lease.taskId === identity.taskId);
  const ports: Partial<Record<PortRole, number>> = {};
  for (const lease of own) {
    if (!leaseIsActive(lease, probe, composeActivity)) continue;
    Object.assign(ports, lease.ports);
  }
  const purpose = options.purpose ?? "e2e";
  for (const role of PORT_ROLES) {
    try {
      const explicit = explicitPort(env, role);
      if (explicit !== undefined) ports[role] = explicit;
    } catch (error) {
      conflicts.push(error instanceof Error ? error.message : `port:${role} invalid`);
    }
  }
  const external = env.WORKPAL_E2E_DATABASE_URL?.trim();
  let databaseName = identity.databaseName;
  if (external) {
    const found = databaseConflict(external, leases, identity.taskId, probe, composeActivity);
    conflicts.push(...found);
    if (found.length === 0) databaseName = assertWorkpalE2eDatabaseUrl(external, "e2e");
  }
  conflicts.push(
    ...findConflicts(
      {
        taskId: identity.taskId,
        purpose,
        ports,
        composeProject: identity.composeProject,
        databaseName: purpose === "e2e" && !external ? identity.databaseName : undefined,
      },
      leases,
      probe,
      composeActivity,
    ),
  );
  const ownStale = stale
    .filter((lease) => lease.taskId === identity.taskId)
    .map((lease) => lease.key);
  return {
    taskId: identity.taskId,
    ports: portView(ports),
    composeProject: identity.composeProject,
    volumes: identity.volumes,
    databaseName,
    dataDirLabel: identity.dataDirLabel,
    leaseDir: "leases",
    conflicts: [...new Set(conflicts)],
    staleLeases: stale.map((lease) => lease.key),
    recovery: ownStale.length > 0 ? "pnpm agent:doctor --recover" : "none",
  };
}

export function formatReport(report: DoctorReport): string {
  const ports = PORT_ROLES.map((role) => `${role}=${report.ports[role]}`).join(" ");
  const lines = [
    `taskId: ${report.taskId}`,
    `ports: ${ports}`,
    `composeProject: ${report.composeProject}`,
    `volumes: pgdata=${report.volumes.pgdata} agentstate=${report.volumes.agentstate}`,
    `database: ${report.databaseName}`,
    `dataDir: ${report.dataDirLabel}`,
    `leaseDir: ${report.leaseDir}`,
    `conflicts: ${report.conflicts.length > 0 ? report.conflicts.join(",") : "none"}`,
    `staleLeases: ${report.staleLeases.length > 0 ? report.staleLeases.join(",") : "none"}`,
    `recovery: ${report.recovery}`,
  ];
  return `${redactText(lines.join("\n"))}\n`;
}

export function formatReportJson(report: DoctorReport): string {
  return `${redactText(
    JSON.stringify({
      taskId: report.taskId,
      ports: report.ports,
      composeProject: report.composeProject,
      volumes: report.volumes,
      database: report.databaseName,
      dataDir: report.dataDirLabel,
      leaseDir: report.leaseDir,
      conflicts: report.conflicts,
      staleLeases: report.staleLeases,
      recovery: report.recovery,
    }),
  )}\n`;
}

export function requirePort(
  lease: { ports: Partial<Record<PortRole, number>> },
  role: PortRole,
): number {
  const port = lease.ports[role];
  if (port === undefined) throw new Error(`port:${role} unassigned`);
  return port;
}
