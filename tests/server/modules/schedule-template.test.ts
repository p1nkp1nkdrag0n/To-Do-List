import { describe, expect, it } from "vitest";

import {
  BUILT_IN_TEMPLATES,
  buildTemplatePayload,
  instantiateTemplate,
  TeamTemplatePayloadSchema,
} from "../../../server/modules/schedule/templates.js";

describe("schedule templates", () => {
  it("stores relative offsets and excludes assignments, progress, and resources", () => {
    const payload = buildTemplatePayload(
      {
        phases: [
          {
            id: "phase-1",
            name: "Preparation",
            description: "Plan work",
            position: 1,
            startDate: "2026-07-20",
            endDate: "2026-07-25",
          },
        ],
        tasks: [
          {
            id: "task-1",
            phaseId: "phase-1",
            parentId: null,
            title: "Proposal",
            description: "Write it",
            position: 1,
            startDate: "2026-07-21",
            dueDate: "2026-07-24",
          },
        ],
        dependencies: [],
        milestones: [],
        deliverableRequirements: [
          {
            id: "deliverable-1",
            taskId: "task-1",
            milestoneId: null,
            title: "Proposal PDF",
            description: "Final draft",
          },
        ],
        participants: [{ userId: "private-user", estimatedMinutes: 600 }],
        progress: [{ summary: "private progress" }],
        resources: [{ title: "private file" }],
      },
      "2026-07-20",
    );

    expect(payload.phases[0]).toMatchObject({
      startOffsetDays: 0,
      endOffsetDays: 5,
    });
    expect(payload.tasks[0]).toMatchObject({
      startOffsetDays: 1,
      dueOffsetDays: 4,
    });
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("private-user");
    expect(serialized).not.toContain("private progress");
    expect(serialized).not.toContain("private file");
    expect(TeamTemplatePayloadSchema.parse(payload)).toEqual(payload);
  });

  it("applies every relative date to an explicit anchor date", () => {
    const payload = buildTemplatePayload(
      {
        phases: [
          {
            id: "phase-1",
            name: "Phase",
            description: "",
            position: 0,
            startDate: "2026-07-10",
            endDate: "2026-07-20",
          },
        ],
        tasks: [
          {
            id: "task-1",
            phaseId: "phase-1",
            parentId: null,
            title: "Task",
            description: "",
            position: 0,
            startDate: null,
            dueDate: "2026-07-31",
          },
        ],
        dependencies: [],
        milestones: [
          {
            id: "milestone-1",
            phaseId: "phase-1",
            title: "Submit",
            description: "",
            dueDate: "2026-08-01",
          },
        ],
        deliverableRequirements: [],
      },
      "2026-07-10",
    );

    const instance = instantiateTemplate(payload, "2027-02-20");
    expect(instance.phases[0]).toMatchObject({
      startDate: "2027-02-20",
      endDate: "2027-03-02",
    });
    expect(instance.tasks[0]).toMatchObject({
      startDate: null,
      dueDate: "2027-03-13",
    });
    expect(instance.milestones[0]?.dueDate).toBe("2027-03-14");
  });

  it("rejects malformed internal references", () => {
    expect(() =>
      TeamTemplatePayloadSchema.parse({
        version: 1,
        anchorSemantics: "relative_days",
        phases: [],
        tasks: [
          {
            key: "task-1",
            phaseKey: "missing-phase",
            parentKey: null,
            title: "Task",
            description: "",
            position: 0,
            startOffsetDays: null,
            dueOffsetDays: null,
          },
        ],
        dependencies: [],
        milestones: [],
        deliverableRequirements: [],
      }),
    ).toThrow(/phaseKey/i);
  });

  it("ships recognizable competition and research built-ins", () => {
    expect(BUILT_IN_TEMPLATES.map((template) => template.id)).toEqual([
      "builtin-competition",
      "builtin-research",
    ]);
    for (const template of BUILT_IN_TEMPLATES) {
      expect(TeamTemplatePayloadSchema.parse(template.payload)).toEqual(
        template.payload,
      );
      expect(template.payload.phases.length).toBeGreaterThan(1);
      expect(template.payload.tasks.length).toBeGreaterThan(1);
    }
  });
});
