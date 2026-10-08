import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Cannot allocate Java runtime port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

export async function startJavaRuntime(dataDir: string, env: NodeJS.ProcessEnv = process.env) {
  const root = path.resolve(import.meta.dirname, "../../../..");
  const project = path.join(root, "services/agent-runtime/pom.xml");
  const jar = path.join(root, "services/agent-runtime/target/agent-runtime-0.1.0.jar");
  if (env.AGENT_RUNTIME_SKIP_BUILD === "1") {
    if (!existsSync(jar)) throw new Error("Java runtime jar is missing");
  } else {
    execFileSync("mvn", ["-q", "-f", project, "package", "-DskipTests"], {
      cwd: root,
      env,
      stdio: "inherit",
      timeout: 180_000,
    });
  }
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child: ChildProcess = spawn("java", ["-jar", jar], {
    cwd: root,
    env: {
      ...env,
      AGENT_RUNTIME_HOST: "127.0.0.1",
      AGENT_RUNTIME_PORT: String(port),
      AGENT_RUNTIME_DATA_DIR: path.join(dataDir, "agent-runtime"),
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  let startupError: Error | undefined;
  child.once("error", (error) => {
    startupError = error;
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (startupError) throw startupError;
    if (child.exitCode !== null) throw new Error(`Java runtime exited ${child.exitCode}`);
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) {
        return {
          url,
          async stop() {
            if (child.exitCode !== null) return;
            child.kill("SIGTERM");
            await new Promise<void>((resolve) => {
              const timer = setTimeout(() => {
                child.kill("SIGKILL");
                resolve();
              }, 5_000);
              child.once("exit", () => {
                clearTimeout(timer);
                resolve();
              });
            });
          },
        };
      }
    } catch {
      /* Server is still starting. */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  child.kill("SIGTERM");
  throw new Error("Java runtime did not become healthy within 30 seconds");
}
