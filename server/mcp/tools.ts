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
import type { McpRuntime } from "./runtime.js";

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
}
