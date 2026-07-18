import type {
  ScheduleConflict,
  WeeklyAvailabilitySlot,
} from "../../../shared/availability-contracts.js";

export interface ConflictTask {
  id: string;
  startDate: string | null;
  dueDate: string | null;
}

export interface ConflictParticipant {
  id: string;
  taskId: string;
  userId: string;
  startDate: string;
  endDate: string;
  estimatedMinutes: number;
  progressPercent: number;
}

export interface ConflictDependency {
  id: string;
  predecessorTaskId: string;
  successorTaskId: string;
}

export interface ConflictAvailabilityException {
  exceptionDate: string;
  kind: "available" | "unavailable";
  startMinute: number;
  endMinute: number;
}

export interface ConflictAvailabilityProfile {
  id: string;
  userId: string;
  validFrom: string;
  validThrough: string;
  weeklyCapacityMinutes: number;
  weeklySlots: WeeklyAvailabilitySlot[];
  exceptions: ConflictAvailabilityException[];
}

export interface AvailabilityConflictInput {
  projectId: string;
  today: string;
  tasks: ConflictTask[];
  participants: ConflictParticipant[];
  dependencies: ConflictDependency[];
  profiles: ConflictAvailabilityProfile[];
}

const DAY_MILLISECONDS = 24 * 60 * 60 * 1_000;

function dateMilliseconds(value: string): number {
  return Date.parse(`${value}T00:00:00.000Z`);
}

function dateAt(milliseconds: number): string {
  return new Date(milliseconds).toISOString().slice(0, 10);
}

function eachDate(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  for (
    let cursor = dateMilliseconds(startDate);
    cursor <= dateMilliseconds(endDate);
    cursor += DAY_MILLISECONDS
  ) {
    dates.push(dateAt(cursor));
  }
  return dates;
}

function weekStart(date: string): string {
  const timestamp = dateMilliseconds(date);
  const dayOfWeek = new Date(timestamp).getUTCDay();
  const daysSinceMonday = (dayOfWeek + 6) % 7;
  return dateAt(timestamp - daysSinceMonday * DAY_MILLISECONDS);
}

function addInterval(blocks: Set<number>, startMinute: number, endMinute: number): void {
  for (let minute = startMinute; minute < endMinute; minute += 30) {
    blocks.add(minute);
  }
}

function removeInterval(
  blocks: Set<number>,
  startMinute: number,
  endMinute: number,
): void {
  for (let minute = startMinute; minute < endMinute; minute += 30) {
    blocks.delete(minute);
  }
}

function availableBlocks(
  profile: ConflictAvailabilityProfile,
  date: string,
): number[] {
  const blocks = new Set<number>();
  const dayOfWeek = new Date(dateMilliseconds(date)).getUTCDay();
  for (const slot of profile.weeklySlots) {
    if (slot.dayOfWeek === dayOfWeek) {
      addInterval(blocks, slot.startMinute, slot.endMinute);
    }
  }
  for (const exception of profile.exceptions) {
    if (exception.exceptionDate === date && exception.kind === "available") {
      addInterval(blocks, exception.startMinute, exception.endMinute);
    }
  }
  for (const exception of profile.exceptions) {
    if (exception.exceptionDate === date && exception.kind === "unavailable") {
      removeInterval(blocks, exception.startMinute, exception.endMinute);
    }
  }
  return [...blocks].sort((left, right) => left - right);
}

function remainingMinutes(participant: ConflictParticipant): number {
  return Math.max(
    0,
    Math.ceil(
      (participant.estimatedMinutes * (100 - participant.progressPercent)) / 100,
    ),
  );
}

function latest(values: Array<string | null | undefined>): string | null {
  return values
    .filter((value): value is string => value !== null && value !== undefined)
    .sort()
    .at(-1) ?? null;
}

function earliest(values: Array<string | null | undefined>): string | null {
  return values
    .filter((value): value is string => value !== null && value !== undefined)
    .sort()
    .at(0) ?? null;
}

export function computeAvailabilityConflicts(
  input: AvailabilityConflictInput,
): ScheduleConflict[] {
  const conflicts: ScheduleConflict[] = [];
  const profilesByUser = new Map<string, ConflictAvailabilityProfile[]>();
  for (const profile of input.profiles) {
    const profiles = profilesByUser.get(profile.userId) ?? [];
    profiles.push(profile);
    profilesByUser.set(profile.userId, profiles);
  }
  for (const profiles of profilesByUser.values()) {
    profiles.sort((left, right) =>
      left.validFrom.localeCompare(right.validFrom) || left.id.localeCompare(right.id),
    );
  }

  const usedBlockMinutes = new Map<string, number>();
  const usedWeeklyMinutes = new Map<string, number>();
  const orderedParticipants = [...input.participants].sort((left, right) =>
    left.endDate.localeCompare(right.endDate) || left.id.localeCompare(right.id),
  );

  for (const participant of orderedParticipants) {
    let unallocatedMinutes = remainingMinutes(participant);
    if (unallocatedMinutes === 0) continue;

    const participantFields = {
      severity: "red" as const,
      participantId: participant.id,
      taskId: participant.taskId,
      userId: participant.userId,
    };
    if (participant.endDate < input.today) {
      conflicts.push({
        type: "overdue",
        ...participantFields,
        deadline: participant.endDate,
      });
    }

    const userProfiles = profilesByUser.get(participant.userId) ?? [];
    const allocationStart =
      participant.startDate > input.today ? participant.startDate : input.today;
    const coverageStart = allocationStart <= participant.endDate
      ? allocationStart
      : participant.startDate;
    const hasProfileCoverage = userProfiles.some(
      (profile) =>
        profile.validFrom <= participant.endDate &&
        profile.validThrough >= coverageStart,
    );
    if (!hasProfileCoverage) {
      conflicts.push({ type: "missing_availability", ...participantFields });
    }

    if (allocationStart <= participant.endDate) {
      for (const date of eachDate(allocationStart, participant.endDate)) {
        if (unallocatedMinutes === 0) break;
        const profile = userProfiles.find(
          (candidate) =>
            candidate.validFrom <= date && candidate.validThrough >= date,
        );
        if (profile === undefined) continue;
        const weeklyKey = `${participant.userId}\u0000${weekStart(date)}`;
        for (const blockStart of availableBlocks(profile, date)) {
          if (unallocatedMinutes === 0) break;
          const blockKey = `${participant.userId}\u0000${date}\u0000${blockStart}`;
          const blockRemaining = 30 - (usedBlockMinutes.get(blockKey) ?? 0);
          const weeklyRemaining =
            profile.weeklyCapacityMinutes -
            (usedWeeklyMinutes.get(weeklyKey) ?? 0);
          const allocated = Math.min(
            unallocatedMinutes,
            blockRemaining,
            weeklyRemaining,
          );
          if (allocated <= 0) continue;
          usedBlockMinutes.set(
            blockKey,
            (usedBlockMinutes.get(blockKey) ?? 0) + allocated,
          );
          usedWeeklyMinutes.set(
            weeklyKey,
            (usedWeeklyMinutes.get(weeklyKey) ?? 0) + allocated,
          );
          unallocatedMinutes -= allocated;
        }
      }
    }
    if (unallocatedMinutes > 0) {
      conflicts.push({
        type: "unallocated_effort",
        ...participantFields,
        unallocatedMinutes,
      });
    }
  }

  const taskById = new Map(input.tasks.map((task) => [task.id, task]));
  const participantsByTask = new Map<string, ConflictParticipant[]>();
  for (const participant of input.participants) {
    const participants = participantsByTask.get(participant.taskId) ?? [];
    participants.push(participant);
    participantsByTask.set(participant.taskId, participants);
  }
  for (const dependency of input.dependencies) {
    const predecessor = taskById.get(dependency.predecessorTaskId);
    const successor = taskById.get(dependency.successorTaskId);
    if (predecessor === undefined || successor === undefined) continue;
    const predecessorFinish = latest([
      predecessor.dueDate,
      ...(participantsByTask.get(predecessor.id) ?? []).map(({ endDate }) => endDate),
    ]);
    const successorStart = earliest([
      successor.startDate,
      ...(participantsByTask.get(successor.id) ?? []).map(({ startDate }) => startDate),
    ]);
    if (
      predecessorFinish !== null &&
      successorStart !== null &&
      successorStart <= predecessorFinish
    ) {
      conflicts.push({
        type: "dependency_inversion",
        severity: "red",
        dependencyId: dependency.id,
        predecessorTaskId: dependency.predecessorTaskId,
        successorTaskId: dependency.successorTaskId,
        predecessorFinish,
        successorStart,
      });
    }
  }

  return conflicts;
}
