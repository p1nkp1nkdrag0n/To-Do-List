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

import { dataRoot, migrateFile, readWithLegacy } from "../config/config-root.js";

function configDir(): string {
  return path.join(dataRoot(), "asr");
}

function configPath(userId: string): string {
  return path.join(configDir(), `${userId}.json`);
}

/** 旧位置：程序目录下的 data/v2/asr（更新 exe 会丢）。 */
function legacyPath(userId: string): string {
  return path.join(process.cwd(), "data", "v2", "asr", `${userId}.json`);
}

export const AsrConfigSchema = z
  .object({
    version: z.literal(1),
    productId: z.string().min(1).max(64),
    apiKey: z.string().min(1).max(200),
    // 实时长语音转写是另一个产品（另一把 Key）；没填就退回上面的文件转写配置。
    realtimeProductId: z.string().min(1).max(64).optional(),
    realtimeApiKey: z.string().min(1).max(200).optional(),
  })
  .strict();

export type AsrConfig = z.infer<typeof AsrConfigSchema>;

export interface AsrConfigView {
  productId: string;
  keyHint: string;
  hasKey: boolean;
  realtimeProductId: string;
  realtimeKeyHint: string;
  hasRealtimeKey: boolean;
}

export function readAsrConfig(userId: string): AsrConfig | null {
  const raw = readWithLegacy(configPath(userId), legacyPath(userId));
  if (raw === null) return null;
  try {
    const parsed = AsrConfigSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function writeAsrConfig(userId: string, config: AsrConfig): void {
  fs.mkdirSync(configDir(), { recursive: true });
  migrateFile(legacyPath(userId), configPath(userId));
  fs.writeFileSync(configPath(userId), JSON.stringify(config, null, 2), "utf8");
}

export function asrConfigView(config: AsrConfig | null): AsrConfigView {
  if (config === null) {
    return {
      productId: "",
      keyHint: "",
      hasKey: false,
      realtimeProductId: "",
      realtimeKeyHint: "",
      hasRealtimeKey: false,
    };
  }
  const realtimeKey = config.realtimeApiKey;
  return {
    productId: config.productId,
    keyHint: config.apiKey.length > 4 ? `****${config.apiKey.slice(-4)}` : "****",
    hasKey: true,
    realtimeProductId: config.realtimeProductId ?? "",
    realtimeKeyHint:
      realtimeKey === undefined ? "" : realtimeKey.length > 4 ? `****${realtimeKey.slice(-4)}` : "****",
    hasRealtimeKey: realtimeKey !== undefined,
  };
}
