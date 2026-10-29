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
import { snapshotSignature, type ReschedulePlan, type PlanOperation } from "./reschedule.js";
import type { McpRuntime } from "./runtime.js";
import { loadSchedule } from "./snapshot.js";

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
  /** 拆分时真正落库的分工 id（占位 id → 真实 id），撤销要用。 */
  createdParticipants: Array<{ placeholderId: string; realId: string; taskId: string; userId: string }>;
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
  // 只比冲突数不够：把工时 600 改成 300，冲突数可能不变，但计划已经过期。
  const { snapshot: currentSnapshot } = loadSchedule(runtime, projectId);
  if (
    plan.beforeSignature !== undefined &&
    plan.beforeSignature !== "" &&
    plan.beforeSignature !== snapshotSignature(currentSnapshot)
  ) {
    throw new Error(
      "排期在试算之后被改动过（任务或分工的版本已变化），请重新 plan_reschedule。",
    );
  }

  backupSchedule(runtime, projectId);
  const applied: string[] = [];
  const createdParticipants: ApplyResult["createdParticipants"] = [];
  // 方案里的「拆分」会给新分工起一个占位 id，后续动作可能又要对它再拆一次。
  // 维护占位 id → 真实 id 的映射，落库时先翻译再执行。
  const placeholderToReal = new Map<string, string>();

  for (const rawOperation of plan.operations) {
    const operation: PlanOperation =
      "participantId" in rawOperation && placeholderToReal.has(rawOperation.participantId)
        ? { ...rawOperation, participantId: placeholderToReal.get(rawOperation.participantId)! }
        : rawOperation;

    try {
      const created = applyOperation(runtime, projectId, operation);
      if (created !== undefined && rawOperation.kind === "split") {
        placeholderToReal.set(rawOperation.newParticipantId, created.id);
        createdParticipants.push({
          placeholderId: rawOperation.newParticipantId,
          realId: created.id,
          taskId: rawOperation.taskId,
          userId: rawOperation.toUserId,
        });
      }
    } catch (error) {
      // 失败就整体回滚到应用前的快照：不能把项目留在“改了一半”的状态。
      const message = error instanceof Error ? error.message : String(error);
      restoreSchedule(runtime, projectId);
      throw new Error(
        `已应用 ${applied.length}/${plan.operations.length} 个动作后失败：${message}。` +
          `本次改动已全部回滚，请重新 plan_reschedule。`,
      );
    }
    applied.push(operation.kind);
  }

  dropBackup(runtime);
  const conflictsAfter = runtime.availability.projectConflicts(projectId);
  return {
    projectId,
    applied,
    conflictsBefore: plan.before.conflicts,
    conflictsAfter: conflictsAfter.length,
    remainingConflictTypes: [...new Set(conflictsAfter.map((conflict) => conflict.type))],
    createdParticipants,
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
): { id: string } | undefined {
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
      return undefined;
    }
    case "split": {
      retry(() => {
        const participant = findParticipant(runtime, projectId, operation.participantId);
        return schedule.updateParticipant(auth, projectId, operation.participantId, {
          expectedRevision: participant.revision,
          estimatedMinutes: Math.max(1, participant.estimatedMinutes - operation.moveMinutes),
        });
      });
      const added = retry(() => {
        const participant = findParticipant(runtime, projectId, operation.participantId);
        // 撤销过一次之后再跑，同一对人会撞上「软删除的历史分工」，
        // 服务层要求带它当前的 revision 才能复活，否则抛 REVISION_CONFLICT。
        const historical = runtime.database.get<{ revision: number; removed_at: string | null }>(
          `SELECT revision, removed_at FROM task_participants
            WHERE task_id = ? AND user_id = ?`,
          [participant.taskId, operation.toUserId],
        );
        return schedule.addParticipant(auth, projectId, participant.taskId, {
          expectedRevision:
            historical !== undefined && historical.removed_at !== null
              ? historical.revision
              : undefined,
          userId: operation.toUserId,
          startDate: participant.startDate,
          endDate: participant.endDate,
          estimatedMinutes: operation.moveMinutes,
        });
      });
      return added.participant;
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
      return undefined;
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
      return undefined;
    }
  }
}

/** 应用前的项目快照：失败时按行还原，避免项目停在「改了一半」。 */
function backupSchedule(runtime: McpRuntime, projectId: string): void {
  const db = runtime.database;
  db.exec(
    "DROP TABLE IF EXISTS temp.bk_tasks; DROP TABLE IF EXISTS temp.bk_participants; DROP TABLE IF EXISTS temp.bk_dependencies;",
  );
  db.prepare("CREATE TEMP TABLE bk_tasks AS SELECT * FROM tasks WHERE project_id = ?").run(projectId);
  db.prepare(
    "CREATE TEMP TABLE bk_participants AS SELECT * FROM task_participants WHERE project_id = ?",
  ).run(projectId);
  db.prepare(
    "CREATE TEMP TABLE bk_dependencies AS SELECT * FROM task_dependencies WHERE project_id = ?",
  ).run(projectId);
}

function dropBackup(runtime: McpRuntime): void {
  runtime.database.exec(
    "DROP TABLE IF EXISTS temp.bk_tasks; DROP TABLE IF EXISTS temp.bk_participants; DROP TABLE IF EXISTS temp.bk_dependencies;",
  );
}

function restoreSchedule(runtime: McpRuntime, projectId: string): void {
  const db = runtime.database;
  const tables: Array<[string, string]> = [
    ["tasks", "bk_tasks"],
    ["task_participants", "bk_participants"],
    ["task_dependencies", "bk_dependencies"],
  ];
  db.transaction(() => {
    for (const [table, backup] of tables) {
      const columns = (
        db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
      ).map((column) => column.name);
      // 先删掉这次新插入的行，再把备份里的行更新/补回。
      db.prepare(
        `DELETE FROM ${table} WHERE project_id = ? AND id NOT IN (SELECT id FROM ${backup})`,
      ).run(projectId);
      const updates = columns.filter((column) => column !== "id");
      const sql =
        `INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")}) ` +
        `ON CONFLICT(id) DO UPDATE SET ${updates.map((column) => `${column}=excluded.${column}`).join(",")}`;
      const statement = db.prepare(sql);
      for (const row of db.prepare(`SELECT * FROM ${backup}`).all() as Array<Record<string, unknown>>) {
        statement.run(...columns.map((column) => row[column] as never));
      }
    }
  });
  dropBackup(runtime);
}
