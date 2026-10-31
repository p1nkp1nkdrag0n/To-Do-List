/**
 * 手动跑一次重排，看看算法在真实演示数据上给出什么方案。
 *
 *   npx tsx server/mcp/plan-demo.ts
 */
import { createMcpRuntime } from "./runtime.js";
import { loadSchedule } from "./snapshot.js";
import { planReschedules } from "./reschedule.js";

function main(): void {
  const runtime = createMcpRuntime();
  try {
    const projectId = runtime.resolveProjectId(undefined);
    const { snapshot, context } = loadSchedule(runtime, projectId);
    console.log(`项目 ${projectId}`);
    console.log(
      `成员 ${context.memberIds.length} / 任务 ${snapshot.tasks.length} / 分工 ${snapshot.participants.length} / 依赖 ${snapshot.dependencies.length}`,
    );

    const plans = planReschedules(snapshot, context, { maxPlans: 4 });
    console.log(`\n候选方案 ${plans.length} 个：\n`);

    for (const plan of plans) {
      console.log(
        `${plan.id} [${plan.label}] ${plan.feasible ? "✅ 可行" : "⚠️ 仍有冲突"}  ` +
          `冲突 ${plan.after.conflicts}（原 ${plan.before.conflicts}）  ` +
          `缺口 ${plan.after.shortfallMinutes} 分钟  延期 ${plan.after.slippageDays} 天  动作 ${plan.operations.length}`,
      );
      if (plan.summary !== "") console.log(`   ${plan.summary}`);
      if (!plan.feasible) {
        for (const conflict of plan.conflictsAfter) {
          console.log(`   剩余冲突：${conflict.type}`);
        }
      }
      console.log("");
    }
  } finally {
    runtime.close();
  }
}

main();
