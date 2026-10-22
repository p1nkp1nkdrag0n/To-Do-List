/**
 * 「粘贴纪要 → 自动排期」的命令行验证。
 *
 *   npx tsx server/meeting/run-minutes-demo.ts               # 内置示例纪要
 *   npx tsx server/meeting/run-minutes-demo.ts ../samples/x.txt
 *   npx tsx server/meeting/run-minutes-demo.ts --keep        # 不清空现有任务
 *
 * 会真的改数据库：先清空项目排期，再把纪要里的任务建进去。
 */
import fs from "node:fs";

import { loadEnvFile } from "../config/dotenv.js";
import { createMcpRuntime } from "../mcp/runtime.js";
import { clearProjectSchedule } from "./demo-reset.js";
import { MeetingOrchestrator } from "./orchestrator.js";

const SAMPLE = `周会纪要（2026-10-22）
邱业恒：今天主要三件事，接口、甘特图、彩排。
张工：MCP 工具层接口联调我来接，大概十个钟头，这周五之前搞定。我周三下午请假。
李工：甘特图和冲突面板我来调，八个钟头，等张工接口好了我才能开始。
邱业恒：会议录音脚本和话术我来写，四个钟头，这周末前。
邱业恒：最后彩排和录屏我来，四个钟头，下周三之前。`;

loadEnvFile();

const args = process.argv.slice(2);
const keepExisting = args.includes("--keep");
const file = args.find((argument) => !argument.startsWith("--"));
const minutes = file === undefined ? SAMPLE : fs.readFileSync(file, "utf8");

const runtime = createMcpRuntime();
const projectId = runtime.resolveProjectId(undefined);

if (!keepExisting) {
  const cleared = clearProjectSchedule(runtime.dependencies, projectId);
  console.log(`已清空项目排期：移除 ${cleared.removedTasks} 个任务\n`);
}

const started = performance.now();
const orchestrator = new MeetingOrchestrator({
  projectId,
  onEvent(event) {
    const stamp = event.at.slice(11, 19);
    const tag = event.type.padEnd(18);
    if (event.type === "tool.call") {
      console.log(`[${stamp}] ${tag} ${event.tool} (${event.durationMs}ms) → ${event.resultSummary}`);
    } else {
      console.log(`[${stamp}] ${tag} ${event.message}`);
    }
  },
});

try {
  const result = await orchestrator.runFromMinutes(minutes);
  console.log(
    `\n结果：冲突 ${result.conflictsBefore} → ${result.conflictsAfter}，` +
      `应用 ${result.appliedPlanId ?? "无"}，耗时 ${((performance.now() - started) / 1000).toFixed(1)}s`,
  );

  console.log("\n数据库最终状态：");
  for (const task of runtime.schedule.listTasks(runtime.auth, projectId)) {
    const participants = runtime.schedule
      .listParticipants(runtime.auth, projectId)
      .filter((participant) => participant.taskId === task.id)
      .map(
        (participant) =>
          `${participant.displayName} ${(participant.estimatedMinutes / 60).toFixed(0)}h`,
      )
      .join(" + ");
    console.log(
      `  ${task.title} | ${task.startDate} → ${task.dueDate} | ${participants || "（无人）"}`,
    );
  }
  const conflicts = runtime.availability.projectConflicts(projectId);
  console.log(`\n冲突：${conflicts.length} 条`);
  for (const conflict of conflicts) console.log("  ", conflict.type);
  process.exitCode = conflicts.length === 0 ? 0 : 1;
} catch (error) {
  console.error("\n失败：", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  runtime.close();
}
