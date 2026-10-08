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

const build = spawn(
  "mvn",
  ["-q", "-f", "services/agent-runtime/pom.xml", "package", "-DskipTests"],
  {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  },
);
children.push(build);
build.on("error", (error) => {
  console.error(`[agent-runtime] failed to build: ${error.message}`);
  stop(1);
});
build.on("exit", (code) => {
  if (stopping) return;
  if (code !== 0) {
    console.error(`[agent-runtime] build exited (${code ?? "unknown"})`);
    stop(code ?? 1);
    return;
  }
  start("java", ["-jar", "services/agent-runtime/target/agent-runtime-0.1.0.jar"], "agent-runtime");
});
start("pnpm", ["run", "dev:app"], "web-stack");
