import { Router, type Response } from "express";
import { z } from "zod";

import { IdSchema, RevisionSchema } from "../../../shared/contracts.js";
import { ExpectedRevisionRequestSchema } from "../../../shared/schedule-contracts.js";
import type { V2RuntimeDependencies } from "../../http/dependencies.js";
import { asyncRoute, parseRequestBody } from "../../http/routing.js";
import type { AuthLocals } from "../auth/auth-router.js";
import { LifecycleService } from "./lifecycle-service.js";

const PermanentDeleteRequestSchema = z
  .object({ expectedRevision: RevisionSchema, confirmation: IdSchema })
  .strict();
const TaskLifecycleRequestSchema = z
  .object({
    expectedRevision: RevisionSchema,
    expectedScheduleRevision: RevisionSchema,
  })
  .strict();
const PermanentTaskDeleteRequestSchema = z
  .object({
    expectedRevision: RevisionSchema,
    expectedScheduleRevision: RevisionSchema,
    confirmation: IdSchema,
  })
  .strict();
const ProjectTrashRequestSchema = TaskLifecycleRequestSchema;

export function createProjectLifecycleRouter(dependencies: V2RuntimeDependencies): Router {
  const router = Router();
  const service = new LifecycleService(dependencies);

  router.get("/archived", (_request, response: Response<unknown, AuthLocals>) => {
    response.json({ projects: service.listArchivedProjects(response.locals.auth) });
  });

  router.post("/:projectId/tasks/:taskId/archive", (request, response: Response<unknown, AuthLocals>) => {
    const input = parseRequestBody(TaskLifecycleRequestSchema, request);
    response.json(service.archiveTask(response.locals.auth, request.params.projectId!, request.params.taskId!, input.expectedRevision, input.expectedScheduleRevision));
  });
  router.post("/:projectId/tasks/:taskId/unarchive", (request, response: Response<unknown, AuthLocals>) => {
    const input = parseRequestBody(TaskLifecycleRequestSchema, request);
    response.json(service.unarchiveTask(response.locals.auth, request.params.projectId!, request.params.taskId!, input.expectedRevision, input.expectedScheduleRevision));
  });
  router.delete("/:projectId/tasks/:taskId", (request, response: Response<unknown, AuthLocals>) => {
    const input = parseRequestBody(TaskLifecycleRequestSchema, request);
    response.json(service.trashTask(response.locals.auth, request.params.projectId!, request.params.taskId!, input.expectedRevision, input.expectedScheduleRevision));
  });
  router.post("/:projectId/tasks/:taskId/restore", (request, response: Response<unknown, AuthLocals>) => {
    const input = parseRequestBody(TaskLifecycleRequestSchema, request);
    response.json(service.restoreTask(response.locals.auth, request.params.projectId!, request.params.taskId!, input.expectedRevision, input.expectedScheduleRevision));
  });
  router.delete("/:projectId/tasks/:taskId/permanent", (request, response: Response<unknown, AuthLocals>) => {
    const input = parseRequestBody(PermanentTaskDeleteRequestSchema, request);
    response.json(service.permanentlyDeleteTask(response.locals.auth, request.params.projectId!, request.params.taskId!, input.expectedRevision, input.expectedScheduleRevision, input.confirmation));
  });
  router.get("/:projectId/trash", (request, response: Response<unknown, AuthLocals>) => {
    response.json({ tasks: service.projectTrash(response.locals.auth, request.params.projectId!) });
  });
  router.get("/:projectId/archived/tasks", (request, response: Response<unknown, AuthLocals>) => {
    response.json({ tasks: service.archivedTasks(response.locals.auth, request.params.projectId!) });
  });

  router.post("/:projectId/archive", (request, response: Response<unknown, AuthLocals>) => {
    const input = parseRequestBody(ExpectedRevisionRequestSchema, request);
    response.json(service.archiveProject(response.locals.auth, request.params.projectId!, input.expectedRevision));
  });
  router.post("/:projectId/unarchive", (request, response: Response<unknown, AuthLocals>) => {
    const input = parseRequestBody(ExpectedRevisionRequestSchema, request);
    response.json(service.unarchiveProject(response.locals.auth, request.params.projectId!, input.expectedRevision));
  });
  router.delete("/:projectId", (request, response: Response<unknown, AuthLocals>) => {
    const input = parseRequestBody(ProjectTrashRequestSchema, request);
    response.json(service.trashProject(response.locals.auth, request.params.projectId!, input.expectedRevision, input.expectedScheduleRevision));
  });

  return router;
}

export function createTrashRouter(dependencies: V2RuntimeDependencies): Router {
  const router = Router();
  const service = new LifecycleService(dependencies);

  router.get("/projects", (_request, response: Response<unknown, AuthLocals>) => {
    response.json({ projects: service.listProjectTrash(response.locals.auth) });
  });
  router.post("/projects/:projectId/restore", (request, response: Response<unknown, AuthLocals>) => {
    const input = parseRequestBody(ExpectedRevisionRequestSchema, request);
    response.json(service.restoreProject(response.locals.auth, request.params.projectId!, input.expectedRevision));
  });
  router.delete("/projects/:projectId/permanent", asyncRoute(async (request, response: Response<unknown, AuthLocals>) => {
    const input = parseRequestBody(PermanentDeleteRequestSchema, request);
    response.json(await service.permanentlyDeleteProject(response.locals.auth, request.params.projectId!, input.expectedRevision, input.confirmation));
  }));

  return router;
}
