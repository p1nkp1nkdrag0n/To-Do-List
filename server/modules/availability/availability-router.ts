import { Router, type Response } from "express";

import { PutAvailabilityRequestSchema } from "../../../shared/availability-contracts.js";
import type { V2RuntimeDependencies } from "../../http/dependencies.js";
import { parseRequestBody } from "../../http/routing.js";
import type { AuthLocals } from "../auth/auth-router.js";
import { AvailabilityService } from "./availability-service.js";

export function createMeAvailabilityRouter(
  dependencies: V2RuntimeDependencies,
): Router {
  const router = Router();
  const service = new AvailabilityService(dependencies);

  router.get(
    "/availability",
    (_request, response: Response<unknown, AuthLocals>) => {
      response.json(service.getDocument(response.locals.auth));
    },
  );
  router.put(
    "/availability",
    (request, response: Response<unknown, AuthLocals>) => {
      response.json(
        service.replaceDocument(
          response.locals.auth,
          parseRequestBody(PutAvailabilityRequestSchema, request),
        ),
      );
    },
  );

  return router;
}

export function createProjectAvailabilityRouter(
  dependencies: V2RuntimeDependencies,
): Router {
  const router = Router();
  const service = new AvailabilityService(dependencies);

  router.get(
    "/:projectId/availability",
    (request, response: Response<unknown, AuthLocals>) => {
      response.json(
        service.projectSummary(
          response.locals.auth,
          request.params.projectId!,
        ),
      );
    },
  );

  return router;
}
