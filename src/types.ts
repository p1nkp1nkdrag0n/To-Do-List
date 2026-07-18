import type { ResourceEntity, ResourceListItem, ResourceVersionEntity, TagEntity } from "../shared/resource-contracts";
import type {
  AvailabilityDocument,
  ProjectAvailabilitySummary,
  ScheduleConflict,
  WeeklyAvailabilitySlot,
} from "../shared/availability-contracts";

export type { AvailabilityDocument, ProjectAvailabilitySummary, ResourceEntity, ResourceListItem, ResourceVersionEntity, ScheduleConflict, TagEntity, WeeklyAvailabilitySlot };

export interface User {
  id: string;
  username: string;
  displayName: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface AuthState {
  user: User;
  teamMember: boolean;
}

export interface TeamMember {
  userId: string;
  username: string;
  displayName: string;
  joinedAt: string;
  revision: number;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  timezone: string;
  startDate: string | null;
  endDate: string | null;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface ProjectMember extends TeamMember {
  color: string;
}

export interface ProjectDetail {
  project: Project;
  members: ProjectMember[];
}

export interface Phase {
  id: string;
  projectId: string;
  name: string;
  description: string;
  position: number;
  startDate: string | null;
  endDate: string | null;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export type WorkStatus = "not_started" | "in_progress" | "blocked" | "pending_review" | "done";

export interface Task {
  id: string;
  projectId: string;
  phaseId: string | null;
  parentId: string | null;
  recurringRuleId: string | null;
  occurrenceDate: string | null;
  title: string;
  description: string;
  position: number;
  status: WorkStatus;
  startDate: string | null;
  dueDate: string | null;
  reviewedAt: string | null;
  reviewedBy: string | null;
  reopenedAt: string | null;
  reopenedBy: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface Participant {
  id: string;
  projectId: string;
  taskId: string;
  userId: string;
  username: string;
  displayName: string;
  color: string;
  startDate: string;
  endDate: string;
  estimatedMinutes: number;
  progressPercent: number;
  status: "not_started" | "in_progress" | "blocked" | "done";
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface Dependency {
  id: string;
  projectId: string;
  predecessorTaskId: string;
  successorTaskId: string;
  createdAt: string;
  revision: number;
  deletedAt: string | null;
}

export interface ProgressEntry {
  id: string;
  participantId: string;
  completionPercent: number;
  summary: string;
  blockers: string;
  nextSteps: string;
  createdBy: string;
  createdAt: string;
}

export interface Milestone {
  id: string;
  projectId: string;
  phaseId: string | null;
  title: string;
  description: string;
  dueDate: string;
  status: WorkStatus;
  reviewedAt: string | null;
  reviewedBy: string | null;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface Deliverable {
  id: string;
  projectId: string;
  taskId: string | null;
  milestoneId: string | null;
  title: string;
  description: string;
  fulfilledResourceId: string | null;
  fulfilledResourceVersionId: string | null;
  fulfilledAt: string | null;
  fulfilledBy: string | null;
  acceptedAt: string | null;
  acceptedBy: string | null;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface Schedule {
  projectId: string;
  revision: number;
  phases: Phase[];
  tasks: Task[];
  participants: Participant[];
  dependencies: Dependency[];
  milestones: Milestone[];
  deliverableRequirements: Deliverable[];
  conflicts: ScheduleConflict[];
}

export interface RecurringRule {
  id: string;
  projectId: string;
  sourceTaskId: string;
  frequency: "weekly" | "monthly";
  intervalCount: number;
  dayOfWeek: number | null;
  dayOfMonth: number | null;
  startsOn: string;
  endsOn: string | null;
  nextOccurrenceOn: string;
  lastGeneratedOn: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface ScheduleTemplatePayload {
  version: number;
  anchorSemantics: "relative_days";
  phases: unknown[];
  tasks: unknown[];
  dependencies: unknown[];
  milestones: unknown[];
  deliverableRequirements: unknown[];
}

export interface BuiltInScheduleTemplate {
  id: "builtin-competition" | "builtin-research";
  name: string;
  source: "built_in";
  payload: ScheduleTemplatePayload;
}

export interface TeamScheduleTemplate {
  id: string;
  name: string;
  source: "team";
  anchorSemantics: "relative_days";
  payload: ScheduleTemplatePayload;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface ScheduleTemplateList {
  builtIn: BuiltInScheduleTemplate[];
  team: TeamScheduleTemplate[];
}

export interface TaskLifecycleItem {
  id: string;
  projectId: string;
  parentId: string | null;
  title: string;
  status: string;
  revision: number;
  archivedAt: string | null;
  deletedAt: string | null;
  purgeAfter: string | null;
}

export interface ProjectLifecycleItem {
  id: string;
  name: string;
  description: string;
  revision: number;
  scheduleRevision: number;
  archivedAt: string | null;
  deletedAt: string | null;
  purgeAfter: string | null;
}

export interface ResourceDetail {
  resource: ResourceEntity;
  versions: ResourceVersionEntity[];
}
