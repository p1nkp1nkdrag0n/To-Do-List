import type { V2RuntimeDependencies } from "../http/dependencies.js";

export interface ActivityInput {
  projectId?: string | null;
  actorId?: string | null;
  entityType: string;
  entityId?: string | null;
  action: string;
  metadata?: Record<string, unknown>;
}

export function writeActivity(
  dependencies: V2RuntimeDependencies,
  input: ActivityInput,
): void {
  dependencies.database.run(
    `INSERT INTO activity_log
      (id, project_id, actor_id, entity_type, entity_id, action, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      dependencies.idGenerator(),
      input.projectId ?? null,
      input.actorId ?? null,
      input.entityType,
      input.entityId ?? null,
      input.action,
      JSON.stringify(input.metadata ?? {}),
      dependencies.clock().toISOString(),
    ],
  );
}
