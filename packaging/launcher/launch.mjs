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

/**
 * 选一个真正可写的数据根目录。
 * 有些机器（或受限账户）不允许往 %LOCALAPPDATA% 写，这时依次退到：
 *   程序目录\ToDoList-data  →  系统临时目录\ToDoList
 */
function canWrite(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, ".write-test");
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function pickDataRoot() {
  const exeDir = path.resolve(appRoot, "..", "..");
  const candidates = [
    path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "ToDoList"),
    // 放在 exe 同级，而不是解压目录里面：更新时解压目录会被整个删掉重建。
    path.join(exeDir, "ToDoList-data"),
    path.join(os.tmpdir(), "ToDoList"),
  ];
  for (const candidate of candidates) {
    if (canWrite(candidate)) return candidate;
  }
  throw new Error(
    "找不到可写的目录。请把程序放到「文档」或「桌面」下再试，或用管理员身份运行。",
  );
}

const dataRoot = pickDataRoot();
const exeDir = path.resolve(appRoot, "..", "..");

// 测试模式：exe 同级放一个 RESET_KEYS.txt，每次启动清空已保存的 Key。
// 删掉这个文件就恢复正常（Key 会保留）。
try {
  if (fs.existsSync(path.join(exeDir, "RESET_KEYS.txt"))) {
    for (const name of ["asr", "llm"]) {
      fs.rmSync(path.join(dataRoot, "data", name), { recursive: true, force: true });
    }
    console.log("测试模式：已清空保存的 Key（删除 RESET_KEYS.txt 可关闭）");
  }
} catch {
  // 清不掉就继续，至少不阻塞启动。
}

// 旧版本把数据放在解压目录里（ToDoList-app\ToDoList-data），更新时会被删。
// 新目录里还没有数据库时，把旧目录的数据并过来（只做一次）。
try {
  const legacyData = path.resolve(appRoot, "..", "ToDoList-data");
  const legacyDb = path.join(legacyData, "data", "app.sqlite");
  const newDb = path.join(dataRoot, "data", "app.sqlite");
  const marker = path.join(dataRoot, ".migrated-from-app");
  const newSize = fs.existsSync(newDb) ? fs.statSync(newDb).size : 0;
  // 只在「新目录还是空库、且没迁移过」时把旧数据并过来，避免覆盖已有数据。
  const shouldMigrate =
    legacyData !== dataRoot &&
    fs.existsSync(legacyDb) &&
    !fs.existsSync(marker) &&
    newSize <= 8 * 1024;
  if (shouldMigrate) {
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.cpSync(legacyData, dataRoot, { recursive: true, force: true });
    // 旧库里记着旧路径的部署锁，换了目录会拒绝启动，迁移时一并清掉。
    const dataDir = path.join(dataRoot, "data");
    if (fs.existsSync(dataDir)) {
      for (const name of fs.readdirSync(dataDir)) {
        if (name.startsWith(".app.sqlite.deployment-lock")) {
          fs.rmSync(path.join(dataDir, name), { recursive: true, force: true });
        }
      }
    }
    fs.writeFileSync(marker, new Date().toISOString(), "utf8");
    console.log("已把旧版本的数据迁移到：" + dataRoot);
  }
} catch (error) {
  console.log("旧数据迁移失败（不影响使用）：" + error.message);
}
const configPath = path.join(dataRoot, "config.json");
const dataDir = path.join(dataRoot, "data");

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return {};
  }
}

function writeConfig(config) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
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

  const localUrl = `http://127.0.0.1:${port}`;
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
