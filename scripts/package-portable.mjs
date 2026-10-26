/**
 * 打一个「便携版」目录（L1）：双击 启动.cmd 就能在本机跑起来。
 *
 *   node scripts/package-portable.mjs
 *
 * 产物：<工作区>/release/ToDoList/
 *   ├─ 启动.cmd
 *   ├─ node.exe
 *   ├─ launcher/launch.mjs
 *   └─ app/{dist, dist-server, node_modules, package.json, licenses}
 *
 * 明确**不包含**：data/、.env、.git、tests/、samples/、scripts/、docs/
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const release = path.resolve(root, "..", "release", "ToDoList");

function rm(target) {
  // Windows 上 fs.rmSync 删大目录常被占用（EPERM/ENOTEMPTY），交给系统命令更稳。
  if (process.platform === "win32") {
    try {
      execFileSync("cmd", ["/c", "rmdir", "/s", "/q", target], { stdio: "ignore" });
      return;
    } catch {
      // 目录本来就不存在时 rmdir 会失败，忽略。
    }
  }
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}

function copy(source, destination) {
  fs.cpSync(source, destination, { recursive: true });
}

console.log("清理旧的 release 目录…");
rm(release);

const app = path.join(release, "app");
fs.mkdirSync(app, { recursive: true });

console.log("复制构建产物…");
for (const name of ["dist", "dist-server", "licenses"]) {
  const from = path.join(root, name);
  if (!fs.existsSync(from)) {
    throw new Error(`缺少 ${name}，先跑 npm run build`);
  }
  copy(from, path.join(app, name));
}
copy(path.join(root, "package.json"), path.join(app, "package.json"));
if (fs.existsSync(path.join(root, "package-lock.json"))) {
  copy(path.join(root, "package-lock.json"), path.join(app, "package-lock.json"));
}
if (fs.existsSync(path.join(root, "THIRD_PARTY_NOTICES.md"))) {
  copy(path.join(root, "THIRD_PARTY_NOTICES.md"), path.join(app, "THIRD_PARTY_NOTICES.md"));
}
if (fs.existsSync(path.join(root, "LICENSE"))) {
  copy(path.join(root, "LICENSE"), path.join(app, "LICENSE"));
}

// 直接复制开发用的 node_modules。
// 说明：npm ci 在本机会在清理阶段报 EPERM/ENOTEMPTY（Windows 文件占用），
// 这里先用最稳的方式：复制。体积约 300MB，后续可再做裁剪脚本。
console.log("复制 node_modules（约 300MB，可能几分钟）…");
copy(path.join(root, "node_modules"), path.join(app, "node_modules"));

console.log("复制 Node 运行时…");
const nodeExe = process.execPath;
fs.copyFileSync(nodeExe, path.join(release, "node.exe"));

console.log("写入启动器…");
fs.mkdirSync(path.join(release, "launcher"), { recursive: true });
copy(path.join(root, "packaging", "launcher", "launch.mjs"), path.join(release, "launcher", "launch.mjs"));
fs.writeFileSync(
  path.join(release, "启动.cmd"),
  [
    "@echo off",
    "chcp 65001 >nul",
    "title ToDoList",
    'cd /d "%~dp0"',
    '"%~dp0node.exe" "%~dp0launcher\\launch.mjs"',
    "pause",
    "",
  ].join("\r\n"),
  "utf8",
);

// 打包后自检：绝对不能带上数据与密钥
const forbidden = ["data", ".env", ".git", "tests", "samples", "scripts", "docs"];
const leftovers = forbidden.filter((name) => fs.existsSync(path.join(app, name)) || fs.existsSync(path.join(release, name)));
if (leftovers.length > 0) {
  throw new Error(`打包产物里出现了不该有的内容：${leftovers.join(", ")}`);
}

const size = (() => {
  let total = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else total += fs.statSync(full).size;
    }
  };
  walk(release);
  return (total / 1024 / 1024).toFixed(1);
})();

console.log(`\n完成：${release}`);
console.log(`体积：${size} MB`);
console.log("试跑：双击 release\\ToDoList\\启动.cmd");
