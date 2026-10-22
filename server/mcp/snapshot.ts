/**
 * 把项目现状读成一份「排期快照」，供重排算法在内存里模拟。
 *
 * 只读、不写库：算法跑出来的方案在内存里改动，落库是 apply_plan 的事。
 */
import type { ScheduleSnapshot, PlanContext } from "./reschedule.js";
import type { McpRuntime } from "./runtime.js";

const DAY_MS = 24 * 60 * 60 * 1_000;

function todayInTimeZone(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(
    parts.filter(({ type }) => type !== "literal").map(({ type, value }) => [type, value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

export interface LoadedSchedule {
  snapshot: ScheduleSnapshot;
  context: PlanContext;
}

export function loadSchedule(
  runtime: McpRuntime,
  projectId: string,
  now: Date = new Date(),
): LoadedSchedule {
  const project = runtime.projects
    .list(runtime.auth)
    .find((candidate) => candidate.id === projectId);
  const timezone = project?.timezone ?? "Asia/Shanghai";
  const today = todayInTimeZone(now, timezone);

  const tasks = runtime.schedule.listTasks(runtime.auth, projectId);
  const participants = runtime.schedule.listParticipants(runtime.auth, projectId);
  const dependencies = runtime.schedule.listDependencies(runtime.auth, projectId);
  const summary = runtime.availability.projectSummary(runtime.auth, projectId);

  const profiles = summary.members.flatMap((member) =>
    member.profiles.map((profile, index) => ({
      id: `${member.userId}:${index}`,
      userId: member.userId,
      validFrom: profile.validFrom,
      validThrough: profile.validThrough,
      weeklyCapacityMinutes: profile.weeklyCapacityMinutes,
      weeklySlots: profile.weeklySlots,
      exceptions: profile.exceptions,
    })),
  );

  return {
    snapshot: {
      tasks: tasks.map((task) => ({
        id: task.id,
        startDate: task.startDate,
        dueDate: task.dueDate,
      })),
      participants: participants.map((participant) => ({
        id: participant.id,
        taskId: participant.taskId,
        userId: participant.userId,
        startDate: participant.startDate,
        endDate: participant.endDate,
        estimatedMinutes: participant.estimatedMinutes,
        progressPercent: participant.progressPercent,
      })),
      dependencies: dependencies.map((dependency) => ({
        id: dependency.id,
        predecessorTaskId: dependency.predecessorTaskId,
        successorTaskId: dependency.successorTaskId,
      })),
      profiles,
    },
    context: {
      today,
      memberIds: summary.members.map((member) => member.userId),
      memberNames: new Map(summary.members.map((member) => [member.userId, member.displayName])),
      taskTitles: new Map(tasks.map((task) => [task.id, task.title])),
      projectEndDate: project?.endDate ?? null,
    },
  };
}

export function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / DAY_MS,
  );
}
