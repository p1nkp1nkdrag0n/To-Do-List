const WEEKDAY_NAMES = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

interface RecurringPattern {
  frequency: "weekly" | "monthly";
  intervalCount: number;
  dayOfWeek: number | null;
  dayOfMonth: number | null;
}

interface TemplateStructure {
  phases: readonly unknown[];
  tasks: readonly unknown[];
  dependencies: readonly unknown[];
  milestones: readonly unknown[];
  deliverableRequirements: readonly unknown[];
}

export function formatRecurringPattern(rule: RecurringPattern): string {
  if (rule.frequency === "weekly") {
    return `每 ${rule.intervalCount} 周 · ${WEEKDAY_NAMES[rule.dayOfWeek ?? 0]}`;
  }
  return `每 ${rule.intervalCount} 月 · ${rule.dayOfMonth ?? 1} 日`;
}

export function templateStructureSummary(payload: TemplateStructure): string {
  return [
    `${payload.phases.length} 阶段`,
    `${payload.tasks.length} 任务`,
    `${payload.dependencies.length} 依赖`,
    `${payload.milestones.length} 里程碑`,
    `${payload.deliverableRequirements.length} 交付要求`,
  ].join(" · ");
}
