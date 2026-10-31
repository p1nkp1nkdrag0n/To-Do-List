/**
 * 撤销：把 apply_plan 做过的动作按相反顺序还原。
 *
 * 关键约束：版本检查与逆向写入必须在同一个短事务里完成。
 * 不能在事务外检查、再用服务层逐条写：服务层的 retry 会重读别人刚改的值，
 * 把“30 分钟”再 +480，得到 510。
 *
 * 因此使用作用域内服务写入（含状态重算/活动记录），只接受 apply 的 afterRevisions；
 * 任一记录已变化或缺少 afterRevisions，整次撤销拒绝，不写任何一条。
 */
import { ScheduleService } from "../modules/schedule/schedule-service.js";
import { HttpError } from "../http/errors.js";
import type { V2RuntimeDependencies } from "../http/dependencies.js";
import type { AuthenticatedSession } from "../modules/auth/auth-service.js";
import type { PlanOperation } from "../mcp/reschedule.js";
import type { AppliedPlanRecord } from "./events.js";

const DAY_MS = 24 * 60 * 60 * 1_000;

function shift(date: string | null, days: number): string | null {
  if (date === null) return null;
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

export interface UndoResult {
  projectId: string;
  reverted: number;
  skipped: string[];
}

interface ParticipantRow extends Record<string, unknown> {
  id: string;
  task_id: string;
  user_id: string;
  start_date: string;
  end_date: string;
  estimated_minutes: number;
  revision: number;
  removed_at: string | null;
}

interface TaskRow extends Record<string, unknown> {
  id: string;
  start_date: string | null;
  due_date: string | null;
  revision: number;
}

export function undoPlan(
  dependencies: V2RuntimeDependencies,
  auth: AuthenticatedSession,
  projectId: string,
  plan: AppliedPlanRecord,
): UndoResult {
  const db = dependencies.database;
  if (plan.afterRevisions === undefined) {
    return {
      projectId,
      reverted: 0,
      skipped: ["缺少写后版本记录，已安全拒绝撤销，避免覆盖人工修改。"],
    };
  }
  const after = plan.afterRevisions;
  // apply 支持 split 后再对占位 ID 做 extend/reassign；撤销前先统一翻译成真实 ID。
  const placeholderToReal = new Map(
    (plan.createdParticipants ?? []).map((item) => [item.placeholderId, item.realId]),
  );
  const operations = plan.operations.map((operation) => {
    if ("participantId" in operation && placeholderToReal.has(operation.participantId)) {
      return { ...operation, participantId: placeholderToReal.get(operation.participantId)! };
    }
    return operation;
  });

  try {
    return new ScheduleService(dependencies).writeUnit(auth, projectId, (writes) => {
      const participants = new Map(
        db
          .all<ParticipantRow>(
            "SELECT id, task_id, user_id, start_date, end_date, estimated_minutes, revision, removed_at FROM task_participants WHERE project_id = ?",
            [projectId],
          )
          .map((row) => [row.id, row]),
      );
      const tasks = new Map(
        db
          .all<TaskRow>(
            "SELECT id, start_date, due_date, revision FROM tasks WHERE project_id = ? AND deleted_at IS NULL",
            [projectId],
          )
          .map((row) => [row.id, row]),
      );

      // Verify the entire receipt before any service mutation can revise related tasks.
      for (const [id, revision] of Object.entries(after.participants)) {
        const row = participants.get(id);
        if (!row || row.removed_at !== null || row.revision !== revision)
          throw new HttpError(409, "UNDO_STALE", "分工已被人工修改，已拒绝撤销。");
      }
      for (const [id, revision] of Object.entries(after.tasks)) {
        if (tasks.get(id)?.revision !== revision)
          throw new HttpError(409, "UNDO_STALE", "任务已被人工修改，已拒绝撤销。");
      }
      const requireParticipant = (id: string): ParticipantRow => {
        if (after.participants[id] === undefined)
          throw new HttpError(409, "UNDO_STALE", "缺少分工版本，已拒绝撤销。");
        const row = db.get<ParticipantRow>(
          "SELECT * FROM task_participants WHERE project_id=? AND id=? AND removed_at IS NULL",
          [projectId, id]);
        if (!row) throw new HttpError(409, "UNDO_STALE", "分工已被删除，已拒绝撤销。");
        return row;
      };
      const requireTask = (id: string): TaskRow => {
        if (after.tasks[id] === undefined)
          throw new HttpError(409, "UNDO_STALE", "缺少任务版本，已拒绝撤销。");
        const row = db.get<TaskRow>("SELECT * FROM tasks WHERE project_id=? AND id=? AND deleted_at IS NULL", [projectId, id]);
        if (!row) throw new HttpError(409, "UNDO_STALE", "任务已被删除，已拒绝撤销。");
        return row;
      };
      const updateParticipant = (
        row: ParticipantRow,
        fields: { userId?: string; startDate?: string; endDate?: string; estimatedMinutes?: number },
      ) => writes.updateParticipant(row.id, { expectedRevision: row.revision, ...fields });
      const updateTask = (row: TaskRow, startDate: string | null, dueDate: string | null) =>
        writes.updateTask(row.id, { expectedRevision: row.revision, startDate, dueDate });

      let reverted = 0;
      for (const operation of [...operations].reverse()) {
        switch (operation.kind) {
          case "split": {
            const mapping = (plan.createdParticipants ?? []).find(
              (item) => item.placeholderId === operation.newParticipantId,
            );
            const createdId = mapping?.realId ?? operation.newParticipantId;
            const created = requireParticipant(createdId);
            writes.deleteParticipant(created.id, created.revision);
            const source = requireParticipant(operation.participantId);
            updateParticipant(source, {
              estimatedMinutes: source.estimated_minutes + operation.moveMinutes,
            });
            break;
          }
          case "reassign": {
            const participant = requireParticipant(operation.participantId);
            updateParticipant(participant, { userId: operation.fromUserId });
            break;
          }
          case "extend": {
            if (operation.previousTaskDueDate === undefined)
              throw new HttpError(409, "UNDO_STALE", "缺少原任务截止日期，已安全拒绝旧记录撤销。");
            const participant = requireParticipant(operation.participantId);
            updateParticipant(participant, { endDate: operation.previousEndDate });
            const task = requireTask(operation.taskId);
            updateTask(
              task,
              task.start_date,
              operation.previousTaskDueDate,
            );
            break;
          }
          case "shiftTask": {
            for (const taskId of operation.taskIds) {
              const task = requireTask(taskId);
              updateTask(
                task,
                shift(task.start_date, -operation.days),
                shift(task.due_date, -operation.days),
              );
            }
            for (const row of [...participants.values()].filter((item) =>
              operation.taskIds.includes(item.task_id),
            )) {
              if (row.removed_at !== null) continue;
              const current = requireParticipant(row.id);
              updateParticipant(current, {
                startDate: shift(current.start_date, -operation.days) ?? current.start_date,
                endDate: shift(current.end_date, -operation.days) ?? current.end_date,
              });
            }
            break;
          }
        }
        reverted += 1;
      }

      return { projectId, reverted, skipped: [] };
    });
  } catch (error) {
    return {
      projectId,
      reverted: 0,
      skipped: [error instanceof Error ? error.message : String(error)],
    };
  }
}
