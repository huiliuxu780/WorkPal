import { spawn } from "node:child_process";
import os from "node:os";
import { createInterface } from "node:readline";

const children = [];
let stopping = false;
let holder;

function redact(text) {
  const username = os.userInfo().username;
  let out = String(text).replace(/(?:\/Users|\/home)\/[^\s"'`]+/g, "[path]");
  out = out.replace(/[A-Za-z]:\\[^\s"'`]+/g, "[path]");
  if (username.length >= 2) out = out.split(username).join("[user]");
  return out;
}

function start(command, args, label) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  child.on("error", (error) => {
    console.error(`[${label}] failed to start: ${redact(error.message)}`);
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
  if (holder && !holder.killed) holder.kill("SIGTERM");
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(code), 250).unref();
}

process.on("SIGINT", () => stop(130));
process.on("SIGTERM", () => stop(143));

function applyPlan(plan) {
  if (typeof plan.ports?.api === "number") {
    const apiOrigin = `http://127.0.0.1:${plan.ports.api}`;
    process.env.API_PORT = String(plan.ports.api);
    process.env.API_URL = apiOrigin;
    process.env.API_PROXY_TARGET = apiOrigin;
  }
  if (typeof plan.ports?.web === "number") {
    const webOrigin = `http://127.0.0.1:${plan.ports.web}`;
    process.env.WEB_PORT = String(plan.ports.web);
    process.env.WEB_ORIGIN = webOrigin;
    process.env.BETTER_AUTH_URL = webOrigin;
  }
}

function reserveDevResources() {
  holder = spawn(
    process.execPath,
    [
      "node_modules/tsx/dist/cli.mjs",
      "packages/testkit/src/cli/resources/doctor.ts",
      "--hold",
      "--purpose=dev",
      "--json",
    ],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  holder.stderr?.on("data", (chunk) => {
    const text = redact(chunk.toString());
    if (text.trim()) process.stderr.write(text);
  });
  holder.on("error", (error) => {
    console.error(`[resources] failed to start: ${redact(error.message)}`);
    stop(1);
  });
  holder.on("exit", (code, signal) => {
    if (stopping) return;
    console.error(`[resources] exited (${signal ?? code ?? "unknown"})`);
    stop(code ?? 1);
  });
  const lines = createInterface({ input: holder.stdout });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("resource plan was not ready"));
    }, 15_000);
    lines.once("line", (line) => {
      clearTimeout(timer);
      try {
        const plan = JSON.parse(line);
        if (plan.conflicts?.length) {
          reject(new Error(String(plan.conflicts)));
          return;
        }
        applyPlan(plan);
        resolve(plan);
      } catch (error) {
        reject(error instanceof Error ? error : new Error("resource plan was invalid"));
      }
    });
  });
}

const devReady = reserveDevResources();
devReady.then(
  () => {
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
      console.error(`[agent-runtime] failed to build: ${redact(error.message)}`);
      stop(1);
    });
    build.on("exit", (code) => {
      if (stopping) return;
      if (code !== 0) {
        console.error(`[agent-runtime] build exited (${code ?? "unknown"})`);
        stop(code ?? 1);
        return;
      }
      start(
        "java",
        ["-jar", "services/agent-runtime/target/agent-runtime-0.1.0.jar"],
        "agent-runtime",
      );
    });
    start("pnpm", ["run", "dev:app"], "web-stack");
  },
  (error) => {
    console.error(`[resources] ${redact(error instanceof Error ? error.message : String(error))}`);
    stop(1);
  },
);
