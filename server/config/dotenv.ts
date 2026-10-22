/**
 * 极简 .env 加载器。
 *
 * 为什么不装 dotenv：只为了读几行 KEY=VALUE，多一个依赖不值得，
 * 而且 Node 自带的 --env-file 需要在启动命令里加参数，容易忘。
 *
 * 规则：
 *  - 只认 `KEY=VALUE`，忽略空行和 # 注释
 *  - 已经存在的环境变量不会被覆盖（命令行显式设置优先）
 *  - 值两端允许有引号
 */
import fs from "node:fs";
import path from "node:path";

export function loadEnvFile(filePath = path.resolve(process.cwd(), ".env")): string[] {
  const loaded: string[] = [];
  if (!fs.existsSync(filePath)) return loaded;

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return loaded;
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
      loaded.push(key);
    }
  }
  return loaded;
}
