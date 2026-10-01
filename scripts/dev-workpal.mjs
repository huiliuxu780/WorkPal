import { spawn } from "node:child_process";

const children = [];
let stopping = false;

function start(command, args, label) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  child.on("error", (error) => {
    console.error(`[${label}] failed to start: ${error.message}`);
    stop(1);
  });
  child.on("exit", (code, signal) => {
    if (stopping) return;
    console.error(`[${label}] exited (${signal ?? code ?? "unknown"})`);
    stop(code ?? 1);
  });
  children.push(child);
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(code), 250).unref();
}

process.on("SIGINT", () => stop(130));
process.on("SIGTERM", () => stop(143));

start(
  "uv",
  [
    "run",
    "--project",
    "services/agentscope",
    "uvicorn",
    "workpal_agentscope.app:app",
    "--host",
    "127.0.0.1",
    "--port",
    process.env.AGENTSCOPE_PORT ?? "8090",
    "--reload",
  ],
  "agentscope",
);
start("pnpm", ["run", "dev:app"], "web-stack");
