import type { V2RuntimeDependencies } from "../../http/dependencies.js";
import { HttpError } from "../../http/errors.js";
import { writeActivity } from "../activity.js";
import type { AuthenticatedSession } from "../auth/auth-service.js";
import { withProgressPurgeContext } from "../progress-purge-context.js";
import { drainStorageGarbageQueue } from "../resources/storage-gc.js";

const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

interface TaskLifecycleRow extends Record<string, unknown> {
  id: string;
  project_id: string;
  parent_id: string | null;
  title: string;
  status: string;
  revision: number;
  archived_at: string | null;
  archive_batch_id: string | null;
  deleted_at: string | null;
  trash_batch_id: string | null;
  purge_after: string | null;
}

interface ProjectLifecycleRow extends Record<string, unknown> {
  id: string;
  name: string;
  description: string;
  revision: number;
  schedule_revision: number;
  archived_at: string | null;
  deleted_at: string | null;
  trash_batch_id: string | null;
  purge_after: string | null;
}

export interface TaskLifecycleEntity {
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

export interface ProjectLifecycleEntity {
  id: string;
  name: string;
  description: string;
  revision: number;
  scheduleRevision: number;
  archivedAt: string | null;
  deletedAt: string | null;
  purgeAfter: string | null;
}

function toTask(row: TaskLifecycleRow): TaskLifecycleEntity {
  return {
    id: row.id,
    projectId: row.project_id,
    parentId: row.parent_id,
    title: row.title,
    status: row.status,
    revision: row.revision,
    archivedAt: row.archived_at,
    deletedAt: row.deleted_at,
    purgeAfter: row.purge_after,
  };
}

function toProject(row: ProjectLifecycleRow): ProjectLifecycleEntity {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    revision: row.revision,
    scheduleRevision: row.schedule_revision,
    archivedAt: row.archived_at,
    deletedAt: row.deleted_at,
    purgeAfter: row.purge_after,
  };
}

export class LifecycleService {
  constructor(private readonly dependencies: V2RuntimeDependencies) {}

  archiveTask(
    auth: AuthenticatedSession,
    projectId: string,
    taskId: string,
    expectedRevision: number,
    expectedScheduleRevision: number,
  ): { tasks: TaskLifecycleEntity[]; rootRevision: number; scheduleRevision: number } {
    return this.dependencies.database.transaction(() => {
      this.requireWritableProject(auth, projectId);
      this.assertScheduleRevision(projectId, expectedScheduleRevision);
      const root = this.requireTask(projectId, taskId, false);
      this.assertRevision("task", root, expectedRevision, toTask(root));
      if (root.archived_at !== null) {
        throw new HttpError(409, "TASK_ALREADY_ARCHIVED", "The task is already archived.", {
          latest: toTask(root),
        });
      }
      const subtree = this.taskSubtree(projectId, taskId, false);
      if (subtree.some((task) => task.status === "done")) {
        throw new HttpError(
          409,
          "TASK_COMPLETED_SUBTREE",
          "Completed tasks must be reopened before the subtree can be archived.",
        );
      }
      const batchId = this.dependencies.idGenerator();
      const now = this.dependencies.clock().toISOString();
      const ids = subtree.filter((task) => task.archived_at === null).map((task) => task.id);
      this.updateTaskSet(
        ids,
        `archived_at=?, archived_by=?, archive_batch_id=?, updated_by=?, updated_at=?, revision=revision+1`,
        [now, auth.user.id, batchId, auth.user.id, now],
      );
      for (const id of ids) {
        writeActivity(this.dependencies, {
          projectId,
          actorId: auth.user.id,
          entityType: "task",
          entityId: id,
          action: "task.archived",
          metadata: { batchId },
        });
      }
      const scheduleRevision = this.bumpSchedule(projectId);
      const tasks = this.tasksByIds(projectId, ids);
      return {
        tasks,
        rootRevision: this.requireTask(projectId, taskId, false).revision,
        scheduleRevision,
      };
    });
  }

  unarchiveTask(
    auth: AuthenticatedSession,
    projectId: string,
    taskId: string,
    expectedRevision: number,
    expectedScheduleRevision: number,
  ): { tasks: TaskLifecycleEntity[]; rootRevision: number; scheduleRevision: number } {
    return this.dependencies.database.transaction(() => {
      this.requireWritableProject(auth, projectId);
      this.assertScheduleRevision(projectId, expectedScheduleRevision);
      const root = this.requireTask(projectId, taskId, false);
      this.assertRevision("task", root, expectedRevision, toTask(root));
      if (root.archived_at === null || root.archive_batch_id === null) {
        throw new HttpError(409, "TASK_NOT_ARCHIVED", "The task is not archived.", {
          latest: toTask(root),
        });
      }
      const batchId = root.archive_batch_id;
      const now = this.dependencies.clock().toISOString();
      const rows = this.dependencies.database.all<TaskLifecycleRow>(
        `${this.taskSelect()} WHERE project_id=? AND archive_batch_id=? AND archived_at IS NOT NULL AND deleted_at IS NULL`,
        [projectId, batchId],
      );
      const ids = rows.map((row) => row.id);
      this.updateTaskSet(
        ids,
        `archived_at=NULL, archived_by=NULL, archive_batch_id=NULL, updated_by=?, updated_at=?, revision=revision+1`,
        [auth.user.id, now],
      );
      for (const id of ids) {
        writeActivity(this.dependencies, {
          projectId,
          actorId: auth.user.id,
          entityType: "task",
          entityId: id,
          action: "task.unarchived",
          metadata: { batchId },
        });
      }
      const scheduleRevision = this.bumpSchedule(projectId);
      return {
        tasks: this.tasksByIds(projectId, ids),
        rootRevision: this.requireTask(projectId, taskId, false).revision,
        scheduleRevision,
      };
    });
  }

  trashTask(
    auth: AuthenticatedSession,
    projectId: string,
    taskId: string,
    expectedRevision: number,
    expectedScheduleRevision: number,
  ): {
    deleted: true;
    trashBatchId: string;
    rootRevision: number;
    scheduleRevision: number;
  } {
    return this.dependencies.database.transaction(() => {
      this.requireWritableProject(auth, projectId);
      this.assertScheduleRevision(projectId, expectedScheduleRevision);
      const root = this.requireTask(projectId, taskId, false);
      this.assertRevision("task", root, expectedRevision, toTask(root));
      const subtree = this.taskSubtree(projectId, taskId, false);
      if (subtree.some((task) => task.status === "done")) {
        throw new HttpError(
          409,
          "TASK_COMPLETED_SUBTREE",
          "Completed tasks must be reopened before the subtree can be deleted.",
        );
      }
      const ids = subtree.map((task) => task.id);
      this.assertNoActiveRecurringSource(projectId, ids);
      const trashBatchId = this.dependencies.idGenerator();
      const nowDate = this.dependencies.clock();
      const now = nowDate.toISOString();
      const purgeAfter = new Date(nowDate.getTime() + TRASH_RETENTION_MS).toISOString();
      const placeholders = this.placeholders(ids);

      this.dependencies.database.run(
        `UPDATE task_participants
            SET removed_at=?, removed_by=?, removed_batch_id=?, updated_by=?, updated_at=?, revision=revision+1
          WHERE project_id=? AND task_id IN (${placeholders}) AND removed_at IS NULL`,
        [now, auth.user.id, trashBatchId, auth.user.id, now, projectId, ...ids],
      );
      this.dependencies.database.run(
        `UPDATE task_dependencies
            SET deleted_at=?, deleted_by=?, deleted_batch_id=?, revision=revision+1
          WHERE project_id=? AND deleted_at IS NULL
            AND (predecessor_task_id IN (${placeholders}) OR successor_task_id IN (${placeholders}))`,
        [now, auth.user.id, trashBatchId, projectId, ...ids, ...ids],
      );
      this.updateTaskSet(
        ids,
        `deleted_at=?, deleted_by=?, purge_after=?, trash_batch_id=?, updated_by=?, updated_at=?, revision=revision+1`,
        [now, auth.user.id, purgeAfter, trashBatchId, auth.user.id, now],
      );
      for (const id of ids) {
        writeActivity(this.dependencies, {
          projectId,
          actorId: auth.user.id,
          entityType: "task",
          entityId: id,
          action: "task.trashed",
          metadata: { trashBatchId },
        });
      }
      const scheduleRevision = this.bumpSchedule(projectId);
      return {
        deleted: true,
        trashBatchId,
        rootRevision: this.requireTask(projectId, taskId, true).revision,
        scheduleRevision,
      };
    });
  }

  restoreTask(
    auth: AuthenticatedSession,
    projectId: string,
    taskId: string,
    expectedRevision: number,
    expectedScheduleRevision: number,
  ): {
    tasks: TaskLifecycleEntity[];
    rootRevision: number;
    scheduleRevision: number;
    skippedParticipantIds: string[];
    skippedDependencyIds: string[];
  } {
    return this.dependencies.database.transaction(() => {
      this.requireWritableProject(auth, projectId);
      this.assertScheduleRevision(projectId, expectedScheduleRevision);
      const root = this.requireTask(projectId, taskId, true);
      this.assertRevision("task", root, expectedRevision, toTask(root));
      if (root.deleted_at === null || root.trash_batch_id === null) {
        throw new HttpError(409, "TASK_NOT_TRASHED", "The task is not in the trash.", {
          latest: toTask(root),
        });
      }
      const trashBatchId = root.trash_batch_id;
      const rows = this.dependencies.database.all<TaskLifecycleRow>(
        `${this.taskSelect()} WHERE project_id=? AND trash_batch_id=? AND deleted_at IS NOT NULL`,
        [projectId, trashBatchId],
      );
      if (root.parent_id !== null && !rows.some((row) => row.id === root.parent_id)) {
        const activeParent = this.dependencies.database.get<{ id: string }>(
          "SELECT id FROM tasks WHERE id=? AND project_id=? AND deleted_at IS NULL",
          [root.parent_id, projectId],
        );
        if (activeParent === undefined) {
          throw new HttpError(
            409,
            "TASK_PARENT_TRASHED",
            "Restore the parent task before restoring this subtree.",
          );
        }
      }
      const ids = rows.map((row) => row.id);
      const now = this.dependencies.clock().toISOString();
      this.updateTaskSet(
        ids,
        `deleted_at=NULL, deleted_by=NULL, purge_after=NULL, trash_batch_id=NULL, updated_by=?, updated_at=?, revision=revision+1`,
        [auth.user.id, now],
      );
      const skippedParticipantIds = this.dependencies.database
        .all<{ id: string }>(
          `SELECT task_participants.id FROM task_participants
            LEFT JOIN users ON users.id=task_participants.user_id
            LEFT JOIN project_members
              ON project_members.project_id=task_participants.project_id
             AND project_members.user_id=task_participants.user_id
            LEFT JOIN team_members ON team_members.user_id=task_participants.user_id
           WHERE task_participants.project_id=? AND task_participants.removed_batch_id=?
              AND (users.id IS NULL OR users.disabled_at IS NOT NULL
                   OR project_members.user_id IS NULL OR project_members.removed_at IS NOT NULL
                   OR team_members.user_id IS NULL OR team_members.removed_at IS NOT NULL)`,
          [projectId, trashBatchId],
        )
        .map(({ id }) => id);
      this.dependencies.database.run(
        `UPDATE task_participants
            SET removed_at=NULL, removed_by=NULL, removed_batch_id=NULL, updated_by=?, updated_at=?, revision=revision+1
          WHERE project_id=? AND removed_batch_id=?
            AND EXISTS (SELECT 1 FROM users WHERE users.id=task_participants.user_id AND disabled_at IS NULL)
            AND EXISTS (SELECT 1 FROM project_members
                         WHERE project_members.project_id=task_participants.project_id
                           AND project_members.user_id=task_participants.user_id
                           AND removed_at IS NULL)
            AND EXISTS (SELECT 1 FROM team_members
                         WHERE team_members.user_id=task_participants.user_id AND removed_at IS NULL)`,
        [auth.user.id, now, projectId, trashBatchId],
      );
      const skippedDependencyIds = this.dependencies.database
        .all<{ id: string }>(
          `SELECT task_dependencies.id FROM task_dependencies
           WHERE task_dependencies.project_id=? AND task_dependencies.deleted_batch_id=?
             AND (NOT EXISTS (SELECT 1 FROM tasks
                               WHERE tasks.id=task_dependencies.predecessor_task_id
                                 AND tasks.project_id=task_dependencies.project_id
                                 AND tasks.deleted_at IS NULL)
                  OR NOT EXISTS (SELECT 1 FROM tasks
                                  WHERE tasks.id=task_dependencies.successor_task_id
                                    AND tasks.project_id=task_dependencies.project_id
                                    AND tasks.deleted_at IS NULL))`,
          [projectId, trashBatchId],
        )
        .map(({ id }) => id);
      this.dependencies.database.run(
        `UPDATE task_dependencies
            SET deleted_at=NULL, deleted_by=NULL, deleted_batch_id=NULL, revision=revision+1
          WHERE project_id=? AND deleted_batch_id=?
            AND EXISTS (SELECT 1 FROM tasks
                         WHERE tasks.id=task_dependencies.predecessor_task_id
                           AND tasks.project_id=task_dependencies.project_id
                           AND tasks.deleted_at IS NULL)
            AND EXISTS (SELECT 1 FROM tasks
                         WHERE tasks.id=task_dependencies.successor_task_id
                           AND tasks.project_id=task_dependencies.project_id
                           AND tasks.deleted_at IS NULL)`,
        [projectId, trashBatchId],
      );
      for (const id of ids) {
        writeActivity(this.dependencies, {
          projectId,
          actorId: auth.user.id,
          entityType: "task",
          entityId: id,
          action: "task.restored",
          metadata: { trashBatchId },
        });
      }
      const scheduleRevision = this.bumpSchedule(projectId);
      return {
        tasks: this.tasksByIds(projectId, ids),
        rootRevision: this.requireTask(projectId, taskId, false).revision,
        scheduleRevision,
        skippedParticipantIds,
        skippedDependencyIds,
      };
    });
  }

  permanentlyDeleteTask(
    auth: AuthenticatedSession,
    projectId: string,
    taskId: string,
    expectedRevision: number,
    expectedScheduleRevision: number,
    confirmation: string,
  ): { deleted: true } {
    return this.dependencies.database.transaction(() => {
      this.requireWritableProject(auth, projectId);
      this.assertScheduleRevision(projectId, expectedScheduleRevision);
      const root = this.requireTask(projectId, taskId, true);
      this.assertRevision("task", root, expectedRevision, toTask(root));
      if (confirmation !== taskId) {
        throw new HttpError(400, "CONFIRMATION_INVALID", "The confirmation value is invalid.");
      }
      if (root.deleted_at === null || root.trash_batch_id === null) {
        throw new HttpError(409, "TASK_NOT_TRASHED", "Only trashed tasks can be deleted permanently.");
      }
      const mismatched = this.taskSubtree(projectId, taskId, true).filter(
        (task) =>
          task.deleted_at === null || task.trash_batch_id !== root.trash_batch_id,
      );
      if (mismatched.length > 0) {
        throw new HttpError(
          409,
          "TASK_TRASH_BATCH_MISMATCH",
          "The task subtree contains descendants from another trash operation.",
          { latest: mismatched.map(toTask) },
        );
      }
      const participantIds = this.participantIdsForTasks(
        this.taskSubtree(projectId, taskId, true).map((task) => task.id),
      );
      const result = withProgressPurgeContext(
        this.dependencies.database,
        participantIds,
        () =>
          this.dependencies.database.run(
            "DELETE FROM tasks WHERE id=? AND project_id=? AND revision=? AND deleted_at IS NOT NULL",
            [taskId, projectId, expectedRevision],
          ),
      );
      if (result.changes !== 1) this.throwLatestTask(projectId, taskId);
      writeActivity(this.dependencies, {
        projectId,
        actorId: auth.user.id,
        entityType: "task",
        entityId: taskId,
        action: "task.permanently_deleted",
      });
      this.bumpSchedule(projectId);
      return { deleted: true };
    });
  }

  projectTrash(auth: AuthenticatedSession, projectId: string): TaskLifecycleEntity[] {
    this.requireActiveProject(auth, projectId);
    return this.dependencies.database
      .all<TaskLifecycleRow>(
        `${this.taskSelect()} WHERE project_id=? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC, title COLLATE NOCASE`,
        [projectId],
      )
      .map(toTask);
  }

  archivedTasks(auth: AuthenticatedSession, projectId: string): TaskLifecycleEntity[] {
    this.requireActiveProject(auth, projectId);
    return this.dependencies.database
      .all<TaskLifecycleRow>(
        `${this.taskSelect()} WHERE project_id=? AND archived_at IS NOT NULL AND deleted_at IS NULL
          ORDER BY archived_at DESC, title COLLATE NOCASE`,
        [projectId],
      )
      .map(toTask);
  }

  archiveProject(
    auth: AuthenticatedSession,
    projectId: string,
    expectedRevision: number,
  ): { project: ProjectLifecycleEntity } {
    return this.dependencies.database.transaction(() => {
      const project = this.requireActiveProject(auth, projectId);
      this.assertRevision("project", project, expectedRevision, toProject(project));
      if (project.archived_at !== null) {
        throw new HttpError(409, "PROJECT_ALREADY_ARCHIVED", "The project is already archived.", {
          latest: toProject(project),
        });
      }
      const now = this.dependencies.clock().toISOString();
      const changed = this.dependencies.database.run(
        `UPDATE projects SET archived_at=?, archived_by=?, updated_by=?, updated_at=?, revision=revision+1
          WHERE id=? AND revision=? AND deleted_at IS NULL`,
        [now, auth.user.id, auth.user.id, now, projectId, expectedRevision],
      );
      if (changed.changes !== 1) this.throwLatestProject(auth, projectId);
      writeActivity(this.dependencies, {
        projectId,
        actorId: auth.user.id,
        entityType: "project",
        entityId: projectId,
        action: "project.archived",
      });
      return { project: toProject(this.requireActiveProject(auth, projectId)) };
    });
  }

  unarchiveProject(
    auth: AuthenticatedSession,
    projectId: string,
    expectedRevision: number,
  ): { project: ProjectLifecycleEntity } {
    return this.dependencies.database.transaction(() => {
      const project = this.requireActiveProject(auth, projectId);
      this.assertRevision("project", project, expectedRevision, toProject(project));
      if (project.archived_at === null) {
        throw new HttpError(409, "PROJECT_NOT_ARCHIVED", "The project is not archived.", {
          latest: toProject(project),
        });
      }
      const now = this.dependencies.clock().toISOString();
      const changed = this.dependencies.database.run(
        `UPDATE projects SET archived_at=NULL, archived_by=NULL, updated_by=?, updated_at=?, revision=revision+1
          WHERE id=? AND revision=? AND deleted_at IS NULL`,
        [auth.user.id, now, projectId, expectedRevision],
      );
      if (changed.changes !== 1) this.throwLatestProject(auth, projectId);
      writeActivity(this.dependencies, {
        projectId,
        actorId: auth.user.id,
        entityType: "project",
        entityId: projectId,
        action: "project.unarchived",
      });
      return { project: toProject(this.requireActiveProject(auth, projectId)) };
    });
  }

  trashProject(
    auth: AuthenticatedSession,
    projectId: string,
    expectedRevision: number,
    expectedScheduleRevision: number,
  ): { project: ProjectLifecycleEntity } {
    return this.dependencies.database.transaction(() => {
      const project = this.requireActiveProject(auth, projectId);
      this.assertRevision("project", project, expectedRevision, toProject(project));
      this.assertScheduleRevision(projectId, expectedScheduleRevision);
      const trashBatchId = this.dependencies.idGenerator();
      const nowDate = this.dependencies.clock();
      const now = nowDate.toISOString();
      const purgeAfter = new Date(nowDate.getTime() + TRASH_RETENTION_MS).toISOString();

      this.dependencies.database.run(
        `UPDATE task_participants
            SET removed_at=?, removed_by=?, removed_batch_id=?, updated_by=?, updated_at=?, revision=revision+1
          WHERE project_id=? AND removed_at IS NULL
            AND task_id IN (SELECT id FROM tasks WHERE project_id=? AND deleted_at IS NULL)`,
        [now, auth.user.id, trashBatchId, auth.user.id, now, projectId, projectId],
      );
      this.dependencies.database.run(
        `UPDATE task_dependencies
            SET deleted_at=?, deleted_by=?, deleted_batch_id=?, revision=revision+1
          WHERE project_id=? AND deleted_at IS NULL`,
        [now, auth.user.id, trashBatchId, projectId],
      );
      this.dependencies.database.run(
        `UPDATE tasks
            SET deleted_at=?, deleted_by=?, purge_after=?, trash_batch_id=?, updated_by=?, updated_at=?, revision=revision+1
          WHERE project_id=? AND deleted_at IS NULL`,
        [now, auth.user.id, purgeAfter, trashBatchId, auth.user.id, now, projectId],
      );
      this.dependencies.database.run(
        `UPDATE resources
            SET deleted_at=?, deleted_by=?, purge_after=?, trash_batch_id=?, updated_by=?, updated_at=?, revision=revision+1
          WHERE project_id=? AND deleted_at IS NULL`,
        [now, auth.user.id, purgeAfter, trashBatchId, auth.user.id, now, projectId],
      );
      const changed = this.dependencies.database.run(
        `UPDATE projects
            SET deleted_at=?, deleted_by=?, purge_after=?, trash_batch_id=?, updated_by=?, updated_at=?,
                revision=revision+1, schedule_revision=schedule_revision+1
          WHERE id=? AND revision=? AND deleted_at IS NULL`,
        [now, auth.user.id, purgeAfter, trashBatchId, auth.user.id, now, projectId, expectedRevision],
      );
      if (changed.changes !== 1) this.throwLatestProject(auth, projectId);
      writeActivity(this.dependencies, {
        projectId,
        actorId: auth.user.id,
        entityType: "project",
        entityId: projectId,
        action: "project.trashed",
        metadata: { trashBatchId },
      });
      return { project: toProject(this.requireDeletedProject(auth, projectId)) };
    });
  }

  listProjectTrash(auth: AuthenticatedSession): ProjectLifecycleEntity[] {
    return this.dependencies.database
      .all<ProjectLifecycleRow>(
        `${this.projectSelect()}
          JOIN project_members ON project_members.project_id=projects.id
          JOIN team_members ON team_members.user_id=project_members.user_id
         WHERE project_members.user_id=? AND project_members.removed_at IS NULL
           AND team_members.removed_at IS NULL AND projects.deleted_at IS NOT NULL
         ORDER BY projects.deleted_at DESC, projects.name COLLATE NOCASE`,
        [auth.user.id],
      )
      .map(toProject);
  }

  listArchivedProjects(auth: AuthenticatedSession): ProjectLifecycleEntity[] {
    return this.dependencies.database
      .all<ProjectLifecycleRow>(
        `${this.projectSelect()}
          JOIN project_members ON project_members.project_id=projects.id
         WHERE project_members.user_id=? AND project_members.removed_at IS NULL
           AND projects.deleted_at IS NULL AND projects.archived_at IS NOT NULL
         ORDER BY projects.archived_at DESC, projects.name COLLATE NOCASE`,
        [auth.user.id],
      )
      .map(toProject);
  }

  restoreProject(
    auth: AuthenticatedSession,
    projectId: string,
    expectedRevision: number,
  ): {
    project: ProjectLifecycleEntity;
    skippedTaskIds: string[];
    skippedParticipantIds: string[];
    skippedDependencyIds: string[];
    skippedResourceIds: string[];
  } {
    return this.dependencies.database.transaction(() => {
      const project = this.requireDeletedProject(auth, projectId);
      this.assertRevision("project", project, expectedRevision, toProject(project));
      if (project.trash_batch_id === null) {
        throw new HttpError(409, "PROJECT_NOT_TRASHED", "The project is not in the trash.");
      }
      const trashBatchId = project.trash_batch_id;
      const now = this.dependencies.clock().toISOString();
      const skippedTaskIds = this.dependencies.database
        .all<{ id: string }>(
          `WITH RECURSIVE restorable(id) AS (
             SELECT tasks.id FROM tasks
              WHERE tasks.project_id=? AND tasks.trash_batch_id=?
                AND (tasks.parent_id IS NULL OR EXISTS (
                  SELECT 1 FROM tasks AS parent
                   WHERE parent.id=tasks.parent_id AND parent.project_id=tasks.project_id
                     AND (parent.deleted_at IS NULL OR parent.trash_batch_id=?)))
             UNION ALL
             SELECT child.id FROM tasks AS child
               JOIN restorable ON child.parent_id=restorable.id
              WHERE child.project_id=? AND child.trash_batch_id=?
           )
           SELECT id FROM tasks
            WHERE project_id=? AND trash_batch_id=? AND id NOT IN (SELECT id FROM restorable)`,
          [
            projectId,
            trashBatchId,
            trashBatchId,
            projectId,
            trashBatchId,
            projectId,
            trashBatchId,
          ],
        )
        .map(({ id }) => id);
      this.dependencies.database.run(
        `UPDATE tasks SET deleted_at=NULL, deleted_by=NULL, purge_after=NULL, trash_batch_id=NULL,
                 updated_by=?, updated_at=?, revision=revision+1
          WHERE project_id=? AND trash_batch_id=?
            AND id NOT IN (${this.selectPlaceholdersOrNull(skippedTaskIds)})`,
        [auth.user.id, now, projectId, trashBatchId, ...skippedTaskIds],
      );
      const skippedParticipantIds = this.dependencies.database
        .all<{ id: string }>(
          `SELECT task_participants.id FROM task_participants
            LEFT JOIN users ON users.id=task_participants.user_id
            LEFT JOIN project_members
              ON project_members.project_id=task_participants.project_id
             AND project_members.user_id=task_participants.user_id
            LEFT JOIN team_members ON team_members.user_id=task_participants.user_id
           WHERE task_participants.project_id=? AND task_participants.removed_batch_id=?
             AND (users.id IS NULL OR users.disabled_at IS NOT NULL
                  OR project_members.user_id IS NULL OR project_members.removed_at IS NOT NULL
                  OR team_members.user_id IS NULL OR team_members.removed_at IS NOT NULL
                  OR NOT EXISTS (SELECT 1 FROM tasks
                                  WHERE tasks.id=task_participants.task_id
                                    AND tasks.project_id=task_participants.project_id
                                    AND tasks.deleted_at IS NULL))`,
          [projectId, trashBatchId],
        )
        .map(({ id }) => id);
      this.dependencies.database.run(
        `UPDATE task_participants SET removed_at=NULL, removed_by=NULL, removed_batch_id=NULL,
                 updated_by=?, updated_at=?, revision=revision+1
          WHERE project_id=? AND removed_batch_id=?
            AND EXISTS (SELECT 1 FROM users
                         WHERE users.id=task_participants.user_id AND users.disabled_at IS NULL)
            AND EXISTS (SELECT 1 FROM project_members
                         WHERE project_members.project_id=task_participants.project_id
                           AND project_members.user_id=task_participants.user_id
                           AND project_members.removed_at IS NULL)
            AND EXISTS (SELECT 1 FROM team_members
                         WHERE team_members.user_id=task_participants.user_id
                           AND team_members.removed_at IS NULL)
            AND EXISTS (SELECT 1 FROM tasks
                         WHERE tasks.id=task_participants.task_id
                           AND tasks.project_id=task_participants.project_id
                           AND tasks.deleted_at IS NULL)`,
        [auth.user.id, now, projectId, trashBatchId],
      );
      const skippedDependencyIds = this.dependencies.database
        .all<{ id: string }>(
          `SELECT task_dependencies.id FROM task_dependencies
            WHERE task_dependencies.project_id=? AND task_dependencies.deleted_batch_id=?
              AND (NOT EXISTS (SELECT 1 FROM tasks
                                WHERE tasks.id=task_dependencies.predecessor_task_id
                                  AND tasks.project_id=task_dependencies.project_id
                                  AND tasks.deleted_at IS NULL)
                   OR NOT EXISTS (SELECT 1 FROM tasks
                                   WHERE tasks.id=task_dependencies.successor_task_id
                                     AND tasks.project_id=task_dependencies.project_id
                                     AND tasks.deleted_at IS NULL))`,
          [projectId, trashBatchId],
        )
        .map(({ id }) => id);
      this.dependencies.database.run(
        `UPDATE task_dependencies SET deleted_at=NULL, deleted_by=NULL, deleted_batch_id=NULL, revision=revision+1
          WHERE project_id=? AND deleted_batch_id=?
            AND EXISTS (SELECT 1 FROM tasks
                         WHERE tasks.id=task_dependencies.predecessor_task_id
                           AND tasks.project_id=task_dependencies.project_id
                           AND tasks.deleted_at IS NULL)
            AND EXISTS (SELECT 1 FROM tasks
                         WHERE tasks.id=task_dependencies.successor_task_id
                           AND tasks.project_id=task_dependencies.project_id
                           AND tasks.deleted_at IS NULL)`,
        [projectId, trashBatchId],
      );
      const skippedResourceIds = this.dependencies.database
        .all<{ id: string }>(
          `SELECT resources.id FROM resources
            WHERE resources.project_id=? AND resources.trash_batch_id=?
              AND ((resources.phase_id IS NOT NULL AND NOT EXISTS (
                     SELECT 1 FROM phases
                      WHERE phases.id=resources.phase_id AND phases.project_id=resources.project_id))
                   OR (resources.source_task_id IS NOT NULL AND NOT EXISTS (
                     SELECT 1 FROM tasks
                      WHERE tasks.id=resources.source_task_id AND tasks.project_id=resources.project_id
                        AND tasks.deleted_at IS NULL)))`,
          [projectId, trashBatchId],
        )
        .map(({ id }) => id);
      this.dependencies.database.run(
        `UPDATE resources SET deleted_at=NULL, deleted_by=NULL, purge_after=NULL, trash_batch_id=NULL,
                 updated_by=?, updated_at=?, revision=revision+1
          WHERE project_id=? AND trash_batch_id=?
            AND id NOT IN (${this.selectPlaceholdersOrNull(skippedResourceIds)})`,
        [auth.user.id, now, projectId, trashBatchId, ...skippedResourceIds],
      );
      const changed = this.dependencies.database.run(
        `UPDATE projects SET deleted_at=NULL, deleted_by=NULL, purge_after=NULL, trash_batch_id=NULL,
                archived_at=NULL, archived_by=NULL, updated_by=?, updated_at=?, revision=revision+1,
                schedule_revision=schedule_revision+1
          WHERE id=? AND revision=? AND deleted_at IS NOT NULL`,
        [auth.user.id, now, projectId, expectedRevision],
      );
      if (changed.changes !== 1) this.throwLatestProject(auth, projectId);
      writeActivity(this.dependencies, {
        projectId,
        actorId: auth.user.id,
        entityType: "project",
        entityId: projectId,
        action: "project.restored",
        metadata: { trashBatchId },
      });
      return {
        project: toProject(this.requireActiveProject(auth, projectId)),
        skippedTaskIds,
        skippedParticipantIds,
        skippedDependencyIds,
        skippedResourceIds,
      };
    });
  }

  async permanentlyDeleteProject(
    auth: AuthenticatedSession,
    projectId: string,
    expectedRevision: number,
    confirmation: string,
  ): Promise<{ deleted: true }> {
    this.dependencies.database.transaction(() => {
      const project = this.requireDeletedProject(auth, projectId);
      this.assertRevision("project", project, expectedRevision, toProject(project));
      if (confirmation !== projectId) {
        throw new HttpError(400, "CONFIRMATION_INVALID", "The confirmation value is invalid.");
      }
      const participantIds = this.dependencies.database
        .all<{ id: string }>(
          "SELECT id FROM task_participants WHERE project_id=?",
          [projectId],
        )
        .map(({ id }) => id);
      const changed = withProgressPurgeContext(
        this.dependencies.database,
        participantIds,
        () =>
          this.dependencies.database.run(
            "DELETE FROM projects WHERE id=? AND revision=? AND deleted_at IS NOT NULL",
            [projectId, expectedRevision],
          ),
      );
      if (changed.changes !== 1) this.throwLatestProject(auth, projectId);
      writeActivity(this.dependencies, {
        projectId: null,
        actorId: auth.user.id,
        entityType: "project",
        entityId: projectId,
        action: "project.permanently_deleted",
      });
    });
    await drainStorageGarbageQueue(this.dependencies);
    return { deleted: true };
  }

  private taskSelect(): string {
    return `SELECT id, project_id, parent_id, title, status, revision, archived_at,
                   archive_batch_id, deleted_at, trash_batch_id, purge_after FROM tasks`;
  }

  private projectSelect(): string {
    return `SELECT projects.id, projects.name, projects.description, projects.revision,
                   projects.schedule_revision, projects.archived_at, projects.deleted_at,
                   projects.trash_batch_id, projects.purge_after FROM projects`;
  }

  private taskSubtree(projectId: string, taskId: string, includeDeleted: boolean): TaskLifecycleRow[] {
    const deletedClause = includeDeleted ? "" : "AND deleted_at IS NULL";
    return this.dependencies.database.all<TaskLifecycleRow>(
      `WITH RECURSIVE tree AS (
         SELECT id FROM tasks WHERE project_id=? AND id=? ${deletedClause}
         UNION ALL
         SELECT tasks.id FROM tasks JOIN tree ON tasks.parent_id=tree.id
          WHERE tasks.project_id=? ${deletedClause}
       )
       ${this.taskSelect()} WHERE id IN (SELECT id FROM tree)`,
      [projectId, taskId, projectId],
    );
  }

  private tasksByIds(projectId: string, ids: string[]): TaskLifecycleEntity[] {
    if (ids.length === 0) return [];
    return this.dependencies.database
      .all<TaskLifecycleRow>(
        `${this.taskSelect()} WHERE project_id=? AND id IN (${this.placeholders(ids)}) ORDER BY title COLLATE NOCASE`,
        [projectId, ...ids],
      )
      .map(toTask);
  }

  private participantIdsForTasks(taskIds: readonly string[]): string[] {
    if (taskIds.length === 0) return [];
    return this.dependencies.database
      .all<{ id: string }>(
        `SELECT id FROM task_participants WHERE task_id IN (${this.placeholders(taskIds)})`,
        [...taskIds],
      )
      .map(({ id }) => id);
  }

  private updateTaskSet(ids: string[], assignmentSql: string, values: unknown[]): void {
    if (ids.length === 0) return;
    const changed = this.dependencies.database.run(
      `UPDATE tasks SET ${assignmentSql} WHERE id IN (${this.placeholders(ids)})`,
      [...values, ...ids] as string[],
    );
    if (changed.changes !== ids.length) {
      throw new Error("The task subtree changed during its lifecycle transaction.");
    }
  }

  private placeholders(values: readonly unknown[]): string {
    return values.map(() => "?").join(", ");
  }

  private selectPlaceholdersOrNull(values: readonly unknown[]): string {
    return values.length === 0 ? "SELECT NULL WHERE 0" : this.placeholders(values);
  }

  private requireTask(projectId: string, taskId: string, includeDeleted: boolean): TaskLifecycleRow {
    const row = this.dependencies.database.get<TaskLifecycleRow>(
      `${this.taskSelect()} WHERE project_id=? AND id=? ${includeDeleted ? "" : "AND deleted_at IS NULL"}`,
      [projectId, taskId],
    );
    if (row === undefined) {
      throw new HttpError(404, "TASK_NOT_FOUND", "The task was not found.");
    }
    return row;
  }

  private requireActiveProject(auth: AuthenticatedSession, projectId: string): ProjectLifecycleRow {
    const row = this.dependencies.database.get<ProjectLifecycleRow>(
      `${this.projectSelect()}
        JOIN project_members ON project_members.project_id=projects.id
       WHERE projects.id=? AND project_members.user_id=?
         AND project_members.removed_at IS NULL AND projects.deleted_at IS NULL`,
      [projectId, auth.user.id],
    );
    if (row === undefined) {
      throw new HttpError(404, "PROJECT_NOT_FOUND", "The project was not found.");
    }
    return row;
  }

  private requireWritableProject(
    auth: AuthenticatedSession,
    projectId: string,
  ): ProjectLifecycleRow {
    const project = this.requireActiveProject(auth, projectId);
    if (project.archived_at !== null) {
      throw new HttpError(
        409,
        "PROJECT_ARCHIVED",
        "Unarchive the project before changing its tasks.",
      );
    }
    return project;
  }

  private requireDeletedProject(auth: AuthenticatedSession, projectId: string): ProjectLifecycleRow {
    const row = this.dependencies.database.get<ProjectLifecycleRow>(
      `${this.projectSelect()}
        JOIN project_members ON project_members.project_id=projects.id
        JOIN team_members ON team_members.user_id=project_members.user_id
       WHERE projects.id=? AND project_members.user_id=?
         AND project_members.removed_at IS NULL AND team_members.removed_at IS NULL
         AND projects.deleted_at IS NOT NULL`,
      [projectId, auth.user.id],
    );
    if (row === undefined) {
      throw new HttpError(404, "PROJECT_NOT_FOUND", "The project was not found.");
    }
    return row;
  }

  private assertRevision(
    entity: string,
    current: { revision: number },
    expectedRevision: number,
    latest: unknown,
  ): void {
    if (current.revision !== expectedRevision) {
      throw new HttpError(409, "REVISION_CONFLICT", `The ${entity} changed on another client.`, {
        latest,
      });
    }
  }

  private assertScheduleRevision(projectId: string, expectedRevision: number): void {
    const latest = this.dependencies.database.get<{ schedule_revision: number }>(
      "SELECT schedule_revision FROM projects WHERE id=?",
      [projectId],
    );
    if (latest === undefined) {
      throw new HttpError(404, "PROJECT_NOT_FOUND", "The project was not found.");
    }
    if (latest.schedule_revision !== expectedRevision) {
      throw new HttpError(
        409,
        "SCHEDULE_REVISION_CONFLICT",
        "The project schedule changed on another client.",
        { latest: { projectId, revision: latest.schedule_revision } },
      );
    }
  }

  private assertNoActiveRecurringSource(projectId: string, taskIds: string[]): void {
    if (taskIds.length === 0) return;
    const active = this.dependencies.database.get<{ id: string }>(
      `SELECT id FROM recurring_task_rules WHERE project_id=? AND is_active=1
        AND source_task_id IN (${this.placeholders(taskIds)}) LIMIT 1`,
      [projectId, ...taskIds],
    );
    if (active !== undefined) {
      throw new HttpError(
        409,
        "TASK_RECURRING_SOURCE",
        "Deactivate the recurring rule before deleting its source task.",
      );
    }
  }

  private bumpSchedule(projectId: string): number {
    this.dependencies.database.run(
      "UPDATE projects SET schedule_revision=schedule_revision+1 WHERE id=?",
      [projectId],
    );
    return this.dependencies.database.get<{ schedule_revision: number }>(
      "SELECT schedule_revision FROM projects WHERE id=?",
      [projectId],
    )!.schedule_revision;
  }

  private throwLatestTask(projectId: string, taskId: string): never {
    const latest = this.dependencies.database.get<TaskLifecycleRow>(
      `${this.taskSelect()} WHERE project_id=? AND id=?`,
      [projectId, taskId],
    );
    if (latest === undefined) {
      throw new HttpError(404, "TASK_NOT_FOUND", "The task was not found.");
    }
    throw new HttpError(409, "REVISION_CONFLICT", "The task changed on another client.", {
      latest: toTask(latest),
    });
  }

  private throwLatestProject(auth: AuthenticatedSession, projectId: string): never {
    const latest = this.dependencies.database.get<ProjectLifecycleRow>(
      `${this.projectSelect()}
        JOIN project_members ON project_members.project_id=projects.id
       WHERE projects.id=? AND project_members.user_id=? AND project_members.removed_at IS NULL`,
      [projectId, auth.user.id],
    );
    if (latest === undefined) {
      throw new HttpError(404, "PROJECT_NOT_FOUND", "The project was not found.");
    }
    throw new HttpError(409, "REVISION_CONFLICT", "The project changed on another client.", {
      latest: toProject(latest),
    });
  }
}
