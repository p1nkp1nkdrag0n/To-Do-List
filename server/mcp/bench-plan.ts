/**
 * 重排算法压力测试：用一个**生成出来的大项目**跑，验证它不是只对演示数据有效。
 *
 *   npx tsx server/mcp/bench-plan.ts [成员数] [任务数]
 *
 * 生成规则刻意制造难度：每人都只填了一部分可用时间、任务链式依赖、
 * 部分任务工时明显超过负责人当周可用量。
 */
import { planReschedules, type PlanContext, type ScheduleSnapshot } from "./reschedule.js";

const DAY_MS = 24 * 60 * 60 * 1_000;

function dateAt(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  return dateAt(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS);
}

/** 固定种子的伪随机，保证可复现。 */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function build(memberCount: number, taskCount: number): { snapshot: ScheduleSnapshot; context: PlanContext } {
  const random = makeRandom(42);
  const today = "2026-10-22";
  const members = Array.from({ length: memberCount }, (_, index) => `u${index + 1}`);
  const profiles = members.map((userId) => ({
    id: `${userId}:0`,
    userId,
    validFrom: addDays(today, -14),
    validThrough: addDays(today, 120),
    weeklyCapacityMinutes: 300 + Math.floor(random() * 900),
    weeklySlots: [1, 2, 3, 4, 5]
      .filter(() => random() > 0.15)
      .map((dayOfWeek) => ({
        dayOfWeek,
        startMinute: 1_080,
        endMinute: 1_080 + 60 + Math.floor(random() * 180),
      })),
    exceptions: [],
  }));

  const tasks: ScheduleSnapshot["tasks"] = [];
  const participants: ScheduleSnapshot["participants"] = [];
  const dependencies: ScheduleSnapshot["dependencies"] = [];

  let cursor = addDays(today, 1);
  for (let index = 0; index < taskCount; index += 1) {
    const taskId = `t${index + 1}`;
    const span = 1 + Math.floor(random() * 4);
    const startDate = cursor;
    const dueDate = addDays(startDate, span);
    tasks.push({ id: taskId, startDate, dueDate });

    const owner = members[Math.floor(random() * members.length)]!;
    const estimated = 120 + Math.floor(random() * 900);
    participants.push({
      id: `p${index + 1}`,
      taskId,
      userId: owner,
      startDate,
      endDate: dueDate,
      estimatedMinutes: estimated,
      progressPercent: 0,
    });

    if (index > 0 && random() > 0.55) {
      const predecessorIndex = Math.floor(random() * index);
      dependencies.push({
        id: `d${index}`,
        predecessorTaskId: `t${predecessorIndex + 1}`,
        successorTaskId: taskId,
      });
    }
    cursor = addDays(cursor, Math.floor(random() * 3));
  }

  return {
    snapshot: { tasks, participants, dependencies, profiles },
    context: {
      today,
      memberIds: members,
      memberNames: new Map(members.map((member) => [member, member.toUpperCase()])),
      taskTitles: new Map(tasks.map((task) => [task.id, `任务 ${task.id}`])),
      projectEndDate: addDays(today, 120),
    },
  };
}

const memberCount = Number(process.argv[2] ?? 8);
const taskCount = Number(process.argv[3] ?? 30);
const { snapshot, context } = build(memberCount, taskCount);

console.log(`合成项目：${memberCount} 人 / ${taskCount} 任务 / ${snapshot.dependencies.length} 依赖`);
const started = performance.now();
const plans = planReschedules(snapshot, context, { maxPlans: 3 });
const elapsed = performance.now() - started;

console.log(`耗时 ${elapsed.toFixed(0)}ms，返回 ${plans.length} 个方案`);
for (const plan of plans) {
  console.log(
    `  ${plan.feasible ? "✅" : "⚠️"} 冲突 ${plan.before.conflicts} → ${plan.after.conflicts}，动作 ${plan.operations.length}，延期 ${plan.after.slippageDays} 天`,
  );
}
