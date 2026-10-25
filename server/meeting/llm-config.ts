/**
 * 大模型配置：环境变量优先，其次是本地文件。
 *
 * 文件放 `data/v2/llm-config.json`（已被 .gitignore 排除），
 * 这样换台机器在页面里填一次就行，不用改代码；仓库里永远不带 key。
 */
import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

const CONFIG_PATH = path.join(process.cwd(), "data", "v2", "llm-config.json");

export const LlmConfigFileSchema = z
  .object({
    provider: z.string().min(1).max(40).default("deepseek"),
    baseUrl: z.string().url().default("https://api.deepseek.com"),
    model: z.string().min(1).max(80).default("deepseek-chat"),
    apiKey: z.string().min(1).max(200),
  })
  .strict();

export type LlmConfigFile = z.infer<typeof LlmConfigFileSchema>;

export interface LlmConfigView {
  provider: string;
  baseUrl: string;
  model: string;
  hasKey: boolean;
  /** 只回显末四位，页面上能确认“填的是哪把钥匙”。 */
  keyHint: string;
  source: "env" | "file" | "none";
}

export function readLlmConfigFile(): LlmConfigFile | undefined {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    const parsed = LlmConfigFileSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function writeLlmConfigFile(config: LlmConfigFile): void {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function clearLlmConfigFile(): void {
  if (fs.existsSync(CONFIG_PATH)) fs.rmSync(CONFIG_PATH);
}

export function llmConfigView(): LlmConfigView {
  const envKey = process.env.DEEPSEEK_API_KEY ?? process.env.LLM_API_KEY;
  if (envKey !== undefined && envKey.trim() !== "") {
    return {
      provider: process.env.LLM_PROVIDER ?? "deepseek",
      baseUrl: process.env.LLM_BASE_URL ?? "https://api.deepseek.com",
      model: process.env.LLM_MODEL ?? "deepseek-chat",
      hasKey: true,
      keyHint: mask(envKey.trim()),
      source: "env",
    };
  }
  const file = readLlmConfigFile();
  if (file !== undefined) {
    return {
      provider: file.provider,
      baseUrl: file.baseUrl,
      model: file.model,
      hasKey: true,
      keyHint: mask(file.apiKey),
      source: "file",
    };
  }
  return {
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-chat",
    hasKey: false,
    keyHint: "",
    source: "none",
  };
}

function mask(key: string): string {
  return key.length <= 4 ? "****" : `****${key.slice(-4)}`;
}
