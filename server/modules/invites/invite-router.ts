import { Router, type Response } from "express";

import {
  ExpectedRevisionRequestSchema,
  ProjectInviteRedeemRequestSchema,
} from "../../../shared/contracts.js";
import type { V2RuntimeDependencies } from "../../http/dependencies.js";
import { parseRequestBody } from "../../http/routing.js";
import type { AuthLocals } from "../auth/auth-router.js";
import { ProjectInviteService } from "./invite-service.js";

export function createProjectInviteRouter(
  dependencies: V2RuntimeDependencies,
): Router {
  const router = Router();
  const service = new ProjectInviteService(dependencies);

  router.post(
    "/:projectId/invites",
    (request, response: Response<unknown, AuthLocals>) => {
      response.status(201).json({
        invite: service.create(response.locals.auth, request.params.projectId!),
      });
    },
  );
  router.delete(
    "/:projectId/invites/:inviteId",
    (request, response: Response<unknown, AuthLocals>) => {
      const input = parseRequestBody(ExpectedRevisionRequestSchema, request);
      service.revoke(
        response.locals.auth,
        request.params.projectId!,
        request.params.inviteId!,
        input.expectedRevision,
      );
      response.status(204).end();
    },
  );
  return router;
}

export function createProjectInviteRedemptionRouter(
  dependencies: V2RuntimeDependencies,
): Router {
  const router = Router();
  const service = new ProjectInviteService(dependencies);
  router.post("/redeem", (request, response: Response<unknown, AuthLocals>) => {
    const result = service.redeem(
      response.locals.auth,
      parseRequestBody(ProjectInviteRedeemRequestSchema, request),
      request.ip ?? request.socket.remoteAddress ?? "unknown",
    );
    dependencies.publishEntityInvalidation?.(
      result.projectId,
      "project",
      result.projectId,
    );
    response.json(result);
  });
  return router;
}
