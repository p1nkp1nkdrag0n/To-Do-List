import { addDays, daysBetween, projectDateRange, todayIso } from "../../lib/date";
import type { Milestone, Participant, Phase, Schedule, Task, WorkStatus } from "../../types";

export type GanttRowKind = "phase" | "task" | "participant" | "milestone";

export interface GanttRow {
  key: string;
  kind: GanttRowKind;
  entityId: string;
  taskId: string | null;
  label: string;
  assignee: string;
  status: WorkStatus | Participant["status"];
  progress: number | null;
  start: string | null;
  end: string | null;
  depth: number;
  color: string;
  revision: number;
}

function minDate(values: Array<string | null | undefined>): string | null {
  return values.filter((value): value is string => Boolean(value)).sort()[0] ?? null;
}

function maxDate(values: Array<string | null | undefined>): string | null {
  return values.filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
}

function phaseSummary(phase: Phase, tasks: Task[], participants: Participant[]) {
  const taskIds = new Set(tasks.filter((task) => task.phaseId === phase.id).map((task) => task.id));
  const assignments = participants.filter((participant) => taskIds.has(participant.taskId));
  const starts = [...tasks.filter((task) => taskIds.has(task.id)).map((task) => task.startDate), ...assignments.map((item) => item.startDate)];
  const ends = [...tasks.filter((task) => taskIds.has(task.id)).map((task) => task.dueDate), ...assignments.map((item) => item.endDate)];
  return { start: phase.startDate ?? minDate(starts), end: phase.endDate ?? maxDate(ends) };
}

function taskSummary(task: Task, participants: Participant[]) {
  const assignments = participants.filter((participant) => participant.taskId === task.id);
  return {
    start: task.startDate ?? minDate(assignments.map((item) => item.startDate)),
    end: task.dueDate ?? maxDate(assignments.map((item) => item.endDate)),
    progress: assignments.length === 0
      ? task.status === "done" ? 100 : 0
      : Math.round(assignments.reduce((sum, item) => sum + item.progressPercent, 0) / assignments.length),
  };
}

export function buildGanttRows(
  schedule: Schedule,
  collapsed: ReadonlySet<string>,
): GanttRow[] {
  const rows: GanttRow[] = [];
  const phases: Array<Phase | null> = [
    ...[...schedule.phases].sort((left, right) => left.position - right.position),
    ...(schedule.tasks.some((task) => task.phaseId === null) ? [null] : []),
  ];
  const milestonesByPhase = new Map<string | null, Milestone[]>();
  for (const milestone of schedule.milestones) {
    const list = milestonesByPhase.get(milestone.phaseId) ?? [];
    list.push(milestone);
    milestonesByPhase.set(milestone.phaseId, list);
  }

  const appendTask = (task: Task, depth: number) => {
    const summary = taskSummary(task, schedule.participants);
    rows.push({
      key: `task:${task.id}`,
      kind: "task",
      entityId: task.id,
      taskId: task.id,
      label: task.title,
      assignee: schedule.participants.filter((item) => item.taskId === task.id).map((item) => item.displayName).join("、") || "—",
      status: task.status,
      progress: summary.progress,
      start: summary.start,
      end: summary.end,
      depth,
      color: "#1769e0",
      revision: task.revision,
    });
    if (collapsed.has(`task:${task.id}`)) return;
    for (const participant of schedule.participants.filter((item) => item.taskId === task.id)) {
      rows.push({
        key: `participant:${participant.id}`,
        kind: "participant",
        entityId: participant.id,
        taskId: task.id,
        label: participant.displayName,
        assignee: participant.displayName,
        status: participant.status,
        progress: participant.progressPercent,
        start: participant.startDate,
        end: participant.endDate,
        depth: depth + 1,
        color: participant.color,
        revision: participant.revision,
      });
    }
    const children = schedule.tasks
      .filter((candidate) => candidate.parentId === task.id)
      .sort((left, right) => left.position - right.position);
    for (const child of children) appendTask(child, depth + 1);
  };

  for (const phase of phases) {
    const phaseKey = phase?.id ?? "unphased";
    const phaseTasks = schedule.tasks.filter((task) => task.phaseId === phase?.id || (phase === null && task.phaseId === null));
    const roots = phaseTasks
      .filter((task) => task.parentId === null || !phaseTasks.some((candidate) => candidate.id === task.parentId))
      .sort((left, right) => left.position - right.position);
    const summary = phase === null
      ? { start: minDate(phaseTasks.map((task) => task.startDate)), end: maxDate(phaseTasks.map((task) => task.dueDate)) }
      : phaseSummary(phase, schedule.tasks, schedule.participants);
    const progressValues = phaseTasks.map((task) => taskSummary(task, schedule.participants).progress);
    rows.push({
      key: `phase:${phaseKey}`,
      kind: "phase",
      entityId: phaseKey,
      taskId: null,
      label: phase?.name ?? "未分阶段",
      assignee: "—",
      status: phaseTasks.every((task) => task.status === "done") && phaseTasks.length > 0 ? "done" : phaseTasks.some((task) => task.status === "blocked") ? "blocked" : phaseTasks.some((task) => task.status !== "not_started") ? "in_progress" : "not_started",
      progress: progressValues.length ? Math.round(progressValues.reduce((sum, item) => sum + item, 0) / progressValues.length) : 0,
      start: summary.start,
      end: summary.end,
      depth: 0,
      color: "#168a4b",
      revision: phase?.revision ?? 1,
    });
    if (!collapsed.has(`phase:${phaseKey}`)) {
      roots.forEach((task) => appendTask(task, 1));
      for (const milestone of [...(milestonesByPhase.get(phase?.id ?? null) ?? [])].sort((left, right) => left.dueDate.localeCompare(right.dueDate))) {
        rows.push({
          key: `milestone:${milestone.id}`,
          kind: "milestone",
          entityId: milestone.id,
          taskId: null,
          label: milestone.title,
          assignee: "—",
          status: milestone.status,
          progress: null,
          start: milestone.dueDate,
          end: milestone.dueDate,
          depth: 1,
          color: milestone.status === "done" ? "#168a4b" : "#1769e0",
          revision: milestone.revision,
        });
      }
    }
  }
  return rows;
}

export function scheduleRange(schedule: Schedule): { start: string; end: string } {
  return projectDateRange([
    ...schedule.phases.flatMap((phase) => [phase.startDate, phase.endDate]),
    ...schedule.tasks.flatMap((task) => [task.startDate, task.dueDate]),
    ...schedule.participants.flatMap((item) => [item.startDate, item.endDate]),
    ...schedule.milestones.map((item) => item.dueDate),
  ]);
}

export function barGeometry(
  rangeStart: string,
  start: string | null,
  end: string | null,
  dayWidth: number,
): { left: number; width: number } | null {
  if (start === null || end === null) return null;
  return {
    left: daysBetween(rangeStart, start) * dayWidth + 2,
    width: Math.max(dayWidth - 4, (daysBetween(start, end) + 1) * dayWidth - 4),
  };
}

export function shiftParticipantDates(participant: Participant, offsetDays: number) {
  return {
    startDate: addDays(participant.startDate, offsetDays),
    endDate: addDays(participant.endDate, offsetDays),
  };
}

export function currentDayOffset(rangeStart: string, dayWidth: number): number {
  return daysBetween(rangeStart, todayIso()) * dayWidth + dayWidth / 2;
}
