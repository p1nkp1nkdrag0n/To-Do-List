import { Router, type Response } from "express";

import {
  ApplyTemplateRequestSchema,
  CreateDependencyRequestSchema,
  CreateDeliverableRequestSchema,
  CreateMilestoneRequestSchema,
  CreateParticipantRequestSchema,
  CreatePhaseRequestSchema,
  CreateRecurringRuleRequestSchema,
  CreateTaskRequestSchema,
  ExpectedRevisionRequestSchema,
  FulfillDeliverableRequestSchema,
  GenerateRecurringRuleRequestSchema,
  PatchDeliverableRequestSchema,
  PatchMilestoneRequestSchema,
  PatchParticipantRequestSchema,
  PatchPhaseRequestSchema,
  PatchRecurringRuleRequestSchema,
  PatchTaskRequestSchema,
  ProgressUpdateRequestSchema,
  SaveTeamTemplateRequestSchema,
  UpdateTeamTemplateRequestSchema,
} from "../../../shared/schedule-contracts.js";
import type { V2RuntimeDependencies } from "../../http/dependencies.js";
import { parseRequestBody } from "../../http/routing.js";
import type { AuthLocals } from "../auth/auth-router.js";
import { ScheduleService } from "./schedule-service.js";

export function createScheduleRouter(
  dependencies: V2RuntimeDependencies,
): Router {
  const router = Router();
  const service = new ScheduleService(dependencies);

  router.get(
    "/:projectId/schedule",
    (request, response: Response<unknown, AuthLocals>) => {
      response.json(
        service.schedule(response.locals.auth, request.params.projectId!),
      );
    },
  );

  router.get(
    "/:projectId/phases",
    (request, response: Response<unknown, AuthLocals>) => {
      response.json({
        phases: service.listPhases(
          response.locals.auth,
          request.params.projectId!,
        ),
      });
    },
  );
  router.post(
    "/:projectId/phases",
    (request, response: Response<unknown, AuthLocals>) => {
      response.status(201).json(
        service.createPhase(
          response.locals.auth,
          request.params.projectId!,
          parseRequestBody(CreatePhaseRequestSchema, request),
        ),
      );
    },
  );
  router.patch(
    "/:projectId/phases/:phaseId",
    (request, response: Response<unknown, AuthLocals>) => {
      response.json(
        service.updatePhase(
          response.locals.auth,
          request.params.projectId!,
          request.params.phaseId!,
          parseRequestBody(PatchPhaseRequestSchema, request),
        ),
      );
    },
  );

  router.get("/:projectId/participants", (request, response: Response<unknown, AuthLocals>) => {
    response.json({ participants: service.listParticipants(response.locals.auth, request.params.projectId!) });
  });
  router.get("/:projectId/dependencies", (request, response: Response<unknown, AuthLocals>) => {
    response.json({ dependencies: service.listDependencies(response.locals.auth, request.params.projectId!) });
  });
  router.get("/:projectId/deliverables", (request, response: Response<unknown, AuthLocals>) => {
    response.json({ deliverables: service.listDeliverables(response.locals.auth, request.params.projectId!) });
  });
  router.get("/:projectId/deliverables/:deliverableId", (request, response: Response<unknown, AuthLocals>) => {
    response.json({ deliverable: service.getDeliverable(response.locals.auth, request.params.projectId!, request.params.deliverableId!) });
  });
  router.delete("/:projectId/tasks/:taskId", (request, response: Response<unknown, AuthLocals>) => {
    const input = parseRequestBody(ExpectedRevisionRequestSchema, request);
    response.json(service.deleteTask(response.locals.auth, request.params.projectId!, request.params.taskId!, input.expectedRevision));
  });
  router.delete("/:projectId/phases/:phaseId", (request, response: Response<unknown, AuthLocals>) => {
    const input = parseRequestBody(ExpectedRevisionRequestSchema, request);
    response.json(service.deletePhase(response.locals.auth, request.params.projectId!, request.params.phaseId!, input.expectedRevision));
  });

  router.get(
    "/:projectId/tasks",
    (request, response: Response<unknown, AuthLocals>) => {
      response.json({
        tasks: service.listTasks(
          response.locals.auth,
          request.params.projectId!,
        ),
      });
    },
  );
  router.post(
    "/:projectId/tasks",
    (request, response: Response<unknown, AuthLocals>) => {
      response.status(201).json(
        service.createTask(
          response.locals.auth,
          request.params.projectId!,
          parseRequestBody(CreateTaskRequestSchema, request),
        ),
      );
    },
  );
  router.get(
    "/:projectId/tasks/:taskId",
    (request, response: Response<unknown, AuthLocals>) => {
      response.json({
        task: service.getTask(
          response.locals.auth,
          request.params.projectId!,
          request.params.taskId!,
        ),
      });
    },
  );
  router.patch(
    "/:projectId/tasks/:taskId",
    (request, response: Response<unknown, AuthLocals>) => {
      response.json(
        service.updateTask(
          response.locals.auth,
          request.params.projectId!,
          request.params.taskId!,
          parseRequestBody(PatchTaskRequestSchema, request),
        ),
      );
    },
  );

  router.post("/:projectId/tasks/:taskId/participants", (request, response: Response<unknown, AuthLocals>) => {
    response.status(201).json(service.addParticipant(response.locals.auth, request.params.projectId!, request.params.taskId!, parseRequestBody(CreateParticipantRequestSchema, request)));
  });
  router.patch("/:projectId/participants/:participantId", (request, response: Response<unknown, AuthLocals>) => {
    response.json(service.updateParticipant(response.locals.auth, request.params.projectId!, request.params.participantId!, parseRequestBody(PatchParticipantRequestSchema, request)));
  });
  router.delete("/:projectId/participants/:participantId", (request, response: Response<unknown, AuthLocals>) => {
    const input = parseRequestBody(ExpectedRevisionRequestSchema, request);
    response.json(service.deleteParticipant(response.locals.auth, request.params.projectId!, request.params.participantId!, input.expectedRevision));
  });
  router.get("/:projectId/participants/:participantId/progress", (request, response: Response<unknown, AuthLocals>) => {
    response.json({ progressUpdates: service.progressUpdates(response.locals.auth, request.params.projectId!, request.params.participantId!) });
  });
  router.post("/:projectId/participants/:participantId/progress", (request, response: Response<unknown, AuthLocals>) => {
    response.status(201).json(service.recordProgress(response.locals.auth, request.params.projectId!, request.params.participantId!, parseRequestBody(ProgressUpdateRequestSchema, request)));
  });
  router.post("/:projectId/tasks/:taskId/review", (request, response: Response<unknown, AuthLocals>) => {
    const input = parseRequestBody(ExpectedRevisionRequestSchema, request);
    response.json(service.reviewTask(response.locals.auth, request.params.projectId!, request.params.taskId!, input.expectedRevision));
  });
  router.post("/:projectId/tasks/:taskId/reopen", (request, response: Response<unknown, AuthLocals>) => {
    const input = parseRequestBody(ExpectedRevisionRequestSchema, request);
    response.json(service.reopenTask(response.locals.auth, request.params.projectId!, request.params.taskId!, input.expectedRevision));
  });

  router.post("/:projectId/tasks/:taskId/dependencies", (request, response: Response<unknown, AuthLocals>) => {
    response.status(201).json(service.createDependency(response.locals.auth, request.params.projectId!, request.params.taskId!, parseRequestBody(CreateDependencyRequestSchema, request)));
  });
  router.delete("/:projectId/dependencies/:dependencyId", (request, response: Response<unknown, AuthLocals>) => {
    const input = parseRequestBody(ExpectedRevisionRequestSchema, request);
    response.json(service.deleteDependency(response.locals.auth, request.params.projectId!, request.params.dependencyId!, input.expectedRevision));
  });

  router.post("/:projectId/milestones", (request, response: Response<unknown, AuthLocals>) => {
    response.status(201).json(service.createMilestone(response.locals.auth, request.params.projectId!, parseRequestBody(CreateMilestoneRequestSchema, request)));
  });
  router.get("/:projectId/milestones", (request, response: Response<unknown, AuthLocals>) => {
    response.json({ milestones: service.listMilestones(response.locals.auth, request.params.projectId!) });
  });
  router.get("/:projectId/milestones/:milestoneId", (request, response: Response<unknown, AuthLocals>) => {
    response.json({ milestone: service.getMilestone(response.locals.auth, request.params.projectId!, request.params.milestoneId!) });
  });
  router.patch("/:projectId/milestones/:milestoneId", (request, response: Response<unknown, AuthLocals>) => {
    response.json(service.updateMilestone(response.locals.auth, request.params.projectId!, request.params.milestoneId!, parseRequestBody(PatchMilestoneRequestSchema, request)));
  });
  router.post("/:projectId/milestones/:milestoneId/review", (request, response: Response<unknown, AuthLocals>) => {
    const input = parseRequestBody(ExpectedRevisionRequestSchema, request);
    response.json(service.reviewMilestone(response.locals.auth, request.params.projectId!, request.params.milestoneId!, input.expectedRevision));
  });
  router.post("/:projectId/milestones/:milestoneId/submit-review", (request, response: Response<unknown, AuthLocals>) => {
    const input = parseRequestBody(ExpectedRevisionRequestSchema, request);
    response.json(service.submitMilestoneForReview(response.locals.auth, request.params.projectId!, request.params.milestoneId!, input.expectedRevision));
  });
  router.post("/:projectId/milestones/:milestoneId/reopen", (request, response: Response<unknown, AuthLocals>) => {
    const input = parseRequestBody(ExpectedRevisionRequestSchema, request);
    response.json(service.reopenMilestone(response.locals.auth, request.params.projectId!, request.params.milestoneId!, input.expectedRevision));
  });
  router.delete("/:projectId/milestones/:milestoneId", (request, response: Response<unknown, AuthLocals>) => {
    const input = parseRequestBody(ExpectedRevisionRequestSchema, request);
    response.json(service.deleteMilestone(response.locals.auth, request.params.projectId!, request.params.milestoneId!, input.expectedRevision));
  });

  router.post("/:projectId/tasks/:taskId/deliverables", (request, response: Response<unknown, AuthLocals>) => {
    response.status(201).json(service.createDeliverable(response.locals.auth, request.params.projectId!, { taskId: request.params.taskId! }, parseRequestBody(CreateDeliverableRequestSchema, request)));
  });
  router.post("/:projectId/milestones/:milestoneId/deliverables", (request, response: Response<unknown, AuthLocals>) => {
    response.status(201).json(service.createDeliverable(response.locals.auth, request.params.projectId!, { milestoneId: request.params.milestoneId! }, parseRequestBody(CreateDeliverableRequestSchema, request)));
  });
  router.patch("/:projectId/deliverables/:deliverableId", (request, response: Response<unknown, AuthLocals>) => {
    response.json(service.updateDeliverable(response.locals.auth, request.params.projectId!, request.params.deliverableId!, parseRequestBody(PatchDeliverableRequestSchema, request)));
  });
  router.delete("/:projectId/deliverables/:deliverableId", (request, response: Response<unknown, AuthLocals>) => {
    const input = parseRequestBody(ExpectedRevisionRequestSchema, request);
    response.json(service.deleteDeliverable(response.locals.auth, request.params.projectId!, request.params.deliverableId!, input.expectedRevision));
  });
  router.post("/:projectId/deliverables/:deliverableId/fulfill", (request, response: Response<unknown, AuthLocals>) => {
    response.json(service.fulfillDeliverable(response.locals.auth, request.params.projectId!, request.params.deliverableId!, parseRequestBody(FulfillDeliverableRequestSchema, request)));
  });
  router.post("/:projectId/deliverables/:deliverableId/unfulfill", (request, response: Response<unknown, AuthLocals>) => {
    const input = parseRequestBody(ExpectedRevisionRequestSchema, request);
    response.json(service.unfulfillDeliverable(response.locals.auth, request.params.projectId!, request.params.deliverableId!, input.expectedRevision));
  });

  router.post("/:projectId/recurring-rules", (request, response: Response<unknown, AuthLocals>) => {
    response.status(201).json(service.createRecurringRule(response.locals.auth, request.params.projectId!, parseRequestBody(CreateRecurringRuleRequestSchema, request)));
  });
  router.get("/:projectId/recurring-rules", (request, response: Response<unknown, AuthLocals>) => {
    response.json({ recurringRules: service.listRecurringRules(response.locals.auth, request.params.projectId!) });
  });
  router.get("/:projectId/recurring-rules/:ruleId", (request, response: Response<unknown, AuthLocals>) => {
    response.json({ rule: service.getRecurringRule(response.locals.auth, request.params.projectId!, request.params.ruleId!) });
  });
  router.patch("/:projectId/recurring-rules/:ruleId", (request, response: Response<unknown, AuthLocals>) => {
    response.json(service.updateRecurringRule(response.locals.auth, request.params.projectId!, request.params.ruleId!, parseRequestBody(PatchRecurringRuleRequestSchema, request)));
  });
  router.delete("/:projectId/recurring-rules/:ruleId", (request, response: Response<unknown, AuthLocals>) => {
    const input = parseRequestBody(ExpectedRevisionRequestSchema, request);
    response.json(service.deleteRecurringRule(response.locals.auth, request.params.projectId!, request.params.ruleId!, input.expectedRevision));
  });
  router.post("/:projectId/recurring-rules/:ruleId/generate", (request, response: Response<unknown, AuthLocals>) => {
    const input = parseRequestBody(GenerateRecurringRuleRequestSchema, request);
    response.json(service.generateRecurringInstances(response.locals.auth, request.params.projectId!, request.params.ruleId!, input.expectedRevision, input.throughDate));
  });

  router.post("/:projectId/templates", (request, response: Response<unknown, AuthLocals>) => {
    response.status(201).json(service.saveTeamTemplate(response.locals.auth, request.params.projectId!, parseRequestBody(SaveTeamTemplateRequestSchema, request)));
  });
  router.post("/:projectId/templates/:templateId/apply", (request, response: Response<unknown, AuthLocals>) => {
    response.json(service.applyTemplate(response.locals.auth, request.params.projectId!, request.params.templateId!, parseRequestBody(ApplyTemplateRequestSchema, request)));
  });
  router.get("/templates", (_request, response: Response<unknown, AuthLocals>) => response.json(service.listTemplates(response.locals.auth)));
  router.patch("/templates/:templateId", (request, response: Response<unknown, AuthLocals>) => response.json({ template: service.updateTeamTemplate(response.locals.auth, request.params.templateId!, parseRequestBody(UpdateTeamTemplateRequestSchema, request)) }));
  router.delete("/templates/:templateId", (request, response: Response<unknown, AuthLocals>) => {
    const input = parseRequestBody(ExpectedRevisionRequestSchema, request);
    response.json(service.archiveTeamTemplate(response.locals.auth, request.params.templateId!, input.expectedRevision));
  });

  return router;
}
