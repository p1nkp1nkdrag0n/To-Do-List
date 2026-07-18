import type {
  ApplyTemplateRequest,
  CreateDependencyRequest,
  CreateDeliverableRequest,
  CreateMilestoneRequest,
  CreateParticipantRequest,
  CreatePhaseRequest,
  CreateRecurringRuleRequest,
  CreateTaskRequest,
  FulfillDeliverableRequest,
  PatchDeliverableRequest,
  PatchMilestoneRequest,
  PatchParticipantRequest,
  PatchPhaseRequest,
  PatchRecurringRuleRequest,
  PatchTaskRequest,
  ProgressUpdateRequest,
  SaveTeamTemplateRequest,
  UpdateTeamTemplateRequest,
} from "../../../shared/schedule-contracts.js";
import type { ScheduleConflict } from "../../../shared/availability-contracts.js";
import type { ParticipantStatus, TaskStatus } from "../../../shared/contracts.js";
import type { V2RuntimeDependencies } from "../../http/dependencies.js";
import { HttpError } from "../../http/errors.js";
import { writeActivity } from "../activity.js";
import { AvailabilityService } from "../availability/availability-service.js";
import type { AuthenticatedSession } from "../auth/auth-service.js";
import { createsParentCycle } from "./graph.js";
import { createsDependencyCycle } from "./graph.js";
import { enumerateOccurrences, firstOccurrenceOnOrAfter, nextOccurrenceAfter } from "./recurrence.js";
import { aggregateTaskStatus } from "./task-status.js";
import {
  BUILT_IN_TEMPLATES,
  buildTemplatePayload,
  instantiateTemplate,
  TeamTemplatePayloadSchema,
  type TeamTemplatePayload,
} from "./templates.js";

interface ProjectScheduleRow extends Record<string, unknown> {
  id: string;
  schedule_revision: number;
}

interface PhaseRow extends Record<string, unknown> {
  id: string;
  project_id: string;
  name: string;
  description: string;
  position: number;
  start_date: string | null;
  end_date: string | null;
  created_at: string;
  updated_at: string;
  revision: number;
}

interface TaskRow extends Record<string, unknown> {
  id: string;
  project_id: string;
  phase_id: string | null;
  parent_id: string | null;
  recurring_rule_id: string | null;
  occurrence_date: string | null;
  title: string;
  description: string;
  position: number;
  status: TaskStatus;
  start_date: string | null;
  due_date: string | null;
  reviewed_at: string | null;
  reviewed_by: string | null;
  reopened_at: string | null;
  reopened_by: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  revision: number;
}

interface ParticipantRow extends Record<string, unknown> {
  id: string;
  project_id: string;
  task_id: string;
  user_id: string;
  username: string;
  display_name: string;
  color: string;
  start_date: string;
  end_date: string;
  estimated_minutes: number;
  progress_percent: number;
  status: ParticipantStatus;
  removed_at: string | null;
  created_at: string;
  updated_at: string;
  revision: number;
}

interface DependencyRow extends Record<string, unknown> {
  id: string;
  project_id: string;
  predecessor_task_id: string;
  successor_task_id: string;
  created_at: string;
  revision: number;
  deleted_at: string | null;
}

interface ProgressRow extends Record<string, unknown> {
  id: string;
  participant_id: string;
  completion_percent: number;
  summary: string;
  blockers: string;
  next_steps: string;
  created_by: string;
  created_at: string;
}

interface MilestoneRow extends Record<string, unknown> {
  id: string;
  project_id: string;
  phase_id: string | null;
  title: string;
  description: string;
  due_date: string;
  status: TaskStatus;
  reviewed_at: string | null;
  reviewed_by: string | null;
  created_at: string;
  updated_at: string;
  revision: number;
}

interface DeliverableRow extends Record<string, unknown> {
  id: string;
  project_id: string;
  task_id: string | null;
  milestone_id: string | null;
  title: string;
  description: string;
  fulfilled_resource_id: string | null;
  fulfilled_resource_version_id: string | null;
  fulfilled_at: string | null;
  fulfilled_by: string | null;
  accepted_at: string | null;
  accepted_by: string | null;
  created_at: string;
  updated_at: string;
  revision: number;
}

interface RecurringRuleRow extends Record<string, unknown> {
  id: string;
  project_id: string;
  source_task_id: string;
  frequency: "weekly" | "monthly";
  interval_count: number;
  day_of_week: number | null;
  day_of_month: number | null;
  starts_on: string;
  ends_on: string | null;
  next_occurrence_on: string;
  last_generated_on: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
  revision: number;
}

interface TeamTemplateRow extends Record<string, unknown> {
  id: string;
  name: string;
  anchor_semantics: "relative_days";
  payload_json: string;
  created_at: string;
  updated_at: string;
  revision: number;
  archived_at: string | null;
}

export interface PhaseEntity {
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

export interface TaskEntity {
  id: string;
  projectId: string;
  phaseId: string | null;
  parentId: string | null;
  recurringRuleId: string | null;
  occurrenceDate: string | null;
  title: string;
  description: string;
  position: number;
  status: TaskStatus;
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

export interface ParticipantEntity {
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
  status: ParticipantStatus;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface DependencyEntity {
  id: string;
  projectId: string;
  predecessorTaskId: string;
  successorTaskId: string;
  createdAt: string;
  revision: number;
  deletedAt: string | null;
}

export interface ProgressEntity {
  id: string;
  participantId: string;
  completionPercent: number;
  summary: string;
  blockers: string;
  nextSteps: string;
  createdBy: string;
  createdAt: string;
}

export interface MilestoneEntity {
  id: string;
  projectId: string;
  phaseId: string | null;
  title: string;
  description: string;
  dueDate: string;
  status: TaskStatus;
  reviewedAt: string | null;
  reviewedBy: string | null;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface DeliverableEntity {
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

export interface RecurringRuleEntity {
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

export interface TeamTemplateEntity {
  id: string;
  name: string;
  source: "team";
  anchorSemantics: "relative_days";
  payload: TeamTemplatePayload;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

function toPhase(row: PhaseRow): PhaseEntity {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    description: row.description,
    position: row.position,
    startDate: row.start_date,
    endDate: row.end_date,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: row.revision,
  };
}

function toTask(row: TaskRow): TaskEntity {
  return {
    id: row.id,
    projectId: row.project_id,
    phaseId: row.phase_id,
    parentId: row.parent_id,
    recurringRuleId: row.recurring_rule_id,
    occurrenceDate: row.occurrence_date,
    title: row.title,
    description: row.description,
    position: row.position,
    status: row.status,
    startDate: row.start_date,
    dueDate: row.due_date,
    reviewedAt: row.reviewed_at,
    reviewedBy: row.reviewed_by,
    reopenedAt: row.reopened_at,
    reopenedBy: row.reopened_by,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: row.revision,
  };
}

function toParticipant(row: ParticipantRow): ParticipantEntity {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    userId: row.user_id,
    username: row.username,
    displayName: row.display_name,
    color: row.color,
    startDate: row.start_date,
    endDate: row.end_date,
    estimatedMinutes: row.estimated_minutes,
    progressPercent: row.progress_percent,
    status: row.status,
    deletedAt: row.removed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: row.revision,
  };
}

function toDependency(row: DependencyRow): DependencyEntity {
  return {
    id: row.id,
    projectId: row.project_id,
    predecessorTaskId: row.predecessor_task_id,
    successorTaskId: row.successor_task_id,
    createdAt: row.created_at,
    revision: row.revision,
    deletedAt: row.deleted_at,
  };
}

function toProgress(row: ProgressRow): ProgressEntity {
  return {
    id: row.id,
    participantId: row.participant_id,
    completionPercent: row.completion_percent,
    summary: row.summary,
    blockers: row.blockers,
    nextSteps: row.next_steps,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function toMilestone(row: MilestoneRow): MilestoneEntity {
  return {
    id: row.id,
    projectId: row.project_id,
    phaseId: row.phase_id,
    title: row.title,
    description: row.description,
    dueDate: row.due_date,
    status: row.status,
    reviewedAt: row.reviewed_at,
    reviewedBy: row.reviewed_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: row.revision,
  };
}

function toDeliverable(row: DeliverableRow): DeliverableEntity {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    milestoneId: row.milestone_id,
    title: row.title,
    description: row.description,
    fulfilledResourceId: row.fulfilled_resource_id,
    fulfilledResourceVersionId: row.fulfilled_resource_version_id,
    fulfilledAt: row.fulfilled_at,
    fulfilledBy: row.fulfilled_by,
    acceptedAt: row.accepted_at,
    acceptedBy: row.accepted_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: row.revision,
  };
}

function toRecurringRule(row: RecurringRuleRow): RecurringRuleEntity {
  return {
    id: row.id,
    projectId: row.project_id,
    sourceTaskId: row.source_task_id,
    frequency: row.frequency,
    intervalCount: row.interval_count,
    dayOfWeek: row.day_of_week,
    dayOfMonth: row.day_of_month,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    nextOccurrenceOn: row.next_occurrence_on,
    lastGeneratedOn: row.last_generated_on,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: row.revision,
  };
}

function toTeamTemplate(row: TeamTemplateRow): TeamTemplateEntity {
  return {
    id: row.id,
    name: row.name,
    source: "team",
    anchorSemantics: row.anchor_semantics,
    payload: TeamTemplatePayloadSchema.parse(JSON.parse(row.payload_json)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: row.revision,
  };
}

export class ScheduleService {
  constructor(protected readonly dependencies: V2RuntimeDependencies) {}

  schedule(auth: AuthenticatedSession, projectId: string): {
    projectId: string;
    revision: number;
    phases: PhaseEntity[];
    tasks: TaskEntity[];
    participants: ParticipantEntity[];
    dependencies: DependencyEntity[];
    milestones: MilestoneEntity[];
    deliverableRequirements: DeliverableEntity[];
    conflicts: ScheduleConflict[];
  } {
    const project = this.requireProjectMember(auth, projectId);
    return {
      projectId,
      revision: project.schedule_revision,
      phases: this.phaseRows(projectId).map(toPhase),
      tasks: this.taskRows(projectId).map(toTask),
      participants: this.participantRows(projectId).map(toParticipant),
      dependencies: this.dependencyRows(projectId).map(toDependency),
      milestones: this.milestoneRows(projectId).map(toMilestone),
      deliverableRequirements: this.deliverableRows(projectId).map(toDeliverable),
      conflicts: new AvailabilityService(this.dependencies).projectConflicts(projectId),
    };
  }

  listPhases(auth: AuthenticatedSession, projectId: string): PhaseEntity[] {
    this.requireProjectMember(auth, projectId);
    return this.phaseRows(projectId).map(toPhase);
  }

  createPhase(
    auth: AuthenticatedSession,
    projectId: string,
    input: CreatePhaseRequest,
  ): { phase: PhaseEntity; scheduleRevision: number } {
    return this.dependencies.database.transaction(() => {
      this.requireProjectMember(auth, projectId);
      const id = this.dependencies.idGenerator();
      const now = this.dependencies.clock().toISOString();
      const position = input.position ?? this.nextPosition("phases", projectId);
      this.dependencies.database.run(
        `INSERT INTO phases
          (id, project_id, name, description, position, start_date, end_date,
           created_by, updated_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          projectId,
          input.name,
          input.description ?? "",
          position,
          input.startDate ?? null,
          input.endDate ?? null,
          auth.user.id,
          auth.user.id,
          now,
          now,
        ],
      );
      writeActivity(this.dependencies, {
        projectId,
        actorId: auth.user.id,
        entityType: "phase",
        entityId: id,
        action: "phase.created",
      });
      const scheduleRevision = this.bumpScheduleRevision(projectId);
      return { phase: toPhase(this.phaseRow(projectId, id)!), scheduleRevision };
    });
  }

  updatePhase(
    auth: AuthenticatedSession,
    projectId: string,
    phaseId: string,
    input: PatchPhaseRequest,
  ): { phase: PhaseEntity; scheduleRevision: number } {
    return this.dependencies.database.transaction(() => {
      this.requireProjectMember(auth, projectId);
      const current = this.requirePhase(projectId, phaseId);
      this.assertRevision("phase", current, input.expectedRevision, toPhase);
      const next = {
        name: input.name ?? current.name,
        description: input.description ?? current.description,
        position: input.position ?? current.position,
        startDate: input.startDate === undefined ? current.start_date : input.startDate,
        endDate: input.endDate === undefined ? current.end_date : input.endDate,
      };
      this.assertDateRange(next.startDate, next.endDate, "phase");
      const now = this.dependencies.clock().toISOString();
      const changed = this.dependencies.database.run(
        `UPDATE phases
            SET name = ?, description = ?, position = ?, start_date = ?, end_date = ?,
                updated_by = ?, updated_at = ?, revision = revision + 1
          WHERE id = ? AND project_id = ? AND revision = ?`,
        [
          next.name,
          next.description,
          next.position,
          next.startDate,
          next.endDate,
          auth.user.id,
          now,
          phaseId,
          projectId,
          input.expectedRevision,
        ],
      );
      if (changed.changes !== 1) {
        this.throwLatestPhase(projectId, phaseId);
      }
      writeActivity(this.dependencies, {
        projectId,
        actorId: auth.user.id,
        entityType: "phase",
        entityId: phaseId,
        action: "phase.updated",
      });
      const scheduleRevision = this.bumpScheduleRevision(projectId);
      return {
        phase: toPhase(this.phaseRow(projectId, phaseId)!),
        scheduleRevision,
      };
    });
  }

  deletePhase(
    auth: AuthenticatedSession,
    projectId: string,
    phaseId: string,
    expectedRevision: number,
  ): { deleted: true; scheduleRevision: number } {
    return this.dependencies.database.transaction(() => {
      this.requireProjectMember(auth, projectId);
      const current = this.requirePhase(projectId, phaseId);
      this.assertRevision("phase", current, expectedRevision, toPhase);
      const completedReference = this.dependencies.database.get<{ id: string }>(
        `SELECT id FROM tasks
          WHERE project_id = ? AND phase_id = ? AND status = 'done'
            AND archived_at IS NULL AND deleted_at IS NULL
         UNION ALL
         SELECT id FROM milestones
          WHERE project_id = ? AND phase_id = ? AND status = 'done'
         LIMIT 1`,
        [projectId, phaseId, projectId, phaseId],
      );
      if (completedReference !== undefined) {
        throw new HttpError(
          409,
          "PHASE_COMPLETED_REFERENCE",
          "The phase contains completed work that must be reopened first.",
        );
      }

      const now = this.dependencies.clock().toISOString();
      this.dependencies.database.run(
        `UPDATE tasks
            SET phase_id = NULL, updated_by = ?, updated_at = ?, revision = revision + 1
          WHERE project_id = ? AND phase_id = ?
            AND archived_at IS NULL AND deleted_at IS NULL`,
        [auth.user.id, now, projectId, phaseId],
      );
      this.dependencies.database.run(
        `UPDATE milestones
            SET phase_id = NULL, updated_by = ?, updated_at = ?, revision = revision + 1
          WHERE project_id = ? AND phase_id = ?`,
        [auth.user.id, now, projectId, phaseId],
      );
      const deleted = this.dependencies.database.run(
        `DELETE FROM phases
          WHERE id = ? AND project_id = ? AND revision = ?`,
        [phaseId, projectId, expectedRevision],
      );
      if (deleted.changes !== 1) {
        this.throwLatestPhase(projectId, phaseId);
      }
      writeActivity(this.dependencies, {
        projectId,
        actorId: auth.user.id,
        entityType: "phase",
        entityId: phaseId,
        action: "phase.deleted",
      });
      return { deleted: true, scheduleRevision: this.bumpScheduleRevision(projectId) };
    });
  }

  listTasks(auth: AuthenticatedSession, projectId: string): TaskEntity[] {
    this.requireProjectMember(auth, projectId);
    return this.taskRows(projectId).map(toTask);
  }

  listParticipants(auth: AuthenticatedSession, projectId: string): ParticipantEntity[] {
    this.requireProjectMember(auth, projectId);
    return this.participantRows(projectId).map(toParticipant);
  }

  listDependencies(auth: AuthenticatedSession, projectId: string): DependencyEntity[] {
    this.requireProjectMember(auth, projectId);
    return this.dependencyRows(projectId).map(toDependency);
  }

  listMilestones(auth: AuthenticatedSession, projectId: string): MilestoneEntity[] {
    this.requireProjectMember(auth, projectId);
    return this.milestoneRows(projectId).map(toMilestone);
  }

  getMilestone(auth: AuthenticatedSession, projectId: string, milestoneId: string): MilestoneEntity {
    this.requireProjectMember(auth, projectId);
    return toMilestone(this.requireMilestone(projectId, milestoneId));
  }

  listDeliverables(auth: AuthenticatedSession, projectId: string): DeliverableEntity[] {
    this.requireProjectMember(auth, projectId);
    return this.deliverableRows(projectId).map(toDeliverable);
  }

  getDeliverable(auth: AuthenticatedSession, projectId: string, deliverableId: string): DeliverableEntity {
    this.requireProjectMember(auth, projectId);
    return toDeliverable(this.requireDeliverable(projectId, deliverableId));
  }

  listRecurringRules(auth: AuthenticatedSession, projectId: string): RecurringRuleEntity[] {
    this.requireProjectMember(auth, projectId);
    return this.dependencies.database.all<RecurringRuleRow>(
      `SELECT id, project_id, source_task_id, frequency, interval_count, day_of_week, day_of_month,
              starts_on, ends_on, next_occurrence_on, last_generated_on, is_active, created_at, updated_at, revision
         FROM recurring_task_rules WHERE project_id=? ORDER BY created_at, id`,
      [projectId],
    ).map(toRecurringRule);
  }

  getRecurringRule(auth: AuthenticatedSession, projectId: string, ruleId: string): RecurringRuleEntity {
    this.requireProjectMember(auth, projectId);
    return toRecurringRule(this.requireRule(projectId, ruleId));
  }

  getTask(
    auth: AuthenticatedSession,
    projectId: string,
    taskId: string,
  ): TaskEntity {
    this.requireProjectMember(auth, projectId);
    return toTask(this.requireTask(projectId, taskId));
  }

  createTask(
    auth: AuthenticatedSession,
    projectId: string,
    input: CreateTaskRequest,
  ): { task: TaskEntity; scheduleRevision: number } {
    return this.dependencies.database.transaction(() => {
      this.requireProjectMember(auth, projectId);
      this.validatePhaseReference(projectId, input.phaseId ?? null);
      this.validateParentReference(projectId, input.parentId ?? null);
      const id = this.dependencies.idGenerator();
      const now = this.dependencies.clock().toISOString();
      const position = input.position ?? this.nextPosition("tasks", projectId);
      this.dependencies.database.run(
        `INSERT INTO tasks
          (id, project_id, phase_id, parent_id, title, description, position,
           start_date, due_date, created_by, updated_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          projectId,
          input.phaseId ?? null,
          input.parentId ?? null,
          input.title,
          input.description ?? "",
          position,
          input.startDate ?? null,
          input.dueDate ?? null,
          auth.user.id,
          auth.user.id,
          now,
          now,
        ],
      );
      this.recomputeAncestors(
        projectId,
        input.parentId ?? null,
        auth.user.id,
        now,
      );
      writeActivity(this.dependencies, {
        projectId,
        actorId: auth.user.id,
        entityType: "task",
        entityId: id,
        action: "task.created",
      });
      const scheduleRevision = this.bumpScheduleRevision(projectId);
      return { task: toTask(this.taskRow(projectId, id)!), scheduleRevision };
    });
  }

  updateTask(
    auth: AuthenticatedSession,
    projectId: string,
    taskId: string,
    input: PatchTaskRequest,
  ): { task: TaskEntity; scheduleRevision: number } {
    return this.dependencies.database.transaction(() => {
      this.requireProjectMember(auth, projectId);
      const current = this.requireTask(projectId, taskId);
      this.assertRevision("task", current, input.expectedRevision, toTask);
      this.assertTaskEditable(current);
      const next = {
        phaseId: input.phaseId === undefined ? current.phase_id : input.phaseId,
        parentId: input.parentId === undefined ? current.parent_id : input.parentId,
        title: input.title ?? current.title,
        description: input.description ?? current.description,
        position: input.position ?? current.position,
        startDate: input.startDate === undefined ? current.start_date : input.startDate,
        dueDate: input.dueDate === undefined ? current.due_date : input.dueDate,
      };
      this.validatePhaseReference(projectId, next.phaseId);
      this.validateParentReference(projectId, next.parentId);
      this.assertDateRange(next.startDate, next.dueDate, "task");
      const parents = new Map(
        this.taskRows(projectId).map(({ id, parent_id }) => [id, parent_id] as const),
      );
      if (createsParentCycle(parents, taskId, next.parentId)) {
        throw new HttpError(
          409,
          "TASK_PARENT_CYCLE",
          "The task parent would create a cycle.",
        );
      }

      const now = this.dependencies.clock().toISOString();
      const changed = this.dependencies.database.run(
        `UPDATE tasks
            SET phase_id = ?, parent_id = ?, title = ?, description = ?, position = ?,
                start_date = ?, due_date = ?, updated_by = ?, updated_at = ?,
                revision = revision + 1
          WHERE id = ? AND project_id = ? AND revision = ? AND deleted_at IS NULL`,
        [
          next.phaseId,
          next.parentId,
          next.title,
          next.description,
          next.position,
          next.startDate,
          next.dueDate,
          auth.user.id,
          now,
          taskId,
          projectId,
          input.expectedRevision,
        ],
      );
      if (changed.changes !== 1) {
        this.throwLatestTask(projectId, taskId);
      }
      if (current.parent_id !== next.parentId) {
        this.recomputeAncestors(projectId, current.parent_id, auth.user.id, now);
        this.recomputeAncestors(projectId, next.parentId, auth.user.id, now);
      }
      writeActivity(this.dependencies, {
        projectId,
        actorId: auth.user.id,
        entityType: "task",
        entityId: taskId,
        action: "task.updated",
      });
      const scheduleRevision = this.bumpScheduleRevision(projectId);
      return { task: toTask(this.taskRow(projectId, taskId)!), scheduleRevision };
    });
  }

  deleteTask(auth: AuthenticatedSession, projectId: string, taskId: string, expectedRevision: number): { deleted: true; scheduleRevision: number } {
    return this.dependencies.database.transaction(() => {
      this.requireProjectMember(auth, projectId);
      const task = this.requireTask(projectId, taskId);
      this.assertRevision("task", task, expectedRevision, toTask);
      const subtree = this.activeTaskSubtree(projectId, taskId);
      if (subtree.some(({ status }) => status === "done")) {
        throw new HttpError(409, "TASK_COMPLETED_SUBTREE", "Completed tasks must be reopened before the subtree can be deleted.");
      }
      const ids = subtree.map(({ id }) => id);
      const placeholders = ids.map(() => "?").join(", ");
      const activeRule = this.dependencies.database.get<{ id: string }>(
        `SELECT id FROM recurring_task_rules
          WHERE project_id=? AND is_active=1 AND source_task_id IN (${placeholders}) LIMIT 1`,
        [projectId, ...ids],
      );
      if (activeRule !== undefined) {
        throw new HttpError(409, "TASK_RECURRING_SOURCE", "Deactivate the recurring rule before deleting its source task.");
      }
      const now = this.dependencies.clock().toISOString();
      const purgeAfter = new Date(this.dependencies.clock().getTime() + 30 * 24 * 60 * 60 * 1_000).toISOString();
      const participants = this.dependencies.database.all<{ id: string }>(
        `SELECT id FROM task_participants WHERE project_id=? AND task_id IN (${placeholders}) AND removed_at IS NULL`, [projectId, ...ids],
      );
      const dependencies = this.dependencies.database.all<{ id: string }>(
        `SELECT id FROM task_dependencies
          WHERE project_id=? AND deleted_at IS NULL
            AND (predecessor_task_id IN (${placeholders}) OR successor_task_id IN (${placeholders}))`,
        [projectId, ...ids, ...ids],
      );
      this.dependencies.database.run(
        `UPDATE task_participants SET removed_at=?, removed_by=?, updated_by=?, updated_at=?, revision=revision+1
          WHERE project_id=? AND task_id IN (${placeholders}) AND removed_at IS NULL`,
        [now, auth.user.id, auth.user.id, now, projectId, ...ids],
      );
      this.dependencies.database.run(
        `UPDATE task_dependencies SET deleted_at=?, deleted_by=?, revision=revision+1
          WHERE project_id=? AND deleted_at IS NULL
            AND (predecessor_task_id IN (${placeholders}) OR successor_task_id IN (${placeholders}))`,
        [now, auth.user.id, projectId, ...ids, ...ids],
      );
      const changed = this.dependencies.database.run(
        `UPDATE tasks SET deleted_at=?, deleted_by=?, purge_after=?, updated_by=?, updated_at=?, revision=revision+1
          WHERE project_id=? AND id IN (${placeholders}) AND deleted_at IS NULL`,
        [now, auth.user.id, purgeAfter, auth.user.id, now, projectId, ...ids],
      );
      if (changed.changes !== subtree.length) this.throwLatestTask(projectId, taskId);
      this.recomputeAncestors(projectId, task.parent_id, auth.user.id, now);
      for (const row of subtree) writeActivity(this.dependencies, { projectId, actorId: auth.user.id, entityType: "task", entityId: row.id, action: "task.deleted" });
      for (const row of participants) writeActivity(this.dependencies, { projectId, actorId: auth.user.id, entityType: "participant", entityId: row.id, action: "participant.removed_with_task" });
      for (const row of dependencies) writeActivity(this.dependencies, { projectId, actorId: auth.user.id, entityType: "dependency", entityId: row.id, action: "dependency.removed_with_task" });
      return { deleted: true, scheduleRevision: this.bumpScheduleRevision(projectId) };
    });
  }

  addParticipant(
    auth: AuthenticatedSession,
    projectId: string,
    taskId: string,
    input: CreateParticipantRequest,
  ): { participant: ParticipantEntity; scheduleRevision: number } {
    return this.dependencies.database.transaction(() => {
      this.requireProjectMember(auth, projectId);
      const task = this.requireTask(projectId, taskId);
      this.assertTaskEditable(task);
      this.requireActiveProjectMember(projectId, input.userId);
      const duplicate = this.dependencies.database.get<{
        id: string;
        revision: number;
        removed_at: string | null;
      }>(
        "SELECT id, revision, removed_at FROM task_participants WHERE task_id = ? AND user_id = ?",
        [taskId, input.userId],
      );
      const now = this.dependencies.clock().toISOString();
      if (duplicate?.removed_at === null) {
        throw new HttpError(409, "PARTICIPANT_EXISTS", "The member already has a task assignment.");
      }
      const id = duplicate?.id ?? this.dependencies.idGenerator();
      if (duplicate !== undefined) {
        if (input.expectedRevision !== duplicate.revision) {
          this.throwLatestParticipant(projectId, duplicate.id);
        }
        const changed = this.dependencies.database.run(
          `UPDATE task_participants
              SET start_date=?, end_date=?, estimated_minutes=?, progress_percent=0,
                  status='not_started', removed_at=NULL, removed_by=NULL,
                  updated_by=?, updated_at=?, revision=revision+1
            WHERE id=? AND project_id=? AND revision=? AND removed_at IS NOT NULL`,
          [input.startDate, input.endDate, input.estimatedMinutes, auth.user.id, now,
            id, projectId, input.expectedRevision],
        );
        if (changed.changes !== 1) this.throwLatestParticipant(projectId, id);
      } else {
        this.dependencies.database.run(
          `INSERT INTO task_participants
            (id, project_id, task_id, user_id, start_date, end_date, estimated_minutes,
             created_by, updated_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, projectId, taskId, input.userId, input.startDate, input.endDate,
            input.estimatedMinutes, auth.user.id, auth.user.id, now, now],
        );
      }
      this.recomputeTaskAndAncestors(projectId, taskId, auth.user.id, now);
      writeActivity(this.dependencies, { projectId, actorId: auth.user.id, entityType: "participant", entityId: id, action: duplicate === undefined ? "participant.created" : "participant.reactivated" });
      return { participant: toParticipant(this.requireParticipant(projectId, id)), scheduleRevision: this.bumpScheduleRevision(projectId) };
    });
  }

  updateParticipant(
    auth: AuthenticatedSession,
    projectId: string,
    participantId: string,
    input: PatchParticipantRequest,
  ): { participant: ParticipantEntity; scheduleRevision: number } {
    return this.dependencies.database.transaction(() => {
      this.requireProjectMember(auth, projectId);
      const current = this.requireParticipant(projectId, participantId);
      this.assertRevision("participant", current, input.expectedRevision, toParticipant);
      const task = this.requireTask(projectId, current.task_id);
      this.assertTaskEditable(task);
      const next = {
        userId: input.userId ?? current.user_id,
        startDate: input.startDate ?? current.start_date,
        endDate: input.endDate ?? current.end_date,
        estimatedMinutes: input.estimatedMinutes ?? current.estimated_minutes,
      };
      this.assertDateRange(next.startDate, next.endDate, "task");
      this.requireActiveProjectMember(projectId, next.userId);
      const now = this.dependencies.clock().toISOString();
      const changed = this.dependencies.database.run(
        `UPDATE task_participants SET user_id=?, start_date=?, end_date=?, estimated_minutes=?,
          updated_by=?, updated_at=?, revision=revision+1
         WHERE id=? AND project_id=? AND revision=?`,
        [next.userId, next.startDate, next.endDate, next.estimatedMinutes, auth.user.id, now,
          participantId, projectId, input.expectedRevision],
      );
      if (changed.changes !== 1) this.throwLatestParticipant(projectId, participantId);
      this.recomputeTaskAndAncestors(projectId, current.task_id, auth.user.id, now);
      writeActivity(this.dependencies, { projectId, actorId: auth.user.id, entityType: "participant", entityId: participantId, action: "participant.updated" });
      return { participant: toParticipant(this.requireParticipant(projectId, participantId)), scheduleRevision: this.bumpScheduleRevision(projectId) };
    });
  }

  deleteParticipant(
    auth: AuthenticatedSession, projectId: string, participantId: string, expectedRevision: number,
  ): { deleted: true; scheduleRevision: number } {
    return this.dependencies.database.transaction(() => {
      this.requireProjectMember(auth, projectId);
      const current = this.requireParticipant(projectId, participantId);
      this.assertRevision("participant", current, expectedRevision, toParticipant);
      this.assertTaskEditable(this.requireTask(projectId, current.task_id));
      const now = this.dependencies.clock().toISOString();
      const deleted = this.dependencies.database.run(
        `UPDATE task_participants
            SET removed_at=?, removed_by=?, updated_by=?, updated_at=?, revision=revision+1
          WHERE id=? AND project_id=? AND revision=? AND removed_at IS NULL`,
        [now, auth.user.id, auth.user.id, now, participantId, projectId, expectedRevision],
      );
      if (deleted.changes !== 1) this.throwLatestParticipant(projectId, participantId);
      this.recomputeTaskAndAncestors(projectId, current.task_id, auth.user.id, now);
      writeActivity(this.dependencies, { projectId, actorId: auth.user.id, entityType: "participant", entityId: participantId, action: "participant.deleted" });
      return { deleted: true, scheduleRevision: this.bumpScheduleRevision(projectId) };
    });
  }

  progressUpdates(auth: AuthenticatedSession, projectId: string, participantId: string): ProgressEntity[] {
    this.requireProjectMember(auth, projectId);
    this.requireParticipant(projectId, participantId);
    return this.dependencies.database.all<ProgressRow>(
      `SELECT id, participant_id, completion_percent, summary, blockers, next_steps, created_by, created_at
       FROM progress_updates WHERE participant_id=? ORDER BY rowid`, [participantId],
    ).map(toProgress);
  }

  recordProgress(
    auth: AuthenticatedSession, projectId: string, participantId: string, input: ProgressUpdateRequest,
  ): { progress: ProgressEntity; participant: ParticipantEntity; task: TaskEntity; scheduleRevision: number } {
    return this.dependencies.database.transaction(() => {
      this.requireProjectMember(auth, projectId);
      const participant = this.requireParticipant(projectId, participantId);
      this.assertRevision("participant", participant, input.participantExpectedRevision, toParticipant);
      const task = this.requireTask(projectId, participant.task_id);
      this.assertTaskEditable(task);
      const now = this.dependencies.clock().toISOString();
      const status: ParticipantStatus = input.blockers.length > 0 ? "blocked" : input.completionPercent === 100 ? "done" : input.completionPercent === 0 ? "not_started" : "in_progress";
      const progressId = this.dependencies.idGenerator();
      this.dependencies.database.run(
        `INSERT INTO progress_updates (id, participant_id, completion_percent, summary, blockers, next_steps, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [progressId, participantId, input.completionPercent, input.summary, input.blockers, input.nextSteps, auth.user.id, now],
      );
      const changed = this.dependencies.database.run(
        `UPDATE task_participants SET progress_percent=?, status=?, updated_by=?, updated_at=?, revision=revision+1
         WHERE id=? AND project_id=? AND revision=?`,
        [input.completionPercent, status, auth.user.id, now, participantId, projectId, input.participantExpectedRevision],
      );
      if (changed.changes !== 1) this.throwLatestParticipant(projectId, participantId);
      this.recomputeTaskAndAncestors(projectId, task.id, auth.user.id, now);
      writeActivity(this.dependencies, { projectId, actorId: auth.user.id, entityType: "progress", entityId: progressId, action: "progress.recorded" });
      return { progress: toProgress(this.dependencies.database.get<ProgressRow>("SELECT id, participant_id, completion_percent, summary, blockers, next_steps, created_by, created_at FROM progress_updates WHERE id=?", [progressId])!), participant: toParticipant(this.requireParticipant(projectId, participantId)), task: toTask(this.requireTask(projectId, task.id)), scheduleRevision: this.bumpScheduleRevision(projectId) };
    });
  }

  reviewTask(auth: AuthenticatedSession, projectId: string, taskId: string, expectedRevision: number): { task: TaskEntity; scheduleRevision: number } {
    return this.dependencies.database.transaction(() => {
      this.requireProjectMember(auth, projectId);
      const task = this.requireTask(projectId, taskId);
      this.assertRevision("task", task, expectedRevision, toTask);
      if (!this.isTaskReviewReady(projectId, task)) throw new HttpError(409, "TASK_NOT_PENDING_REVIEW", "The task is not ready for review.", { latest: toTask(task) });
      const now = this.dependencies.clock().toISOString();
      this.dependencies.database.run("UPDATE tasks SET status='done', reviewed_at=?, reviewed_by=?, updated_by=?, updated_at=?, revision=revision+1 WHERE id=? AND project_id=? AND revision=?", [now, auth.user.id, auth.user.id, now, taskId, projectId, expectedRevision]);
      this.acceptDeliverables(projectId, taskId, null, auth.user.id, now);
      this.recomputeAncestors(projectId, task.parent_id, auth.user.id, now);
      writeActivity(this.dependencies, { projectId, actorId: auth.user.id, entityType: "task", entityId: taskId, action: "task.reviewed" });
      return { task: toTask(this.requireTask(projectId, taskId)), scheduleRevision: this.bumpScheduleRevision(projectId) };
    });
  }

  reopenTask(auth: AuthenticatedSession, projectId: string, taskId: string, expectedRevision: number): { task: TaskEntity; scheduleRevision: number } {
    return this.dependencies.database.transaction(() => {
      this.requireProjectMember(auth, projectId);
      const task = this.requireTask(projectId, taskId);
      this.assertRevision("task", task, expectedRevision, toTask);
      if (task.status !== "done") throw new HttpError(409, "TASK_NOT_COMPLETED", "Only completed tasks can be reopened.", { latest: toTask(task) });
      let ancestorId = task.parent_id;
      while (ancestorId !== null) {
        const ancestor = this.requireTask(projectId, ancestorId);
        if (ancestor.status === "done") {
          throw new HttpError(
            409,
            "TASK_COMPLETED_ANCESTOR_LOCKED",
            "Completed parent tasks must be reopened before this task can be reopened.",
            { latest: toTask(ancestor) },
          );
        }
        ancestorId = ancestor.parent_id;
      }
      const now = this.dependencies.clock().toISOString();
      this.dependencies.database.run("UPDATE tasks SET status='pending_review', reviewed_at=NULL, reviewed_by=NULL, reopened_at=?, reopened_by=?, updated_by=?, updated_at=?, revision=revision+1 WHERE id=? AND project_id=? AND revision=?", [now, auth.user.id, auth.user.id, now, taskId, projectId, expectedRevision]);
      this.clearDeliverableAcceptance(projectId, taskId, null, auth.user.id, now);
      this.recomputeTaskAndAncestors(projectId, taskId, auth.user.id, now);
      writeActivity(this.dependencies, { projectId, actorId: auth.user.id, entityType: "task", entityId: taskId, action: "task.reopened" });
      return { task: toTask(this.requireTask(projectId, taskId)), scheduleRevision: this.bumpScheduleRevision(projectId) };
    });
  }

  createDependency(
    auth: AuthenticatedSession, projectId: string, successorTaskId: string, input: CreateDependencyRequest,
  ): { dependency: DependencyEntity; scheduleRevision: number } {
    return this.dependencies.database.transaction(() => {
      this.requireProjectMember(auth, projectId);
      const successor = this.requireTask(projectId, successorTaskId);
      this.assertTaskEditable(successor);
      const predecessor = this.requireTask(projectId, input.predecessorTaskId);
      this.assertTaskEditable(predecessor);
      if (createsDependencyCycle(this.dependencyRows(projectId).map((row) => ({ predecessorId: row.predecessor_task_id, successorId: row.successor_task_id })), predecessor.id, successor.id)) {
        throw new HttpError(409, "DEPENDENCY_CYCLE", "The dependency would create a cycle.");
      }
      const existing = this.dependencies.database.get<DependencyRow>(
        `SELECT id, project_id, predecessor_task_id, successor_task_id, created_at, revision, deleted_at
         FROM task_dependencies WHERE project_id=? AND predecessor_task_id=? AND successor_task_id=?`,
        [projectId, predecessor.id, successor.id],
      );
      const now = this.dependencies.clock().toISOString();
      let id: string;
      if (existing !== undefined) {
        if (existing.deleted_at === null) throw new HttpError(409, "DEPENDENCY_EXISTS", "The dependency already exists.", { latest: toDependency(existing) });
        if (input.expectedRevision === undefined || input.expectedRevision !== existing.revision) {
          throw new HttpError(409, "REVISION_CONFLICT", "The deleted dependency must be restored with its current revision.", { latest: toDependency(existing) });
        }
        this.dependencies.database.run("UPDATE task_dependencies SET deleted_at=NULL, deleted_by=NULL, created_by=?, created_at=?, revision=revision+1 WHERE id=? AND revision=?", [auth.user.id, now, existing.id, existing.revision]);
        id = existing.id;
      } else {
        id = this.dependencies.idGenerator();
        this.dependencies.database.run(
          `INSERT INTO task_dependencies (id, project_id, predecessor_task_id, successor_task_id, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`, [id, projectId, predecessor.id, successor.id, auth.user.id, now],
        );
      }
      writeActivity(this.dependencies, { projectId, actorId: auth.user.id, entityType: "dependency", entityId: id, action: "dependency.created" });
      return { dependency: toDependency(this.requireDependency(projectId, id)), scheduleRevision: this.bumpScheduleRevision(projectId) };
    });
  }

  deleteDependency(auth: AuthenticatedSession, projectId: string, dependencyId: string, expectedRevision: number): { deleted: true; scheduleRevision: number } {
    return this.dependencies.database.transaction(() => {
      this.requireProjectMember(auth, projectId);
      const dependency = this.requireDependency(projectId, dependencyId);
      this.assertRevision("dependency", dependency, expectedRevision, toDependency);
      this.assertTaskEditable(this.requireTask(projectId, dependency.predecessor_task_id));
      this.assertTaskEditable(this.requireTask(projectId, dependency.successor_task_id));
      const now = this.dependencies.clock().toISOString();
      const changed = this.dependencies.database.run(
        "UPDATE task_dependencies SET deleted_at=?, deleted_by=?, revision=revision+1 WHERE id=? AND project_id=? AND revision=? AND deleted_at IS NULL",
        [now, auth.user.id, dependencyId, projectId, expectedRevision],
      );
      if (changed.changes !== 1) this.throwLatestDependency(projectId, dependencyId);
      writeActivity(this.dependencies, { projectId, actorId: auth.user.id, entityType: "dependency", entityId: dependencyId, action: "dependency.deleted" });
      return { deleted: true, scheduleRevision: this.bumpScheduleRevision(projectId) };
    });
  }

  createMilestone(auth: AuthenticatedSession, projectId: string, input: CreateMilestoneRequest): { milestone: MilestoneEntity; scheduleRevision: number } {
    return this.dependencies.database.transaction(() => {
      this.requireProjectMember(auth, projectId);
      this.validatePhaseReference(projectId, input.phaseId ?? null);
      const id = this.dependencies.idGenerator(); const now = this.dependencies.clock().toISOString();
      this.dependencies.database.run(`INSERT INTO milestones (id, project_id, phase_id, title, description, due_date, status, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id, projectId, input.phaseId ?? null, input.title, input.description ?? "", input.dueDate, input.status ?? "not_started", auth.user.id, auth.user.id, now, now]);
      writeActivity(this.dependencies, { projectId, actorId: auth.user.id, entityType: "milestone", entityId: id, action: "milestone.created" });
      return { milestone: toMilestone(this.requireMilestone(projectId, id)), scheduleRevision: this.bumpScheduleRevision(projectId) };
    });
  }

  updateMilestone(auth: AuthenticatedSession, projectId: string, milestoneId: string, input: PatchMilestoneRequest): { milestone: MilestoneEntity; scheduleRevision: number } {
    return this.dependencies.database.transaction(() => {
      this.requireProjectMember(auth, projectId); const current = this.requireMilestone(projectId, milestoneId);
      this.assertRevision("milestone", current, input.expectedRevision, toMilestone);
      if (current.status === "done") throw new HttpError(409, "MILESTONE_COMPLETED_LOCKED", "The completed milestone must be reopened before it can be changed.", { latest: toMilestone(current) });
      const next = { phaseId: input.phaseId === undefined ? current.phase_id : input.phaseId, title: input.title ?? current.title, description: input.description ?? current.description, dueDate: input.dueDate ?? current.due_date, status: current.status === "pending_review" ? "in_progress" : input.status ?? current.status };
      this.validatePhaseReference(projectId, next.phaseId); const now = this.dependencies.clock().toISOString();
      const changed = this.dependencies.database.run("UPDATE milestones SET phase_id=?, title=?, description=?, due_date=?, status=?, updated_by=?, updated_at=?, revision=revision+1 WHERE id=? AND project_id=? AND revision=?", [next.phaseId, next.title, next.description, next.dueDate, next.status, auth.user.id, now, milestoneId, projectId, input.expectedRevision]);
      if (changed.changes !== 1) this.throwLatestMilestone(projectId, milestoneId);
      writeActivity(this.dependencies, { projectId, actorId: auth.user.id, entityType: "milestone", entityId: milestoneId, action: "milestone.updated" });
      return { milestone: toMilestone(this.requireMilestone(projectId, milestoneId)), scheduleRevision: this.bumpScheduleRevision(projectId) };
    });
  }

  submitMilestoneForReview(auth: AuthenticatedSession, projectId: string, milestoneId: string, expectedRevision: number): { milestone: MilestoneEntity; scheduleRevision: number } {
    return this.dependencies.database.transaction(() => {
      this.requireProjectMember(auth, projectId); const milestone = this.requireMilestone(projectId, milestoneId);
      this.assertRevision("milestone", milestone, expectedRevision, toMilestone);
      if (milestone.status === "done") this.assertMilestoneEditable(milestone);
      if (!this.areDeliverablesFulfilled(projectId, null, milestoneId)) throw new HttpError(409, "MILESTONE_DELIVERABLES_INCOMPLETE", "Required deliverables are incomplete.", { latest: toMilestone(milestone) });
      const now = this.dependencies.clock().toISOString();
      const changed = this.dependencies.database.run("UPDATE milestones SET status='pending_review', updated_by=?, updated_at=?, revision=revision+1 WHERE id=? AND project_id=? AND revision=? AND status <> 'pending_review'", [auth.user.id, now, milestoneId, projectId, expectedRevision]);
      if (changed.changes !== 1) this.throwLatestMilestone(projectId, milestoneId);
      writeActivity(this.dependencies, { projectId, actorId: auth.user.id, entityType: "milestone", entityId: milestoneId, action: "milestone.submitted_for_review" });
      return { milestone: toMilestone(this.requireMilestone(projectId, milestoneId)), scheduleRevision: this.bumpScheduleRevision(projectId) };
    });
  }

  reviewMilestone(auth: AuthenticatedSession, projectId: string, milestoneId: string, expectedRevision: number): { milestone: MilestoneEntity; scheduleRevision: number } {
    return this.dependencies.database.transaction(() => {
      this.requireProjectMember(auth, projectId); const milestone = this.requireMilestone(projectId, milestoneId);
      this.assertRevision("milestone", milestone, expectedRevision, toMilestone);
      if (milestone.status !== "pending_review") throw new HttpError(409, "MILESTONE_NOT_PENDING_REVIEW", "The milestone is not ready for review.", { latest: toMilestone(milestone) });
      if (!this.areDeliverablesFulfilled(projectId, null, milestoneId)) throw new HttpError(409, "MILESTONE_DELIVERABLES_INCOMPLETE", "Required deliverables are incomplete.", { latest: toMilestone(milestone) });
      const now = this.dependencies.clock().toISOString();
      this.dependencies.database.run("UPDATE milestones SET status='done', reviewed_at=?, reviewed_by=?, updated_by=?, updated_at=?, revision=revision+1 WHERE id=? AND project_id=? AND revision=?", [now, auth.user.id, auth.user.id, now, milestoneId, projectId, expectedRevision]);
      this.acceptDeliverables(projectId, null, milestoneId, auth.user.id, now);
      writeActivity(this.dependencies, { projectId, actorId: auth.user.id, entityType: "milestone", entityId: milestoneId, action: "milestone.reviewed" });
      return { milestone: toMilestone(this.requireMilestone(projectId, milestoneId)), scheduleRevision: this.bumpScheduleRevision(projectId) };
    });
  }

  reopenMilestone(auth: AuthenticatedSession, projectId: string, milestoneId: string, expectedRevision: number): { milestone: MilestoneEntity; scheduleRevision: number } {
    return this.dependencies.database.transaction(() => {
      this.requireProjectMember(auth, projectId); const milestone = this.requireMilestone(projectId, milestoneId);
      this.assertRevision("milestone", milestone, expectedRevision, toMilestone);
      if (milestone.status !== "done") throw new HttpError(409, "MILESTONE_NOT_COMPLETED", "Only completed milestones can be reopened.", { latest: toMilestone(milestone) });
      const now = this.dependencies.clock().toISOString();
      this.dependencies.database.run("UPDATE milestones SET status='in_progress', reviewed_at=NULL, reviewed_by=NULL, updated_by=?, updated_at=?, revision=revision+1 WHERE id=? AND project_id=? AND revision=?", [auth.user.id, now, milestoneId, projectId, expectedRevision]);
      this.clearDeliverableAcceptance(projectId, null, milestoneId, auth.user.id, now);
      writeActivity(this.dependencies, { projectId, actorId: auth.user.id, entityType: "milestone", entityId: milestoneId, action: "milestone.reopened" });
      return { milestone: toMilestone(this.requireMilestone(projectId, milestoneId)), scheduleRevision: this.bumpScheduleRevision(projectId) };
    });
  }

  deleteMilestone(auth: AuthenticatedSession, projectId: string, milestoneId: string, expectedRevision: number): { deleted: true; scheduleRevision: number } {
    return this.dependencies.database.transaction(() => {
      this.requireProjectMember(auth, projectId); const milestone = this.requireMilestone(projectId, milestoneId); this.assertRevision("milestone", milestone, expectedRevision, toMilestone);
      if (milestone.status === "done") throw new HttpError(409, "MILESTONE_COMPLETED_LOCKED", "The completed milestone must be reopened before it can be deleted.", { latest: toMilestone(milestone) });
      const changed = this.dependencies.database.run("DELETE FROM milestones WHERE id=? AND project_id=? AND revision=?", [milestoneId, projectId, expectedRevision]);
      if (changed.changes !== 1) this.throwLatestMilestone(projectId, milestoneId);
      writeActivity(this.dependencies, { projectId, actorId: auth.user.id, entityType: "milestone", entityId: milestoneId, action: "milestone.deleted" });
      return { deleted: true, scheduleRevision: this.bumpScheduleRevision(projectId) };
    });
  }

  createDeliverable(auth: AuthenticatedSession, projectId: string, owner: { taskId?: string; milestoneId?: string }, input: CreateDeliverableRequest): { deliverable: DeliverableEntity; scheduleRevision: number } {
    return this.dependencies.database.transaction(() => {
      this.requireProjectMember(auth, projectId); const taskId = owner.taskId ?? null; const milestoneId = owner.milestoneId ?? null;
      if ((taskId === null) === (milestoneId === null)) throw new HttpError(400, "DELIVERABLE_OWNER_INVALID", "A deliverable must have exactly one owner.");
      if (taskId !== null) this.assertTaskEditable(this.requireTask(projectId, taskId));
      if (milestoneId !== null) this.assertMilestoneEditable(this.requireMilestone(projectId, milestoneId));
      const id = this.dependencies.idGenerator(); const now = this.dependencies.clock().toISOString();
      this.dependencies.database.run("INSERT INTO deliverable_requirements (id, project_id, task_id, milestone_id, title, description, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [id, projectId, taskId, milestoneId, input.title, input.description ?? "", auth.user.id, auth.user.id, now, now]);
      if (taskId !== null) this.recomputeTaskAndAncestors(projectId, taskId, auth.user.id, now);
      if (milestoneId !== null) this.invalidateMilestoneSubmission(projectId, milestoneId, auth.user.id, now);
      writeActivity(this.dependencies, { projectId, actorId: auth.user.id, entityType: "deliverable", entityId: id, action: "deliverable.created" });
      return { deliverable: toDeliverable(this.requireDeliverable(projectId, id)), scheduleRevision: this.bumpScheduleRevision(projectId) };
    });
  }

  updateDeliverable(auth: AuthenticatedSession, projectId: string, deliverableId: string, input: PatchDeliverableRequest): { deliverable: DeliverableEntity; scheduleRevision: number } {
    return this.dependencies.database.transaction(() => {
      this.requireProjectMember(auth, projectId); const current = this.requireDeliverable(projectId, deliverableId);
      this.assertRevision("deliverable", current, input.expectedRevision, toDeliverable);
      if (current.task_id !== null) this.assertTaskEditable(this.requireTask(projectId, current.task_id));
      if (current.milestone_id !== null) this.assertMilestoneEditable(this.requireMilestone(projectId, current.milestone_id));
      const now = this.dependencies.clock().toISOString(); const changed = this.dependencies.database.run("UPDATE deliverable_requirements SET title=?, description=?, updated_by=?, updated_at=?, revision=revision+1 WHERE id=? AND project_id=? AND revision=?", [input.title ?? current.title, input.description ?? current.description, auth.user.id, now, deliverableId, projectId, input.expectedRevision]);
      if (changed.changes !== 1) this.throwLatestDeliverable(projectId, deliverableId);
      if (current.task_id !== null) this.recomputeTaskAndAncestors(projectId, current.task_id, auth.user.id, now);
      if (current.milestone_id !== null) this.invalidateMilestoneSubmission(projectId, current.milestone_id, auth.user.id, now);
      writeActivity(this.dependencies, { projectId, actorId: auth.user.id, entityType: "deliverable", entityId: deliverableId, action: "deliverable.updated" });
      return { deliverable: toDeliverable(this.requireDeliverable(projectId, deliverableId)), scheduleRevision: this.bumpScheduleRevision(projectId) };
    });
  }

  deleteDeliverable(auth: AuthenticatedSession, projectId: string, deliverableId: string, expectedRevision: number): { deleted: true; scheduleRevision: number } {
    return this.dependencies.database.transaction(() => {
      this.requireProjectMember(auth, projectId); const current = this.requireDeliverable(projectId, deliverableId);
      this.assertRevision("deliverable", current, expectedRevision, toDeliverable);
      if (current.task_id !== null) this.assertTaskEditable(this.requireTask(projectId, current.task_id));
      if (current.milestone_id !== null) this.assertMilestoneEditable(this.requireMilestone(projectId, current.milestone_id));
      const changed = this.dependencies.database.run("DELETE FROM deliverable_requirements WHERE id=? AND project_id=? AND revision=?", [deliverableId, projectId, expectedRevision]);
      if (changed.changes !== 1) this.throwLatestDeliverable(projectId, deliverableId);
      const now = this.dependencies.clock().toISOString(); if (current.task_id !== null) this.recomputeTaskAndAncestors(projectId, current.task_id, auth.user.id, now);
      if (current.milestone_id !== null) this.invalidateMilestoneSubmission(projectId, current.milestone_id, auth.user.id, now);
      writeActivity(this.dependencies, { projectId, actorId: auth.user.id, entityType: "deliverable", entityId: deliverableId, action: "deliverable.deleted" });
      return { deleted: true, scheduleRevision: this.bumpScheduleRevision(projectId) };
    });
  }

  fulfillDeliverable(auth: AuthenticatedSession, projectId: string, deliverableId: string, input: FulfillDeliverableRequest): { deliverable: DeliverableEntity; task: TaskEntity | null; milestone: MilestoneEntity | null; scheduleRevision: number } {
    return this.dependencies.database.transaction(() => {
      this.requireProjectMember(auth, projectId);
      const deliverable = this.requireDeliverable(projectId, deliverableId);
      this.assertRevision("deliverable", deliverable, input.expectedRevision, toDeliverable);
      this.assertDeliverableOwnerEditable(projectId, deliverable);
      const resource = this.dependencies.database.get<{ id: string; version_id: string }>(
        `SELECT resources.id, resource_versions.id AS version_id
           FROM resources
           JOIN resource_versions
             ON resource_versions.resource_id=resources.id
            AND resource_versions.version_number=resources.current_version_number
          WHERE resources.id=? AND resources.project_id=?
            AND resources.archived_at IS NULL AND resources.deleted_at IS NULL`,
        [input.resourceId, projectId],
      );
      if (resource === undefined) throw new HttpError(404, "RESOURCE_NOT_FOUND", "The active versioned project resource was not found.");
      const now = this.dependencies.clock().toISOString();
      const changed = this.dependencies.database.run(
        `UPDATE deliverable_requirements
            SET fulfilled_resource_id=?, fulfilled_resource_version_id=?, fulfilled_at=?, fulfilled_by=?, accepted_at=NULL, accepted_by=NULL,
                updated_by=?, updated_at=?, revision=revision+1
          WHERE id=? AND project_id=? AND revision=?`,
        [input.resourceId, resource.version_id, now, auth.user.id, auth.user.id, now, deliverableId, projectId, input.expectedRevision],
      );
      if (changed.changes !== 1) this.throwLatestDeliverable(projectId, deliverableId);
      if (deliverable.task_id !== null) this.recomputeTaskAndAncestors(projectId, deliverable.task_id, auth.user.id, now);
      if (deliverable.milestone_id !== null) this.invalidateMilestoneSubmission(projectId, deliverable.milestone_id, auth.user.id, now);
      writeActivity(this.dependencies, { projectId, actorId: auth.user.id, entityType: "deliverable", entityId: deliverableId, action: "deliverable.fulfilled" });
      return { deliverable: toDeliverable(this.requireDeliverable(projectId, deliverableId)), task: deliverable.task_id === null ? null : toTask(this.requireTask(projectId, deliverable.task_id)), milestone: deliverable.milestone_id === null ? null : toMilestone(this.requireMilestone(projectId, deliverable.milestone_id)), scheduleRevision: this.bumpScheduleRevision(projectId) };
    });
  }

  unfulfillDeliverable(auth: AuthenticatedSession, projectId: string, deliverableId: string, expectedRevision: number): { deliverable: DeliverableEntity; task: TaskEntity | null; milestone: MilestoneEntity | null; scheduleRevision: number } {
    return this.dependencies.database.transaction(() => {
      this.requireProjectMember(auth, projectId);
      const deliverable = this.requireDeliverable(projectId, deliverableId);
      this.assertRevision("deliverable", deliverable, expectedRevision, toDeliverable);
      this.assertDeliverableOwnerEditable(projectId, deliverable);
      const now = this.dependencies.clock().toISOString();
      const changed = this.dependencies.database.run(
        `UPDATE deliverable_requirements
            SET fulfilled_resource_id=NULL, fulfilled_resource_version_id=NULL, fulfilled_at=NULL, fulfilled_by=NULL, accepted_at=NULL, accepted_by=NULL,
                updated_by=?, updated_at=?, revision=revision+1
          WHERE id=? AND project_id=? AND revision=?`,
        [auth.user.id, now, deliverableId, projectId, expectedRevision],
      );
      if (changed.changes !== 1) this.throwLatestDeliverable(projectId, deliverableId);
      if (deliverable.task_id !== null) this.recomputeTaskAndAncestors(projectId, deliverable.task_id, auth.user.id, now);
      if (deliverable.milestone_id !== null) this.invalidateMilestoneSubmission(projectId, deliverable.milestone_id, auth.user.id, now);
      writeActivity(this.dependencies, { projectId, actorId: auth.user.id, entityType: "deliverable", entityId: deliverableId, action: "deliverable.unfulfilled" });
      return { deliverable: toDeliverable(this.requireDeliverable(projectId, deliverableId)), task: deliverable.task_id === null ? null : toTask(this.requireTask(projectId, deliverable.task_id)), milestone: deliverable.milestone_id === null ? null : toMilestone(this.requireMilestone(projectId, deliverable.milestone_id)), scheduleRevision: this.bumpScheduleRevision(projectId) };
    });
  }

  createRecurringRule(auth: AuthenticatedSession, projectId: string, input: CreateRecurringRuleRequest): { rule: RecurringRuleEntity; scheduleRevision: number } {
    return this.dependencies.database.transaction(() => {
      this.requireProjectMember(auth, projectId); const source = this.requireTask(projectId, input.sourceTaskId); this.assertTaskEditable(source);
      const id = this.dependencies.idGenerator(); const now = this.dependencies.clock().toISOString();
      const nextOccurrence = firstOccurrenceOnOrAfter(input.startsOn, input.frequency === "weekly" ? { frequency: "weekly", intervalCount: input.intervalCount, dayOfWeek: input.dayOfWeek } : { frequency: "monthly", intervalCount: input.intervalCount, dayOfMonth: input.dayOfMonth });
      this.dependencies.database.run(`INSERT INTO recurring_task_rules (id, project_id, source_task_id, frequency, interval_count, day_of_week, day_of_month, starts_on, ends_on, next_occurrence_on, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id, projectId, source.id, input.frequency, input.intervalCount, input.frequency === "weekly" ? input.dayOfWeek : null, input.frequency === "monthly" ? input.dayOfMonth : null, input.startsOn, input.endsOn ?? null, nextOccurrence, auth.user.id, auth.user.id, now, now]);
      writeActivity(this.dependencies, { projectId, actorId: auth.user.id, entityType: "recurring_rule", entityId: id, action: "recurring_rule.created" });
      return { rule: toRecurringRule(this.requireRule(projectId, id)), scheduleRevision: this.bumpScheduleRevision(projectId) };
    });
  }

  updateRecurringRule(auth: AuthenticatedSession, projectId: string, ruleId: string, input: PatchRecurringRuleRequest): { rule: RecurringRuleEntity; scheduleRevision: number } {
    return this.dependencies.database.transaction(() => {
      this.requireProjectMember(auth, projectId); const current = this.requireRule(projectId, ruleId); this.assertRevision("recurring rule", current, input.expectedRevision, toRecurringRule);
      const frequency = input.frequency ?? current.frequency; const intervalCount = input.intervalCount ?? current.interval_count;
      const dayOfWeek = frequency === "weekly" ? (input.dayOfWeek === undefined ? current.day_of_week : input.dayOfWeek) : null;
      const dayOfMonth = frequency === "monthly" ? (input.dayOfMonth === undefined ? current.day_of_month : input.dayOfMonth) : null;
      if ((frequency === "weekly" && dayOfWeek === null) || (frequency === "monthly" && dayOfMonth === null)) throw new HttpError(400, "RECURRENCE_PATTERN_INVALID", "The selected recurrence frequency requires its day field.");
      const startsOn = input.startsOn ?? current.starts_on; const endsOn = input.endsOn === undefined ? current.ends_on : input.endsOn;
      if (endsOn !== null && startsOn > endsOn) throw new HttpError(400, "DATE_RANGE_INVALID", "The rule start date must not be after its end date.");
      const isActive = input.isActive === undefined
        ? current.is_active
        : Number(input.isActive);
      if (isActive === 1) {
        this.requireTask(projectId, current.source_task_id);
      }
      const pattern = frequency === "weekly" ? { frequency, intervalCount, dayOfWeek: dayOfWeek! } : { frequency, intervalCount, dayOfMonth: dayOfMonth! };
      const latestOccurrence = this.dependencies.database.get<{ occurrence_date: string | null }>(
        "SELECT MAX(occurrence_date) AS occurrence_date FROM tasks WHERE project_id=? AND recurring_rule_id=?",
        [projectId, ruleId],
      )?.occurrence_date ?? null;
      const generatedFrontier = [latestOccurrence, current.last_generated_on]
        .filter((value): value is string => value !== null)
        .sort()
        .at(-1) ?? null;
      const firstCandidate = firstOccurrenceOnOrAfter(startsOn, pattern);
      const nextOccurrence = generatedFrontier === null
        ? firstCandidate
        : this.firstOccurrenceStrictlyAfter(startsOn, generatedFrontier, pattern);
      const now = this.dependencies.clock().toISOString(); const changed = this.dependencies.database.run(`UPDATE recurring_task_rules SET frequency=?, interval_count=?, day_of_week=?, day_of_month=?, starts_on=?, ends_on=?, next_occurrence_on=?, is_active=?, updated_by=?, updated_at=?, revision=revision+1 WHERE id=? AND project_id=? AND revision=?`, [frequency, intervalCount, dayOfWeek, dayOfMonth, startsOn, endsOn, nextOccurrence, isActive, auth.user.id, now, ruleId, projectId, input.expectedRevision]);
      if (changed.changes !== 1) this.throwLatestRule(projectId, ruleId);
      writeActivity(this.dependencies, { projectId, actorId: auth.user.id, entityType: "recurring_rule", entityId: ruleId, action: "recurring_rule.updated" });
      return { rule: toRecurringRule(this.requireRule(projectId, ruleId)), scheduleRevision: this.bumpScheduleRevision(projectId) };
    });
  }

  deleteRecurringRule(auth: AuthenticatedSession, projectId: string, ruleId: string, expectedRevision: number): { deleted: true; scheduleRevision: number } {
    return this.dependencies.database.transaction(() => {
      this.requireProjectMember(auth, projectId); const rule = this.requireRule(projectId, ruleId); this.assertRevision("recurring rule", rule, expectedRevision, toRecurringRule);
      if (rule.is_active !== 1) throw new HttpError(409, "REVISION_CONFLICT", "The recurring rule was already deactivated.", { latest: toRecurringRule(rule) });
      const changed = this.dependencies.database.run("UPDATE recurring_task_rules SET is_active=0, updated_by=?, updated_at=?, revision=revision+1 WHERE id=? AND project_id=? AND revision=? AND is_active=1", [auth.user.id, this.dependencies.clock().toISOString(), ruleId, projectId, expectedRevision]);
      if (changed.changes !== 1) this.throwLatestRule(projectId, ruleId);
      writeActivity(this.dependencies, { projectId, actorId: auth.user.id, entityType: "recurring_rule", entityId: ruleId, action: "recurring_rule.deleted" });
      return { deleted: true, scheduleRevision: this.bumpScheduleRevision(projectId) };
    });
  }

  generateRecurringInstances(auth: AuthenticatedSession, projectId: string, ruleId: string, expectedRevision: number, throughDate: string): { tasks: TaskEntity[]; rule: RecurringRuleEntity; scheduleRevision: number } {
    return this.dependencies.database.transaction(() => {
      this.requireProjectMember(auth, projectId); const rule = this.requireRule(projectId, ruleId); this.assertRevision("recurring rule", rule, expectedRevision, toRecurringRule);
      if (rule.is_active !== 1) return { tasks: [], rule: toRecurringRule(rule), scheduleRevision: this.requireProjectMember(auth, projectId).schedule_revision };
      const pattern = rule.frequency === "weekly" ? { frequency: "weekly" as const, intervalCount: rule.interval_count, dayOfWeek: rule.day_of_week! } : { frequency: "monthly" as const, intervalCount: rule.interval_count, dayOfMonth: rule.day_of_month! };
      let generated; try { generated = enumerateOccurrences({ ...pattern, nextOccurrenceOn: rule.next_occurrence_on, endsOn: rule.ends_on }, throughDate); } catch (error) { throw new HttpError(400, "RECURRENCE_GENERATION_LIMIT", error instanceof Error ? error.message : "Recurring generation failed."); }
      if (generated.dates.length === 0) return { tasks: [], rule: toRecurringRule(rule), scheduleRevision: this.requireProjectMember(auth, projectId).schedule_revision };
      const source = this.requireTask(projectId, rule.source_task_id); const now = this.dependencies.clock().toISOString(); const tasks: TaskEntity[] = [];
      const participants = this.activeParticipantRowsForTask(projectId, source.id);
      const deliverables = this.dependencies.database.all<DeliverableRow>(
        `SELECT id, project_id, task_id, milestone_id, title, description, fulfilled_resource_id, fulfilled_resource_version_id,
                fulfilled_at, fulfilled_by, accepted_at, accepted_by, created_at, updated_at, revision
           FROM deliverable_requirements
          WHERE project_id=? AND task_id=?`,
        [projectId, source.id],
      );
      for (const participant of participants) this.requireEnabledActiveProjectMember(projectId, participant.user_id);
      for (const occurrenceDate of generated.dates) {
        const id = this.dependencies.idGenerator();
        const inserted = this.dependencies.database.run(`INSERT OR IGNORE INTO tasks (id, project_id, phase_id, parent_id, recurring_rule_id, occurrence_date, title, description, position, start_date, due_date, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id, projectId, source.phase_id, ruleId, occurrenceDate, source.title, source.description, this.nextPosition("tasks", projectId), this.dateWithOffset(occurrenceDate, this.dateOffset(rule.starts_on, source.start_date)), this.dateWithOffset(occurrenceDate, this.dateOffset(rule.starts_on, source.due_date)), auth.user.id, auth.user.id, now, now]);
        if (inserted.changes !== 1) continue;
        for (const participant of participants) this.dependencies.database.run(`INSERT INTO task_participants (id, project_id, task_id, user_id, start_date, end_date, estimated_minutes, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [this.dependencies.idGenerator(), projectId, id, participant.user_id, this.dateWithOffset(occurrenceDate, this.dateOffset(rule.starts_on, participant.start_date))!, this.dateWithOffset(occurrenceDate, this.dateOffset(rule.starts_on, participant.end_date))!, participant.estimated_minutes, auth.user.id, auth.user.id, now, now]);
        for (const deliverable of deliverables) this.dependencies.database.run(`INSERT INTO deliverable_requirements (id, project_id, task_id, milestone_id, title, description, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`, [this.dependencies.idGenerator(), projectId, id, deliverable.title, deliverable.description, auth.user.id, auth.user.id, now, now]);
        tasks.push(toTask(this.requireTask(projectId, id)));
      }
      const advanced = this.dependencies.database.run("UPDATE recurring_task_rules SET next_occurrence_on=?, last_generated_on=?, updated_by=?, updated_at=?, revision=revision+1 WHERE id=? AND project_id=? AND revision=?", [generated.nextOccurrenceOn, generated.dates.at(-1)!, auth.user.id, now, ruleId, projectId, expectedRevision]);
      if (advanced.changes !== 1) this.throwLatestRule(projectId, ruleId);
      writeActivity(this.dependencies, { projectId, actorId: auth.user.id, entityType: "recurring_rule", entityId: ruleId, action: "recurring_rule.generated" });
      return { tasks, rule: toRecurringRule(this.requireRule(projectId, ruleId)), scheduleRevision: this.bumpScheduleRevision(projectId) };
    });
  }

  listTemplates(auth: AuthenticatedSession): { builtIn: typeof BUILT_IN_TEMPLATES; team: TeamTemplateEntity[] } {
    this.requireTeamMember(auth.user.id);
    return { builtIn: BUILT_IN_TEMPLATES, team: this.dependencies.database.all<TeamTemplateRow>("SELECT id, name, anchor_semantics, payload_json, created_at, updated_at, revision, archived_at FROM team_schedule_templates WHERE archived_at IS NULL ORDER BY name COLLATE NOCASE, id").map(toTeamTemplate) };
  }

  saveTeamTemplate(auth: AuthenticatedSession, projectId: string, input: SaveTeamTemplateRequest): { template: TeamTemplateEntity; scheduleRevision: number } {
    return this.dependencies.database.transaction(() => {
      this.requireProjectMember(auth, projectId);
      this.assertTemplateNameAvailable(input.name);
      const schedule = this.schedule(auth, projectId); const id = this.dependencies.idGenerator(); const now = this.dependencies.clock().toISOString();
      const payload = buildTemplatePayload({ phases: schedule.phases, tasks: schedule.tasks, dependencies: schedule.dependencies, milestones: schedule.milestones, deliverableRequirements: schedule.deliverableRequirements }, input.anchorDate);
      this.dependencies.database.run("INSERT INTO team_schedule_templates (id, name, payload_json, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [id, input.name, JSON.stringify(payload), auth.user.id, auth.user.id, now, now]);
      writeActivity(this.dependencies, { projectId, actorId: auth.user.id, entityType: "schedule_template", entityId: id, action: "template.saved" });
      return { template: toTeamTemplate(this.requireTemplate(id)), scheduleRevision: this.requireProjectMember(auth, projectId).schedule_revision };
    });
  }

  updateTeamTemplate(auth: AuthenticatedSession, templateId: string, input: UpdateTeamTemplateRequest): TeamTemplateEntity {
    return this.dependencies.database.transaction(() => {
      this.requireTeamMember(auth.user.id); const current = this.requireTemplate(templateId); this.assertRevision("template", current, input.expectedRevision, toTeamTemplate);
      const name = input.name ?? current.name;
      this.assertTemplateNameAvailable(name, templateId);
      const now = this.dependencies.clock().toISOString(); const changed = this.dependencies.database.run("UPDATE team_schedule_templates SET name=?, updated_by=?, updated_at=?, revision=revision+1 WHERE id=? AND revision=? AND archived_at IS NULL", [name, auth.user.id, now, templateId, input.expectedRevision]);
      if (changed.changes !== 1) this.throwLatestTemplate(templateId);
      writeActivity(this.dependencies, { actorId: auth.user.id, entityType: "schedule_template", entityId: templateId, action: "template.updated" });
      return toTeamTemplate(this.requireTemplate(templateId));
    });
  }

  archiveTeamTemplate(auth: AuthenticatedSession, templateId: string, expectedRevision: number): { archived: true } {
    return this.dependencies.database.transaction(() => {
      this.requireTeamMember(auth.user.id); const current = this.requireTemplate(templateId); this.assertRevision("template", current, expectedRevision, toTeamTemplate);
      const now = this.dependencies.clock().toISOString(); const changed = this.dependencies.database.run("UPDATE team_schedule_templates SET archived_at=?, archived_by=?, updated_by=?, updated_at=?, revision=revision+1 WHERE id=? AND revision=? AND archived_at IS NULL", [now, auth.user.id, auth.user.id, now, templateId, expectedRevision]);
      if (changed.changes !== 1) this.throwLatestTemplate(templateId);
      writeActivity(this.dependencies, { actorId: auth.user.id, entityType: "schedule_template", entityId: templateId, action: "template.archived" });
      return { archived: true };
    });
  }

  applyTemplate(auth: AuthenticatedSession, projectId: string, templateId: string, input: ApplyTemplateRequest): { scheduleRevision: number } {
    return this.dependencies.database.transaction(() => {
      this.requireProjectMember(auth, projectId);
      const payload = templateId.startsWith("builtin-") ? BUILT_IN_TEMPLATES.find((template) => template.id === templateId)?.payload : this.requireTemplate(templateId).payload_json;
      if (payload === undefined) throw new HttpError(404, "TEMPLATE_NOT_FOUND", "The template was not found.");
      const instance = instantiateTemplate(typeof payload === "string" ? TeamTemplatePayloadSchema.parse(JSON.parse(payload)) : payload, input.anchorDate);
      const now = this.dependencies.clock().toISOString();
      const phaseIds = new Map(instance.phases.map((phase) => [phase.key, this.dependencies.idGenerator()]));
      const taskIds = new Map(instance.tasks.map((task) => [task.key, this.dependencies.idGenerator()]));
      const milestoneIds = new Map(instance.milestones.map((milestone) => [milestone.key, this.dependencies.idGenerator()]));
      for (const phase of instance.phases) this.dependencies.database.run("INSERT INTO phases (id, project_id, name, description, position, start_date, end_date, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [phaseIds.get(phase.key)!, projectId, phase.name, phase.description, phase.position, phase.startDate, phase.endDate, auth.user.id, auth.user.id, now, now]);
      const pendingTasks = [...instance.tasks];
      const insertedTaskKeys = new Set<string>();
      while (pendingTasks.length > 0) {
        let insertedThisPass = 0;
        for (let index = pendingTasks.length - 1; index >= 0; index -= 1) {
          const task = pendingTasks[index]!;
          if (task.parentKey !== null && !insertedTaskKeys.has(task.parentKey)) continue;
          this.dependencies.database.run("INSERT INTO tasks (id, project_id, phase_id, parent_id, title, description, position, start_date, due_date, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [taskIds.get(task.key)!, projectId, task.phaseKey === null ? null : phaseIds.get(task.phaseKey)!, task.parentKey === null ? null : taskIds.get(task.parentKey)!, task.title, task.description, task.position, task.startDate, task.dueDate, auth.user.id, auth.user.id, now, now]);
          insertedTaskKeys.add(task.key); pendingTasks.splice(index, 1); insertedThisPass += 1;
        }
        if (insertedThisPass === 0) throw new HttpError(400, "TEMPLATE_PARENT_CYCLE", "The template task parents cannot be applied.");
      }
      for (const milestone of instance.milestones) this.dependencies.database.run("INSERT INTO milestones (id, project_id, phase_id, title, description, due_date, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [milestoneIds.get(milestone.key)!, projectId, milestone.phaseKey === null ? null : phaseIds.get(milestone.phaseKey)!, milestone.title, milestone.description, milestone.dueDate, auth.user.id, auth.user.id, now, now]);
      for (const edge of instance.dependencies) this.dependencies.database.run("INSERT INTO task_dependencies (id, project_id, predecessor_task_id, successor_task_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)", [this.dependencies.idGenerator(), projectId, taskIds.get(edge.predecessorTaskKey)!, taskIds.get(edge.successorTaskKey)!, auth.user.id, now]);
      for (const requirement of instance.deliverableRequirements) this.dependencies.database.run("INSERT INTO deliverable_requirements (id, project_id, task_id, milestone_id, title, description, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [this.dependencies.idGenerator(), projectId, requirement.ownerType === "task" ? taskIds.get(requirement.ownerKey)! : null, requirement.ownerType === "milestone" ? milestoneIds.get(requirement.ownerKey)! : null, requirement.title, requirement.description, auth.user.id, auth.user.id, now, now]);
      writeActivity(this.dependencies, { projectId, actorId: auth.user.id, entityType: "schedule_template", entityId: templateId, action: "template.applied" });
      return { scheduleRevision: this.bumpScheduleRevision(projectId) };
    });
  }

  private requireActiveProjectMember(projectId: string, userId: string): void {
    const member = this.dependencies.database.get<{ user_id: string }>(
      "SELECT user_id FROM project_members WHERE project_id=? AND user_id=? AND removed_at IS NULL",
      [projectId, userId],
    );
    if (member === undefined) throw new HttpError(409, "PROJECT_MEMBER_REQUIRED", "The assignee must be an active project member.");
  }

  private requireEnabledActiveProjectMember(projectId: string, userId: string): void {
    const member = this.dependencies.database.get<{ user_id: string }>(
      `SELECT project_members.user_id FROM project_members
       JOIN users ON users.id=project_members.user_id
       WHERE project_members.project_id=? AND project_members.user_id=?
         AND project_members.removed_at IS NULL AND users.disabled_at IS NULL`,
      [projectId, userId],
    );
    if (member === undefined) throw new HttpError(409, "RECURRENCE_PARTICIPANT_UNAVAILABLE", "A recurring source participant is no longer an active enabled project member.");
  }

  private activeParticipantRowsForTask(projectId: string, taskId: string): ParticipantRow[] {
    return this.dependencies.database.all<ParticipantRow>(
      `SELECT task_participants.id, task_participants.project_id, task_participants.task_id,
              task_participants.user_id, users.username, users.display_name, project_members.color,
              task_participants.start_date, task_participants.end_date, task_participants.estimated_minutes,
              task_participants.progress_percent, task_participants.status, task_participants.removed_at,
              task_participants.created_at, task_participants.updated_at, task_participants.revision
         FROM task_participants
         JOIN users ON users.id=task_participants.user_id
         JOIN project_members ON project_members.project_id=task_participants.project_id AND project_members.user_id=task_participants.user_id
        WHERE task_participants.project_id=? AND task_participants.task_id=? AND task_participants.removed_at IS NULL`,
      [projectId, taskId],
    );
  }

  private dateOffset(anchorDate: string, value: string | null): number | null {
    if (value === null) return null;
    return Math.round((Date.parse(`${value}T00:00:00.000Z`) - Date.parse(`${anchorDate}T00:00:00.000Z`)) / 86_400_000);
  }

  private dateWithOffset(anchorDate: string, offset: number | null): string | null {
    if (offset === null) return null;
    return new Date(Date.parse(`${anchorDate}T00:00:00.000Z`) + offset * 86_400_000).toISOString().slice(0, 10);
  }

  private firstOccurrenceStrictlyAfter(
    startsOn: string,
    frontier: string,
    pattern: Parameters<typeof nextOccurrenceAfter>[1],
  ): string {
    let candidate = firstOccurrenceOnOrAfter(startsOn, pattern);
    while (candidate <= frontier) {
      candidate = nextOccurrenceAfter(candidate, pattern);
    }
    return candidate;
  }

  private requireTeamMember(userId: string): void {
    const member = this.dependencies.database.get<{ user_id: string }>(
      "SELECT user_id FROM team_members WHERE user_id=? AND removed_at IS NULL", [userId],
    );
    if (member === undefined) throw new HttpError(403, "TEAM_MEMBERSHIP_REQUIRED", "An active team membership is required.");
  }

  private requireParticipant(projectId: string, participantId: string): ParticipantRow {
    const row = this.participantRow(projectId, participantId);
    if (row === undefined) throw new HttpError(404, "PARTICIPANT_NOT_FOUND", "The participant was not found.");
    if (row.removed_at !== null) {
      throw new HttpError(409, "REVISION_CONFLICT", "The participant was removed on another client.", { latest: toParticipant(row) });
    }
    return row;
  }

  private participantRow(projectId: string, participantId: string): ParticipantRow | undefined {
    return this.dependencies.database.get<ParticipantRow>(
      `SELECT task_participants.id, task_participants.project_id, task_participants.task_id,
              task_participants.user_id, users.username, users.display_name, project_members.color,
              task_participants.start_date, task_participants.end_date, task_participants.estimated_minutes,
              task_participants.progress_percent, task_participants.status, task_participants.removed_at, task_participants.created_at,
              task_participants.updated_at, task_participants.revision
         FROM task_participants JOIN users ON users.id=task_participants.user_id
         JOIN project_members ON project_members.project_id=task_participants.project_id AND project_members.user_id=task_participants.user_id
        WHERE task_participants.project_id=? AND task_participants.id=?`, [projectId, participantId],
    );
  }

  private requireDependency(projectId: string, dependencyId: string): DependencyRow {
    const row = this.dependencies.database.get<DependencyRow>(
      `SELECT id, project_id, predecessor_task_id, successor_task_id, created_at, revision, deleted_at
         FROM task_dependencies WHERE project_id=? AND id=?`, [projectId, dependencyId],
    );
    if (row === undefined) throw new HttpError(404, "DEPENDENCY_NOT_FOUND", "The dependency was not found.");
    if (row.deleted_at !== null) throw new HttpError(409, "REVISION_CONFLICT", "The dependency was deleted on another client.", { latest: toDependency(row) });
    return row;
  }

  private requireMilestone(projectId: string, milestoneId: string): MilestoneRow {
    const row = this.dependencies.database.get<MilestoneRow>(
      `SELECT id, project_id, phase_id, title, description, due_date, status, reviewed_at, reviewed_by, created_at, updated_at, revision
         FROM milestones WHERE project_id=? AND id=?`, [projectId, milestoneId],
    );
    if (row === undefined) throw new HttpError(404, "MILESTONE_NOT_FOUND", "The milestone was not found.");
    return row;
  }

  private requireDeliverable(projectId: string, deliverableId: string): DeliverableRow {
    const row = this.dependencies.database.get<DeliverableRow>(
      `SELECT id, project_id, task_id, milestone_id, title, description, fulfilled_resource_id, fulfilled_resource_version_id,
              fulfilled_at, fulfilled_by, accepted_at, accepted_by, created_at, updated_at, revision
         FROM deliverable_requirements WHERE project_id=? AND id=?`, [projectId, deliverableId],
    );
    if (row === undefined) throw new HttpError(404, "DELIVERABLE_NOT_FOUND", "The deliverable was not found.");
    return row;
  }

  private requireRule(projectId: string, ruleId: string): RecurringRuleRow {
    const row = this.dependencies.database.get<RecurringRuleRow>(
      `SELECT id, project_id, source_task_id, frequency, interval_count, day_of_week, day_of_month,
              starts_on, ends_on, next_occurrence_on, last_generated_on, is_active, created_at, updated_at, revision
         FROM recurring_task_rules WHERE project_id=? AND id=?`, [projectId, ruleId],
    );
    if (row === undefined) throw new HttpError(404, "RECURRING_RULE_NOT_FOUND", "The recurring rule was not found.");
    return row;
  }

  private requireTemplate(templateId: string): TeamTemplateRow {
    const row = this.dependencies.database.get<TeamTemplateRow>(
      "SELECT id, name, anchor_semantics, payload_json, created_at, updated_at, revision, archived_at FROM team_schedule_templates WHERE id=?", [templateId],
    );
    if (row === undefined) throw new HttpError(404, "TEMPLATE_NOT_FOUND", "The template was not found.");
    if (row.archived_at !== null) throw new HttpError(409, "REVISION_CONFLICT", "The template was archived on another client.", { latest: toTeamTemplate(row) });
    return row;
  }

  private assertTemplateNameAvailable(name: string, excludedId?: string): void {
    const existing = this.dependencies.database.get<{ id: string }>(
      `SELECT id FROM team_schedule_templates
        WHERE name = ? COLLATE NOCASE AND archived_at IS NULL
          AND (? IS NULL OR id <> ?)
        LIMIT 1`,
      [name, excludedId ?? null, excludedId ?? null],
    );
    if (existing !== undefined) {
      throw new HttpError(
        409,
        "TEMPLATE_NAME_CONFLICT",
        "An active team template already uses this name.",
        { fieldErrors: { name: ["Choose a different team template name."] } },
      );
    }
  }

  private areDeliverablesFulfilled(projectId: string, taskId: string | null, milestoneId: string | null): boolean {
    const missing = this.dependencies.database.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM deliverable_requirements
        WHERE project_id=? AND task_id IS ? AND milestone_id IS ?
          AND (fulfilled_resource_id IS NULL OR fulfilled_resource_version_id IS NULL OR fulfilled_at IS NULL)`, [projectId, taskId, milestoneId],
    )!;
    return missing.count === 0;
  }

  private assertMilestoneEditable(milestone: MilestoneRow): void {
    if (milestone.status === "done") {
      throw new HttpError(409, "MILESTONE_COMPLETED_LOCKED", "The completed milestone must be reopened before it can be changed.", { latest: toMilestone(milestone) });
    }
  }

  private assertDeliverableOwnerEditable(projectId: string, deliverable: DeliverableRow): { task: TaskRow | null; milestone: MilestoneRow | null } {
    const task = deliverable.task_id === null ? null : this.requireTask(projectId, deliverable.task_id);
    const milestone = deliverable.milestone_id === null ? null : this.requireMilestone(projectId, deliverable.milestone_id);
    if (task !== null) this.assertTaskEditable(task);
    if (milestone !== null) this.assertMilestoneEditable(milestone);
    return { task, milestone };
  }

  private invalidateMilestoneSubmission(projectId: string, milestoneId: string, actorId: string, now: string): void {
    const milestone = this.requireMilestone(projectId, milestoneId);
    if (milestone.status === "pending_review") {
      this.dependencies.database.run(
        `UPDATE milestones SET status='in_progress', updated_by=?, updated_at=?, revision=revision+1
          WHERE id=? AND project_id=? AND status='pending_review'`,
        [actorId, now, milestoneId, projectId],
      );
    }
  }

  private acceptDeliverables(projectId: string, taskId: string | null, milestoneId: string | null, actorId: string, now: string): void {
    this.dependencies.database.run(
      `UPDATE deliverable_requirements
          SET accepted_at=?, accepted_by=?, updated_by=?, updated_at=?, revision=revision+1
        WHERE project_id=? AND task_id IS ? AND milestone_id IS ?
          AND fulfilled_resource_id IS NOT NULL AND fulfilled_resource_version_id IS NOT NULL AND fulfilled_at IS NOT NULL
          AND accepted_at IS NULL`,
      [now, actorId, actorId, now, projectId, taskId, milestoneId],
    );
  }

  private clearDeliverableAcceptance(projectId: string, taskId: string | null, milestoneId: string | null, actorId: string, now: string): void {
    this.dependencies.database.run(
      `UPDATE deliverable_requirements
          SET accepted_at=NULL, accepted_by=NULL, updated_by=?, updated_at=?, revision=revision+1
        WHERE project_id=? AND task_id IS ? AND milestone_id IS ? AND accepted_at IS NOT NULL`,
      [actorId, now, projectId, taskId, milestoneId],
    );
  }

  private activeTaskSubtree(projectId: string, taskId: string): TaskRow[] {
    return this.dependencies.database.all<TaskRow>(
      `WITH RECURSIVE task_tree(id) AS (
         SELECT id FROM tasks
          WHERE project_id=? AND id=? AND archived_at IS NULL AND deleted_at IS NULL
         UNION ALL
         SELECT tasks.id FROM tasks JOIN task_tree ON tasks.parent_id=task_tree.id
          WHERE tasks.project_id=? AND tasks.archived_at IS NULL AND tasks.deleted_at IS NULL
       )
       SELECT id, project_id, phase_id, parent_id, recurring_rule_id, occurrence_date,
              title, description, position, status, start_date, due_date, reviewed_at,
              reviewed_by, reopened_at, reopened_by, deleted_at, created_at, updated_at, revision
         FROM tasks WHERE project_id=? AND id IN (SELECT id FROM task_tree)`,
      [projectId, taskId, projectId, projectId],
    );
  }

  private recomputeTaskAndAncestors(projectId: string, taskId: string, actorId: string, now: string): void {
    const task = this.requireTask(projectId, taskId);
    this.recomputeOneTask(projectId, task.id, actorId, now);
    this.recomputeAncestors(projectId, task.parent_id, actorId, now);
  }

  private recomputeAncestors(projectId: string, parentId: string | null, actorId: string, now: string): void {
    let cursor = parentId;
    const visited = new Set<string>();
    while (cursor !== null && !visited.has(cursor)) {
      visited.add(cursor); const task = this.requireTask(projectId, cursor);
      this.recomputeOneTask(projectId, task.id, actorId, now); cursor = task.parent_id;
    }
  }

  private recomputeOneTask(projectId: string, taskId: string, actorId: string, now: string): void {
    const task = this.requireTask(projectId, taskId);
    if (task.reviewed_at !== null) return;
    const nextStatus = this.computedTaskStatus(projectId, task);
    if (nextStatus !== task.status) this.dependencies.database.run("UPDATE tasks SET status=?, updated_by=?, updated_at=?, revision=revision+1 WHERE id=? AND project_id=?", [nextStatus, actorId, now, taskId, projectId]);
  }

  private computedTaskStatus(projectId: string, task: TaskRow): TaskStatus {
    const participants = this.dependencies.database.all<{ status: ParticipantStatus }>("SELECT status FROM task_participants WHERE project_id=? AND task_id=? AND removed_at IS NULL", [projectId, task.id]);
    const children = this.dependencies.database.all<{ status: TaskStatus }>("SELECT status FROM tasks WHERE project_id=? AND parent_id=? AND archived_at IS NULL AND deleted_at IS NULL", [projectId, task.id]);
    return aggregateTaskStatus({ reviewed: task.reviewed_at !== null, participantStatuses: participants.map((row) => row.status), childStatuses: children.map((row) => row.status), requiredDeliverablesFulfilled: this.areDeliverablesFulfilled(projectId, task.id, null) });
  }

  private isTaskReviewReady(projectId: string, task: TaskRow): boolean {
    return this.computedTaskStatus(projectId, task) === "pending_review";
  }

  protected requireProjectMember(
    auth: AuthenticatedSession,
    projectId: string,
  ): ProjectScheduleRow {
    const row = this.dependencies.database.get<ProjectScheduleRow>(
      `SELECT projects.id, projects.schedule_revision
         FROM projects
         JOIN project_members ON project_members.project_id = projects.id
        WHERE projects.id = ?
          AND project_members.user_id = ?
          AND project_members.removed_at IS NULL
          AND projects.deleted_at IS NULL`,
      [projectId, auth.user.id],
    );
    if (row === undefined) {
      throw new HttpError(404, "PROJECT_NOT_FOUND", "The project was not found.");
    }
    return row;
  }

  protected bumpScheduleRevision(projectId: string): number {
    const changed = this.dependencies.database.run(
      `UPDATE projects
          SET schedule_revision = schedule_revision + 1
        WHERE id = ? AND deleted_at IS NULL`,
      [projectId],
    );
    if (changed.changes !== 1) {
      throw new HttpError(404, "PROJECT_NOT_FOUND", "The project was not found.");
    }
    return this.dependencies.database.get<{ schedule_revision: number }>(
      "SELECT schedule_revision FROM projects WHERE id = ?",
      [projectId],
    )!.schedule_revision;
  }

  protected requireTask(projectId: string, taskId: string): TaskRow {
    const row = this.taskRow(projectId, taskId);
    if (row !== undefined) return row;
    const tombstone = this.taskAnyRow(projectId, taskId);
    if (tombstone !== undefined) throw new HttpError(409, "REVISION_CONFLICT", "The task was deleted on another client.", { latest: toTask(tombstone) });
    throw new HttpError(404, "TASK_NOT_FOUND", "The task was not found.");
  }

  protected taskRow(projectId: string, taskId: string): TaskRow | undefined {
    return this.dependencies.database.get<TaskRow>(
      `SELECT id, project_id, phase_id, parent_id, recurring_rule_id,
              occurrence_date, title, description, position, status,
              start_date, due_date, reviewed_at, reviewed_by, reopened_at,
              reopened_by, deleted_at, created_at, updated_at, revision
         FROM tasks
        WHERE project_id = ? AND id = ?
          AND archived_at IS NULL AND deleted_at IS NULL`,
      [projectId, taskId],
    );
  }

  private taskAnyRow(projectId: string, taskId: string): TaskRow | undefined {
    return this.dependencies.database.get<TaskRow>(
      `SELECT id, project_id, phase_id, parent_id, recurring_rule_id,
              occurrence_date, title, description, position, status,
              start_date, due_date, reviewed_at, reviewed_by, reopened_at,
              reopened_by, deleted_at, created_at, updated_at, revision
         FROM tasks
        WHERE project_id = ? AND id = ? AND archived_at IS NULL`,
      [projectId, taskId],
    );
  }

  protected assertTaskEditable(task: TaskRow): void {
    if (task.status === "done") {
      throw new HttpError(
        409,
        "TASK_COMPLETED_LOCKED",
        "The completed task must be reopened before it can be changed.",
        { latest: toTask(task) },
      );
    }
  }

  private requirePhase(projectId: string, phaseId: string): PhaseRow {
    const row = this.phaseRow(projectId, phaseId);
    if (row === undefined) {
      throw new HttpError(404, "PHASE_NOT_FOUND", "The phase was not found.");
    }
    return row;
  }

  private phaseRow(projectId: string, phaseId: string): PhaseRow | undefined {
    return this.dependencies.database.get<PhaseRow>(
      `SELECT id, project_id, name, description, position, start_date, end_date,
              created_at, updated_at, revision
         FROM phases WHERE project_id = ? AND id = ?`,
      [projectId, phaseId],
    );
  }

  private phaseRows(projectId: string): PhaseRow[] {
    return this.dependencies.database.all<PhaseRow>(
      `SELECT id, project_id, name, description, position, start_date, end_date,
              created_at, updated_at, revision
         FROM phases WHERE project_id = ? ORDER BY position, created_at, id`,
      [projectId],
    );
  }

  protected taskRows(projectId: string): TaskRow[] {
    return this.dependencies.database.all<TaskRow>(
      `SELECT id, project_id, phase_id, parent_id, recurring_rule_id,
              occurrence_date, title, description, position, status,
              start_date, due_date, reviewed_at, reviewed_by, reopened_at,
              reopened_by, deleted_at, created_at, updated_at, revision
         FROM tasks
        WHERE project_id = ? AND archived_at IS NULL AND deleted_at IS NULL
        ORDER BY position, created_at, id`,
      [projectId],
    );
  }

  private participantRows(projectId: string): ParticipantRow[] {
    return this.dependencies.database.all<ParticipantRow>(
      `SELECT task_participants.id, task_participants.project_id,
              task_participants.task_id, task_participants.user_id,
              users.username, users.display_name, project_members.color,
              task_participants.start_date, task_participants.end_date,
              task_participants.estimated_minutes,
              task_participants.progress_percent, task_participants.status, task_participants.removed_at,
              task_participants.created_at, task_participants.updated_at,
              task_participants.revision
         FROM task_participants
         JOIN users ON users.id = task_participants.user_id
         JOIN project_members
           ON project_members.project_id = task_participants.project_id
          AND project_members.user_id = task_participants.user_id
        WHERE task_participants.project_id = ?
          AND task_participants.removed_at IS NULL
          AND EXISTS (
            SELECT 1 FROM tasks
             WHERE tasks.id = task_participants.task_id
               AND tasks.project_id = task_participants.project_id
               AND tasks.archived_at IS NULL
               AND tasks.deleted_at IS NULL
          )
        ORDER BY task_participants.created_at, task_participants.id`,
      [projectId],
    );
  }

  private dependencyRows(projectId: string): DependencyRow[] {
    return this.dependencies.database.all<DependencyRow>(
        `SELECT id, project_id, predecessor_task_id, successor_task_id,
              created_at, revision, deleted_at
         FROM task_dependencies
        WHERE project_id = ? AND deleted_at IS NULL
          AND EXISTS (SELECT 1 FROM tasks WHERE tasks.id=task_dependencies.predecessor_task_id AND tasks.project_id=task_dependencies.project_id AND tasks.archived_at IS NULL AND tasks.deleted_at IS NULL)
          AND EXISTS (SELECT 1 FROM tasks WHERE tasks.id=task_dependencies.successor_task_id AND tasks.project_id=task_dependencies.project_id AND tasks.archived_at IS NULL AND tasks.deleted_at IS NULL)
        ORDER BY created_at, id`,
      [projectId],
    );
  }

  private milestoneRows(projectId: string): MilestoneRow[] {
    return this.dependencies.database.all<MilestoneRow>(
      `SELECT id, project_id, phase_id, title, description, due_date, status,
              reviewed_at, reviewed_by, created_at, updated_at, revision
         FROM milestones WHERE project_id = ? ORDER BY due_date, created_at, id`,
      [projectId],
    );
  }

  private deliverableRows(projectId: string): DeliverableRow[] {
    return this.dependencies.database.all<DeliverableRow>(
      `SELECT id, project_id, task_id, milestone_id, title, description,
              fulfilled_resource_id, fulfilled_resource_version_id, fulfilled_at, fulfilled_by,
              accepted_at, accepted_by, created_at, updated_at, revision
         FROM deliverable_requirements
        WHERE project_id = ?
          AND (task_id IS NULL OR EXISTS (
            SELECT 1 FROM tasks WHERE tasks.id=deliverable_requirements.task_id
              AND tasks.project_id=deliverable_requirements.project_id
              AND tasks.archived_at IS NULL AND tasks.deleted_at IS NULL
          ))
        ORDER BY created_at, id`,
      [projectId],
    );
  }

  private validatePhaseReference(projectId: string, phaseId: string | null): void {
    if (phaseId !== null && this.phaseRow(projectId, phaseId) === undefined) {
      throw new HttpError(404, "PHASE_NOT_FOUND", "The phase was not found.");
    }
  }

  private validateParentReference(projectId: string, parentId: string | null): void {
    if (parentId === null) {
      return;
    }
    const parent = this.taskRow(projectId, parentId);
    if (parent === undefined) {
      throw new HttpError(404, "TASK_NOT_FOUND", "The parent task was not found.");
    }
    if (parent.status === "done") {
      throw new HttpError(
        409,
        "TASK_PARENT_COMPLETED",
        "A child task cannot be added beneath a completed parent.",
        { latest: toTask(parent) },
      );
    }
  }

  private nextPosition(table: "phases" | "tasks", projectId: string): number {
    return (
      (this.dependencies.database.get<{ position: number | null }>(
        `SELECT MAX(position) AS position FROM ${table} WHERE project_id = ?`,
        [projectId],
      )?.position ?? -1) + 1
    );
  }

  private assertDateRange(
    startDate: string | null,
    endDate: string | null,
    entity: "phase" | "task",
  ): void {
    if (startDate !== null && endDate !== null && startDate > endDate) {
      throw new HttpError(
        400,
        "DATE_RANGE_INVALID",
        `The ${entity} start date must not be after its end date.`,
      );
    }
  }

  private assertRevision<Row extends { revision: number }>(
    entity: string,
    current: Row,
    expectedRevision: number,
    sanitize: (row: Row) => unknown,
  ): void {
    if (current.revision !== expectedRevision) {
      throw new HttpError(
        409,
        "REVISION_CONFLICT",
        `The ${entity} changed on another client.`,
        { latest: sanitize(current) },
      );
    }
  }

  private throwLatestPhase(projectId: string, phaseId: string): never {
    const latest = this.phaseRow(projectId, phaseId);
    if (latest === undefined) {
      throw new HttpError(404, "PHASE_NOT_FOUND", "The phase was not found.");
    }
    throw new HttpError(
      409,
      "REVISION_CONFLICT",
      "The phase changed on another client.",
      { latest: toPhase(latest) },
    );
  }

  private throwLatestTask(projectId: string, taskId: string): never {
    const latest = this.taskAnyRow(projectId, taskId);
    if (latest === undefined) {
      throw new HttpError(404, "TASK_NOT_FOUND", "The task was not found.");
    }
    throw new HttpError(
      409,
      "REVISION_CONFLICT",
      "The task changed on another client.",
      { latest: toTask(latest) },
    );
  }

  private throwLatestParticipant(projectId: string, participantId: string): never {
    const latest = this.participantRow(projectId, participantId);
    if (latest === undefined) throw new HttpError(404, "PARTICIPANT_NOT_FOUND", "The participant was not found.");
    throw new HttpError(409, "REVISION_CONFLICT", "The participant changed on another client.", { latest: toParticipant(latest) });
  }

  private throwLatestDependency(projectId: string, dependencyId: string): never {
    const latest = this.dependencies.database.get<DependencyRow>(`SELECT id, project_id, predecessor_task_id, successor_task_id, created_at, revision, deleted_at FROM task_dependencies WHERE project_id=? AND id=?`, [projectId, dependencyId]);
    if (latest === undefined) throw new HttpError(404, "DEPENDENCY_NOT_FOUND", "The dependency was not found.");
    throw new HttpError(409, "REVISION_CONFLICT", "The dependency changed on another client.", { latest: toDependency(latest) });
  }

  private throwLatestMilestone(projectId: string, milestoneId: string): never {
    const latest = this.requireMilestone(projectId, milestoneId);
    throw new HttpError(409, "REVISION_CONFLICT", "The milestone changed on another client.", { latest: toMilestone(latest) });
  }

  private throwLatestDeliverable(projectId: string, deliverableId: string): never {
    const latest = this.requireDeliverable(projectId, deliverableId);
    throw new HttpError(409, "REVISION_CONFLICT", "The deliverable changed on another client.", { latest: toDeliverable(latest) });
  }

  private throwLatestRule(projectId: string, ruleId: string): never {
    const latest = this.requireRule(projectId, ruleId);
    throw new HttpError(409, "REVISION_CONFLICT", "The recurring rule changed on another client.", { latest: toRecurringRule(latest) });
  }

  private throwLatestTemplate(templateId: string): never {
    const latest = this.dependencies.database.get<TeamTemplateRow>(
      "SELECT id, name, anchor_semantics, payload_json, created_at, updated_at, revision, archived_at FROM team_schedule_templates WHERE id=?", [templateId],
    );
    if (latest === undefined) throw new HttpError(404, "TEMPLATE_NOT_FOUND", "The template was not found.");
    throw new HttpError(409, "REVISION_CONFLICT", "The template changed on another client.", { latest: toTeamTemplate(latest) });
  }
}
