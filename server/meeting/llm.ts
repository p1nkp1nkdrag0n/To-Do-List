/**
 * DeepSeek 客户端（OpenAI 兼容格式）。
 *
 * 只用到一个能力：给一段文字，返回严格 JSON。
 * 不装 SDK，直接 fetch —— 少一个依赖，也方便以后换任何 OpenAI 兼容的服务
 * （硅基流动、通义、智谱都是同一个形状）。
 */
import type { ZodType } from "zod";

export interface LlmConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  provider: string;
}

export function llmFromEnv(): LlmConfig | null {
  const apiKey = process.env.DEEPSEEK_API_KEY ?? process.env.LLM_API_KEY;
  if (apiKey === undefined || apiKey.trim() === "") return null;
  const provider = (process.env.LLM_PROVIDER ?? "deepseek").toLowerCase();
  return {
    apiKey: apiKey.trim(),
    baseUrl: process.env.LLM_BASE_URL ?? "https://api.deepseek.com",
    model: process.env.LLM_MODEL ?? "deepseek-chat",
    provider,
  };
}

export interface ChatJsonOptions {
  config: LlmConfig;
  system: string;
  user: string;
  /** 用 zod 校验模型输出；校验不过会带着错误重试一次。 */
  schema: ZodType<unknown>;
  timeoutMs?: number;
}

export interface ChatJsonResult {
  value: unknown;
  raw: string;
  attempts: number;
}

export async function chatJson(options: ChatJsonOptions): Promise<ChatJsonResult> {
  const { config, system, user, schema } = options;
  const timeoutMs = options.timeoutMs ?? 30_000;
  let lastError: unknown;
  let lastRaw = "";

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages: [
            { role: "system", content: system },
            {
              role: "user",
              content:
                attempt === 0
                  ? user
                  : `${user}\n\n上次的输出不符合要求，错误：${String(lastError)}。请只返回合法 JSON。`,
            },
          ],
          response_format: { type: "json_object" },
          temperature: 0.1,
          max_tokens: 2_000,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`LLM HTTP ${response.status}: ${body.slice(0, 300)}`);
      }

      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      lastRaw = payload.choices?.[0]?.message?.content ?? "";
      const parsed = JSON.parse(lastRaw) as unknown;
      const checked = schema.safeParse(parsed);
      if (!checked.success) {
        lastError = checked.error.issues.map((issue) => issue.path.join(".") + ":" + issue.message);
        continue;
      }
      return { value: checked.data, raw: lastRaw, attempts: attempt + 1 };
    } catch (error) {
      lastError = error;
      if (attempt === 1) break;
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(
    `LLM 调用失败：${lastError instanceof Error ? lastError.message : String(lastError)}` +
      (lastRaw === "" ? "" : `（最后一次原始输出：${lastRaw.slice(0, 200)}）`),
  );
}
