/**
 * 抽取员：把「会议纪要 / 转写文字」变成结构化任务。
 *
 * 两条实现：
 *   1. 大模型（DeepSeek）—— 主要路线，能读任意写法
 *   2. 规则解析 —— 没有 key 时的兜底，只认「谁 + 做什么 + 几小时 + 什么时候前」
 *
 * 返回前统一用 zod 校验：模型抽错格式会被拒，不会把垃圾写进数据库。
 */
import { z } from "zod";

import { chatJson, llmFromEnv } from "./llm.js";

export const ExtractedTaskSchema = z.object({
  title: z.string().min(1).max(60),
  ownerName: z.string().min(1),
  estimatedHours: z.number().positive().max(200),
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullish(),
  dependsOnTitle: z.string().max(60).nullish(),
  sourceQuote: z.string().max(200).nullish(),
});

export const ExtractionSchema = z.object({
  tasks: z.array(ExtractedTaskSchema).min(1).max(12),
});

export type ExtractedTask = z.infer<typeof ExtractedTaskSchema>;

export interface ExtractionResult {
  tasks: ExtractedTask[];
  source: "deepseek" | "rules";
  warnings: string[];
}

const SYSTEM_PROMPT = [
  "你是项目管理助手。输入是一段中文会议纪要或会议转写。",
  "请抽出所有需要人去做的工作项，输出严格 JSON。",
  "要求：",
  "1. 每个任务一句话，不超过 20 个汉字，动词开头，例如「完成接口联调」。",
  "2. ownerName 必须是给定成员名单里的名字原样，不能编造。",
  "3. estimatedHours 用数字，单位小时；没说工时就按同类任务估一个合理值（4~8）。",
  "4. dueDate 必须是 YYYY-MM-DD；根据今天的日期和纪要里的「这周」「下周三」「周末」等说法换算。",
  "5. dependsOnTitle 只有明确说「等谁做完我才能开始」时才填，值必须是另一个任务的 title。",
  "6. 不要输出解释，只输出 JSON：{\"tasks\":[...]}。",
].join("\n");

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

const CHINESE_DIGITS: Record<string, number> = {
  一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

/** 「十」「十二」「二十」「两」都能认；认不出返回 null。 */
function chineseNumber(value: string): number | null {
  if (/^\d+$/.test(value)) return Number(value);
  if (value === "十") return 10;
  const tenIndex = value.indexOf("十");
  if (tenIndex >= 0) {
    const high = tenIndex === 0 ? 1 : CHINESE_DIGITS[value.slice(0, tenIndex)];
    const lowPart = value.slice(tenIndex + 1);
    const low = lowPart === "" ? 0 : CHINESE_DIGITS[lowPart];
    if (high === undefined || low === undefined) return null;
    return high * 10 + low;
  }
  return CHINESE_DIGITS[value] ?? null;
}

function hoursFrom(text: string): number | null {
  const match = text.match(/(\d+(?:\.\d+)?|[一二两三四五六七八九十]+)\s*(?:个)?\s*(?:钟头|小时|h|H)/);
  if (match === null) return null;
  const value = chineseNumber(match[1]!);
  if (value === null || !Number.isFinite(value) || value <= 0 || value > 200) return null;
  return value;
}

/** 规则兜底：认「某人 + 做某事 + N 小时」。宁可少抽，也不乱抽。 */
export function extractWithRules(text: string, memberNames: string[]): ExtractedTask[] {
  const tasks: ExtractedTask[] = [];
  const lines = text
    .split(/[\n。；;]+/)
    .map((line) => line.trim())
    .filter((line) => line !== "");

  for (const line of lines) {
    // 优先认「说话人前缀」：『李工：……』比句子里随便提到的名字可靠得多。
    const speaker = memberNames.find(
      (name) => line.startsWith(`${name}：`) || line.startsWith(`${name}:`) || line.startsWith(name),
    );
    const owner = speaker ?? memberNames.find((name) => line.includes(name));
    if (owner === undefined) continue;
    const hours = hoursFrom(line);
    if (hours === null) continue;

    // 去掉「张工：」前缀，再砍掉「我来接 / 负责…」这类谓语尾巴
    let title = line.replace(/^[^：:]{1,6}[:：]\s*/, "").trim();
    title = title.split(/[，,。；;]/)[0]!.trim();
    title = title.replace(/(我来接|我来做|我来写|我来调|我来|负责).*$/, "").trim();
    if (title.length < 2) continue;
    if (title.length > 30) title = `${title.slice(0, 30)}…`;

    tasks.push({
      title,
      ownerName: owner,
      estimatedHours: hours,
      dueDate: null,
      dependsOnTitle: null,
      sourceQuote: line.slice(0, 120),
    });
  }
  return tasks.slice(0, 12);
}

export async function extractTasksFromText(
  text: string,
  memberNames: string[],
): Promise<ExtractionResult> {
  const warnings: string[] = [];
  const config = llmFromEnv();

  if (config !== null) {
    try {
      const result = await chatJson({
        config,
        system: SYSTEM_PROMPT,
        user: [
          `今天的日期：${today()}`,
          `项目成员名单：${memberNames.join("、")}`,
          "",
          "会议纪要：",
          text,
        ].join("\n"),
        schema: ExtractionSchema,
      });
      const parsed = result.value as z.infer<typeof ExtractionSchema>;
      const unknownOwners = parsed.tasks.filter((task) => !memberNames.includes(task.ownerName));
      if (unknownOwners.length > 0) {
        warnings.push(
          `模型给了不在名单里的负责人：${unknownOwners.map((task) => task.ownerName).join("、")}`,
        );
      }
      const valid = parsed.tasks.filter((task) => memberNames.includes(task.ownerName));
      if (valid.length > 0) {
        return { tasks: valid, source: "deepseek", warnings };
      }
      warnings.push("模型抽出的任务负责人全部不在成员名单里，改用规则解析。");
    } catch (error) {
      warnings.push(
        `大模型抽取失败，已回退到规则解析：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } else {
    warnings.push("没有配置 DEEPSEEK_API_KEY，使用规则解析。");
  }

  return { tasks: extractWithRules(text, memberNames), source: "rules", warnings };
}
