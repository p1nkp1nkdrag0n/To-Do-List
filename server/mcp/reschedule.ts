/**
 * 重排算法（plan_reschedule 的核心）。
 *
 * 设计原则：**不针对某个具体项目写死**。
 *  - 输入是一份「排期快照」（任务 / 分工 / 依赖 / 可用时间），项目有几个成员、
 *    几个任务、依赖多深都无所谓；
 *  - 好坏只由冲突引擎判定，算法不猜；
 *  - 候选动作是通用的六类：换人、拆分、延长、整体平移、连带平移、对齐前置。
 *
 * 为什么不是「一步一修」的贪心：
 *   现实里修一个冲突经常会把另一个冲突顶出来（挪了任务，后面依赖它的任务就倒挂了），
 *   严格贪心会卡在「修不动」上。所以这里用**有界束搜索**（beam search）：
 *   允许中间状态一样差甚至更差，只要最终能收敛到 0 冲突。
 */
import { computeAvailabilityConflicts } from "../modules/availability/conflict-engine.js";
import type {
  ConflictAvailabilityProfile,
  ConflictDependency,
  ConflictParticipant,
  ConflictTask,
} from "../modules/availability/conflict-engine.js";
import type { ScheduleConflict } from "../../shared/availability-contracts.js";

const DAY_MS = 24 * 60 * 60 * 1_000;

export interface ScheduleSnapshot {
  tasks: ConflictTask[];
  participants: ConflictParticipant[];
  dependencies: ConflictDependency[];
  profiles: ConflictAvailabilityProfile[];
}

export interface PlanContext {
  today: string;
  memberIds: string[];
  memberNames: Map<string, string>;
  taskTitles: Map<string, string>;
  projectEndDate?: string | null;
}

export type PlanOperation =
  | {
      kind: "reassign";
      participantId: string;
      taskId: string;
      fromUserId: string;
      toUserId: string;
    }
  | {
      kind: "split";
      participantId: string;
      taskId: string;
      fromUserId: string;
      toUserId: string;
      moveMinutes: number;
      newParticipantId: string;
    }
  | {
      kind: "extend";
      participantId: string;
      taskId: string;
      newEndDate: string;
      previousEndDate: string;
      /** 任务自己的截止日；撤销时要还原它，而不是分工的结束日。 */
      previousTaskDueDate?: string | null;
    }
  | {
      kind: "shiftTask";
      taskId: string;
      days: number;
      taskIds: string[];
      previousStartDate: string | null;
      previousDueDate: string | null;
      newStartDate: string | null;
      newDueDate: string | null;
    };

export interface PlanScore {
  conflicts: number;
  shortfallMinutes: number;
  slippageDays: number;
  operations: number;
}

export interface ReschedulePlan {
  id: string;
  /** 试算时排期的指纹；应用前必须一致，否则说明期间有人改过。 */
  beforeSignature: string;
  label: string;
  operations: PlanOperation[];
  before: PlanScore;
  after: PlanScore;
  conflictsAfter: ScheduleConflict[];
  summary: string;
  feasible: boolean;
}

export interface PlanOptions {
  maxSteps?: number;
  maxPlans?: number;
  beamWidth?: number;
  /**
   * 是否允许把活转给别人（换人 / 拆分）。
   * 有些项目里「谁负责」是定死的，只能延期或平移，这时传 false。
   */
  allowReassign?: boolean;
}

function dateAt(milliseconds: number): string {
  return new Date(milliseconds).toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  return dateAt(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS);
}

function diffDays(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / DAY_MS,
  );
}

function cloneSnapshot(snapshot: ScheduleSnapshot): ScheduleSnapshot {
  return {
    tasks: snapshot.tasks.map((task) => ({ ...task })),
    participants: snapshot.participants.map((participant) => ({ ...participant })),
    dependencies: snapshot.dependencies.map((dependency) => ({ ...dependency })),
    profiles: snapshot.profiles,
  };
}

function hours(minutes: number): string {
  return `${(minutes / 60).toFixed(1)}h`;
}

function conflictList(snapshot: ScheduleSnapshot, today: string): ScheduleConflict[] {
  return computeAvailabilityConflicts({
    projectId: "simulation",
    today,
    tasks: snapshot.tasks,
    participants: snapshot.participants,
    dependencies: snapshot.dependencies,
    profiles: snapshot.profiles,
  });
}

function baselineDueDates(snapshot: ScheduleSnapshot): Map<string, string | null> {
  return new Map(snapshot.tasks.map((task) => [task.id, task.dueDate]));
}

function scoreOf(
  snapshot: ScheduleSnapshot,
  context: PlanContext,
  baselineDue: Map<string, string | null>,
  operations: number,
): PlanScore {
  const conflicts = conflictList(snapshot, context.today);
  let shortfallMinutes = 0;
  for (const conflict of conflicts) {
    if (conflict.type === "unallocated_effort") shortfallMinutes += conflict.unallocatedMinutes;
  }
  let slippageDays = 0;
  for (const task of snapshot.tasks) {
    const original = baselineDue.get(task.id) ?? null;
    if (original === null || task.dueDate === null) continue;
    const slip = diffDays(original, task.dueDate);
    if (slip > 0) slippageDays += slip;
  }
  return { conflicts: conflicts.length, shortfallMinutes, slippageDays, operations };
}

/** 单一排序键：冲突数 > 缺口 > 延期 > 动作数。 */
function rank(score: PlanScore): number {
  return (
    score.conflicts * 1e9 +
    score.shortfallMinutes * 1e4 +
    score.slippageDays * 100 +
    score.operations
  );
}

function taskOf(snapshot: ScheduleSnapshot, taskId: string): ConflictTask | undefined {
  return snapshot.tasks.find((task) => task.id === taskId);
}

function participantsOfTask(
  snapshot: ScheduleSnapshot,
  taskId: string,
): ConflictParticipant[] {
  return snapshot.participants.filter((participant) => participant.taskId === taskId);
}

function hasMemberOnTask(snapshot: ScheduleSnapshot, taskId: string, userId: string): boolean {
  return snapshot.participants.some(
    (participant) => participant.taskId === taskId && participant.userId === userId,
  );
}

function shiftOne(snapshot: ScheduleSnapshot, taskId: string, days: number): void {
  if (days === 0) return;
  const task = taskOf(snapshot, taskId);
  if (task === undefined) return;
  task.startDate = task.startDate === null ? null : addDays(task.startDate, days);
  task.dueDate = task.dueDate === null ? null : addDays(task.dueDate, days);
  for (const participant of participantsOfTask(snapshot, taskId)) {
    participant.startDate = addDays(participant.startDate, days);
    participant.endDate = addDays(participant.endDate, days);
  }
}

/** 顺着依赖往下游收集所有后继任务（含自身）。 */
function downstreamTasks(snapshot: ScheduleSnapshot, taskId: string): string[] {
  const result = new Set<string>([taskId]);
  const queue = [taskId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const dependency of snapshot.dependencies) {
      if (dependency.predecessorTaskId !== current) continue;
      if (result.has(dependency.successorTaskId)) continue;
      result.add(dependency.successorTaskId);
      queue.push(dependency.successorTaskId);
    }
  }
  return [...result];
}

function applyOperation(snapshot: ScheduleSnapshot, operation: PlanOperation): ScheduleSnapshot {
  const next = cloneSnapshot(snapshot);
  switch (operation.kind) {
    case "reassign": {
      const participant = next.participants.find((item) => item.id === operation.participantId);
      if (participant !== undefined) participant.userId = operation.toUserId;
      break;
    }
    case "split": {
      const source = next.participants.find((item) => item.id === operation.participantId);
      if (source === undefined) break;
      source.estimatedMinutes = Math.max(0, source.estimatedMinutes - operation.moveMinutes);
      next.participants.push({
        id: operation.newParticipantId,
        taskId: source.taskId,
        userId: operation.toUserId,
        startDate: source.startDate,
        endDate: source.endDate,
        estimatedMinutes: operation.moveMinutes,
        progressPercent: 0,
      });
      break;
    }
    case "extend": {
      const participant = next.participants.find((item) => item.id === operation.participantId);
      if (participant === undefined) break;
      participant.endDate = operation.newEndDate;
      const task = taskOf(next, participant.taskId);
      if (task !== undefined && task.dueDate !== null && operation.newEndDate > task.dueDate) {
        task.dueDate = operation.newEndDate;
      }
      break;
    }
    case "shiftTask": {
      for (const taskId of operation.taskIds) shiftOne(next, taskId, operation.days);
      break;
    }
  }
  return next;
}

function memberOptions(
  snapshot: ScheduleSnapshot,
  conflict: Extract<ScheduleConflict, { type: "unallocated_effort" }>,
  context: PlanContext,
): string[] {
  return context.memberIds.filter(
    (userId) => userId !== conflict.userId && !hasMemberOnTask(snapshot, conflict.taskId, userId),
  );
}

function shiftOperation(
  snapshot: ScheduleSnapshot,
  taskId: string,
  days: number,
  cascade: boolean,
): PlanOperation | null {
  const task = taskOf(snapshot, taskId);
  if (task === undefined) return null;
  const taskIds = cascade ? downstreamTasks(snapshot, taskId) : [taskId];
  for (const id of taskIds) {
    const target = taskOf(snapshot, id);
    if (target?.startDate == null) return null;
  }
  return {
    kind: "shiftTask",
    taskId,
    days,
    taskIds,
    previousStartDate: task.startDate,
    previousDueDate: task.dueDate,
    newStartDate: task.startDate === null ? null : addDays(task.startDate, days),
    newDueDate: task.dueDate === null ? null : addDays(task.dueDate, days),
  };
}

function candidatesFor(
  snapshot: ScheduleSnapshot,
  conflict: ScheduleConflict,
  context: PlanContext,
  options: { allowReassign: boolean } = { allowReassign: true },
): PlanOperation[] {
  const operations: PlanOperation[] = [];

  if (conflict.type === "unallocated_effort") {
    const participant = snapshot.participants.find(
      (item) => item.id === conflict.participantId,
    );
    if (participant === undefined) return operations;

    // 别把活推给已经排不下的人：那只是把红色从 A 挪到 B，不是解决问题。
    const overloaded = new Set(
      conflictList(snapshot, context.today)
        .filter((item) => item.type === "unallocated_effort")
        .map((item) => item.userId),
    );
    const allTargets = memberOptions(snapshot, conflict, context);
    const healthyTargets = allTargets.filter((userId) => !overloaded.has(userId));
    const targets = options.allowReassign
      ? healthyTargets.length > 0
        ? healthyTargets
        : allTargets
      : [];

    for (const userId of targets) {
      if (conflict.unallocatedMinutes >= participant.estimatedMinutes) {
        operations.push({
          kind: "reassign",
          participantId: participant.id,
          taskId: participant.taskId,
          fromUserId: participant.userId,
          toUserId: userId,
        });
      }
      const moveMinutes = Math.min(conflict.unallocatedMinutes, participant.estimatedMinutes);
      if (moveMinutes > 0 && moveMinutes < participant.estimatedMinutes) {
        operations.push({
          kind: "split",
          participantId: participant.id,
          taskId: participant.taskId,
          fromUserId: participant.userId,
          toUserId: userId,
          moveMinutes,
          newParticipantId: `split:${participant.id}:${userId}`,
        });
      }
    }

    for (const extra of [1, 2, 4, 7]) {
      const newEnd = addDays(participant.endDate, extra);
      if (context.projectEndDate != null && newEnd > context.projectEndDate) continue;
      operations.push({
        kind: "extend",
        participantId: participant.id,
        taskId: participant.taskId,
        newEndDate: newEnd,
        previousEndDate: participant.endDate,
        previousTaskDueDate: taskOf(snapshot, participant.taskId)?.dueDate ?? null,
      });
    }
    return operations;
  }

  if (conflict.type === "dependency_inversion") {
    const successor = taskOf(snapshot, conflict.successorTaskId);
    const predecessor = taskOf(snapshot, conflict.predecessorTaskId);
    if (successor?.startDate != null) {
      const target = addDays(conflict.predecessorFinish, 1);
      if (target > successor.startDate) {
        const delta = diffDays(successor.startDate, target);
        // 连带平移：把下游依赖一起推，避免按下葫芦浮起瓢。
        const cascade = shiftOperation(snapshot, successor.id, delta, true);
        if (cascade !== null) operations.push(cascade);
        const single = shiftOperation(snapshot, successor.id, delta, false);
        if (single !== null) operations.push(single);
      }
    }
    if (predecessor?.startDate != null) {
      for (const days of [-2, -4]) {
        if (addDays(predecessor.startDate, days) < context.today) continue;
        const single = shiftOperation(snapshot, predecessor.id, days, false);
        if (single !== null) operations.push(single);
      }
    }
    return operations;
  }

  if (conflict.type === "overdue") {
    const task = taskOf(snapshot, conflict.taskId);
    if (task?.startDate != null && task.dueDate !== null) {
      const days = Math.max(1, diffDays(context.today, task.dueDate) + 1);
      const cascade = shiftOperation(snapshot, task.id, days, true);
      if (cascade !== null) operations.push(cascade);
    }
    return operations;
  }

  // missing_availability：人没填可用时间，算法不能替人编，只能报给用户手动补。
  return operations;
}

function operationLabel(operation: PlanOperation, context: PlanContext): string {
  const name = (userId: string) => context.memberNames.get(userId) ?? userId;
  const title = (taskId: string) => context.taskTitles.get(taskId) ?? taskId;
  switch (operation.kind) {
    case "reassign":
      return `把「${title(operation.taskId)}」整个从 ${name(operation.fromUserId)} 转给 ${name(operation.toUserId)}`;
    case "split":
      return `把「${title(operation.taskId)}」的 ${hours(operation.moveMinutes)} 从 ${name(operation.fromUserId)} 拆给 ${name(operation.toUserId)}`;
    case "extend":
      return `把「${title(operation.taskId)}」的完成日从 ${operation.previousEndDate} 延到 ${operation.newEndDate}`;
    case "shiftTask": {
      const direction = operation.days > 0 ? "推后" : "提前";
      const tail =
        operation.taskIds.length > 1
          ? `，连带 ${operation.taskIds.length - 1} 个下游任务`
          : "";
      return `把「${title(operation.taskId)}」整体${direction} ${Math.abs(operation.days)} 天（${operation.newStartDate ?? "?"} → ${operation.newDueDate ?? "?"}）${tail}`;
    }
  }
}

function planLabel(operations: PlanOperation[]): string {
  const kinds = new Set(operations.map((operation) => operation.kind));
  const parts: string[] = [];
  if (kinds.has("reassign")) parts.push("换人");
  if (kinds.has("split")) parts.push("拆分工");
  if (kinds.has("extend")) parts.push("延期");
  if (kinds.has("shiftTask")) parts.push("平移");
  return parts.length === 0 ? "无需调整" : parts.join(" + ");
}

function signature(operations: PlanOperation[]): string {
  return operations
    .map((operation) => {
      switch (operation.kind) {
        case "reassign":
          return `reassign:${operation.participantId}:${operation.toUserId}`;
        case "split":
          return `split:${operation.participantId}:${operation.toUserId}:${operation.moveMinutes}`;
        case "extend":
          return `extend:${operation.participantId}:${operation.newEndDate}`;
        case "shiftTask":
          return `shift:${operation.taskId}:${operation.days}:${operation.taskIds.length}`;
      }
    })
    .join("|");
}

export function snapshotSignature(snapshot: ScheduleSnapshot): string {
  const tasks = snapshot.tasks
    .map((task) => `${task.id}:${task.startDate}:${task.dueDate}`)
    .sort()
    .join(",");
  const participants = snapshot.participants
    .map((item) => `${item.id}:${item.userId}:${item.startDate}:${item.endDate}:${item.estimatedMinutes}`)
    .sort()
    .join(",");
  return `${tasks}#${participants}`;
}

interface SearchNode {
  snapshot: ScheduleSnapshot;
  operations: PlanOperation[];
  score: PlanScore;
}

/**
 * 有界束搜索：每层扩展 beamWidth 个最有希望的节点，深度不超过 maxSteps。
 * 一旦某层出现 0 冲突方案，就在这一层里挑代价最小的返回。
 */
function search(
  initial: ScheduleSnapshot,
  context: PlanContext,
  baselineDue: Map<string, string | null>,
  maxSteps: number,
  beamWidth: number,
  allowReassign: boolean,
): { best: SearchNode | null; solutions: SearchNode[] } {
  let frontier: SearchNode[] = [
    {
      snapshot: cloneSnapshot(initial),
      operations: [],
      score: scoreOf(initial, context, baselineDue, 0),
    },
  ];
  const seenStates = new Set<string>([snapshotSignature(initial)]);
  let best: SearchNode | null = frontier[0];
  const solutions: SearchNode[] = [];

  for (let depth = 1; depth <= maxSteps; depth += 1) {
    const expanded: SearchNode[] = [];
    for (const node of frontier) {
      const conflicts = conflictList(node.snapshot, context.today);
      if (conflicts.length === 0) continue;
      for (const conflict of conflicts.slice(0, 2)) {
        for (const operation of candidatesFor(node.snapshot, conflict, context, { allowReassign })) {
          const nextSnapshot = applyOperation(node.snapshot, operation);
          const stateKey = snapshotSignature(nextSnapshot);
          if (seenStates.has(stateKey)) continue;
          seenStates.add(stateKey);
          const operations = [...node.operations, operation];
          const score = scoreOf(nextSnapshot, context, baselineDue, operations.length);
          const next: SearchNode = { snapshot: nextSnapshot, operations, score };
          if (best === null || rank(score) < rank(best.score)) best = next;
          if (score.conflicts === 0) solutions.push(next);
          expanded.push(next);
        }
      }
    }
    if (expanded.length === 0) break;
    expanded.sort((left, right) => rank(left.score) - rank(right.score));
    frontier = expanded.slice(0, beamWidth);
    if (solutions.length > 0) break;
  }

  return { best, solutions };
}

/**
 * 贪心修复：每一步在所有候选里挑「最好的一步」，要求严格变好。
 * 便宜、能处理几十条冲突的项目；缺点是遇到「修这个会顶出那个」的局部最优会卡住。
 */
function greedyRepair(
  initial: ScheduleSnapshot,
  context: PlanContext,
  baselineDue: Map<string, string | null>,
  maxSteps: number,
  allowReassign: boolean,
): SearchNode {
  let snapshot = cloneSnapshot(initial);
  const operations: PlanOperation[] = [];
  let score = scoreOf(snapshot, context, baselineDue, 0);

  for (let step = 0; step < maxSteps; step += 1) {
    const conflicts = conflictList(snapshot, context.today);
    if (conflicts.length === 0) break;

    let best: { snapshot: ScheduleSnapshot; operation: PlanOperation; score: PlanScore } | null =
      null;
    for (const conflict of conflicts.slice(0, 3)) {
      for (const operation of candidatesFor(snapshot, conflict, context, { allowReassign })) {
        const next = applyOperation(snapshot, operation);
        const nextScore = scoreOf(next, context, baselineDue, operations.length + 1);
        if (rank(nextScore) >= rank(score)) continue;
        if (best === null || rank(nextScore) < rank(best.score)) {
          best = { snapshot: next, operation, score: nextScore };
        }
      }
    }
    if (best === null) break;
    snapshot = best.snapshot;
    operations.push(best.operation);
    score = best.score;
  }

  return { snapshot, operations, score };
}

export function planReschedules(
  snapshot: ScheduleSnapshot,
  context: PlanContext,
  options: PlanOptions = {},
): ReschedulePlan[] {
  const maxPlans = options.maxPlans ?? 3;
  const beamWidth = options.beamWidth ?? 24;
  const allowReassign = options.allowReassign ?? true;
  const baselineDue = baselineDueDates(snapshot);
  const before = scoreOf(snapshot, context, baselineDue, 0);
  const conflictCount = before.conflicts;

  // 先贪心：便宜，且对「几十条冲突」的大项目也能一步一条地推进。
  const greedyResult = greedyRepair(
    snapshot,
    context,
    baselineDue,
    options.maxSteps ?? Math.min(Math.max(conflictCount + 2, 4), 24),
    allowReassign,
  );

  const pools: SearchNode[] = [greedyResult];

  // 贪心卡住时（还有少量冲突），用束搜索尝试绕开局部最优。
  if (greedyResult.score.conflicts > 0 && greedyResult.score.conflicts <= 4) {
    const escaped = search(
      greedyResult.snapshot,
      context,
      baselineDue,
      options.maxSteps ?? 4,
      beamWidth,
      allowReassign,
    );
    for (const node of escaped.solutions) {
      pools.push({
        snapshot: node.snapshot,
        operations: [...greedyResult.operations, ...node.operations],
        score: scoreOf(
          node.snapshot,
          context,
          baselineDue,
          greedyResult.operations.length + node.operations.length,
        ),
      });
    }
    if (escaped.best !== null && escaped.best.score.conflicts < greedyResult.score.conflicts) {
      pools.push({
        snapshot: escaped.best.snapshot,
        operations: [...greedyResult.operations, ...escaped.best.operations],
        score: scoreOf(
          escaped.best.snapshot,
          context,
          baselineDue,
          greedyResult.operations.length + escaped.best.operations.length,
        ),
      });
    }
  }

  const toPlan = (node: SearchNode, index: number): ReschedulePlan => {
    const conflictsAfter = conflictList(node.snapshot, context.today);
    return {
      id: `plan-${index + 1}`,
      beforeSignature: snapshotSignature(snapshot),
      label: planLabel(node.operations),
      operations: node.operations,
      before,
      after: node.score,
      conflictsAfter,
      feasible: conflictsAfter.length === 0,
      summary:
        node.operations.length === 0
          ? "当前没有冲突，不需要调整。"
          : node.operations.map((operation) => operationLabel(operation, context)).join("；"),
    };
  };

  const unique = new Map<string, SearchNode>();
  for (const node of pools) {
    const key = signature(node.operations);
    if (!unique.has(key)) unique.set(key, node);
  }

  return [...unique.values()]
    .sort((left, right) => rank(left.score) - rank(right.score))
    .slice(0, maxPlans)
    .map(toPlan);
}
