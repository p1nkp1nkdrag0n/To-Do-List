import express, { type Express } from "express";

import { createAuthRouter } from "../modules/auth/auth-router.js";
import { createRequireAuth } from "../modules/auth/auth-router.js";
import {
  createProjectInviteRedemptionRouter,
  createProjectInviteRouter,
} from "../modules/invites/invite-router.js";
import { createProjectRouter } from "../modules/projects/project-router.js";
import { createTeamRouter } from "../modules/team/team-router.js";
import {
  resolveDependencies,
  type V2AppDependencies,
} from "./dependencies.js";
import { createV2ErrorHandler, HttpError } from "./errors.js";

export function createV2App(dependencies: V2AppDependencies): Express {
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
    "/api/projects",
    requireAuth,
    createProjectInviteRouter(runtime),
    createProjectRouter(runtime),
  );
  app.use(
    "/api/project-invites",
    requireAuth,
    createProjectInviteRedemptionRouter(runtime),
  );
  app.use((_request, _response, next) => {
    next(new HttpError(404, "NOT_FOUND", "The requested endpoint was not found."));
  });
  app.use(createV2ErrorHandler(runtime.logger));
  return app;
}

export type { V2AppDependencies } from "./dependencies.js";
