/**
 * 重排算法（`server/mcp/reschedule.ts`）的独立单测。
 *
 * 全部用假数据：算法是纯函数，不碰数据库、不碰真实项目。
 * 唯一的外部依赖是冲突引擎（`computeAvailabilityConflicts`），
 * 所以这里的断言都是「引擎怎么判，算法就得怎么改」。
 */
import { describe, expect, it } from "vitest";

import type {
  ConflictAvailabilityProfile,
  ConflictDependency,
  ConflictParticipant,
  ConflictTask,
} from "../../../server/modules/availability/conflict-engine.js";
import {
  planReschedules,
  type PlanContext,
  type ScheduleSnapshot,
} from "../../../server/mcp/reschedule.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
/** 固定「今天」，避免测试跟随真实日期漂移。 */
const TODAY = "2026-10-22";

function dateAt(milliseconds: number): string {
  return new Date(milliseconds).toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  return dateAt(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS);
}

function dayOfWeek(date: string): number {
  return new Date(`${date}T00:00:00.000Z`).getUTCDay();
}

function everyDay(startMinute: number, endMinute: number) {
  return Array.from({ length: 7 }, (_, day) => ({
    dayOfWeek: day,
    startMinute,
    endMinute,
  }));
}

function makeProfile(
  userId: string,
  options: {
    weeklyCapacityMinutes: number;
    slots: Array<{ dayOfWeek: number; startMinute: number; endMinute: number }>;
    exceptions?: ConflictAvailabilityProfile["exceptions"];
  },
): ConflictAvailabilityProfile {
  return {
    id: `profile:${userId}`,
    userId,
    validFrom: addDays(TODAY, -7),
    validThrough: addDays(TODAY, 60),
    weeklyCapacityMinutes: options.weeklyCapacityMinutes,
    weeklySlots: options.slots,
    exceptions: options.exceptions ?? [],
  };
}

function makeTask(id: string, startDate: string, dueDate: string): ConflictTask {
  return { id, startDate, dueDate };
}

function makeParticipant(options: {
  id: string;
  taskId: string;
  userId: string;
  startDate: string;
  endDate: string;
  estimatedMinutes: number;
}): ConflictParticipant {
  return { ...options, progressPercent: 0 };
}

function makeContext(
  members: Array<[userId: string, name: string]>,
  tasks: Array<[taskId: string, title: string]>,
  projectEndDate: string | null = addDays(TODAY, 60),
): PlanContext {
  return {
    today: TODAY,
    memberIds: members.map(([userId]) => userId),
    memberNames: new Map(members),
    taskTitles: new Map(tasks),
    projectEndDate,
  };
}

describe("planReschedules · 无需调整", () => {
  it("没有冲突时只返回一个空方案", () => {
    const snapshot: ScheduleSnapshot = {
      tasks: [makeTask("t1", TODAY, addDays(TODAY, 3))],
      participants: [
        makeParticipant({
          id: "p1",
          taskId: "t1",
          userId: "u1",
          startDate: TODAY,
          endDate: addDays(TODAY, 3),
          estimatedMinutes: 120,
        }),
      ],
      dependencies: [],
      profiles: [makeProfile("u1", { weeklyCapacityMinutes: 1_680, slots: everyDay(1_140, 1_380) })],
    };
    const context = makeContext([["u1", "邱业恒"]], [["t1", "脚本定稿"]]);

    const plans = planReschedules(snapshot, context);

    expect(plans).toHaveLength(1);
    expect(plans[0]!.operations).toEqual([]);
    expect(plans[0]!.feasible).toBe(true);
    expect(plans[0]!.after.conflicts).toBe(0);
    expect(plans[0]!.summary).toContain("不需要调整");
  });
});

describe("planReschedules · 单人超载", () => {
  /** 张工只有今天 2h 可用，任务却要 10h；李工每天都有空。 */
  function overloadedSnapshot(): ScheduleSnapshot {
    const slotDay = dayOfWeek(TODAY);
    return {
      tasks: [makeTask("t2", TODAY, TODAY)],
      participants: [
        makeParticipant({
          id: "p2",
          taskId: "t2",
          userId: "backend",
          startDate: TODAY,
          endDate: TODAY,
          estimatedMinutes: 600,
        }),
      ],
      dependencies: [],
      profiles: [
        makeProfile("backend", {
          weeklyCapacityMinutes: 240,
          slots: [{ dayOfWeek: slotDay, startMinute: 1_140, endMinute: 1_260 }],
        }),
        makeProfile("qa", { weeklyCapacityMinutes: 1_680, slots: everyDay(1_140, 1_380) }),
      ],
    };
  }

  const context = makeContext(
    [
      ["backend", "张工"],
      ["qa", "李工"],
    ],
    [["t2", "接口联调"]],
  );

  it("能找到 0 冲突的可行方案，且动作是拆分/换人", () => {
    const plans = planReschedules(overloadedSnapshot(), context);

    const feasible = plans.find((plan) => plan.feasible);
    expect(feasible).toBeDefined();
    expect(feasible!.after.conflicts).toBe(0);
    expect(feasible!.operations.length).toBeGreaterThan(0);

    const kinds = feasible!.operations.map((operation) => operation.kind);
    expect(kinds.some((kind) => kind === "split" || kind === "reassign")).toBe(true);

    const targeted = feasible!.operations.find(
      (operation) => operation.kind === "split" || operation.kind === "reassign",
    );
    if (targeted?.kind === "split" || targeted?.kind === "reassign") {
      expect(targeted.toUserId).toBe("qa");
    }
  });

  it("把缺口换算成可以念给人听的摘要", () => {
    const plans = planReschedules(overloadedSnapshot(), context);
    const feasible = plans.find((plan) => plan.feasible)!;

    expect(feasible.summary).toContain("接口联调");
    expect(feasible.summary).toContain("张工");
    expect(feasible.summary).toContain("李工");
  });

  it("同一输入跑两次，方案完全一致", () => {
    const first = planReschedules(overloadedSnapshot(), context);
    const second = planReschedules(overloadedSnapshot(), context);

    expect(JSON.stringify(first[0]!.operations)).toBe(JSON.stringify(second[0]!.operations));
    expect(JSON.stringify(first[0]!.after)).toBe(JSON.stringify(second[0]!.after));
  });
});

describe("planReschedules · 依赖倒挂", () => {
  it("把后置任务推到前置结束之后，并且连带下游", () => {
    const predecessorDue = addDays(TODAY, 2);
    const successorStart = addDays(TODAY, 1);

    const snapshot: ScheduleSnapshot = {
      tasks: [
        makeTask("pred", TODAY, predecessorDue),
        makeTask("succ", successorStart, addDays(TODAY, 5)),
      ],
      participants: [
        makeParticipant({
          id: "p-pred",
          taskId: "pred",
          userId: "u1",
          startDate: TODAY,
          endDate: predecessorDue,
          estimatedMinutes: 240,
        }),
        makeParticipant({
          id: "p-succ",
          taskId: "succ",
          userId: "u1",
          startDate: successorStart,
          endDate: addDays(TODAY, 5),
          estimatedMinutes: 240,
        }),
      ],
      dependencies: [
        { id: "d1", predecessorTaskId: "pred", successorTaskId: "succ" } as ConflictDependency,
      ],
      profiles: [makeProfile("u1", { weeklyCapacityMinutes: 1_680, slots: everyDay(1_140, 1_380) })],
    };
    const context = makeContext([["u1", "邱业恒"]], [
      ["pred", "接口联调"],
      ["succ", "甘特图联调"],
    ]);

    const plans = planReschedules(snapshot, context);
    const feasible = plans.find((plan) => plan.feasible);

    expect(feasible).toBeDefined();
    expect(feasible!.operations.length).toBeGreaterThan(0);

    const shift = feasible!.operations.find((operation) => operation.kind === "shiftTask");
    expect(shift).toBeDefined();
    if (shift?.kind === "shiftTask") {
      expect(shift.days).toBeGreaterThan(0);
      expect(shift.newStartDate! > predecessorDue).toBe(true);
      // 连带平移：下游任务一起挪，不然会按下葫芦浮起瓢。
      expect(shift.taskIds).toContain("succ");
    }

    expect(feasible!.conflictsAfter).toHaveLength(0);
  });
});

describe("planReschedules · 不要把活推给已经超载的人", () => {
  it("拆分目标只落在健康成员身上", () => {
    // 张工、李工各自只有 2h 可用，却各背 4h 的活；王工有空。
    const slotDay = dayOfWeek(TODAY);
    const snapshot: ScheduleSnapshot = {
      tasks: [makeTask("ta", TODAY, TODAY), makeTask("tb", TODAY, TODAY)],
      participants: [
        makeParticipant({
          id: "pa",
          taskId: "ta",
          userId: "backend",
          startDate: TODAY,
          endDate: TODAY,
          estimatedMinutes: 240,
        }),
        makeParticipant({
          id: "pb",
          taskId: "tb",
          userId: "qa",
          startDate: TODAY,
          endDate: TODAY,
          estimatedMinutes: 240,
        }),
      ],
      dependencies: [],
      profiles: [
        makeProfile("backend", {
          weeklyCapacityMinutes: 120,
          slots: [{ dayOfWeek: slotDay, startMinute: 1_140, endMinute: 1_260 }],
        }),
        makeProfile("qa", {
          weeklyCapacityMinutes: 120,
          slots: [{ dayOfWeek: slotDay, startMinute: 1_140, endMinute: 1_260 }],
        }),
        makeProfile("lead", { weeklyCapacityMinutes: 1_680, slots: everyDay(1_140, 1_380) }),
      ],
    };
    const context = makeContext(
      [
        ["backend", "张工"],
        ["qa", "李工"],
        ["lead", "邱业恒"],
      ],
      [
        ["ta", "接口联调"],
        ["tb", "甘特图联调"],
      ],
    );

    const plans = planReschedules(snapshot, context);
    const feasible = plans.find((plan) => plan.feasible);
    expect(feasible).toBeDefined();

    // 先确认这颗雷真的埋住了：两个人各缺 2h。
    expect(feasible!.before.conflicts).toBe(2);

    // 李工本来就是超载的人，任何动作都不该把活再堆给他。
    for (const operation of feasible!.operations) {
      if (operation.kind === "split" || operation.kind === "reassign") {
        expect(operation.toUserId).not.toBe("qa");
      }
    }
  });
});

describe("planReschedules · 规模与性能", () => {
  it("30 个任务 / 8 个成员 / 若干依赖：1.5 秒内返回，且不会越修越糟", () => {
    const members = Array.from({ length: 8 }, (_, index) => `m${index}`);
    const tasks: ConflictTask[] = [];
    const participants: ConflictParticipant[] = [];
    const dependencies: ConflictDependency[] = [];

    for (let index = 0; index < 30; index += 1) {
      const start = addDays(TODAY, index % 5);
      tasks.push(makeTask(`t${index}`, start, addDays(start, 3)));
      participants.push(
        makeParticipant({
          id: `p${index}`,
          taskId: `t${index}`,
          userId: members[index % members.length]!,
          startDate: start,
          endDate: addDays(start, 3),
          estimatedMinutes: 180,
        }),
      );
    }
    // 每 7 个任务插一条依赖，并且故意让后置任务早于前置结束 → 4 条倒挂
    for (let index = 0; index < 28; index += 7) {
      dependencies.push({
        id: `d${index}`,
        predecessorTaskId: `t${index}`,
        successorTaskId: `t${index + 1}`,
      });
    }

    const snapshot: ScheduleSnapshot = {
      tasks,
      participants,
      dependencies,
      profiles: members.map((userId) =>
        makeProfile(userId, { weeklyCapacityMinutes: 1_680, slots: everyDay(1_140, 1_380) }),
      ),
    };
    const context = makeContext(
      members.map((userId) => [userId, `成员${userId}`]),
      tasks.map((task) => [task.id, `任务${task.id}`]),
    );

    const started = performance.now();
    const plans = planReschedules(snapshot, context);
    const elapsed = performance.now() - started;

    expect(plans.length).toBeGreaterThan(0);
    expect(plans[0]!.before.conflicts).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(1_500);
    for (const plan of plans) {
      expect(plan.after.conflicts).toBeLessThanOrEqual(plan.before.conflicts);
    }
  });
});
