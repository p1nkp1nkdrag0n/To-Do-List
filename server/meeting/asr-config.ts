/**
 * 思必驰「录音文件长语音转写」的账号配置（每个用户一份）。
 *
 * 存 data/v2/asr/<userId>.json：
 *   { version: 1, productId: "278578090", apiKey: "..." }
 *
 * productId 在 DUI 控制台创建「基础技术产品」后生成；apiKey 来自
 * 「授权管理 → 服务授权 → 配置 IP 白名单」，所以调用方的公网 IP 必须在白名单里。
 */
import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

const CONFIG_DIR = path.join(process.cwd(), "data", "v2", "asr");

function configPath(userId: string): string {
  return path.join(CONFIG_DIR, `${userId}.json`);
}

export const AsrConfigSchema = z
  .object({
    version: z.literal(1),
    productId: z.string().min(1).max(64),
    apiKey: z.string().min(1).max(200),
  })
  .strict();

export type AsrConfig = z.infer<typeof AsrConfigSchema>;

export interface AsrConfigView {
  productId: string;
  keyHint: string;
  hasKey: boolean;
}

export function readAsrConfig(userId: string): AsrConfig | null {
  try {
    const raw = fs.readFileSync(configPath(userId), "utf8");
    const parsed = AsrConfigSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function writeAsrConfig(userId: string, config: AsrConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(configPath(userId), JSON.stringify(config, null, 2), "utf8");
}

export function asrConfigView(config: AsrConfig | null): AsrConfigView {
  if (config === null) return { productId: "", keyHint: "", hasKey: false };
  return {
    productId: config.productId,
    keyHint: config.apiKey.length > 4 ? `****${config.apiKey.slice(-4)}` : "****",
    hasKey: true,
  };
}
