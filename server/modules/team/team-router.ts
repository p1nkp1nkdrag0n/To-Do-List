import { Router, type Response } from "express";

import {
  AddTeamMemberRequestSchema,
  ExpectedRevisionRequestSchema,
} from "../../../shared/contracts.js";
import type { V2RuntimeDependencies } from "../../http/dependencies.js";
import { parseRequestBody } from "../../http/routing.js";
import type { AuthLocals } from "../auth/auth-router.js";
import { createRegistrationInviteRouter } from "../registration-invites/registration-invite-router.js";
import { TeamService } from "./team-service.js";

export function createTeamRouter(dependencies: V2RuntimeDependencies): Router {
  const router = Router();
  const service = new TeamService(dependencies);

  router.use(
    "/registration-invites",
    createRegistrationInviteRouter(dependencies),
  );

  router.get("/", (_request, response: Response<unknown, AuthLocals>) => {
    response.json({ members: service.list(response.locals.auth) });
  });
  router.post("/members", (request, response: Response<unknown, AuthLocals>) => {
    response.json(
      service.add(
        response.locals.auth,
        parseRequestBody(AddTeamMemberRequestSchema, request),
      ),
    );
  });
  router.delete(
    "/members/:userId",
    (request, response: Response<unknown, AuthLocals>) => {
      const input = parseRequestBody(ExpectedRevisionRequestSchema, request);
      service.remove(
        response.locals.auth,
        request.params.userId!,
        input.expectedRevision,
      );
      response.status(204).end();
    },
  );
  return router;
}
