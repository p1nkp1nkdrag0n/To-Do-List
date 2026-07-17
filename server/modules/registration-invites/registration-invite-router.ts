import { Router, type Response } from "express";

import {
  CreateRegistrationInviteRequestSchema,
  ExpectedRevisionRequestSchema,
} from "../../../shared/contracts.js";
import type { V2RuntimeDependencies } from "../../http/dependencies.js";
import { parseRequestBody } from "../../http/routing.js";
import type { AuthLocals } from "../auth/auth-router.js";
import { RegistrationInviteService } from "./registration-invite-service.js";

export function createRegistrationInviteRouter(
  dependencies: V2RuntimeDependencies,
): Router {
  const router = Router();
  const service = new RegistrationInviteService(dependencies);

  router.post("/", (request, response: Response<unknown, AuthLocals>) => {
    parseRequestBody(CreateRegistrationInviteRequestSchema, request);
    response.status(201).json({
      invite: service.create(response.locals.auth.user.id),
    });
  });
  router.delete(
    "/:inviteId",
    (request, response: Response<unknown, AuthLocals>) => {
      const input = parseRequestBody(ExpectedRevisionRequestSchema, request);
      service.revoke(
        response.locals.auth.user.id,
        request.params.inviteId!,
        input.expectedRevision,
      );
      response.status(204).end();
    },
  );
  return router;
}
