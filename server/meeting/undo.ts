/**
 * 撤销：把 apply_plan 做过的动作按相反顺序还原。
 *
 * 为什么不需要「快照整个项目」：
 *   方案里的每个动作都自带还原所需的信息（原负责人 / 原结束日 / 平移天数 /
 *   拆出去的那条分工 id），所以逆运算就是逐条反过来做。
 *
 * 注意：撤销走的是服务层（而不是 MCP），因为它是「人在环上」的人工操作，
 * 不属于智能体的自动流程；权限仍然用当前登录用户，没有开后门。
 */
import { HttpError } from "../http/errors.js";
import type { V2RuntimeDependencies } from "../http/dependencies.js";
import type { AuthenticatedSession } from "../modules/auth/auth-service.js";
import { ScheduleService } from "../modules/schedule/schedule-service.js";
import type { PlanOperation } from "../mcp/reschedule.js";
import type { AppliedPlanRecord } from "./events.js";

const DAY_MS = 24 * 60 * 60 * 1_000;

function shift(date: string | null, days: number): string | null {
  if (date === null) return null;
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

function retry<T>(operation: () => T): T {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      lastError = error;
      if (!(error instanceof HttpError && error.code === "REVISION_CONFLICT")) throw error;
    }
  }
  throw lastError;
}

export interface UndoResult {
  projectId: string;
  reverted: number;
  skipped: string[];
}

export function undoPlan(
  dependencies: V2RuntimeDependencies,
  auth: AuthenticatedSession,
  projectId: string,
  plan: AppliedPlanRecord,
): UndoResult {
  const schedule = new ScheduleService(dependencies);
  const skipped: string[] = [];
  let reverted = 0;

  const participants = () =>
    schedule.listParticipants(auth, projectId);
  const tasks = () => schedule.listTasks(auth, projectId);

  for (const operation of [...plan.operations].reverse()) {
    try {
      revert(operation);
      reverted += 1;
    } catch (error) {
      skipped.push(
        `${operation.kind}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return { projectId, reverted, skipped };

  function revert(operation: PlanOperation): void {
    switch (operation.kind) {
      case "split": {
        // 先删掉拆出去的那条，再把工时还给原负责人。
        // 落库时生成的是真实 id，和方案里的占位 id 不同，优先用 apply 回报的映射。
        const mapping = (plan.createdParticipants ?? []).find(
          (item) => item.placeholderId === operation.newParticipantId,
        );
        const created = participants().find(
          (item) => item.id === (mapping?.realId ?? operation.newParticipantId),
        );
        if (created !== undefined) {
          retry(() => schedule.deleteParticipant(auth, projectId, created.id, created.revision));
        }
        retry(() => {
          const source = participants().find((item) => item.id === operation.participantId);
          if (source === undefined) throw new Error("原分工不存在");
          return schedule.updateParticipant(auth, projectId, source.id, {
            expectedRevision: source.revision,
            estimatedMinutes: source.estimatedMinutes + operation.moveMinutes,
          });
        });
        return;
      }
      case "reassign": {
        retry(() => {
          const participant = participants().find((item) => item.id === operation.participantId);
          if (participant === undefined) throw new Error("分工不存在");
          return schedule.updateParticipant(auth, projectId, participant.id, {
            expectedRevision: participant.revision,
            userId: operation.fromUserId,
          });
        });
        return;
      }
      case "extend": {
        retry(() => {
          const participant = participants().find((item) => item.id === operation.participantId);
          if (participant === undefined) throw new Error("分工不存在");
          return schedule.updateParticipant(auth, projectId, participant.id, {
            expectedRevision: participant.revision,
            endDate: operation.previousEndDate,
          });
        });
        retry(() => {
          const task = tasks().find((item) => item.id === operation.taskId);
          if (task === undefined || task.dueDate !== operation.newEndDate) return;
          return schedule.updateTask(auth, projectId, task.id, {
            expectedRevision: task.revision,
            dueDate: operation.previousEndDate,
          });
        });
        return;
      }
      case "shiftTask": {
        // 整体平移：被连带推走的下游任务也要一起挪回去。
        for (const taskId of operation.taskIds) {
          retry(() => {
            const current = tasks().find((item) => item.id === taskId);
            if (current === undefined) return;
            return schedule.updateTask(auth, projectId, current.id, {
              expectedRevision: current.revision,
              startDate: shift(current.startDate, -operation.days) ?? current.startDate,
              dueDate: shift(current.dueDate, -operation.days) ?? current.dueDate,
            });
          });
        }
        for (const participant of participants().filter((item) =>
          operation.taskIds.includes(item.taskId),
        )) {
          retry(() => {
            const current = participants().find((item) => item.id === participant.id);
            if (current === undefined) return;
            return schedule.updateParticipant(auth, projectId, current.id, {
              expectedRevision: current.revision,
              startDate: shift(current.startDate, -operation.days) ?? current.startDate,
              endDate: shift(current.endDate, -operation.days) ?? current.endDate,
            });
          });
        }
        return;
      }
    }
  }
}
