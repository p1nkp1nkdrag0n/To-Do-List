/**
 * 在**副本**上验证「试算 → 应用」这条链，不动演示库。
 *
 *   cp data/v2/app.sqlite .tmp/apply-test.sqlite
 *   DB_PATH=.tmp/apply-test.sqlite npx tsx server/mcp/apply-demo.ts
 */
import { createMcpRuntime } from "./runtime.js";
import { applyPlan } from "./apply-plan.js";
import { loadSchedule } from "./snapshot.js";
import { planReschedules } from "./reschedule.js";

const runtime = createMcpRuntime({ dbPath: process.env.DB_PATH });
const projectId = runtime.resolveProjectId(undefined);

const before = runtime.availability.projectConflicts(projectId);
console.log(`应用前：${before.length} 条冲突（${before.map((c) => c.type).join(", ")}）`);

const { snapshot, context } = loadSchedule(runtime, projectId);
const started = performance.now();
const plans = planReschedules(snapshot, context, { maxPlans: 3 });
const elapsed = performance.now() - started;
console.log(`试算耗时 ${elapsed.toFixed(0)}ms，得到 ${plans.length} 个方案：`);
for (const plan of plans) {
  console.log(`  ${plan.id} ${plan.feasible ? "✅" : "⚠️"} ${plan.summary}`);
}

const chosen = plans.find((plan) => plan.feasible);
if (chosen === undefined) {
  console.log("没有可行方案，跳过应用。");
  runtime.close();
  process.exit(1);
}

const result = applyPlan(runtime, projectId, chosen);
console.log(`\n已应用 ${chosen.id}：动作 ${result.applied.join(", ")}`);
console.log(`冲突 ${result.conflictsBefore} → ${result.conflictsAfter}`);
if (result.remainingConflictTypes.length > 0) {
  console.log(`剩余类型：${result.remainingConflictTypes.join(", ")}`);
}

const after = runtime.availability.projectConflicts(projectId);
if (after.length > 0) {
  console.log("\n剩余冲突明细：");
  for (const conflict of after) console.log("  ", JSON.stringify(conflict));
}

const tasks = runtime.schedule.listTasks(runtime.auth, projectId);
console.log("\n应用后的排期：");
for (const task of tasks) console.log(`  ${task.title}  ${task.startDate} → ${task.dueDate}`);
const participants = runtime.schedule.listParticipants(runtime.auth, projectId);
console.log("\n应用后的分工：");
for (const participant of participants) {
  console.log(
    `  ${participant.displayName}  ${participant.startDate} → ${participant.endDate}  ${(participant.estimatedMinutes / 60).toFixed(1)}h`,
  );
}

runtime.close();
process.exitCode = result.conflictsAfter === 0 ? 0 : 1;
