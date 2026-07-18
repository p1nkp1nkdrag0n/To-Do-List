import { describe, expect, it } from "vitest";

import {
  ApplyTemplateRequestSchema,
  CreateDeliverableRequestSchema,
  CreateDependencyRequestSchema,
  CreateMilestoneRequestSchema,
  CreateParticipantRequestSchema,
  CreatePhaseRequestSchema,
  CreateRecurringRuleRequestSchema,
  CreateTaskRequestSchema,
  GenerateRecurringRuleRequestSchema,
  PatchDeliverableRequestSchema,
  PatchMilestoneRequestSchema,
  PatchParticipantRequestSchema,
  PatchPhaseRequestSchema,
  PatchRecurringRuleRequestSchema,
  PatchTaskRequestSchema,
  ProgressUpdateRequestSchema,
  SaveTeamTemplateRequestSchema,
  UpdateTeamTemplateRequestSchema,
} from "../../shared/schedule-contracts.js";

const ID = "00000000-0000-4000-8000-000000000001";

describe("schedule request contracts", () => {
  it("requires positive participant effort and an ordered date window", () => {
    expect(
      CreateParticipantRequestSchema.safeParse({
        userId: ID,
        startDate: "2026-07-20",
        endDate: "2026-07-19",
        estimatedMinutes: 0,
      }).success,
    ).toBe(false);
    expect(
      CreateParticipantRequestSchema.parse({
        userId: ID,
        startDate: "2026-07-20",
        endDate: "2026-07-20",
        estimatedMinutes: 30,
      }),
    ).toMatchObject({ estimatedMinutes: 30 });
  });

  it("does not accept client-owned task status", () => {
    expect(
      CreateTaskRequestSchema.safeParse({ title: "Task", status: "done" })
        .success,
    ).toBe(false);
  });

  it("requires a real phase patch in addition to expected revision", () => {
    expect(PatchPhaseRequestSchema.safeParse({ expectedRevision: 1 }).success).toBe(
      false,
    );
  });

  it("validates frequency-specific recurrence fields", () => {
    expect(
      CreateRecurringRuleRequestSchema.safeParse({
        sourceTaskId: ID,
        frequency: "weekly",
        intervalCount: 1,
        dayOfMonth: 10,
        startsOn: "2026-07-20",
      }).success,
    ).toBe(false);
    expect(
      CreateRecurringRuleRequestSchema.safeParse({
        sourceTaskId: ID,
        frequency: "monthly",
        intervalCount: 1,
        dayOfMonth: 31,
        startsOn: "2026-07-20",
      }).success,
    ).toBe(true);
  });

  it("accepts immutable progress content with participant revision", () => {
    expect(
      ProgressUpdateRequestSchema.parse({
        participantExpectedRevision: 2,
        completionPercent: 60,
        summary: "Completed the first experiment.",
        blockers: "",
        nextSteps: "Run the second experiment.",
      }),
    ).toMatchObject({ completionPercent: 60 });
  });

  it("parses every schedule command with strict revisioned payloads", () => {
    expect(CreatePhaseRequestSchema.parse({ name: "Phase" }).name).toBe("Phase");
    expect(
      PatchTaskRequestSchema.parse({ expectedRevision: 1, title: "Renamed" }),
    ).toMatchObject({ expectedRevision: 1 });
    expect(
      PatchParticipantRequestSchema.parse({
        expectedRevision: 1,
        estimatedMinutes: 90,
      }),
    ).toMatchObject({ estimatedMinutes: 90 });
    expect(
      CreateDependencyRequestSchema.parse({ predecessorTaskId: ID }),
    ).toEqual({ predecessorTaskId: ID });
    expect(
      CreateMilestoneRequestSchema.parse({
        title: "Submit",
        dueDate: "2026-08-01",
      }),
    ).toMatchObject({ title: "Submit" });
    expect(
      PatchMilestoneRequestSchema.parse({
        expectedRevision: 1,
        dueDate: "2026-08-02",
      }),
    ).toMatchObject({ expectedRevision: 1 });
    expect(CreateDeliverableRequestSchema.parse({ title: "PDF" })).toEqual({
      title: "PDF",
    });
    expect(
      PatchDeliverableRequestSchema.parse({
        expectedRevision: 1,
        description: "Signed copy",
      }),
    ).toMatchObject({ expectedRevision: 1 });
    expect(
      PatchRecurringRuleRequestSchema.parse({
        expectedRevision: 1,
        isActive: false,
      }),
    ).toMatchObject({ isActive: false });
    expect(
      GenerateRecurringRuleRequestSchema.parse({ expectedRevision: 1, throughDate: "2026-12-31" }),
    ).toEqual({ expectedRevision: 1, throughDate: "2026-12-31" });
    expect(
      SaveTeamTemplateRequestSchema.parse({
        name: "Our process",
        anchorDate: "2026-07-20",
      }),
    ).toMatchObject({ name: "Our process" });
    expect(
      UpdateTeamTemplateRequestSchema.parse({
        expectedRevision: 1,
        name: "Updated process",
      }),
    ).toMatchObject({ expectedRevision: 1 });
    expect(
      ApplyTemplateRequestSchema.parse({ anchorDate: "2026-07-20" }),
    ).toEqual({ anchorDate: "2026-07-20" });
  });
});
