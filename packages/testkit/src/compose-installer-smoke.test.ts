import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  COMPOSE_SMOKE_TIMEOUT_MS,
  listComposeSmokeScripts,
  runComposeSmokeScript,
} from "./compose-smoke-runner.js";

const describeFast = process.env.VERIFY_PROVIDERS ? describe.skip : describe;
const repoRoot = path.resolve(import.meta.dirname, "../../..");
const scripts = await listComposeSmokeScripts(repoRoot);
if (scripts.length === 0) {
  throw new Error("No compose smoke scripts found under infra/compose");
}

// One test per script: a failure names its script, and each script gets its
// own finite budget instead of sharing one implicit deadline for the batch.
describeFast("compose installer smoke scripts", () => {
  for (const script of scripts) {
    it(
      `passes ${path.basename(script)}`,
      async () => {
        await runComposeSmokeScript(script);
      },
      COMPOSE_SMOKE_TIMEOUT_MS + 30_000,
    );
  }

  it("names the failing script and surfaces its stderr", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "compose-smoke-fail-"));
    try {
      const script = path.join(dir, "fail.smoke.sh");
      await writeFile(script, "#!/usr/bin/env bash\necho boom-marker >&2\nexit 3\n");
      await chmod(script, 0o755);
      await expect(runComposeSmokeScript(script)).rejects.toThrow(
        /compose smoke script failed with exit 3: .*fail\.smoke\.sh[\s\S]*boom-marker/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("kills a hung script's process group when its budget expires", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "compose-smoke-hang-"));
    const pidFile = path.join(dir, "pid");
    try {
      const script = path.join(dir, "hung.smoke.sh");
      await writeFile(script, `#!/usr/bin/env bash\necho $$ > "${pidFile}"\nsleep 300\n`);
      await chmod(script, 0o755);
      const started = Date.now();
      await expect(runComposeSmokeScript(script, 700)).rejects.toThrow(
        /timed out after 700ms and its process group was killed: .*hung\.smoke\.sh/,
      );
      expect(Date.now() - started).toBeLessThan(30_000);
      // The killed process group leaves no sleeper behind.
      const pid = (await readFile(pidFile, "utf8")).trim();
      await new Promise((resolve) => setTimeout(resolve, 300));
      const ps = spawnSync("ps", ["-p", pid], { encoding: "utf8" });
      expect(ps.stdout.trim().split("\n").filter(Boolean)).toHaveLength(1); // header only
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("resolves a healthy script with its output", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "compose-smoke-ok-"));
    try {
      const script = path.join(dir, "ok.smoke.sh");
      await writeFile(script, "#!/usr/bin/env bash\necho healthy-marker\n");
      await chmod(script, 0o755);
      const { stdout } = await runComposeSmokeScript(script);
      expect(stdout).toContain("healthy-marker");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
