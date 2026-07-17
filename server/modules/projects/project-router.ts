import { Router, type Response } from "express";

import {
  AddProjectMemberRequestSchema,
  CreateProjectRequestSchema,
  ExpectedRevisionRequestSchema,
  PatchProjectRequestSchema,
} from "../../../shared/contracts.js";
import type { V2RuntimeDependencies } from "../../http/dependencies.js";
import { parseRequestBody } from "../../http/routing.js";
import type { AuthLocals } from "../auth/auth-router.js";
import { ProjectService } from "./project-service.js";

export function createProjectRouter(dependencies: V2RuntimeDependencies): Router {
  const router = Router();
  const service = new ProjectService(dependencies);

  router.get("/", (_request, response: Response<unknown, AuthLocals>) => {
    response.json({ projects: service.list(response.locals.auth) });
  });
  router.post("/", (request, response: Response<unknown, AuthLocals>) => {
    response.status(201).json(
      service.create(
        response.locals.auth,
        parseRequestBody(CreateProjectRequestSchema, request),
      ),
    );
  });
  router.get("/:projectId", (request, response: Response<unknown, AuthLocals>) => {
    response.json(service.detail(response.locals.auth, request.params.projectId!));
  });
  router.patch("/:projectId", (request, response: Response<unknown, AuthLocals>) => {
    response.json({
      project: service.update(
        response.locals.auth,
        request.params.projectId!,
        parseRequestBody(PatchProjectRequestSchema, request),
      ),
    });
  });
  router.post(
    "/:projectId/members",
    (request, response: Response<unknown, AuthLocals>) => {
      response.json(
        service.addMember(
          response.locals.auth,
          request.params.projectId!,
          parseRequestBody(AddProjectMemberRequestSchema, request),
        ),
      );
    },
  );
  router.delete(
    "/:projectId/members/:userId",
    (request, response: Response<unknown, AuthLocals>) => {
      const input = parseRequestBody(ExpectedRevisionRequestSchema, request);
      service.removeMember(
        response.locals.auth,
        request.params.projectId!,
        request.params.userId!,
        input.expectedRevision,
      );
      response.status(204).end();
    },
  );
  return router;
}
