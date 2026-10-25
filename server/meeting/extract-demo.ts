/**
 * 抽取员命令行验证：给一段纪要，看能不能抽出任务。
 *
 *   npx tsx server/meeting/extract-demo.ts                    # 用内置示例
 *   npx tsx server/meeting/extract-demo.ts ../samples/x.txt   # 用文件
 *
 * 这一步不写库，只验证「文字 → 任务 JSON」。
 */
import fs from "node:fs";

import { loadEnvFile } from "../config/dotenv.js";
import { extractTasksFromText } from "./extractor.js";
import { llmFromEnv } from "./llm.js";
import { createMcpRuntime } from "../mcp/runtime.js";

const SAMPLE = `周会纪要
邱业恒：今天主要三件事，接口、甘特图、彩排。
张工：MCP 工具层接口联调我来接，大概十个钟头，这周五之前搞定。我周三下午请假。
李工：甘特图和冲突面板我来调，八个钟头，等张工接口好了我才能开始。
邱业恒：会议录音脚本和话术我来写，四个钟头，这周末前。
邱业恒：最后彩排和录屏我来，四个钟头，下周三之前。`;

// 命令行工具没有登录用户，这里显式允许用 .env 里的 Key（服务端默认不开）。
process.env.LLM_ALLOW_SHARED_FALLBACK ??= "1";
loadEnvFile();

const file = process.argv[2];
const text = file === undefined ? SAMPLE : fs.readFileSync(file, "utf8");

const runtime = createMcpRuntime();
const projectId = runtime.resolveProjectId(undefined);
const members = runtime.availability
  .projectSummary(runtime.auth, projectId)
  .members.map((member) => member.displayName);
runtime.close();

const config = llmFromEnv();
console.log(`模型：${config === null ? "未配置（走规则解析）" : `${config.provider}/${config.model}`}`);
console.log(`成员：${members.join("、")}\n`);

const started = Date.now();
const result = await extractTasksFromText(text, members);
console.log(`抽取方式：${result.source}，耗时 ${Date.now() - started}ms`);
for (const warning of result.warnings) console.log(`  ⚠ ${warning}`);
console.log("");
for (const task of result.tasks) {
  console.log(
    `- ${task.title} | ${task.ownerName} | ${task.estimatedHours}h` +
      (task.dueDate ? ` | 截止 ${task.dueDate}` : "") +
      (task.dependsOnTitle ? ` | 依赖「${task.dependsOnTitle}」` : ""),
  );
}
console.log(`\n共 ${result.tasks.length} 条`);
