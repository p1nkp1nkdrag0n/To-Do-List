import type { ScheduleWriteUnit } from "../modules/schedule/schedule-service.js";
import { snapshotSignature, type ReschedulePlan, type PlanOperation } from "./reschedule.js";
import type { McpRuntime } from "./runtime.js";
import { loadSchedule } from "./snapshot.js";

export interface ApplyResult {
  projectId: string;
  applied: string[];
  conflictsBefore: number;
  conflictsAfter: number;
  remainingConflictTypes: string[];
  /** 拆分时真正落库的分工 id（占位 id → 真实 id），撤销要用。 */
  createdParticipants: Array<{ placeholderId: string; realId: string; taskId: string; userId: string }>;
  /** 应用完成时各记录的 revision；撤销前要求仍然一致。 */
  afterRevisions: {
    tasks: Record<string, number>;
    participants: Record<string, number>;
  };
}

export function applyPlan(
  runtime: McpRuntime,
  projectId: string,
  plan: ReschedulePlan,
): ApplyResult {
  return runtime.schedule.writeUnit(runtime.auth, projectId, (writes) => {
    // 防呆一：方案算完之后现场可能又被人改过。冲突数对不上就不要盲目落库，
    // 否则会拿一份过期的方案去改现在的数据。
    const currentConflicts = runtime.availability.projectConflicts(projectId);
    if (currentConflicts.length !== plan.before.conflicts) {
      throw new Error(
        `排期在试算之后被改动过（冲突 ${plan.before.conflicts} → ${currentConflicts.length}），请重新 plan_reschedule。`,
      );
    }
    // 只比冲突数不够：把工时 600 改成 300，冲突数可能不变，但计划已经过期。
    const { snapshot: currentSnapshot, context: currentContext } = loadSchedule(runtime, projectId);
    if (
      typeof plan.beforeSignature !== "string" ||
      plan.beforeSignature.length === 0 ||
      plan.beforeSignature !== snapshotSignature(currentSnapshot, currentContext)
    ) {
      throw new Error(
        "排期在试算之后被改动过（任务或分工的版本已变化），请重新 plan_reschedule。",
      );
    }


    const beforeTaskRevisions = new Map(runtime.schedule.listTasks(runtime.auth, projectId).map(task => [task.id, task.revision]));
    const applied: string[] = [];
    const createdParticipants: ApplyResult["createdParticipants"] = [];
    // 方案里的「拆分」会给新分工起一个占位 id，后续动作可能又要对它再拆一次。
    // 维护占位 id → 真实 id 的映射，落库时先翻译再执行。
    const placeholderToReal = new Map<string, string>();
    const afterRevisions: ApplyResult["afterRevisions"] = { tasks: {}, participants: {} };

    for (const rawOperation of plan.operations) {
      const operation: PlanOperation =
        "participantId" in rawOperation && placeholderToReal.has(rawOperation.participantId)
          ? { ...rawOperation, participantId: placeholderToReal.get(rawOperation.participantId)! }
          : rawOperation;

      try {
        const result = applyOperation(runtime, projectId, operation, writes);
        if (result.created !== undefined && rawOperation.kind === "split") {
          placeholderToReal.set(rawOperation.newParticipantId, result.created.id);
          createdParticipants.push({
            placeholderId: rawOperation.newParticipantId,
            realId: result.created.id,
            taskId: rawOperation.taskId,
            userId: rawOperation.toUserId,
          });
        }
        Object.assign(afterRevisions.tasks, result.revisions.tasks);
        Object.assign(afterRevisions.participants, result.revisions.participants);
      } catch (error) {
        // Throw through the enclosing write unit: SQLite rolls back ALL effects.
        const message = error instanceof Error ? error.message : String(error);

        throw new Error(
          `已应用 ${applied.length}/${plan.operations.length} 个动作后失败：${message}。` +
            `本次改动已全部回滚，请重新 plan_reschedule。`,
        );
      }
      applied.push(operation.kind);
    }


    // Recalculation may revise tasks/ancestors. Capture receipts while the same
    // write lock is held, never with a post-commit reread.
    for (const task of runtime.schedule.listTasks(runtime.auth, projectId)) {
      if (afterRevisions.tasks[task.id] !== undefined || beforeTaskRevisions.get(task.id) !== task.revision) {
        afterRevisions.tasks[task.id] = task.revision;
      }
    }
    for (const id of Object.keys(afterRevisions.participants)) {
      afterRevisions.participants[id] = findParticipant(runtime, projectId, id).revision;
    }
    const conflictsAfter = runtime.availability.projectConflicts(projectId);
    return {
      projectId,
      applied,
      conflictsBefore: plan.before.conflicts,
      conflictsAfter: conflictsAfter.length,
      remainingConflictTypes: [...new Set(conflictsAfter.map((conflict) => conflict.type))],
      createdParticipants,
      afterRevisions,
    };
  });
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

interface OperationResult {
  created?: { id: string };
  revisions: {
    tasks: Record<string, number>;
    participants: Record<string, number>;
  };
}

function applyOperation(
  runtime: McpRuntime,
  projectId: string,
  operation: PlanOperation,
  writes: ScheduleWriteUnit,
): OperationResult {

  const auth = runtime.auth;
  const revisions: OperationResult["revisions"] = { tasks: {}, participants: {} };

  switch (operation.kind) {
    case "reassign": {
      const source = findParticipant(runtime, projectId, operation.participantId);
      if (source.taskId !== operation.taskId || source.userId !== operation.fromUserId)
        throw new Error("分工归属已变化，请重新 plan_reschedule。");
      const updated = (() => {
        const participant = findParticipant(runtime, projectId, operation.participantId);
        return writes.updateParticipant(operation.participantId, {
          expectedRevision: participant.revision,
          userId: operation.toUserId,
        });
      })();
      revisions.participants[updated.participant.id] = updated.participant.revision;
      return { revisions };
    }
    case "split": {
      const source = findParticipant(runtime, projectId, operation.participantId);
      if (source.taskId !== operation.taskId || source.userId !== operation.fromUserId ||
          !Number.isSafeInteger(operation.moveMinutes) || operation.moveMinutes <= 0 ||
          operation.moveMinutes >= source.estimatedMinutes) {
        throw new Error("拆分输入已变化或工时无效，请重新 plan_reschedule。");
      }
      const updated = (() => {
        const participant = findParticipant(runtime, projectId, operation.participantId);
        return writes.updateParticipant(operation.participantId, {
          expectedRevision: participant.revision,
          estimatedMinutes: participant.estimatedMinutes - operation.moveMinutes,
        });
      })();
      revisions.participants[updated.participant.id] = updated.participant.revision;
      const added = (() => {
        const participant = findParticipant(runtime, projectId, operation.participantId);
        // 撤销过一次之后再跑，同一对人会撞上「软删除的历史分工」，
        // 服务层要求带它当前的 revision 才能复活，否则抛 REVISION_CONFLICT。
        const historical = runtime.database.get<{ revision: number; removed_at: string | null }>(
          `SELECT revision, removed_at FROM task_participants
            WHERE task_id = ? AND user_id = ?`,
          [participant.taskId, operation.toUserId],
        );
        return writes.addParticipant(participant.taskId, {
          expectedRevision:
            historical !== undefined && historical.removed_at !== null
              ? historical.revision
              : undefined,
          userId: operation.toUserId,
          startDate: participant.startDate,
          endDate: participant.endDate,
          estimatedMinutes: operation.moveMinutes,
        });
      })();
      revisions.participants[added.participant.id] = added.participant.revision;
      return { created: { id: added.participant.id }, revisions };
    }
    case "extend": {
      const source = findParticipant(runtime, projectId, operation.participantId);
      if (source.taskId !== operation.taskId || source.endDate !== operation.previousEndDate)
        throw new Error("分工日期已变化，请重新 plan_reschedule。");
      const updated = (() => {
        const participant = findParticipant(runtime, projectId, operation.participantId);
        return writes.updateParticipant(operation.participantId, {
          expectedRevision: participant.revision,
          endDate: operation.newEndDate,
        });
      })();
      revisions.participants[updated.participant.id] = updated.participant.revision;
      const task = findTask(runtime, projectId, operation.taskId);
      if (task.dueDate !== null && operation.newEndDate > task.dueDate) {
        const changed = (() => {
          const current = findTask(runtime, projectId, operation.taskId);
          return writes.updateTask(operation.taskId, {
            expectedRevision: current.revision,
            dueDate: operation.newEndDate,
          });
        })();
        revisions.tasks[changed.task.id] = changed.task.revision;
      } else {
        revisions.tasks[task.id] = task.revision;
      }
      return { revisions };
    }
    case "shiftTask": {
      for (const taskId of operation.taskIds) {
        const changed = (() => {
          const current = findTask(runtime, projectId, taskId);
          return writes.updateTask(taskId, {
            expectedRevision: current.revision,
            startDate: shiftDate(current.startDate, operation.days),
            dueDate: shiftDate(current.dueDate, operation.days),
          });
        })();
        revisions.tasks[changed.task.id] = changed.task.revision;
        const participants = runtime.schedule
          .listParticipants(auth, projectId)
          .filter((participant) => participant.taskId === taskId);
        for (const participant of participants) {
          const current = (() => {
            const currentParticipant = findParticipant(runtime, projectId, participant.id);
            return writes.updateParticipant(participant.id, {
              expectedRevision: currentParticipant.revision,
              startDate: shiftDate(currentParticipant.startDate, operation.days) ?? currentParticipant.startDate,
              endDate: shiftDate(currentParticipant.endDate, operation.days) ?? currentParticipant.endDate,
            });
          })();
          revisions.participants[current.participant.id] = current.participant.revision;
        }
      }
      return { revisions };
    }
  }
}
