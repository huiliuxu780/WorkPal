import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { createDb } from "./client.js";

const ADVISORY_LOCK_KEY = "814230701";
const here = path.dirname(fileURLToPath(import.meta.url));
const packagesDbDir = path.resolve(here, "..");

export type IsolatedPostgresDatabase = {
  db: ReturnType<typeof createDb>;
  drop: () => Promise<void>;
};

type MigrationState = {
  hash: string;
  count: number;
  latest: string;
};

/**
 * Give one Vitest file its own database cloned from a migrated template.
 * The advisory lock is held across migrate and CREATE DATABASE ... TEMPLATE so
 * parallel files share one template and never migrate the caller's database.
 */
export async function createIsolatedPostgresDatabase(
  label: string,
): Promise<IsolatedPostgresDatabase> {
  const sourceUrl = process.env.DATABASE_URL;
  if (!sourceUrl?.startsWith("postgres")) {
    throw new Error("DATABASE_URL must be a postgres connection string");
  }
  const migrations = migrationState();
  const templateName = `wp_tpl_${migrations.hash}`;
  const clone = cloneName(migrations.hash, label);
  assertDisposable(templateName, sourceUrl);
  assertDisposable(clone, sourceUrl);

  const admin = new Client({
    connectionString: sourceUrl,
    application_name: "wp_test_admin",
  });
  await admin.connect().catch((error: unknown) => {
    throw new Error(`isolated postgres admin connection failed: ${scrub(error)}`);
  });
  let created = false;
  try {
    await admin.query("SELECT pg_advisory_lock($1::bigint)", [ADVISORY_LOCK_KEY]);
    await ensureTemplate(admin, sourceUrl, templateName, migrations);
    await terminateBackends(admin, templateName);
    await admin.query(
      `CREATE DATABASE ${quoteIdent(clone)} TEMPLATE ${quoteIdent(templateName)}`,
    );
    created = true;
  } finally {
    await admin.query("SELECT pg_advisory_unlock($1::bigint)", [ADVISORY_LOCK_KEY]).catch(() => undefined);
    await admin.end().catch(() => undefined);
  }

  const databaseUrl = withDatabase(sourceUrl, clone);
  try {
    const db = createDb(databaseUrl, {
      applicationName: `wp_${label}`.replace(/[^a-z0-9_]/gi, "").slice(0, 60),
    });
    return {
      db,
      async drop() {
        await db.prisma.$disconnect().catch(() => undefined);
        await db.pool.end().catch(() => undefined);
        await dropDatabase(sourceUrl, clone);
      },
    };
  } catch (error) {
    if (created) await dropDatabase(sourceUrl, clone);
    throw error;
  }
}

function migrationState(): MigrationState {
  const root = path.join(packagesDbDir, "prisma", "migrations");
  const hash = createHash("sha256");
  const names: string[] = [];
  for (const dir of readdirSync(root).sort()) {
    const sqlPath = path.join(root, dir, "migration.sql");
    if (!existsSync(sqlPath)) continue;
    names.push(dir);
    hash.update(dir);
    hash.update("\0");
    hash.update(readFileSync(sqlPath));
  }
  const latest = names[names.length - 1];
  if (!latest) throw new Error("no prisma migrations found");
  return { hash: hash.digest("hex").slice(0, 12), count: names.length, latest };
}

async function ensureTemplate(
  admin: Client,
  sourceUrl: string,
  templateName: string,
  migrations: MigrationState,
): Promise<void> {
  const existing = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [templateName]);
  const current = (existing.rowCount ?? 0) > 0 && (await templateIsCurrent(sourceUrl, templateName, migrations));
  if (!current && (existing.rowCount ?? 0) > 0) {
    await terminateBackends(admin, templateName);
    await admin.query(`DROP DATABASE ${quoteIdent(templateName)}`);
  }
  if (!current) {
    await admin.query(`CREATE DATABASE ${quoteIdent(templateName)}`);
    migrateTemplate(sourceUrl, templateName);
    await terminateBackends(admin, templateName);
  }
  await dropStaleTemplates(admin, templateName);
}

async function templateIsCurrent(
  sourceUrl: string,
  templateName: string,
  migrations: MigrationState,
): Promise<boolean> {
  const client = new Client({
    connectionString: withDatabase(sourceUrl, templateName),
    application_name: "wp_test_template_check",
  });
  try {
    await client.connect();
    const result = await client.query<{ finished: number; latest: Date | null }>(
      `SELECT
         (SELECT COUNT(*)::int FROM "_prisma_migrations"
           WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) AS finished,
         (SELECT finished_at FROM "_prisma_migrations"
           WHERE migration_name = $1 AND rolled_back_at IS NULL) AS latest`,
      [migrations.latest],
    );
    const row = result.rows[0];
    return row?.finished === migrations.count && row.latest != null;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

function migrateTemplate(sourceUrl: string, templateName: string): void {
  const databaseUrl = withDatabase(sourceUrl, templateName);
  try {
    execFileSync("pnpm", ["exec", "prisma", "migrate", "deploy"], {
      cwd: packagesDbDir,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      encoding: "utf8",
      stdio: "pipe",
      timeout: 180_000,
    });
  } catch (error) {
    const stderr =
      error && typeof error === "object" && "stderr" in error ? String(error.stderr) : String(error);
    throw new Error(
      `prisma migrate deploy failed for ${templateName}: ${scrub(stderr).slice(0, 1500)}`,
    );
  }
}

async function dropStaleTemplates(admin: Client, current: string): Promise<void> {
  const stale = await admin.query<{ datname: string }>(
    "SELECT datname FROM pg_database WHERE datname LIKE 'wp_tpl_%' AND datname <> $1",
    [current],
  );
  for (const row of stale.rows) {
    if (!/^wp_tpl_[a-z0-9_]+$/.test(row.datname)) continue;
    await terminateBackends(admin, row.datname);
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(row.datname)}`);
  }
}

async function dropDatabase(sourceUrl: string, name: string): Promise<void> {
  assertDisposable(name, sourceUrl);
  const admin = new Client({
    connectionString: sourceUrl,
    application_name: "wp_test_drop",
  });
  await admin.connect();
  try {
    await terminateBackends(admin, name);
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)}`);
  } finally {
    await admin.end().catch(() => undefined);
  }
}

async function terminateBackends(admin: Client, datname: string): Promise<void> {
  await admin.query(
    `SELECT pg_terminate_backend(pid)
     FROM pg_stat_activity
     WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [datname],
  );
}

function cloneName(hash: string, label: string): string {
  const safe = label.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 16) || "test";
  const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
  return `wp_${hash.slice(0, 8)}_${safe}_${suffix}`;
}

function quoteIdent(name: string): string {
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error("unsafe database identifier");
  return `"${name}"`;
}

function sourceDatabaseName(connectionString: string): string {
  const withoutQuery = connectionString.split("?")[0] ?? connectionString;
  return decodeURIComponent(withoutQuery.slice(withoutQuery.lastIndexOf("/") + 1));
}

function assertDisposable(name: string, sourceUrl: string): void {
  quoteIdent(name);
  const source = sourceDatabaseName(sourceUrl);
  if (
    name === source ||
    name === "rakazo" ||
    name === "postgres" ||
    name === "template0" ||
    name === "template1"
  ) {
    throw new Error(`refusing to change database ${name}`);
  }
}

function withDatabase(connectionString: string, database: string): string {
  quoteIdent(database);
  const queryIndex = connectionString.indexOf("?");
  const base = queryIndex === -1 ? connectionString : connectionString.slice(0, queryIndex);
  const query = queryIndex === -1 ? "" : connectionString.slice(queryIndex);
  const slash = base.lastIndexOf("/");
  if (slash < "postgres://".length) throw new Error("invalid database url");
  return `${base.slice(0, slash + 1)}${database}${query}`;
}

function scrub(value: unknown): string {
  return String(value).replace(/postgres(?:ql)?:\/\/[^\s'"]+/gi, "postgres://***");
}
