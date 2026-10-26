/**
 * MCP 工具：P1 只读五个。
 *
 * 设计上只有一条硬规则——**返回给模型的东西必须能直接说人话**。
 * 所以每个工具除了原始字段，还会带一段中文 summary；
 * 冲突工具会自己把 unallocatedMinutes 翻译成「还差 6 小时」。
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ScheduleConflict } from "../../shared/availability-contracts.js";
import { applyPlan } from "./apply-plan.js";
import { planReschedules } from "./reschedule.js";
import type { McpRuntime } from "./runtime.js";
import { loadSchedule } from "./snapshot.js";

const ProjectIdArgument = z
  .string()
  .min(1)
  .optional()
  .describe("项目 ID；省略时使用默认项目（演示环境只有一个项目）");

function jsonResult(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text" as const, text: `调用失败：${message}` }],
  };
}

function hours(minutes: number): string {
  return `${(minutes / 60).toFixed(1)}h`;
}

function taskLabel(titles: Map<string, string>, taskId: string): string {
  return titles.get(taskId) ?? taskId;
}

export function describeConflict(
  conflict: ScheduleConflict,
  titles: Map<string, string>,
  memberNames: Map<string, string>,
): string {
  switch (conflict.type) {
    case "unallocated_effort":
      return `${memberNames.get(conflict.userId) ?? conflict.userId} 在任务「${taskLabel(titles, conflict.taskId)}」上还有 ${hours(conflict.unallocatedMinutes)} 排不进去`;
    case "dependency_inversion":
      return `「${taskLabel(titles, conflict.successorTaskId)}」计划 ${conflict.successorStart} 开始，但前置任务「${taskLabel(titles, conflict.predecessorTaskId)}」要到 ${conflict.predecessorFinish} 才结束`;
    case "overdue":
      return `任务「${taskLabel(titles, conflict.taskId)}」已过期（截止 ${conflict.deadline}）`;
    case "missing_availability":
      return `${memberNames.get(conflict.userId) ?? conflict.userId} 在任务「${taskLabel(titles, conflict.taskId)}」的周期内没有登记可用时间`;
    default:
      return JSON.stringify(conflict);
  }
}

export function registerTools(server: McpServer, runtime: McpRuntime): void {
  server.registerTool(
    "list_projects",
    {
      title: "列出项目",
      description:
        "列出当前账号能看到的项目（含成员数、起止日期）。演示环境通常只有「苏客松·会议排班助手」一个。",
      inputSchema: {},
    },
    async () => {
      try {
        const projects = runtime.projects.list(runtime.auth);
        return jsonResult({
          defaultProjectId: runtime.defaultProjectId ?? null,
          projects: projects.map((project) => ({
            id: project.id,
            name: project.name,
            description: project.description,
            startDate: project.startDate,
            endDate: project.endDate,
            timezone: project.timezone,
          })),
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "get_tasks",
    {
      title: "读取任务树",
      description:
        "读取一个项目的全部任务，已按「谁负责 / 依赖谁 / 被谁阻塞」合并成树，模型不需要分别查三张表。",
      inputSchema: { projectId: ProjectIdArgument },
    },
    async ({ projectId }) => {
      try {
        const resolved = runtime.resolveProjectId(projectId);
        const tasks = runtime.schedule.listTasks(runtime.auth, resolved);
        const participants = runtime.schedule.listParticipants(runtime.auth, resolved);
        const dependencies = runtime.schedule.listDependencies(runtime.auth, resolved);

        const assigneesByTask = new Map<string, typeof participants>();
        for (const participant of participants) {
          const list = assigneesByTask.get(participant.taskId) ?? [];
          list.push(participant);
          assigneesByTask.set(participant.taskId, list);
        }

        return jsonResult({
          projectId: resolved,
          tasks: tasks.map((task) => {
            const assignees = assigneesByTask.get(task.id) ?? [];
            return {
              id: task.id,
              title: task.title,
              description: task.description,
              status: task.status,
              startDate: task.startDate,
              dueDate: task.dueDate,
              parentId: task.parentId,
              phaseId: task.phaseId,
              assignees: assignees.map((participant) => ({
                participantId: participant.id,
                userId: participant.userId,
                displayName: participant.displayName,
                startDate: participant.startDate,
                endDate: participant.endDate,
                estimatedMinutes: participant.estimatedMinutes,
                estimatedHours: Number((participant.estimatedMinutes / 60).toFixed(1)),
                progressPercent: participant.progressPercent,
              })),
              dependsOn: dependencies
                .filter((dependency) => dependency.successorTaskId === task.id)
                .map((dependency) => dependency.predecessorTaskId),
              blocks: dependencies
                .filter((dependency) => dependency.predecessorTaskId === task.id)
                .map((dependency) => dependency.successorTaskId),
            };
          }),
          dependencyCount: dependencies.length,
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "list_members",
    {
      title: "列出成员与可用时间",
      description:
        "列出项目成员，以及每个人每周的可用时段、每周上限、请假/加班例外。排期要看「谁能干多少小时」时用这个。",
      inputSchema: { projectId: ProjectIdArgument },
    },
    async ({ projectId }) => {
      try {
        const resolved = runtime.resolveProjectId(projectId);
        const summary = runtime.availability.projectSummary(runtime.auth, resolved);
        return jsonResult({
          projectId: resolved,
          members: summary.members.map((member) => ({
            userId: member.userId,
            username: member.username,
            displayName: member.displayName,
            profiles: member.profiles.map((profile) => ({
              validFrom: profile.validFrom,
              validThrough: profile.validThrough,
              weeklyCapacityMinutes: profile.weeklyCapacityMinutes,
              weeklyCapacityHours: Number((profile.weeklyCapacityMinutes / 60).toFixed(1)),
              weeklySlots: profile.weeklySlots,
              exceptions: profile.exceptions,
            })),
          })),
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "get_availability",
    {
      title: "读取可用时间",
      description:
        "读取可用时间文档。传 projectId 返回该项目全体成员的可用时间；不传 projectId 返回当前账号自己的。",
      inputSchema: {
        projectId: ProjectIdArgument,
        userId: z.string().min(1).optional().describe("只看某个人；省略表示全体"),
      },
    },
    async ({ projectId, userId }) => {
      try {
        if (projectId === undefined && userId === undefined) {
          const document = runtime.availability.getDocument(runtime.auth);
          return jsonResult({
            scope: "self",
            userId: runtime.auth.user.id,
            revision: document.revision,
            profiles: document.profiles,
          });
        }
        const resolved = runtime.resolveProjectId(projectId);
        const summary = runtime.availability.projectSummary(runtime.auth, resolved);
        const members =
          userId === undefined
            ? summary.members
            : summary.members.filter((member) => member.userId === userId);
        return jsonResult({
          scope: "project",
          projectId: resolved,
          members,
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "check_conflicts",
    {
      title: "检测排期冲突",
      description:
        "跑一遍冲突引擎，返回红/黄冲突清单：工时排不下（unallocated_effort）、依赖倒挂（dependency_inversion）、过期（overdue）、没登记可用时间（missing_availability）。每条都带中文 summary，可以直接念给用户听。",
      inputSchema: { projectId: ProjectIdArgument },
    },
    async ({ projectId }) => {
      try {
        const resolved = runtime.resolveProjectId(projectId);
        const conflicts = runtime.availability.projectConflicts(resolved);
        const tasks = runtime.schedule.listTasks(runtime.auth, resolved);
        const members = runtime.availability.projectSummary(runtime.auth, resolved).members;
        const titles = new Map(tasks.map((task) => [task.id, task.title]));
        const names = new Map(members.map((member) => [member.userId, member.displayName]));

        return jsonResult({
          projectId: resolved,
          count: conflicts.length,
          conflicts: conflicts.map((conflict) => ({
            ...conflict,
            summary: describeConflict(conflict, titles, names),
          })),
          summary:
            conflicts.length === 0
              ? "当前没有冲突。"
              : conflicts
                  .map((conflict) => describeConflict(conflict, titles, names))
                  .join("；"),
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "plan_reschedule",
    {
      title: "试算重排方案（不写库）",
      description:
        "对当前排期做一次只读试算：先生成候选动作（换人 / 拆分 / 延期 / 整体平移并连带下游），用冲突引擎当裁判逐个模拟，返回最多 3 个方案，每个都带「冲突数、缺口、延期天数」和中文摘要。**不修改任何数据**，选定后把 planId 交给 apply_plan。",
      inputSchema: {
        projectId: ProjectIdArgument,
        allowReassign: z
          .boolean()
          .optional()
          .describe("是否允许换人/拆分；某些项目负责人是定死的，传 false 就只延期和排期"),
      },
    },
    async ({ projectId, allowReassign }) => {
      try {
        const resolved = runtime.resolveProjectId(projectId);
        const { snapshot, context } = loadSchedule(runtime, resolved);
        const plans = planReschedules(snapshot, context, {
          maxPlans: 3,
          allowReassign: allowReassign ?? true,
        });
        runtime.planCache.set(resolved, plans);

        return jsonResult({
          projectId: resolved,
          before: plans[0]?.before ?? { conflicts: 0 },
          plans: plans.map((plan) => ({
            id: plan.id,
            label: plan.label,
            feasible: plan.feasible,
            summary: plan.summary,
            operations: plan.operations,
            after: plan.after,
          })),
          recommendation: plans.find((plan) => plan.feasible)?.id ?? plans[0]?.id ?? null,
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "apply_plan",
    {
      title: "应用重排方案（写库）",
      description:
        "把 plan_reschedule 返回的某个方案落库。内部自己处理乐观锁重试（最多 3 次），调用方不需要关心 revision。默认只接受最近一次试算出来的方案；省略 planId 时应用「推荐方案」。",
      inputSchema: {
        projectId: ProjectIdArgument,
        planId: z
          .string()
          .min(1)
          .optional()
          .describe("plan_reschedule 返回的方案 id，例如 plan-1；省略表示用推荐方案"),
      },
    },
    async ({ projectId, planId }) => {
      try {
        const resolved = runtime.resolveProjectId(projectId);
        const cached = runtime.planCache.get(resolved);
        if (cached === undefined || cached.length === 0) {
          throw new Error("还没有试算结果，先调用 plan_reschedule。");
        }
        const chosen =
          planId === undefined
            ? (cached.find((plan) => plan.feasible) ?? cached[0]!)
            : cached.find((plan) => plan.id === planId);
        if (chosen === undefined) {
          throw new Error(
            `找不到方案 ${planId}，可用方案：${cached.map((plan) => plan.id).join(", ")}`,
          );
        }

        const result = applyPlan(runtime, resolved, chosen);
        runtime.planCache.delete(resolved);

        return jsonResult({
          ...result,
          planId: chosen.id,
          summary:
            result.conflictsAfter === 0
              ? `已应用「${chosen.label}」，冲突清零。`
              : `已应用「${chosen.label}」，仍有 ${result.conflictsAfter} 条冲突：${result.remainingConflictTypes.join("、")}`,
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "create_task",
    {
      title: "创建任务",
      description:
        "把会议里抽出来的待办落成一个任务。只填标题也能建，日期可后补；建完记得用 assign_member 挂人，否则排期引擎不会计算它的工时。",
      inputSchema: {
        projectId: ProjectIdArgument,
        title: z.string().min(1).max(200).describe("任务标题"),
        description: z.string().max(2_000).optional().describe("任务说明"),
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("开始日 YYYY-MM-DD"),
        dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("截止日 YYYY-MM-DD"),
      },
    },
    async ({ projectId, title, description, startDate, dueDate }) => {
      try {
        const resolved = runtime.resolveProjectId(projectId);
        const created = runtime.schedule.createTask(runtime.auth, resolved, {
          title,
          description,
          startDate,
          dueDate,
        });
        return jsonResult({
          projectId: resolved,
          taskId: created.task.id,
          title: created.task.title,
          startDate: created.task.startDate,
          dueDate: created.task.dueDate,
          summary: `已创建任务「${created.task.title}」${created.task.dueDate ? `，截止 ${created.task.dueDate}` : ""}。下一步用 assign_member 指定负责人。`,
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "assign_member",
    {
      title: "分配负责人与工时",
      description:
        "给任务挂一个负责人，并指定他的起止日期与预计工时（按小时传，内部换算成分钟）。同一个人不能在同一任务上挂两次；已存在则报错。",
      inputSchema: {
        projectId: ProjectIdArgument,
        taskId: z.string().min(1).describe("任务 ID"),
        userId: z.string().min(1).describe("成员 ID，可先用 list_members 查"),
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("此人开始投入的日期"),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("此人最晚完成日期"),
        estimatedHours: z.number().positive().max(2_000).describe("预计工时（小时）"),
      },
    },
    async ({ projectId, taskId, userId, startDate, endDate, estimatedHours }) => {
      try {
        const resolved = runtime.resolveProjectId(projectId);
        const result = runtime.schedule.addParticipant(runtime.auth, resolved, taskId, {
          userId,
          startDate,
          endDate,
          estimatedMinutes: Math.round(estimatedHours * 60),
        });
        return jsonResult({
          projectId: resolved,
          participantId: result.participant.id,
          taskId,
          displayName: result.participant.displayName,
          startDate: result.participant.startDate,
          endDate: result.participant.endDate,
          estimatedHours,
          summary: `已把任务分给 ${result.participant.displayName}：${startDate} → ${endDate}，${estimatedHours}h。`,
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "set_dependency",
    {
      title: "建立任务依赖",
      description:
        "让一个任务必须在前一个任务完成后才能开始（successor 依赖 predecessor）。建完建议再跑一次 check_conflicts，看有没有制造出新的倒挂。",
      inputSchema: {
        projectId: ProjectIdArgument,
        predecessorTaskId: z.string().min(1).describe("前置任务（先做）"),
        successorTaskId: z.string().min(1).describe("后置任务（后做）"),
      },
    },
    async ({ projectId, predecessorTaskId, successorTaskId }) => {
      try {
        const resolved = runtime.resolveProjectId(projectId);
        const result = runtime.schedule.createDependency(runtime.auth, resolved, successorTaskId, {
          predecessorTaskId,
        });
        return jsonResult({
          projectId: resolved,
          dependencyId: result.dependency.id,
          predecessorTaskId,
          successorTaskId,
          summary: `已建立依赖：${predecessorTaskId} → ${successorTaskId}。`,
        });
      } catch (error) {
        return failure(error);
      }
    },
  );
}
