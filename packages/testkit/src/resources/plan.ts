import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Public resource id. Never includes a machine user name or absolute path. */
export const TASK_ID_MAX = 40;
const SLUG_MAX = 24;
const DIGEST_LEN = 10;

export const PORT_ROLES = ["api", "web", "apiHost", "webHost", "postgresHost"] as const;
export type PortRole = (typeof PORT_ROLES)[number];

export const PURPOSES = ["e2e", "dev", "compose"] as const;
export type Purpose = (typeof PURPOSES)[number];

export const PURPOSE_PORTS: Record<Purpose, readonly PortRole[]> = {
  e2e: ["api", "web"],
  dev: ["api", "web"],
  compose: ["apiHost", "webHost", "postgresHost"],
};

export const PORT_ENV: Record<PortRole, string> = {
  api: "API_PORT",
  web: "WEB_PORT",
  apiHost: "API_HOST_PORT",
  webHost: "WEB_HOST_PORT",
  postgresHost: "POSTGRES_HOST_PORT",
};

const PROJECT_NAME = /^[a-z0-9][a-z0-9_-]{0,52}$/;

export function forbiddenIdentityTokens(): Set<string> {
  const username = os
    .userInfo()
    .username.toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  return new Set([username, "users", "home", "root"].filter((token) => token.length >= 2));
}

export function redactText(text: string): string {
  const username = os.userInfo().username;
  let out = text.replace(/(?:\/Users|\/home)\/[^\s"'`]+/g, "[path]");
  out = out.replace(/[A-Za-z]:\\[^\s"'`]+/g, "[path]");
  if (username.length >= 2) out = out.split(username).join("[user]");
  return out;
}

function digest(label: string): string {
  return createHash("sha256").update(label).digest("hex").slice(0, DIGEST_LEN);
}

function slugFromParts(value: string, forbidden: Set<string>): string {
  const parts = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .split("-")
    .filter((part) => part.length > 0 && !forbidden.has(part));
  return parts.join("-").slice(0, SLUG_MAX).replace(/-$/g, "");
}

export function normalizeWorktreePath(input: string): string {
  try {
    return realpathSync(path.resolve(input))
      .replaceAll("\\", "/")
      .replace(/\/+$/, "")
      .toLowerCase();
  } catch {
    return path.resolve(input).replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
  }
}

export function taskIdFromSlug(slug: string): string {
  const forbidden = forbiddenIdentityTokens();
  const cleaned = slug.trim().toLowerCase();
  if (
    cleaned.includes("/") ||
    cleaned.includes("\\") ||
    cleaned.includes("..") ||
    [...forbidden].some((token) => cleaned.split(/[^a-z0-9]+/).includes(token))
  ) {
    throw new Error("task slug contains an unsupported character");
  }
  const body = slugFromParts(cleaned, forbidden);
  if (!body) throw new Error("task slug must contain a letter or digit");
  const id = `wt-${body}-${digest(`workpal-slug:${cleaned}`)}`;
  return id.slice(0, TASK_ID_MAX);
}

export function taskIdFor(input: { cwd?: string; taskSlug?: string }): string {
  if (input.taskSlug?.trim()) return taskIdFromSlug(input.taskSlug);
  const normalized = normalizeWorktreePath(input.cwd ?? process.cwd());
  const body = slugFromParts(path.posix.basename(normalized), forbiddenIdentityTokens()) || "task";
  const id = `wt-${body}-${digest(`workpal-worktree:${normalized}`)}`;
  return id.slice(0, TASK_ID_MAX);
}

export function taskSlugFrom(argv: readonly string[], env: NodeJS.ProcessEnv): string | undefined {
  const arg = argv.find((item) => item.startsWith("--task="));
  const value = (arg ? arg.slice("--task=".length) : env.WORKPAL_TASK_SLUG)?.trim();
  return value ? value : undefined;
}

export function composeProjectFor(taskId: string): string {
  const project = `wp-${taskId}`.replace(/[^a-z0-9-]/g, "").slice(0, 53);
  if (!PROJECT_NAME.test(project)) throw new Error("composeProject:invalid");
  return project;
}

export function assertComposeProjectName(name: string): string {
  const trimmed = name.trim().toLowerCase();
  if (!PROJECT_NAME.test(trimmed)) throw new Error("composeProject:invalid");
  return trimmed;
}

export function databaseNameFor(taskId: string): string {
  const name = `workpal_e2e_${taskId.replaceAll("-", "_")}`.slice(0, 63);
  if (!name.startsWith("workpal_e2e_") || !/^[a-z0-9_]+$/.test(name)) {
    throw new Error("database:invalid");
  }
  return name;
}

export function volumeNamesFor(project: string): { pgdata: string; agentstate: string } {
  return {
    pgdata: `${project}_pgdata`,
    agentstate: `${project}_agentstate`,
  };
}

export function dataDirLabelFor(taskId: string): string {
  return `data/compose/${taskId}`;
}

export function composeDataDirValue(taskId: string): string {
  return `../../${dataDirLabelFor(taskId)}`;
}

export type PlannedIdentity = {
  taskId: string;
  composeProject: string;
  databaseName: string;
  dataDirLabel: string;
  volumes: { pgdata: string; agentstate: string };
};

export function planIdentity(input: {
  cwd?: string;
  taskSlug?: string;
  composeProject?: string;
}): PlannedIdentity {
  const taskId = taskIdFor(input);
  const composeProject = input.composeProject?.trim()
    ? assertComposeProjectName(input.composeProject)
    : composeProjectFor(taskId);
  return {
    taskId,
    composeProject,
    databaseName: databaseNameFor(taskId),
    dataDirLabel: dataDirLabelFor(taskId),
    volumes: volumeNamesFor(composeProject),
  };
}

export function databaseNameFromUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("database:invalid rejected");
  }
  return decodeURIComponent(url.pathname.replace(/^\//, "").split("/")[0] ?? "");
}

/**
 * Integration never accepts an external database URL. E2E accepts only a local
 * database whose name starts with workpal_e2e_.
 */
export function assertWorkpalE2eDatabaseUrl(value: string, mode: "e2e" | "integration"): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("WORKPAL_E2E_DATABASE_URL must name a local workpal_e2e_ database in E2E mode");
  }
  const name = databaseNameFromUrl(value);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (mode === "integration" || !local || !name.startsWith("workpal_e2e_")) {
    throw new Error("WORKPAL_E2E_DATABASE_URL must name a local workpal_e2e_ database in E2E mode");
  }
  return name;
}

export function explicitPort(env: NodeJS.ProcessEnv, role: PortRole): number | undefined {
  const raw = env[PORT_ENV[role]];
  if (raw === undefined || raw.trim() === "") return undefined;
  if (!/^[0-9]+$/.test(raw.trim())) throw new Error(`port:${role} invalid`);
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`port:${role} invalid`);
  return port;
}

export function isPurpose(value: string): value is Purpose {
  return (PURPOSES as readonly string[]).includes(value);
}
