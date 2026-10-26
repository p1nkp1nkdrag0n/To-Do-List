/**
 * DeepSeek 客户端（OpenAI 兼容格式）。
 *
 * 只用到一个能力：给一段文字，返回严格 JSON。
 * 不装 SDK，直接 fetch —— 少一个依赖，也方便以后换任何 OpenAI 兼容的服务
 * （硅基流动、通义、智谱都是同一个形状）。
 */
import type { ZodType } from "zod";

import { activeProvider, envApiKey } from "./llm-config.js";

export interface LlmConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  provider: string;
}

export function llmFromEnv(userId?: string): LlmConfig | null {
  // 1) 这个用户自己选中的供应商优先
  const provider = userId !== undefined ? activeProvider(userId) : undefined;
  if (provider !== undefined) {
    return {
      apiKey: provider.apiKey,
      baseUrl: provider.baseUrl,
      model: provider.model,
      provider: provider.name.toLowerCase(),
    };
  }

  // 2) 服务器默认 Key 只作为显式开启的兜底：
  //    发布给别人用时，每个人必须配自己的 Key，不能白烧部署者的额度。
  const allowShared = process.env.LLM_ALLOW_SHARED_FALLBACK === "1";
  const envKey = allowShared ? envApiKey() : undefined;
  if (envKey !== undefined) {
    return {
      apiKey: envKey,
      baseUrl: process.env.LLM_BASE_URL ?? "https://api.deepseek.com",
      model: process.env.LLM_MODEL ?? "deepseek-chat",
      provider: (process.env.LLM_PROVIDER ?? "deepseek").toLowerCase(),
    };
  }

  return null;
}

/** 有些供应商会把 JSON 包在 ```json 里，或者前后带一句解释，这里都剥掉。 */
function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try {
    return JSON.parse(fenced);
  } catch {
    const start = fenced.indexOf("{");
    const end = fenced.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(fenced.slice(start, end + 1));
    throw new Error("模型没有返回合法 JSON");
  }
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
  // 实测：Kimi 的部分模型和 response_format=json_object 一起用会直接挂住（等到超时），
  // 而我们的 extractJson 本来就能从文字里抠 JSON，所以默认不开这个字段。
  let jsonMode = false;
  // 各家的温度限制不一样（Kimi K2.6 只要 1、K3.1 只要 0.6），
  // 先按 0.1 试，被拒就按它要求的数值重试。
  let temperature: number | undefined = 0.1;
  // Kimi 的新模型默认会「思考」，正文会落在 reasoning_content 里且容易截断；
  // 关掉思考既快又直接给结果。不支持的平台会 400，那时再摘掉这个字段。
  let thinking: { type: "disabled" } | undefined = { type: "disabled" };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const startedAt = Date.now();
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
          // 部分供应商（Kimi 的旧模型等）不支持 json_object，会直接 400；
          // 这时退一步，用纯文本指令约束，再自己抽 JSON。
          ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
          ...(temperature !== undefined ? { temperature } : {}),
          ...(thinking !== undefined ? { thinking } : {}),
          // 推理型模型（Kimi K2.6/K3 等）会先写很长的思考过程，
          // 给少了会直接截断，content 变成空字符串。
          max_tokens: 4_000,
        }),
        signal: controller.signal,
      });

      if (process.env.LLM_DEBUG === "1") {
        console.error(`[llm] attempt=${attempt} model=${config.model} temp=${String(temperature)} json=${jsonMode} status=${response.status} ${Date.now() - startedAt}ms`);
      }
      if (!response.ok) {
        const body = await response.text();
        if (response.status === 401 || response.status === 403) {
          throw new Error("大模型密钥无效或已过期，请到设置里检查 API Key。");
        }
        if (response.status === 429) {
          throw new Error("大模型调用太频繁或额度不足，稍等一会儿再试。");
        }
        if (response.status === 404) {
          throw new Error(
            "这个 Key 用不了该模型（404）。常见原因：模型名不对、Key 属于别的平台、或 Kimi 国内/国际站混用（.cn 与 .ai）。",
          );
        }
        if (response.status === 400 || response.status === 422) {
          clearTimeout(timer);
          lastError = new Error(body.slice(0, 200));
          if (body.toLowerCase().includes("thinking")) {
            thinking = undefined;
            continue;
          }
          if (body.toLowerCase().includes("temperature")) {
            const allowed = /only\s+([0-9.]+)\s+is allowed/i.exec(body);
            if (allowed !== null) {
              temperature = Number(allowed[1]);
            } else if (temperature !== 1) {
              temperature = 1;
            } else {
              temperature = undefined;
            }
            continue;
          }
          if (jsonMode) {
            jsonMode = false;
            continue;
          }
        }
        console.error(`[llm] ${config.provider}/${config.model} 返回 ${response.status}: ${body.slice(0, 300)}`);
        throw new Error(
          `大模型服务返回 ${response.status}：${body.slice(0, 160)}`,
        );
      }

      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
      };
      const message = payload.choices?.[0]?.message;
      // 有的模型把正文放 reasoning_content（Kimi 的思考型模型就是这样）。
      lastRaw = message?.content?.trim() !== "" && message?.content !== undefined
        ? message.content
        : (message?.reasoning_content ?? "");
      const parsed = extractJson(lastRaw);
      const checked = schema.safeParse(parsed);
      if (!checked.success) {
        if (process.env.LLM_DEBUG === "1") {
          console.error("[llm] schema mismatch:", JSON.stringify(checked.error.issues).slice(0, 300));
          console.error("[llm] raw:", lastRaw.slice(0, 400));
        }
        lastError = checked.error.issues.map((issue) => issue.path.join(".") + ":" + issue.message);
        continue;
      }
      return { value: checked.data, raw: lastRaw, attempts: attempt + 1 };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        lastError = new Error(`大模型 ${Math.round(timeoutMs / 1000)} 秒没响应，可能是网络问题。`);
      } else {
        lastError = error;
      }
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
