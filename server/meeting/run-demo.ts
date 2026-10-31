/**
 * 命令行版的会议编排：先在终端里把「系统自己决策」这条链跑通，再谈页面。
 *
 *   npx tsx server/meeting/run-demo.ts            # 用默认项目
 *   npx tsx server/meeting/run-demo.ts <项目ID>
 *
 * 注意：这会**真的改数据库**，跑之前先 `npm run demo:snapshot`。
 */
import { MeetingOrchestrator } from "./orchestrator.js";

const projectId = process.argv[2] ?? process.env.MCP_PROJECT_ID;

if (projectId === undefined || projectId === "") {
  console.error("缺少项目 ID：tsx server/meeting/run-demo.ts <项目ID>");
  process.exit(1);
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
  const result = await orchestrator.run();
  console.log(
    `\n完成：冲突 ${result.conflictsBefore} → ${result.conflictsAfter}，` +
      `应用 ${result.appliedPlanId ?? "无"}，总耗时 ${((performance.now() - started) / 1000).toFixed(1)}s，` +
      `事件 ${result.events.length} 条`,
  );
  process.exitCode = result.conflictsAfter === 0 ? 0 : 1;
} catch (error) {
  console.error("失败：", error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
