import type {
  ParticipantStatus,
  TaskStatus,
} from "../../../shared/contracts.js";

export interface TaskStatusInput {
  reviewed: boolean;
  participantStatuses: readonly ParticipantStatus[];
  childStatuses: readonly TaskStatus[];
  requiredDeliverablesFulfilled: boolean;
}

export function aggregateTaskStatus(input: TaskStatusInput): TaskStatus {
  if (input.reviewed) {
    return "done";
  }

  const responsibilityStatuses = [
    ...input.participantStatuses,
    ...input.childStatuses,
  ];
  if (responsibilityStatuses.some((status) => status === "blocked")) {
    return "blocked";
  }

  const hasResponsibility = responsibilityStatuses.length > 0;
  const everyResponsibilityDone =
    input.participantStatuses.every((status) => status === "done") &&
    input.childStatuses.every((status) => status === "done");
  if (
    hasResponsibility &&
    everyResponsibilityDone &&
    input.requiredDeliverablesFulfilled
  ) {
    return "pending_review";
  }

  const workHasBegun = responsibilityStatuses.some(
    (status) => status !== "not_started",
  );
  return workHasBegun ? "in_progress" : "not_started";
}
