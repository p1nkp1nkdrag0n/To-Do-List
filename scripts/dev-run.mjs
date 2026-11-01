/**
 * 一条命令同时起 API 和前端（替代 concurrently，少一个依赖）。
 *
 *   node scripts/dev-run.mjs demo    # 演示：API(4000) + 前端(5173)，不热重载
 *   node scripts/dev-run.mjs dev     # 开发：两个都热重载
 *
 * 任一进程退出就一起收掉，Ctrl+C 也是。
 */
import { spawn } from "node:child_process";

const mode = process.argv[2] === "dev" ? "dev" : "demo";
const apiScript = mode === "dev" ? "server:dev" : "server:v2";

const COMMANDS = [
  { name: "api", color: "\u001b[34m", script: apiScript },
  { name: "web", color: "\u001b[32m", script: "client:dev" },
];

const RESET = "\u001b[0m";
const children = [];
let shuttingDown = false;

function prefix(name, color, chunk) {
  const text = String(chunk);
  return text
    .split(/\r?\n/)
    .filter((line) => line !== "")
    .map((line) => `${color}[${name}]${RESET} ${line}`)
    .join("\n");
}

for (const command of COMMANDS) {
  const child = spawn("npm", ["run", command.script], {
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
    env: process.env,
  });
  child.stdout.on("data", (chunk) => process.stdout.write(`${prefix(command.name, command.color, chunk)}\n`));
  child.stderr.on("data", (chunk) => process.stderr.write(`${prefix(command.name, command.color, chunk)}\n`));
  child.on("exit", (code) => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const other of children) {
      if (other !== child) other.kill();
    }
    process.exitCode = code ?? 1;
  });
  children.push(child);
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
