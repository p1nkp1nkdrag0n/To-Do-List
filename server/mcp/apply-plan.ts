/**
 * 把 plan_reschedule 算出的方案落库。
 *
 * 两个约束决定了这里必须包重试：
 *  1. ScheduleService 的每个写方法都要 expectedRevision（乐观锁）；
 *  2. 人可能在网页上同时改同一个任务，所以冲突不是异常，是常态。
 *
 * 对模型的承诺：**调用方不需要知道 revision 的存在**，失败重试三次后仍然
 * 冲突才会把错误抛回去。
 */
import { HttpError } from "../http/errors.js";
import type { ReschedulePlan, PlanOperation } from "./reschedule.js";
import type { McpRuntime } from "./runtime.js";

const MAX_ATTEMPTS = 3;

function isRevisionConflict(error: unknown): boolean {
  return error instanceof HttpError && error.code === "REVISION_CONFLICT";
}

function retry<T>(operation: () => T): T {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      lastError = error;
      if (!isRevisionConflict(error)) throw error;
    }
  }
  throw lastError;
}

export interface ApplyResult {
  projectId: string;
  applied: string[];
  conflictsBefore: number;
  conflictsAfter: number;
  remainingConflictTypes: string[];
}

export function applyPlan(
  runtime: McpRuntime,
  projectId: string,
  plan: ReschedulePlan,
): ApplyResult {
  const auth = runtime.auth;

  // 防呆一：方案算完之后现场可能又被人改过。冲突数对不上就不要盲目落库，
  // 否则会拿一份过期的方案去改现在的数据。
  const currentConflicts = runtime.availability.projectConflicts(projectId);
  if (currentConflicts.length !== plan.before.conflicts) {
    throw new Error(
      `排期在试算之后被改动过（冲突 ${plan.before.conflicts} → ${currentConflicts.length}），请重新 plan_reschedule。`,
    );
  }

  const applied: string[] = [];
  for (const operation of plan.operations) {
    try {
      applyOperation(runtime, projectId, operation);
    } catch (error) {
      // 防呆二：这一步不是原子的，失败时必须告诉调用方「改到哪一步了」，
      // 而不是让人以为什么都没发生。
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `已应用 ${applied.length}/${plan.operations.length} 个动作后失败：${message}。` +
          `数据库可能处于改了一半的状态，建议重新 plan_reschedule，必要时用快照还原。`,
      );
    }
    applied.push(operation.kind);
  }

  const conflictsAfter = runtime.availability.projectConflicts(projectId);
  return {
    projectId,
    applied,
    conflictsBefore: plan.before.conflicts,
    conflictsAfter: conflictsAfter.length,
    remainingConflictTypes: [...new Set(conflictsAfter.map((conflict) => conflict.type))],
  };
}

function findParticipant(runtime: McpRuntime, projectId: string, participantId: string) {
  const participant = runtime.schedule
    .listParticipants(runtime.auth, projectId)
    .find((candidate) => candidate.id === participantId);
  if (participant === undefined) {
    throw new Error(`分工 ${participantId} 不存在，可能已经被删除，请重新 plan_reschedule。`);
  }
  return participant;
}

function findTask(runtime: McpRuntime, projectId: string, taskId: string) {
  const task = runtime.schedule
    .listTasks(runtime.auth, projectId)
    .find((candidate) => candidate.id === taskId);
  if (task === undefined) {
    throw new Error(`任务 ${taskId} 不存在，可能已经被删除，请重新 plan_reschedule。`);
  }
  return task;
}

function shiftDate(date: string | null, days: number): string | null {
  if (date === null) return null;
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 24 * 60 * 60 * 1_000)
    .toISOString()
    .slice(0, 10);
}

function applyOperation(
  runtime: McpRuntime,
  projectId: string,
  operation: PlanOperation,
): void {
  const schedule = runtime.schedule;
  const auth = runtime.auth;

  switch (operation.kind) {
    case "reassign": {
      retry(() => {
        const participant = findParticipant(runtime, projectId, operation.participantId);
        return schedule.updateParticipant(auth, projectId, operation.participantId, {
          expectedRevision: participant.revision,
          userId: operation.toUserId,
        });
      });
      return;
    }
    case "split": {
      retry(() => {
        const participant = findParticipant(runtime, projectId, operation.participantId);
        return schedule.updateParticipant(auth, projectId, operation.participantId, {
          expectedRevision: participant.revision,
          estimatedMinutes: Math.max(1, participant.estimatedMinutes - operation.moveMinutes),
        });
      });
      retry(() => {
        const participant = findParticipant(runtime, projectId, operation.participantId);
        return schedule.addParticipant(auth, projectId, participant.taskId, {
          userId: operation.toUserId,
          startDate: participant.startDate,
          endDate: participant.endDate,
          estimatedMinutes: operation.moveMinutes,
        });
      });
      return;
    }
    case "extend": {
      retry(() => {
        const participant = findParticipant(runtime, projectId, operation.participantId);
        return schedule.updateParticipant(auth, projectId, operation.participantId, {
          expectedRevision: participant.revision,
          endDate: operation.newEndDate,
        });
      });
      const task = findTask(runtime, projectId, operation.taskId);
      if (task.dueDate !== null && operation.newEndDate > task.dueDate) {
        retry(() => {
          const current = findTask(runtime, projectId, operation.taskId);
          return schedule.updateTask(auth, projectId, operation.taskId, {
            expectedRevision: current.revision,
            dueDate: operation.newEndDate,
          });
        });
      }
      return;
    }
    case "shiftTask": {
      for (const taskId of operation.taskIds) {
        retry(() => {
          const current = findTask(runtime, projectId, taskId);
          return schedule.updateTask(auth, projectId, taskId, {
            expectedRevision: current.revision,
            startDate: shiftDate(current.startDate, operation.days),
            dueDate: shiftDate(current.dueDate, operation.days),
          });
        });
        const participants = runtime.schedule
          .listParticipants(auth, projectId)
          .filter((participant) => participant.taskId === taskId);
        for (const participant of participants) {
          retry(() => {
            const current = findParticipant(runtime, projectId, participant.id);
            return schedule.updateParticipant(auth, projectId, participant.id, {
              expectedRevision: current.revision,
              startDate: shiftDate(current.startDate, operation.days) ?? current.startDate,
              endDate: shiftDate(current.endDate, operation.days) ?? current.endDate,
            });
          });
        }
      }
      return;
    }
  }
}
