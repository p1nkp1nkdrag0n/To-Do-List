import { describe, expect, it } from "vitest";

import { computeAvailabilityConflicts } from "../../../server/modules/availability/conflict-engine.js";

const PROJECT_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000002";
const PROFILE_ID = "00000000-0000-4000-8000-000000000003";

function profile(overrides: Record<string, unknown> = {}) {
  return {
    id: PROFILE_ID,
    userId: USER_ID,
    validFrom: "2026-07-20",
    validThrough: "2026-12-31",
    weeklyCapacityMinutes: 60,
    weeklySlots: [{ dayOfWeek: 1, startMinute: 540, endMinute: 600 }],
    exceptions: [],
    ...overrides,
  };
}

describe("availability conflict engine", () => {
  it("allocates remaining effort by earliest deadline instead of input order", () => {
    const earlyTaskId = "00000000-0000-4000-8000-000000000010";
    const lateTaskId = "00000000-0000-4000-8000-000000000011";
    const earlyParticipantId = "00000000-0000-4000-8000-000000000020";
    const lateParticipantId = "00000000-0000-4000-8000-000000000021";

    const conflicts = computeAvailabilityConflicts({
      projectId: PROJECT_ID,
      today: "2026-07-20",
      tasks: [
        { id: earlyTaskId, startDate: "2026-07-20", dueDate: "2026-07-20" },
        { id: lateTaskId, startDate: "2026-07-20", dueDate: "2026-07-21" },
      ],
      participants: [
        {
          id: lateParticipantId,
          taskId: lateTaskId,
          userId: USER_ID,
          startDate: "2026-07-20",
          endDate: "2026-07-21",
          estimatedMinutes: 120,
          progressPercent: 50,
        },
        {
          id: earlyParticipantId,
          taskId: earlyTaskId,
          userId: USER_ID,
          startDate: "2026-07-20",
          endDate: "2026-07-20",
          estimatedMinutes: 60,
          progressPercent: 0,
        },
      ],
      dependencies: [],
      profiles: [profile()],
    });

    expect(conflicts).toEqual([
      {
        type: "unallocated_effort",
        severity: "red",
        participantId: lateParticipantId,
        taskId: lateTaskId,
        userId: USER_ID,
        unallocatedMinutes: 60,
      },
    ]);
  });

  it("unions available exceptions, subtracts unavailable exceptions, and resets weekly caps", () => {
    const mondayTask = "00000000-0000-4000-8000-000000000030";
    const tuesdayTask = "00000000-0000-4000-8000-000000000031";
    const nextMondayTask = "00000000-0000-4000-8000-000000000032";
    const mondayParticipant = "00000000-0000-4000-8000-000000000040";
    const tuesdayParticipant = "00000000-0000-4000-8000-000000000041";
    const nextMondayParticipant = "00000000-0000-4000-8000-000000000042";

    const conflicts = computeAvailabilityConflicts({
      projectId: PROJECT_ID,
      today: "2026-07-20",
      tasks: [
        { id: mondayTask, startDate: "2026-07-20", dueDate: "2026-07-20" },
        { id: tuesdayTask, startDate: "2026-07-21", dueDate: "2026-07-21" },
        { id: nextMondayTask, startDate: "2026-07-27", dueDate: "2026-07-27" },
      ],
      participants: [
        { id: mondayParticipant, taskId: mondayTask, userId: USER_ID, startDate: "2026-07-20", endDate: "2026-07-20", estimatedMinutes: 90, progressPercent: 0 },
        { id: tuesdayParticipant, taskId: tuesdayTask, userId: USER_ID, startDate: "2026-07-21", endDate: "2026-07-21", estimatedMinutes: 60, progressPercent: 0 },
        { id: nextMondayParticipant, taskId: nextMondayTask, userId: USER_ID, startDate: "2026-07-27", endDate: "2026-07-27", estimatedMinutes: 90, progressPercent: 0 },
      ],
      dependencies: [],
      profiles: [
        profile({
          weeklyCapacityMinutes: 150,
          weeklySlots: [{ dayOfWeek: 1, startMinute: 540, endMinute: 660 }],
          exceptions: [
            { exceptionDate: "2026-07-20", kind: "unavailable", startMinute: 570, endMinute: 600 },
            { exceptionDate: "2026-07-21", kind: "available", startMinute: 540, endMinute: 600 },
            { exceptionDate: "2026-07-27", kind: "unavailable", startMinute: 570, endMinute: 600 },
          ],
        }),
      ],
    });

    expect(conflicts).toEqual([]);
  });

  it("does not reset a weekly cap when semester profiles switch midweek", () => {
    const mondayTask = "00000000-0000-4000-8000-000000000070";
    const thursdayTask = "00000000-0000-4000-8000-000000000071";
    const mondayParticipant = "00000000-0000-4000-8000-000000000072";
    const thursdayParticipant = "00000000-0000-4000-8000-000000000073";

    const conflicts = computeAvailabilityConflicts({
      projectId: PROJECT_ID,
      today: "2026-07-20",
      tasks: [
        { id: mondayTask, startDate: "2026-07-20", dueDate: "2026-07-20" },
        { id: thursdayTask, startDate: "2026-07-23", dueDate: "2026-07-23" },
      ],
      participants: [
        { id: mondayParticipant, taskId: mondayTask, userId: USER_ID, startDate: "2026-07-20", endDate: "2026-07-20", estimatedMinutes: 60, progressPercent: 0 },
        { id: thursdayParticipant, taskId: thursdayTask, userId: USER_ID, startDate: "2026-07-23", endDate: "2026-07-23", estimatedMinutes: 60, progressPercent: 0 },
      ],
      dependencies: [],
      profiles: [
        profile({
          validThrough: "2026-07-22",
          weeklyCapacityMinutes: 60,
        }),
        profile({
          id: "00000000-0000-4000-8000-000000000074",
          validFrom: "2026-07-23",
          weeklyCapacityMinutes: 60,
          weeklySlots: [{ dayOfWeek: 4, startMinute: 540, endMinute: 600 }],
        }),
      ],
    });

    expect(conflicts).toEqual([
      expect.objectContaining({
        type: "unallocated_effort",
        participantId: thursdayParticipant,
        unallocatedMinutes: 60,
      }),
    ]);
  });

  it("reports rounded unallocated effort, overdue work, and a missing profile", () => {
    const taskId = "00000000-0000-4000-8000-000000000050";
    const participantId = "00000000-0000-4000-8000-000000000051";
    const completedId = "00000000-0000-4000-8000-000000000052";

    const conflicts = computeAvailabilityConflicts({
      projectId: PROJECT_ID,
      today: "2026-07-20",
      tasks: [{ id: taskId, startDate: "2026-07-18", dueDate: "2026-07-19" }],
      participants: [
        { id: participantId, taskId, userId: USER_ID, startDate: "2026-07-18", endDate: "2026-07-19", estimatedMinutes: 61, progressPercent: 50 },
        { id: completedId, taskId, userId: USER_ID, startDate: "2026-07-18", endDate: "2026-07-19", estimatedMinutes: 600, progressPercent: 100 },
      ],
      dependencies: [],
      profiles: [],
    });

    expect(conflicts).toEqual([
      { type: "overdue", severity: "red", participantId, taskId, userId: USER_ID, deadline: "2026-07-19" },
      { type: "missing_availability", severity: "red", participantId, taskId, userId: USER_ID },
      { type: "unallocated_effort", severity: "red", participantId, taskId, userId: USER_ID, unallocatedMinutes: 31 },
    ]);
  });

  it("treats past-only profiles as missing for the remaining allocation window", () => {
    const taskId = "00000000-0000-4000-8000-000000000080";
    const participantId = "00000000-0000-4000-8000-000000000081";

    const conflicts = computeAvailabilityConflicts({
      projectId: PROJECT_ID,
      today: "2026-07-20",
      tasks: [{ id: taskId, startDate: "2026-07-18", dueDate: "2026-07-21" }],
      participants: [
        { id: participantId, taskId, userId: USER_ID, startDate: "2026-07-18", endDate: "2026-07-21", estimatedMinutes: 30, progressPercent: 0 },
      ],
      dependencies: [],
      profiles: [
        profile({ validFrom: "2026-07-18", validThrough: "2026-07-19" }),
      ],
    });

    expect(conflicts).toEqual([
      { type: "missing_availability", severity: "red", participantId, taskId, userId: USER_ID },
      { type: "unallocated_effort", severity: "red", participantId, taskId, userId: USER_ID, unallocatedMinutes: 30 },
    ]);
  });

  it("reports finish-to-start dependency inversions from task and assignment dates", () => {
    const predecessorTaskId = "00000000-0000-4000-8000-000000000060";
    const successorTaskId = "00000000-0000-4000-8000-000000000061";
    const dependencyId = "00000000-0000-4000-8000-000000000062";

    const conflicts = computeAvailabilityConflicts({
      projectId: PROJECT_ID,
      today: "2026-07-20",
      tasks: [
        { id: predecessorTaskId, startDate: "2026-07-20", dueDate: "2026-07-24" },
        { id: successorTaskId, startDate: "2026-07-25", dueDate: "2026-07-30" },
      ],
      participants: [
        { id: "00000000-0000-4000-8000-000000000063", taskId: predecessorTaskId, userId: USER_ID, startDate: "2026-07-20", endDate: "2026-07-25", estimatedMinutes: 0, progressPercent: 100 },
        { id: "00000000-0000-4000-8000-000000000064", taskId: successorTaskId, userId: USER_ID, startDate: "2026-07-25", endDate: "2026-07-30", estimatedMinutes: 0, progressPercent: 100 },
      ],
      dependencies: [{ id: dependencyId, predecessorTaskId, successorTaskId }],
      profiles: [],
    });

    expect(conflicts).toEqual([
      {
        type: "dependency_inversion",
        severity: "red",
        dependencyId,
        predecessorTaskId,
        successorTaskId,
        predecessorFinish: "2026-07-25",
        successorStart: "2026-07-25",
      },
    ]);
  });
});
