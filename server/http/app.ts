import express, { type Express } from "express";
import path from "node:path";

import {
  createMeAvailabilityRouter,
  createProjectAvailabilityRouter,
} from "../modules/availability/availability-router.js";
import { createAuthRouter } from "../modules/auth/auth-router.js";
import { createRequireAuth } from "../modules/auth/auth-router.js";
import {
  createProjectInviteRedemptionRouter,
  createProjectInviteRouter,
} from "../modules/invites/invite-router.js";
import {
  createProjectLifecycleRouter,
  createTrashRouter,
} from "../modules/lifecycle/lifecycle-router.js";
import { createProjectRouter } from "../modules/projects/project-router.js";
import { createProjectWriteGuard } from "../modules/projects/project-write-guard.js";
import { createResourceRouter } from "../modules/resources/resource-router.js";
import { createScheduleRouter } from "../modules/schedule/schedule-router.js";
import { createTeamRouter } from "../modules/team/team-router.js";
import {
  resolveDependencies,
  type V2AppDependencies,
} from "./dependencies.js";
import { createV2ErrorHandler, HttpError } from "./errors.js";

export interface V2AppOptions {
  staticPath?: string;
}

export function createV2App(
  dependencies: V2AppDependencies,
  options: V2AppOptions = {},
): Express {
  const runtime = resolveDependencies(dependencies);
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", runtime.trustProxyHops);
  app.use(express.json({ limit: "1mb", strict: true }));
  app.get("/healthz", (_request, response) => {
    response.json({ ok: true, version: "v2" });
  });
  app.use("/api/auth", createAuthRouter(runtime));
  const requireAuth = createRequireAuth(runtime);
  app.use("/api/team", requireAuth, createTeamRouter(runtime));
  app.use(
    "/api/me",
    requireAuth,
    (request, response, next) => {
      if (request.method === "PUT" && request.path === "/availability") {
        const userId = response.locals.auth.user.id;
        response.once("finish", () => {
          if (response.statusCode < 200 || response.statusCode >= 400) return;
          const projects = runtime.database.all<{ id: string }>(
            `SELECT projects.id
               FROM projects
               JOIN project_members ON project_members.project_id=projects.id
              WHERE project_members.user_id=?
                AND project_members.removed_at IS NULL
                AND projects.deleted_at IS NULL`,
            [userId],
          );
          for (const project of projects) {
            runtime.publishEntityInvalidation?.(
              project.id,
              "availability",
              userId,
            );
          }
        });
      }
      next();
    },
    createMeAvailabilityRouter(runtime),
  );
  app.use("/api/trash", requireAuth, createTrashRouter(runtime));
  app.use(
    "/api/projects",
    requireAuth,
    (request, response, next) => {
      if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
        const projectId = request.path.split("/").filter(Boolean)[0];
        if (projectId !== undefined) {
          response.once("finish", () => {
            if (response.statusCode >= 200 && response.statusCode < 400) {
              runtime.publishEntityInvalidation?.(projectId, "project", projectId);
            }
          });
        }
      }
      next();
    },
    createProjectLifecycleRouter(runtime),
    createProjectWriteGuard(runtime),
    createResourceRouter(runtime),
    createProjectAvailabilityRouter(runtime),
    createProjectInviteRouter(runtime),
    createScheduleRouter(runtime),
    createProjectRouter(runtime),
  );
  app.use(
    "/api/project-invites",
    requireAuth,
    createProjectInviteRedemptionRouter(runtime),
  );
  if (options.staticPath !== undefined) {
    const staticPath = path.resolve(options.staticPath);
    app.use(express.static(staticPath, { index: "index.html" }));
    app.use((request, response, next) => {
      if (
        request.method !== "GET"
        || request.path.startsWith("/api/")
        || request.path === "/api"
        || request.path === "/healthz"
        || request.path === "/ws"
        || path.extname(request.path) !== ""
        || !request.accepts("html")
      ) {
        next();
        return;
      }
      response.sendFile(path.join(staticPath, "index.html"), (error) => {
        if (error) next(error);
      });
    });
  }
  app.use((_request, _response, next) => {
    next(new HttpError(404, "NOT_FOUND", "The requested endpoint was not found."));
  });
  app.use(createV2ErrorHandler(runtime.logger));
  return app;
}

export type { V2AppDependencies } from "./dependencies.js";
