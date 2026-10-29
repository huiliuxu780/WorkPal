import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vitest = path.join(root, "node_modules", ".bin", "vitest");

const environment = process.env;
if (!environment.VERIFY_DATABASE || !environment.DATABASE_URL) {
  console.error("VERIFY_DATABASE=1 and DATABASE_URL are required");
  process.exit(2);
}

for (let round = 1; round <= 20; round += 1) {
  console.log(`RT-25 PostgreSQL concurrency round ${round}/20`);
  const result = spawnSync(vitest, ["run", "packages/db/src/session-admission.postgres.test.ts"], {
    cwd: root,
    env: environment,
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
