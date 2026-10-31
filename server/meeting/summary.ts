/**
 * 会议纪要生成：把转写文本整理成一份可存档的 Markdown。
 *
 * 有模型时用模型总结；没有模型或调用失败时退回结构化模板，
 * 保证「存档」这件事不会因为没配 Key 而失败。
 */
import { z } from "zod";

import { chatJson, llmFromEnv } from "./llm.js";

const SummarySchema = z.object({
  markdown: z.string().min(1),
});

export interface SummaryTask {
  title: string;
  ownerName: string;
  estimatedHours: number;
  dueDate?: string | null;
}

export interface GenerateMinutesOptions {
  userId?: string;
  transcript: string;
  tasks?: SummaryTask[];
  title?: string;
}

export async function generateMinutes(options: GenerateMinutesOptions): Promise<string> {
  const transcript = options.transcript.trim();
  const title = options.title ?? `会议纪要 ${new Date().toISOString().slice(0, 10)}`;
  const config = llmFromEnv(options.userId);

  if (config !== null) {
    try {
      const result = await chatJson({
        config,
        system: [
          "你是会议记录员。输入是一段会议转写（可能带说话人）。",
          "请整理成一份中文 Markdown 会议纪要，结构：",
          "1. 一级标题：会议纪要 + 日期",
          "2. 「讨论要点」：3–6 条要点，忠实于原文，不编造",
          "3. 「任务分工」：表格，列为 任务 / 负责人 / 工时 / 截止日",
          "4. 「待确认」：原文里没定下来的事情",
          "要求：只输出 JSON {\"markdown\": \"...\"}；不要编造原文没有的人名、日期和数字。",
        ].join("\n"),
        user: [
          options.tasks !== undefined && options.tasks.length > 0
            ? `已确认的任务：${JSON.stringify(options.tasks)}`
            : "",
          "",
          "会议转写：",
          transcript.slice(0, 12_000),
        ].join("\n"),
        schema: SummarySchema,
        timeoutMs: 90_000,
      });
      const markdown = (result.value as z.infer<typeof SummarySchema>).markdown.trim();
      if (markdown !== "") return markdown;
    } catch (error) {
      console.error("[meeting] 纪要生成失败，使用模板：", error);
    }
  }

  return templateMinutes(title, transcript, options.tasks ?? []);
}

function templateMinutes(title: string, transcript: string, tasks: SummaryTask[]): string {
  const lines = transcript
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => `- ${line}`);
  const taskRows =
    tasks.length === 0
      ? "| — | — | — | — |"
      : tasks
          .map(
            (task) =>
              `| ${task.title} | ${task.ownerName} | ${task.estimatedHours} 小时 | ${task.dueDate ?? "—"} |`,
          )
          .join("\n");
  return [
    `# ${title}`,
    "",
    "## 讨论要点",
    ...lines,
    "",
    "## 任务分工",
    "| 任务 | 负责人 | 工时 | 截止日 |",
    "| --- | --- | --- | --- |",
    taskRows,
    "",
    "## 待确认",
    "- 无（由转写原文自动整理）",
  ].join("\n");
}
