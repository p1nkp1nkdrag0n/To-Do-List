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
  /** 负责人是怎么定下来的：explicit=原文写了名字，pronoun=代词按上下文推断，unknown=没定。 */
  ownerBasis: z.enum(["explicit", "pronoun", "unknown"]).optional(),
  /** 0–1；推断出来的负责人必须给。 */
  ownerConfidence: z.number().min(0).max(1).optional(),
  /** 一句话说明推断依据，给用户核对。 */
  ownerReason: z.string().max(60).optional(),
});

export const ExtractionSchema = z.object({
  tasks: z.array(ExtractedTaskSchema).min(1).max(60),
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
  "2. ownerName 优先用成员名单里的写法：如果原文的名字与某个成员同音或只差一两个字（例如「秋叶恒」和「邱业恒」），把它改写成名单里的写法。",
  "2.0 如果确实找不到对应成员，再照原文写；不要换成名单里毫不相干的人。",
  "2.0.1 原文写了「X 负责……」但 X 不在成员名单时，ownerName 填「未分配」，任务必须保留，ownerReason 写「原文负责人不在成员名单」。",
  "2.1 如果纪要只是记录「改了什么」，没有写明谁来做，ownerName 填「未分配」，**不要因此省略这条任务**。",
  "2.2 代词解析：允许根据上下文推断负责人。我/我们 → 说话人（「发言人N：」「名字：」或自我介绍「我是X」）；如果上一句是别人在安排、这一句是回应承接（如「好，我来做」），说话人就是回应的人。你/你们 → 句子里被称呼的人，或上一句正在被交代的人。他/她/他们 → 上下文里唯一指向的成员（排除说话人）；有多个候选就填「未分配」。",
  "2.2.1 推断时必须在 ownerBasis 里写 pronoun，ownerConfidence 给 0–1，ownerReason 用不超过 40 字写依据（例如「乙回应『我来做』」）；低于 0.5 的推断请直接填「未分配」。原文直接写了名字时 ownerBasis=explicit。",
  "2.3 口语化表达要转成可执行的任务：「弄一下 / 搞定 / 盯一下 / 收个尾」写成具体动作（例如「完成演示稿」「跟进甘特图」）；工时按原话数字，没有就不写；日期没说就填 null，不要猜。",
  "3. estimatedHours 用数字，单位小时；没说工时就按同类任务估一个合理值（4~8）。",
  "4. dueDate 必须是 YYYY-MM-DD；根据今天的日期和纪要里的「这周」「下周三」「周末」等说法换算。纪要没说时间就填 null，不要猜成今天。",
  "5. dependsOnTitle 只有明确说「等谁做完我才能开始」时才填，值必须是另一个任务的 title。",
  "6. 同一件事不要拆成多条重复计工时：如果纪要给的是一件事的总工时（如「仿真这块还要十个钟头」），就只输出一条任务，工时按总数填；只有明确列出多个独立交付物时才拆开，并把总工时分摊，不要每条都填总数。",
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

// A duration unit must end the estimate or be followed by a separator. This
// excludes task nouns such as “24小时制显示” / “24小时监控” and identifiers “H5”.
// Use the same grammar for extraction and title cleanup, so they cannot disagree.
const DURATION_SOURCE = String.raw`(?<![\d.\-−负一二两三四五六七八九十])(\d+(?:\.\d+)?|[一二两三四五六七八九十]+)\s*(?:个)?\s*(?:钟头|小时|h|H)(?=$|[\s,，。；;！!？?、或和/])`;

function durationFrom(text: string): { hours: number; index: number } | null {
  const matches = [...text.matchAll(new RegExp(DURATION_SOURCE, "gu"))];
  // Multiple estimates need clarification instead of silently picking one.
  if (matches.length !== 1) return null;
  const match = matches[0]!;
  const raw = match[1]!;
  const value = /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : chineseNumber(raw);
  if (value === null || !Number.isFinite(value) || value <= 0 || value > 200) return null;
  return { hours: value, index: match.index };
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
    const duration = durationFrom(line);
    if (duration === null) continue;
    const hours = duration.hours;

    // 标题里不能带名字，三种写法都要能认：
    //   甲：订营地，2 小时
    //   甲负责订营地，2 小时
    //   订营地由甲负责，2 小时
    let ownerName = owner;
    let title: string;
    if (owner !== undefined) {
      title = line.split(owner).join(" ");
    } else {
      // 语音把人名听错时，负责人可能不在名单里；任务本身仍要保留为「未分配」。
      const explicit = line.match(/^(.{1,12}?)(负责|来做|完成|跟进|牵头|处理)/);
      if (explicit === null) continue;
      ownerName = "未分配";
      title = line.slice(explicit[0].length);
    }
    title = title
      .replace(/^[\s:：,，\-、]+/, "")
      .replace(/^(负责|来做|做|完成|处理|跟进|牵头)[\s:：,，]*/, "")
      .replace(/由\s*(负责|来做|来完成|完成|做)?/g, " ")
      .replace(/负责/g, " ")
      .trim();
    title = title.split(/[，,。；;]/)[0]!.trim();
    title = title.replace(/(我来接|我来做|我来写|我来调|我来|负责).*$/, "").trim();
    const titleDuration = durationFrom(title);
    if (titleDuration !== null) {
      title = title.slice(0, titleDuration.index).replace(/(?:需要|要)\s*$/u, "").trim();
    }
    if (title.length < 2) continue;
    if (title.length > 30) title = `${title.slice(0, 30)}…`;

    tasks.push({
      title,
      ownerName: ownerName ?? "未分配",
      estimatedHours: hours,
      dueDate: null,
      dependsOnTitle: null,
      sourceQuote: line.slice(0, 120),
    });
  }
  return tasks.slice(0, 30);
}

export async function extractTasksFromText(
  text: string,
  memberNames: string[],
  userId?: string,
): Promise<ExtractionResult> {
  const warnings: string[] = [];
  const config = llmFromEnv(userId);

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
      // 纪要较长时模型可能一次返回很多条：取前 30 条并说明，而不是整份判失败。
      const CAP = 30;
      const capped = parsed.tasks.length > CAP ? parsed.tasks.slice(0, CAP) : parsed.tasks;
      if (parsed.tasks.length > CAP) {
        warnings.push(
          `纪要较长，这次只取了前 ${CAP} 条任务（模型返回 ${parsed.tasks.length} 条）。`,
        );
      }
      // 置信度太低的推断不可靠，降级为未分配；其余推断在 warnings 里列出来让用户核对。
      const resolved = capped.map((task) => {
        if (
          task.ownerName !== "未分配" &&
          task.ownerBasis === "pronoun" &&
          (task.ownerConfidence ?? 0) < 0.5
        ) {
          return { ...task, ownerName: "未分配", ownerBasis: "unknown" as const };
        }
        return task;
      });
      const inferred = resolved.filter(
        (task) => task.ownerBasis === "pronoun" && task.ownerName !== "未分配",
      );
      if (inferred.length > 0) {
        const examples = inferred
          .slice(0, 3)
          .map(
            (task) =>
              `「${task.title}」→ ${task.ownerName}${task.ownerReason !== undefined ? `（${task.ownerReason}）` : ""}`,
          )
          .join("；");
        warnings.push(
          `有 ${inferred.length} 条任务的负责人是根据上下文推断的：${examples}。请在排期前核对。`,
        );
      }
      const unassigned = resolved.filter((task) => task.ownerName === "未分配");
      const unknown = resolved.filter(
        (task) => task.ownerName !== "未分配" && !memberNames.includes(task.ownerName),
      );
      const valid = resolved.filter(
        (task) => task.ownerName === "未分配" || memberNames.includes(task.ownerName),
      );
      if (unknown.length > 0) {
        const names = [...new Set(unknown.map((task) => task.ownerName))].join("、");
        warnings.push(
          `${names} 不在项目成员里，相关 ${unknown.length} 条任务已跳过；需要的话先把他们加进项目再重试。`,
        );
      }
      const pronounUnresolved = valid.filter((task) => task.ownerName === "未分配").length;
      if (pronounUnresolved > 0 && /[我你他她]|咱们|大家/.test(text)) {
        warnings.push(
          `有 ${pronounUnresolved} 条任务用「我 / 你 / 他」指代负责人，但没能确定具体是谁，已标为「未分配」，请手动指派。`,
        );
      }
      if (valid.length > 0) {
        return { tasks: valid, source: "deepseek", warnings };
      }
      warnings.push("大模型抽出的任务负责人都不在成员名单里。");
    } catch (error) {
      // 技术细节只进终端，给用户看的是人话。
      console.error("[extractor] 大模型抽取失败：", error);
      const message = error instanceof Error ? error.message : String(error);
      // 把真实原因带上：之前一律说「没识别出任务」，会让人以为是纪要写得不好。
      const detail = message.length > 140 ? `${message.slice(0, 140)}…` : message;
      warnings.push(
        message.includes("密钥") || message.includes("网络") || message.includes("超时")
          ? `大模型暂时不可用（${detail}），已回退到规则解析。`
          : `大模型抽取失败（${detail}），已回退到规则解析。`,
      );
    }
  } else {
    warnings.push("还没有配置大模型 Key，先用规则解析。");
  }

  return { tasks: extractWithRules(text, memberNames), source: "rules", warnings };
}
