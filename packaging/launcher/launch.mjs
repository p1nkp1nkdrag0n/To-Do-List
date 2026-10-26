/**
 * 便携版启动器：选端口 → 准备数据目录 → （首次）请求管理员加防火墙 → 起服务 → 开浏览器。
 *
 * 数据目录：%LOCALAPPDATA%\ToDoList\data      （绝不放程序目录）
 * 配置：    %APPDATA%\ToDoList\config.json    （端口、密钥、防火墙是否已放行）
 */
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "..", "app");
const serverEntry = path.join(appRoot, "dist-server", "server", "v2.js");
const mcpEntry = path.join(appRoot, "dist-server", "server", "mcp", "main.js");

const configDir = path.join(process.env.APPDATA ?? os.homedir(), "ToDoList");
const configPath = path.join(configDir, "config.json");
const dataDir = path.join(process.env.LOCALAPPDATA ?? os.homedir(), "ToDoList", "data");

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return {};
  }
}

function writeConfig(config) {
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
}

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
  const port = await pickPort(config.port ?? 4000);
  writeConfig({ ...config, sessionSecret, port, dataPath: dataDir });

  fs.mkdirSync(dataDir, { recursive: true });
  ensureFirewall(port);

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
      SESSION_SECRET: sessionSecret,
      COOKIE_SECURE: "false",
      BOOTSTRAP_CODE: crypto.randomBytes(16).toString("hex"),
      MCP_ENTRY: mcpEntry,
    },
  });
  child.stdout.on("data", (chunk) => process.stdout.write(String(chunk)));
  child.stderr.on("data", (chunk) => process.stderr.write(String(chunk)));

  const localUrl = `http://localhost:${port}`;
  const deadline = Date.now() + 30_000;
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
    console.error("\n服务 30 秒内没有就绪，请把上面的报错发给我。");
    child.kill();
    process.exit(1);
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
  console.error("启动失败：", error instanceof Error ? error.message : error);
  process.exit(1);
});
