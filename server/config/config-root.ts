/**
 * 用户级配置（大模型 Key、思必驰 Key）应该跟数据库放在一起，而不是程序目录：
 *  - 更新 exe 会整个替换程序目录，放在那里会把 Key 弄丢
 *  - 把程序目录发给别人也会把 Key 一起带走
 *
 * 数据根目录取 DB_PATH 的所在目录；没有设置时退回 <cwd>/data/v2（开发态）。
 * 老位置（<cwd>/data/v2/...）的文件会在第一次读取时自动迁移过来。
 */
import fs from "node:fs";
import path from "node:path";

export function dataRoot(): string {
  const dbPath = process.env.DB_PATH;
  if (dbPath !== undefined && dbPath !== "") {
    return path.dirname(path.resolve(dbPath));
  }
  return path.join(process.cwd(), "data", "v2");
}

/** 迁移旧文件（存在才动），返回新路径。 */
export function migrateFile(legacyPath: string, nextPath: string): void {
  try {
    if (fs.existsSync(nextPath) || !fs.existsSync(legacyPath)) return;
    fs.mkdirSync(path.dirname(nextPath), { recursive: true });
    fs.renameSync(legacyPath, nextPath);
  } catch {
    // 迁移失败不影响读取：调用方会在新路径读不到时再回退。
  }
}

/** 读取时优先新位置，没有再读旧位置（并尝试迁移）。 */
export function readWithLegacy(nextPath: string, legacyPath: string): string | null {
  try {
    if (fs.existsSync(nextPath)) return fs.readFileSync(nextPath, "utf8");
    if (!fs.existsSync(legacyPath)) return null;
    const content = fs.readFileSync(legacyPath, "utf8");
    migrateFile(legacyPath, nextPath);
    return content;
  } catch {
    return null;
  }
}
