import type { NextFunction, Request, Response } from "express";

import type { V2RuntimeDependencies } from "../../http/dependencies.js";
import { HttpError } from "../../http/errors.js";
import type { AuthLocals } from "../auth/auth-router.js";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function createProjectWriteGuard(dependencies: V2RuntimeDependencies) {
  return (
    request: Request,
    response: Response<unknown, AuthLocals>,
    next: NextFunction,
  ): void => {
    if (!MUTATING_METHODS.has(request.method)) {
      next();
      return;
    }
    const projectId = request.path.split("/").filter(Boolean)[0];
    if (projectId === undefined) {
      next();
      return;
    }
    const project = dependencies.database.get<{ archived_at: string | null }>(
      `SELECT projects.archived_at FROM projects
        JOIN project_members ON project_members.project_id=projects.id
       WHERE projects.id=? AND project_members.user_id=?
         AND project_members.removed_at IS NULL AND projects.deleted_at IS NULL`,
      [projectId, response.locals.auth.user.id],
    );
    if (project !== undefined && project.archived_at !== null) {
      next(
        new HttpError(
          409,
          "PROJECT_ARCHIVED",
          "Unarchive the project before changing its content.",
        ),
      );
      return;
    }
    next();
  };
}
