/**
 * 转写纠错：语音识别会把人名听成同音字（「邱业恒」→「秋叶恒」），
 * 这里用已经配置的大模型，只在「明显同音/近似」时把词改回热词写法，不顺稿、不改写。
 *
 * 没有配置大模型时直接返回原文，转写照常可用。
 */
import { z } from "zod";

import { chatJson, llmFromEnv } from "./llm.js";

const CorrectionSchema = z.object({
  text: z.string(),
});

export interface CorrectOptions {
  userId?: string;
  text: string;
  hotwords?: string[];
}

export async function correctTranscript(options: CorrectOptions): Promise<string> {
  const config = llmFromEnv(options.userId);
  if (config === null) return options.text;
  if (options.text.trim() === "") return options.text;

  const hotwords = [...new Set((options.hotwords ?? []).map((word) => word.trim()).filter(Boolean))];
  if (hotwords.length === 0) return options.text;

  try {
    const result = await chatJson({
      config,
      system: [
        "你是语音转写校对员。输入是一段会议转写文本，以及一组专有名词（人名、项目名等）。",
        "任务：只修正「与专有名词同音或读音相近」的识别错误，把写错的词改成专有名词里的写法。",
        "规则：",
        "1. 不得改写句子结构、不得润色、不得增删内容、不得调整顺序。",
        "2. 只替换读音相同或非常接近的词（例如「秋叶恒」→「邱业恒」）。",
        "3. 拿不准时保持原文不动。",
        "4. 只输出 JSON：{\"text\":\"校对后的完整文本\"}。",
      ].join("\n"),
      user: [`专有名词：${hotwords.join("、")}`, "", "转写文本：", options.text].join("\n"),
      schema: CorrectionSchema,
      timeoutMs: 60_000,
    });
    const next = (result.value as z.infer<typeof CorrectionSchema>).text.trim();
    // 长度差异太大说明模型在改写而不是纠错，这时宁可不采用。
    if (next === "" || Math.abs(next.length - options.text.length) > options.text.length * 0.05) {
      return options.text;
    }
    return next;
  } catch (error) {
    console.error("[asr] 转写纠错失败，保留原文：", error);
    return options.text;
  }
}
