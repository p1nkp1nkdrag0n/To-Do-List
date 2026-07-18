import { describe, expect, it } from "vitest";

import {
  formatRecurringPattern,
  templateStructureSummary,
} from "../../src/features/gantt/schedule-tools-model.js";

describe("schedule tools presentation model", () => {
  it("formats weekly and monthly recurrence for a compact team workflow", () => {
    expect(formatRecurringPattern({ frequency: "weekly", intervalCount: 2, dayOfWeek: 1, dayOfMonth: null })).toBe("每 2 周 · 周一");
    expect(formatRecurringPattern({ frequency: "monthly", intervalCount: 1, dayOfWeek: null, dayOfMonth: 15 })).toBe("每 1 月 · 15 日");
  });

  it("summarizes the reusable structure without members or progress", () => {
    expect(templateStructureSummary({
      phases: [{}, {}],
      tasks: [{}, {}, {}],
      dependencies: [{}],
      milestones: [{}],
      deliverableRequirements: [{}, {}],
    })).toBe("2 阶段 · 3 任务 · 1 依赖 · 1 里程碑 · 2 交付要求");
  });
});
