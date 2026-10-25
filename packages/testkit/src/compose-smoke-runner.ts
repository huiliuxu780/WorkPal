import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";

/**
 * Finite per-script budget. The smoke scripts are bash-only and finish in
 * milliseconds idle; the budget is a last-resort bound under full-suite CPU
 * saturation, not a tuning knob for slow machines.
 */
export const COMPOSE_SMOKE_TIMEOUT_MS = 60_000;

export async function listComposeSmokeScripts(repoRoot: string): Promise<string[]> {
  const composeDir = path.join(repoRoot, "infra", "compose");
  const entries = await readdir(composeDir);
  return entries
    .filter((entry) => entry.endsWith(".smoke.sh"))
    .sort()
    .map((entry) => path.join(composeDir, entry));
}

/**
 * Run one compose smoke script in its own process group so a timeout can kill
 * the script and everything it spawned. Errors always name the script.
 */
export function runComposeSmokeScript(
  script: string,
  timeoutMs: number = COMPOSE_SMOKE_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [script], {
      cwd: path.dirname(script),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`compose smoke script could not start: ${script}: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(
          new Error(
            `compose smoke script timed out after ${timeoutMs}ms and its process group was killed: ${script}\n${stderr}`,
          ),
        );
        return;
      }
      if (code !== 0) {
        reject(
          new Error(
            `compose smoke script failed with exit ${code}: ${script}\n${stderr || stdout}`,
          ),
        );
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}
