/**
 * 演示库快照 / 还原
 *
 *   npx tsx scripts/demo-db.ts snapshot           # 存一份快照（服务运行中也可，走 sqlite 在线备份）
 *   npx tsx scripts/demo-db.ts list               # 列出已有快照
 *   npx tsx scripts/demo-db.ts restore            # 还原到最新快照（先停服务）
 *   npx tsx scripts/demo-db.ts restore <文件名>    # 还原到指定快照（先停服务）
 *
 * 现场用法：开演前 `npm run demo:snapshot`，演砸了 `npm run demo:restore`，10 秒回到开局。
 */
import fs from "node:fs";
import path from "node:path";

import { backup, DatabaseSync } from "node:sqlite";

import { parseConfig } from "../server/config/env.js";

const config = parseConfig();
const snapshotDir = path.join(path.dirname(config.dbPath), "demo-snapshots");

function timestamp(): string {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+$/, "")
    .replace("T", "-");
}

async function snapshot(): Promise<void> {
  if (!fs.existsSync(config.dbPath)) {
    throw new Error(`数据库不存在：${config.dbPath}`);
  }
  fs.mkdirSync(snapshotDir, { recursive: true });
  const target = path.join(snapshotDir, `demo-${timestamp()}.sqlite`);
  const database = new DatabaseSync(config.dbPath, { readOnly: true });
  try {
    await backup(database, target);
  } finally {
    database.close();
  }
  const size = fs.statSync(target).size;
  console.log(`✓ 快照已保存 ${target} (${(size / 1024).toFixed(1)} KB)`);
}

function listSnapshots(): string[] {
  if (!fs.existsSync(snapshotDir)) return [];
  return fs
    .readdirSync(snapshotDir)
    .filter((name) => name.endsWith(".sqlite"))
    .sort();
}

async function restore(name?: string): Promise<void> {
  const all = listSnapshots();
  if (all.length === 0) {
    throw new Error("还没有任何快照，先运行 snapshot。");
  }
  const target = name === undefined ? all.at(-1)! : path.basename(name);
  const source = path.join(snapshotDir, target);
  if (!fs.existsSync(source)) {
    throw new Error(`快照不存在：${source}`);
  }

  // 附件进程是否还握着库——WAL 模式下边跑边覆盖会写坏，必须让用户先停服务。
  const wal = `${config.dbPath}-wal`;
  if (fs.existsSync(wal) && fs.statSync(wal).size > 0) {
    console.warn(
      "⚠ 检测到非空 WAL 文件，可能仍有服务在跑。请先停掉 npm run dev 再还原。",
    );
  }

  fs.copyFileSync(source, config.dbPath);
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = `${config.dbPath}${suffix}`;
    if (fs.existsSync(sidecar)) fs.rmSync(sidecar);
  }
  console.log(`✓ 已还原 ${source} → ${config.dbPath}`);
  console.log("  提示：如果服务在运行，请重启它让连接重新打开文件。");
}

const [command, argument] = process.argv.slice(2);

switch (command) {
  case "snapshot":
    await snapshot();
    break;
  case "list": {
    const all = listSnapshots();
    if (all.length === 0) {
      console.log("（还没有快照）");
    } else {
      for (const name of all) {
        const full = path.join(snapshotDir, name);
        console.log(
          `${name}  ${(fs.statSync(full).size / 1024).toFixed(1)} KB  ${fs.statSync(full).mtime.toISOString()}`,
        );
      }
    }
    break;
  }
  case "restore":
    await restore(argument);
    break;
  default:
    console.log("用法: tsx scripts/demo-db.ts <snapshot|list|restore [文件名]>");
    process.exitCode = 1;
}
