import type { V2RuntimeDependencies } from "../http/dependencies.js";
import { withProgressPurgeContext } from "./progress-purge-context.js";
import { drainStorageGarbageQueue } from "./resources/storage-gc.js";

type TrashHousekeepingDependencies = Pick<
  V2RuntimeDependencies,
  "database" | "blobStore" | "clock" | "idGenerator"
>;

export interface TrashPurgeResult {
  projects: number;
  tasks: number;
  resources: number;
  blobsDeleted: number;
  blobsFailed: number;
}

interface TrashRow extends Record<string, unknown> {
  id: string;
  project_id: string;
}

function writePurgeActivity(
  dependencies: TrashHousekeepingDependencies,
  input: {
    projectId: string | null;
    entityType: "project" | "task" | "resource";
    entityId: string;
    createdAt: string;
  },
): void {
  dependencies.database.run(
    `INSERT INTO activity_log
      (id, project_id, actor_id, entity_type, entity_id, action, metadata_json, created_at)
     VALUES (?, ?, NULL, ?, ?, ?, '{}', ?)`,
    [
      dependencies.idGenerator(),
      input.projectId,
      input.entityType,
      input.entityId,
      `${input.entityType}.expired_trash_purged`,
      input.createdAt,
    ],
  );
}

export async function purgeExpiredTrash(
  dependencies: TrashHousekeepingDependencies,
): Promise<TrashPurgeResult> {
  const now = dependencies.clock().toISOString();
  const counts = dependencies.database.transaction(() => {
    const projects = dependencies.database.all<TrashRow>(
      `SELECT id, id AS project_id FROM projects
        WHERE deleted_at IS NOT NULL AND purge_after<=? ORDER BY purge_after, id`,
      [now],
    );
    const projectIds = new Set(projects.map((project) => project.id));
    const resources = dependencies.database.all<TrashRow>(
      `SELECT id, project_id FROM resources
        WHERE deleted_at IS NOT NULL AND purge_after<=? ORDER BY purge_after, id`,
      [now],
    ).filter((resource) => !projectIds.has(resource.project_id));
    const tasks = dependencies.database.all<TrashRow>(
      `SELECT tasks.id, tasks.project_id FROM tasks
        WHERE tasks.deleted_at IS NOT NULL AND tasks.purge_after<=?
          AND NOT EXISTS (
            SELECT 1 FROM tasks AS parent
             WHERE parent.id=tasks.parent_id
               AND parent.deleted_at IS NOT NULL AND parent.purge_after<=?
          )
          AND NOT EXISTS (
            WITH RECURSIVE descendants(id) AS (
              SELECT child.id FROM tasks AS child WHERE child.parent_id=tasks.id
              UNION ALL
              SELECT child.id FROM tasks AS child
                JOIN descendants ON child.parent_id=descendants.id
            )
            SELECT 1 FROM tasks AS descendant
              JOIN descendants ON descendants.id=descendant.id
             WHERE descendant.deleted_at IS NULL OR descendant.purge_after>?
          )
        ORDER BY tasks.purge_after, tasks.id`,
      [now, now, now],
    ).filter((task) => !projectIds.has(task.project_id));

    const taskIds = tasks.map((task) => task.id);
    const participantIds = dependencies.database
      .all<{ id: string }>(
        `SELECT task_participants.id FROM task_participants
          WHERE task_participants.project_id IN (${placeholders([...projectIds])})
             OR task_participants.task_id IN (
               WITH RECURSIVE purge_tree(id) AS (
                 SELECT tasks.id FROM tasks
                  WHERE tasks.id IN (${placeholders(taskIds)})
                 UNION ALL
                 SELECT child.id FROM tasks AS child
                   JOIN purge_tree ON child.parent_id=purge_tree.id
               )
               SELECT id FROM purge_tree
             )`,
        [...projectIds, ...taskIds],
      )
      .map(({ id }) => id);

    withProgressPurgeContext(dependencies.database, participantIds, () => {
      for (const resource of resources) {
        writePurgeActivity(dependencies, {
          projectId: resource.project_id,
          entityType: "resource",
          entityId: resource.id,
          createdAt: now,
        });
        dependencies.database.run(
          "DELETE FROM resources WHERE id=? AND deleted_at IS NOT NULL AND purge_after<=?",
          [resource.id, now],
        );
      }
      for (const task of tasks) {
        writePurgeActivity(dependencies, {
          projectId: task.project_id,
          entityType: "task",
          entityId: task.id,
          createdAt: now,
        });
        dependencies.database.run(
          "DELETE FROM tasks WHERE id=? AND deleted_at IS NOT NULL AND purge_after<=?",
          [task.id, now],
        );
      }
      for (const project of projects) {
        dependencies.database.run(
          "DELETE FROM projects WHERE id=? AND deleted_at IS NOT NULL AND purge_after<=?",
          [project.id, now],
        );
        writePurgeActivity(dependencies, {
          projectId: null,
          entityType: "project",
          entityId: project.id,
          createdAt: now,
        });
      }
    });
    return {
      projects: projects.length,
      tasks: tasks.length,
      resources: resources.length,
    };
  });
  const blobs = await drainStorageGarbageQueue(dependencies);
  return {
    ...counts,
    blobsDeleted: blobs.deleted,
    blobsFailed: blobs.failed,
  };
}

function placeholders(values: readonly unknown[]): string {
  return values.length === 0 ? "SELECT NULL WHERE 0" : values.map(() => "?").join(", ");
}
