/**
 * 大模型供应商配置（多供应商，像 cc-switch 那样一键切换）。
 *
 * 存 `data/v2/llm-config.json`（已被 .gitignore 排除），结构 v2：
 *   { version: 2, activeId: "p_xxx", providers: [{ id, name, baseUrl, model, apiKey }] }
 *
 * 优先级：**文件里的当前供应商** > 环境变量 > 无。
 * 这样在页面里“切一个供应商”就立刻生效，跟 cc-switch 的直觉一致；
 * 部署时若只想用环境变量，文件里没有 active 就会回落到环境变量。
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

const CONFIG_PATH = path.join(process.cwd(), "data", "v2", "llm-config.json");

export const ProviderSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).max(40),
    baseUrl: z.string().url(),
    model: z.string().min(1).max(80),
    apiKey: z.string().max(200).default(""),
  })
  .strict();

export const LlmConfigFileSchema = z
  .object({
    version: z.literal(2),
    activeId: z.string().nullable(),
    providers: z.array(ProviderSchema),
  })
  .strict();

export type ProviderRecord = z.infer<typeof ProviderSchema>;
export type LlmConfigFile = z.infer<typeof LlmConfigFileSchema>;

/** 旧版单供应商格式，读到时自动迁移。 */
const LegacySchema = z
  .object({
    provider: z.string(),
    baseUrl: z.string().url(),
    model: z.string(),
    apiKey: z.string(),
  })
  .passthrough();

export interface ProviderView {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  keyHint: string;
  hasKey: boolean;
  active: boolean;
  /** 当前生效来源：本机配置 or 环境变量。 */
  source: "file" | "env";
}

export interface LlmConfigView {
  activeId: string | null;
  providers: ProviderView[];
  /** 环境变量里也配了一把 key（页面只提示，不直接切换）。 */
  envAvailable: boolean;
}

function emptyConfig(): LlmConfigFile {
  return { version: 2, activeId: null, providers: [] };
}

export function readConfig(): LlmConfigFile {
  let raw: string;
  try {
    raw = fs.readFileSync(CONFIG_PATH, "utf8");
  } catch {
    return emptyConfig();
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    const v2 = LlmConfigFileSchema.safeParse(parsed);
    if (v2.success) return v2.data;

    const legacy = LegacySchema.safeParse(parsed);
    if (legacy.success && legacy.data.apiKey !== "") {
      const migrated: LlmConfigFile = {
        version: 2,
        activeId: "p_migrated",
        providers: [
          {
            id: "p_migrated",
            name: legacy.data.provider,
            baseUrl: legacy.data.baseUrl,
            model: legacy.data.model,
            apiKey: legacy.data.apiKey,
          },
        ],
      };
      writeConfig(migrated);
      return migrated;
    }
  } catch {
    // 文件坏了就当没有，别让页面打不开。
  }
  return emptyConfig();
}

export function writeConfig(config: LlmConfigFile): void {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function activeProvider(config = readConfig()): ProviderRecord | undefined {
  if (config.activeId === null) return undefined;
  return config.providers.find((item) => item.id === config.activeId);
}

function assertKeyLooksValid(apiKey: string): void {
  if (apiKey.includes("://")) {
    throw new Error("这看起来是接口地址，不是 API Key。Key 一般以 sk- 开头。");
  }
}

export function createProvider(input: {
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}): ProviderRecord {
  assertKeyLooksValid(input.apiKey);
  const config = readConfig();
  const provider: ProviderRecord = {
    id: `p_${randomUUID().slice(0, 8)}`,
    name: input.name,
    baseUrl: input.baseUrl.replace(/\/$/, ""),
    model: input.model,
    apiKey: input.apiKey.trim(),
  };
  config.providers.push(provider);
  if (config.activeId === null) config.activeId = provider.id;
  writeConfig(config);
  return provider;
}

export function updateProvider(
  id: string,
  input: { name?: string; baseUrl?: string; model?: string; apiKey?: string },
): ProviderRecord | undefined {
  const config = readConfig();
  const index = config.providers.findIndex((item) => item.id === id);
  if (index < 0) return undefined;
  if (input.apiKey !== undefined && input.apiKey.trim() !== "") {
    assertKeyLooksValid(input.apiKey.trim());
  }
  const current = config.providers[index]!;
  const next: ProviderRecord = {
    ...current,
    name: input.name?.trim() || current.name,
    baseUrl: input.baseUrl !== undefined ? input.baseUrl.replace(/\/$/, "") : current.baseUrl,
    model: input.model?.trim() || current.model,
    // 空字符串表示“不修改已保存的 key”
    apiKey:
      input.apiKey !== undefined && input.apiKey.trim() !== ""
        ? input.apiKey.trim()
        : current.apiKey,
  };
  config.providers[index] = next;
  writeConfig(config);
  return next;
}

export function deleteProvider(id: string): boolean {
  const config = readConfig();
  const before = config.providers.length;
  config.providers = config.providers.filter((item) => item.id !== id);
  if (config.providers.length === before) return false;
  if (config.activeId === id) {
    config.activeId = config.providers[0]?.id ?? null;
  }
  writeConfig(config);
  return true;
}

export function activateProvider(id: string): boolean {
  const config = readConfig();
  if (!config.providers.some((item) => item.id === id)) return false;
  config.activeId = id;
  writeConfig(config);
  return true;
}

export function envApiKey(): string | undefined {
  const key = process.env.DEEPSEEK_API_KEY ?? process.env.LLM_API_KEY;
  return key !== undefined && key.trim() !== "" ? key.trim() : undefined;
}

export function mask(key: string): string {
  if (key === "") return "";
  return key.length <= 4 ? "****" : `****${key.slice(-4)}`;
}

export function configView(): LlmConfigView {
  const config = readConfig();
  const envKey = envApiKey();
  const providers: ProviderView[] = config.providers.map((item) => ({
    id: item.id,
    name: item.name,
    baseUrl: item.baseUrl,
    model: item.model,
    keyHint: mask(item.apiKey),
    hasKey: item.apiKey !== "",
    active: item.id === config.activeId,
    source: "file",
  }));

  return {
    activeId: config.activeId,
    providers,
    envAvailable: envKey !== undefined,
  };
}
