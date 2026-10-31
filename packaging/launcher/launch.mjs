/**
 * 便携版启动器：选端口 → 准备数据目录 → （首次）请求管理员加防火墙 → 起服务 → 开浏览器。
 *
 * 数据目录：%LOCALAPPDATA%\ToDoList\data      （绝不放程序目录）
 * 配置：    %LOCALAPPDATA%\ToDoList\config.json    （端口、密钥、防火墙是否已放行）
 */
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { pickDataRoot, migrateDataRoot, readLauncherConfig, writeLauncherConfig, findLegacyDataRoots } from "./data-root.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "..", "app");
const serverEntry = path.join(appRoot, "dist-server", "server", "v2.js");
const mcpEntry = path.join(appRoot, "dist-server", "server", "mcp", "main.js");

function pathState(target) {
  try {
    fs.statSync(target);
    return "exists";
  } catch (error) {
    if (error?.code === "ENOENT") return "missing";
    // EACCES/EPERM 等表示“无法判断”，不能当成不存在。
    return "unknown";
  }
}

async function confirmDirectory(question) {
  if (!process.stdin.isTTY) {
    throw new Error(
      "AppData 不可写，且当前不是交互式终端。请设置 TODOLIST_DATA_ROOT 为可写绝对路径后重试。",
    );
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question + " [y/N] ");
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

function writePointer(pointer, value) {
  try {
    fs.writeFileSync(pointer, value, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error?.code === "EEXIST") {
      const saved = fs.readFileSync(pointer, "utf8").trim();
      if (saved === value) return;
      throw new Error("数据目录指针已存在且指向另一个目录，已停止启动：" + saved);
    }
    throw new Error("无法保存数据目录选择，已停止启动：" + (error?.message ?? String(error)));
  }
}

const programRoot = path.resolve(here, "..");
let dataRoot;
if (process.env.TODOLIST_DATA_ROOT) {
  // 显式配置错误（绝对路径、迁移锁、不可写）必须直接停止，不能回退到另一份库。
  dataRoot = pickDataRoot({ programRoot });
} else {
  const exeDir = process.env.TODOLIST_EXE_DIR;
  const pointer = exeDir ? path.join(exeDir, "todolist-data-root.txt") : undefined;
  if (pointer && fs.existsSync(pointer)) {
    // 上次确认过的持久目录；空值/相对路径/不可用都要报错，不能自动换库。
    const saved = fs.readFileSync(pointer, "utf8").trim();
    if (saved === "" || !path.isAbsolute(saved)) {
      throw new Error("数据目录指针为空或不是绝对路径，已停止启动，请修正或删除：" + pointer);
    }
    dataRoot = pickDataRoot({
      programRoot,
      env: { ...process.env, TODOLIST_DATA_ROOT: saved },
    });
  } else {
    try {
      dataRoot = pickDataRoot({ programRoot });
    } catch (error) {
      const code = error?.code ?? "";
      if (!["EPERM", "EACCES", "EROFS"].includes(code)) throw error;
      const defaultRoot = path.join(
        process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
        "ToDoList",
      );
      const state = pathState(defaultRoot);
      if (state !== "missing") {
        throw new Error(
          "默认数据目录存在或无法判断是否为空，已停止启动，避免打开另一份空库：" + defaultRoot,
        );
      }
      if (!exeDir) throw error;
      const fallback = path.join(exeDir, "ToDoList-data");
      const confirmed = await confirmDirectory(
        "AppData 不可写。是否使用 exe 同级数据目录？\n" + fallback,
      );
      if (!confirmed) {
        throw new Error("用户未确认备用数据目录，已停止启动。");
      }
      dataRoot = pickDataRoot({
        programRoot,
        env: { ...process.env, TODOLIST_DATA_ROOT: fallback },
      });
      writePointer(pointer, fallback);
      console.log("已确认使用 exe 同级数据目录：" + dataRoot);
    }
  }
}
// Do not silently open an empty database when a previous unsafe fallback exists.
if (!process.env.TODOLIST_MIGRATE_FROM) {
  const legacyRoots = findLegacyDataRoots({ destination: dataRoot, programRoot });
  if (legacyRoots.length > 0) throw new Error(`发现旧数据：${legacyRoots.join("；")}。请关闭旧程序，选择需要迁移的旧数据根目录设置 TODOLIST_MIGRATE_FROM 及 TODOLIST_MIGRATION_OFFLINE=1 后重启；不会覆盖或删除原数据。`);
}

if (process.env.TODOLIST_MIGRATE_FROM) {
  if (process.env.TODOLIST_MIGRATION_OFFLINE !== "1") {
    throw new Error("迁移前请关闭旧程序，并明确设置 TODOLIST_MIGRATION_OFFLINE=1。旧数据不会被删除。");
  }
  migrateDataRoot(process.env.TODOLIST_MIGRATE_FROM, dataRoot);
}
const configPath = path.join(dataRoot, "config.json");
const dataDir = path.join(dataRoot, "data");
const readConfig = () => readLauncherConfig(configPath);
const writeConfig = (config) => writeLauncherConfig(configPath, config);

function isPortFree(port) {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once("error", () => resolve(false));
    tester.once("listening", () => tester.close(() => resolve(true)));
    tester.listen(port, "0.0.0.0");
  });
}

async function pickPort(preferred) {
  if (await isPortFree(preferred)) return preferred;
  for (let port = 4001; port <= 4010; port += 1) {
    if (await isPortFree(port)) return port;
  }
  throw new Error("4000–4010 都被占用了，请关掉占用端口的程序再试。");
}

function lanAddresses() {
  const result = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) result.push(entry.address);
    }
  }
  return result;
}

/** 首次运行：请求管理员权限添加防火墙放行规则（用户点“是”即可）。 */
function ensureFirewall(port) {
  // 测试/无网环境可以用 TODOLIST_SKIP_FIREWALL=1 跳过提权，避免卡在 UAC。
  if (process.env.TODOLIST_SKIP_FIREWALL === "1") return false;
  const config = readConfig();
  if (config.firewallPort === port) return true;

  console.log(`\n首次运行需要放行局域网访问（端口 ${port}），会弹出一次管理员确认…`);
  const command = [
    `netsh advfirewall firewall delete rule name="ToDoList ${port}" >nul 2>&1`,
    `netsh advfirewall firewall add rule name="ToDoList ${port}" dir=in action=allow protocol=TCP localport=${port} profile=any`,
  ].join(" & ");
  const result = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `Start-Process -FilePath cmd.exe -Verb RunAs -Wait -ArgumentList '/c ${command}'`,
    ],
    { stdio: "inherit" },
  );

  if (result.status === 0) {
    writeConfig({ ...config, firewallPort: port });
    console.log("防火墙规则已添加。");
    return true;
  }
  console.log("没有获得管理员权限：本机可以访问，但同一 WiFi 下的其他人可能连不上。");
  return false;
}

function openBrowser(url) {
  spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
}

async function main() {
  if (!fs.existsSync(serverEntry)) {
    console.error(`找不到程序文件：${serverEntry}\n请确认解压完整，或重新下载。`);
    process.exit(1);
  }

  const config = readConfig();
  const sessionSecret =
    config.sessionSecret ?? crypto.randomBytes(32).toString("hex");
  const bootstrapCode = crypto.randomBytes(16).toString("hex");
  const port = await pickPort(config.port ?? 4000);
  writeConfig({ ...config, sessionSecret, port, dataPath: dataDir });

  fs.mkdirSync(dataDir, { recursive: true });

  console.log(`\n数据目录：${dataDir}`);
  console.log("启动服务中…\n");

  const child = spawn(process.execPath, [serverEntry], {
    cwd: appRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(port),
      HOST: "0.0.0.0",
      DB_PATH: path.join(dataDir, "app.sqlite"),
      UPLOAD_PATH: path.join(dataDir, "uploads"),
      BACKUP_PATH: path.join(dataDir, "backups"),
      SESSION_SECRET: sessionSecret,
      COOKIE_SECURE: "false",
      BOOTSTRAP_CODE: bootstrapCode,
      MCP_ENTRY: mcpEntry,
    },
  });
  child.stdout.on("data", (chunk) => process.stdout.write(String(chunk)));
  child.stderr.on("data", (chunk) => process.stderr.write(String(chunk)));

  const localUrl = `http://127.0.0.1:${port}`;
  // 首次运行要解压一万多个文件，30 秒不够；给足 2 分钟。
  const deadline = Date.now() + 120_000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${localUrl}/healthz`);
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      // 还没起来，继续等。
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  if (!ready) {
    console.error("\n服务 120 秒内没有就绪，请把上面的报错发给我。");
    child.kill();
    process.exit(1);
  }

  // 服务已经起来了，再处理防火墙；失败也不影响本机使用。
  try {
    ensureFirewall(port);
  } catch (error) {
    console.log(`防火墙设置失败（不影响本机使用）：${error instanceof Error ? error.message : error}`);
  }

  const addresses = lanAddresses();
  console.log("\n============================================");
  console.log("  ToDoList 已启动");
  console.log(`  本机访问：${localUrl}`);
  if (addresses.length > 0) {
    console.log("  同一 WiFi 下其他人访问：");
    for (const address of addresses) console.log(`    http://${address}:${port}`);
  } else {
    console.log("  没有检测到局域网地址（可能没连 WiFi）。");
  }
  console.log("  首次使用：在自己浏览器里完成初始化（创建管理员）");
  console.log(`  初始化码（仅首启使用，请勿分享）：${bootstrapCode}`);
  console.log("  关闭本窗口 = 停止服务");
  console.log("============================================\n");

  openBrowser(localUrl);

  const shutdown = () => {
    child.kill();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  child.on("exit", () => process.exit(0));
}

main().catch((error) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error("\n启动失败：", error instanceof Error ? error.message : error);
  try {
    fs.mkdirSync(path.join(process.env.LOCALAPPDATA ?? os.homedir(), "ToDoList"), { recursive: true });
    fs.appendFileSync(
      path.join(process.env.LOCALAPPDATA ?? os.homedir(), "ToDoList", "launcher.log"),
      `\n[${new Date().toISOString()}] 启动失败\n${message}\n`,
      "utf8",
    );
    console.error("日志已写入：%LOCALAPPDATA%\\ToDoList\\launcher.log");
  } catch {
    // 写不了日志就算了。
  }
  process.exit(1);
});
