import { z } from "zod";

import { createsDependencyCycle, createsParentCycle } from "./graph.js";

const TemplateKeySchema = z.string().trim().min(1).max(120);
const NullableOffsetSchema = z.number().int().min(-36_500).max(36_500).nullable();

const TemplatePhaseSchema = z
  .object({
    key: TemplateKeySchema,
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(10_000),
    position: z.number().int(),
    startOffsetDays: NullableOffsetSchema,
    endOffsetDays: NullableOffsetSchema,
  })
  .strict();

const TemplateTaskSchema = z
  .object({
    key: TemplateKeySchema,
    phaseKey: TemplateKeySchema.nullable(),
    parentKey: TemplateKeySchema.nullable(),
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(20_000),
    position: z.number().int(),
    startOffsetDays: NullableOffsetSchema,
    dueOffsetDays: NullableOffsetSchema,
  })
  .strict();

const TemplateDependencySchema = z
  .object({
    predecessorTaskKey: TemplateKeySchema,
    successorTaskKey: TemplateKeySchema,
  })
  .strict();

const TemplateMilestoneSchema = z
  .object({
    key: TemplateKeySchema,
    phaseKey: TemplateKeySchema.nullable(),
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(20_000),
    dueOffsetDays: z.number().int().min(-36_500).max(36_500),
  })
  .strict();

const TemplateDeliverableSchema = z.discriminatedUnion("ownerType", [
  z
    .object({
      ownerType: z.literal("task"),
      ownerKey: TemplateKeySchema,
      title: z.string().trim().min(1).max(200),
      description: z.string().trim().max(10_000),
    })
    .strict(),
  z
    .object({
      ownerType: z.literal("milestone"),
      ownerKey: TemplateKeySchema,
      title: z.string().trim().min(1).max(200),
      description: z.string().trim().max(10_000),
    })
    .strict(),
]);

export const TeamTemplatePayloadSchema = z
  .object({
    version: z.literal(1),
    anchorSemantics: z.literal("relative_days"),
    phases: z.array(TemplatePhaseSchema).max(200),
    tasks: z.array(TemplateTaskSchema).max(2_000),
    dependencies: z.array(TemplateDependencySchema).max(5_000),
    milestones: z.array(TemplateMilestoneSchema).max(500),
    deliverableRequirements: z.array(TemplateDeliverableSchema).max(5_000),
  })
  .strict()
  .superRefine((payload, context) => {
    const addDuplicateIssues = (
      values: readonly { key: string }[],
      path: "phases" | "tasks" | "milestones",
    ): void => {
      const seen = new Set<string>();
      values.forEach((value, index) => {
        if (seen.has(value.key)) {
          context.addIssue({
            code: "custom",
            message: `Duplicate ${path} key: ${value.key}`,
            path: [path, index, "key"],
          });
        }
        seen.add(value.key);
      });
    };
    addDuplicateIssues(payload.phases, "phases");
    addDuplicateIssues(payload.tasks, "tasks");
    addDuplicateIssues(payload.milestones, "milestones");

    const phaseKeys = new Set(payload.phases.map(({ key }) => key));
    const taskKeys = new Set(payload.tasks.map(({ key }) => key));
    const milestoneKeys = new Set(payload.milestones.map(({ key }) => key));
    const parents = new Map(
      payload.tasks.map(({ key, parentKey }) => [key, parentKey] as const),
    );

    payload.tasks.forEach((task, index) => {
      if (task.phaseKey !== null && !phaseKeys.has(task.phaseKey)) {
        context.addIssue({
          code: "custom",
          message: `Unknown phaseKey: ${task.phaseKey}`,
          path: ["tasks", index, "phaseKey"],
        });
      }
      if (task.parentKey !== null && !taskKeys.has(task.parentKey)) {
        context.addIssue({
          code: "custom",
          message: `Unknown parentKey: ${task.parentKey}`,
          path: ["tasks", index, "parentKey"],
        });
      } else if (createsParentCycle(parents, task.key, task.parentKey)) {
        context.addIssue({
          code: "custom",
          message: "Task parent links must not contain a cycle.",
          path: ["tasks", index, "parentKey"],
        });
      }
    });

    payload.milestones.forEach((milestone, index) => {
      if (milestone.phaseKey !== null && !phaseKeys.has(milestone.phaseKey)) {
        context.addIssue({
          code: "custom",
          message: `Unknown phaseKey: ${milestone.phaseKey}`,
          path: ["milestones", index, "phaseKey"],
        });
      }
    });

    const acceptedDependencies: Array<{
      predecessorId: string;
      successorId: string;
    }> = [];
    const dependencyPairs = new Set<string>();
    payload.dependencies.forEach((dependency, index) => {
      const pair = `${dependency.predecessorTaskKey}\u0000${dependency.successorTaskKey}`;
      if (
        !taskKeys.has(dependency.predecessorTaskKey) ||
        !taskKeys.has(dependency.successorTaskKey)
      ) {
        context.addIssue({
          code: "custom",
          message: "Dependency references an unknown task key.",
          path: ["dependencies", index],
        });
      } else if (dependencyPairs.has(pair)) {
        context.addIssue({
          code: "custom",
          message: "Duplicate dependency pair.",
          path: ["dependencies", index],
        });
      } else if (
        createsDependencyCycle(
          acceptedDependencies,
          dependency.predecessorTaskKey,
          dependency.successorTaskKey,
        )
      ) {
        context.addIssue({
          code: "custom",
          message: "Task dependencies must not contain a cycle.",
          path: ["dependencies", index],
        });
      } else {
        dependencyPairs.add(pair);
        acceptedDependencies.push({
          predecessorId: dependency.predecessorTaskKey,
          successorId: dependency.successorTaskKey,
        });
      }
    });

    payload.deliverableRequirements.forEach((requirement, index) => {
      const ownerExists =
        requirement.ownerType === "task"
          ? taskKeys.has(requirement.ownerKey)
          : milestoneKeys.has(requirement.ownerKey);
      if (!ownerExists) {
        context.addIssue({
          code: "custom",
          message: `Unknown ${requirement.ownerType} ownerKey: ${requirement.ownerKey}`,
          path: ["deliverableRequirements", index, "ownerKey"],
        });
      }
    });
  });

export type TeamTemplatePayload = z.infer<typeof TeamTemplatePayloadSchema>;

interface TemplateScheduleSnapshot {
  phases: Array<{
    id: string;
    name: string;
    description: string;
    position: number;
    startDate: string | null;
    endDate: string | null;
  }>;
  tasks: Array<{
    id: string;
    phaseId: string | null;
    parentId: string | null;
    title: string;
    description: string;
    position: number;
    startDate: string | null;
    dueDate: string | null;
  }>;
  dependencies: Array<{
    predecessorTaskId: string;
    successorTaskId: string;
  }>;
  milestones: Array<{
    id: string;
    phaseId: string | null;
    title: string;
    description: string;
    dueDate: string;
  }>;
  deliverableRequirements: Array<{
    id: string;
    taskId: string | null;
    milestoneId: string | null;
    title: string;
    description: string;
  }>;
  [key: string]: unknown;
}

function isoDateMilliseconds(value: string): number {
  const parsed = z.iso.date().parse(value);
  return Date.parse(`${parsed}T00:00:00.000Z`);
}

function offsetDays(value: string | null, anchorDate: string): number | null {
  if (value === null) {
    return null;
  }
  return Math.round(
    (isoDateMilliseconds(value) - isoDateMilliseconds(anchorDate)) /
      (24 * 60 * 60 * 1_000),
  );
}

function dateAtOffset(anchorDate: string, offset: number | null): string | null {
  if (offset === null) {
    return null;
  }
  return new Date(
    isoDateMilliseconds(anchorDate) + offset * 24 * 60 * 60 * 1_000,
  )
    .toISOString()
    .slice(0, 10);
}

export function buildTemplatePayload(
  snapshot: TemplateScheduleSnapshot,
  anchorDate: string,
): TeamTemplatePayload {
  z.iso.date().parse(anchorDate);
  return TeamTemplatePayloadSchema.parse({
    version: 1,
    anchorSemantics: "relative_days",
    phases: snapshot.phases.map((phase) => ({
      key: phase.id,
      name: phase.name,
      description: phase.description,
      position: phase.position,
      startOffsetDays: offsetDays(phase.startDate, anchorDate),
      endOffsetDays: offsetDays(phase.endDate, anchorDate),
    })),
    tasks: snapshot.tasks.map((task) => ({
      key: task.id,
      phaseKey: task.phaseId,
      parentKey: task.parentId,
      title: task.title,
      description: task.description,
      position: task.position,
      startOffsetDays: offsetDays(task.startDate, anchorDate),
      dueOffsetDays: offsetDays(task.dueDate, anchorDate),
    })),
    dependencies: snapshot.dependencies.map((dependency) => ({
      predecessorTaskKey: dependency.predecessorTaskId,
      successorTaskKey: dependency.successorTaskId,
    })),
    milestones: snapshot.milestones.map((milestone) => ({
      key: milestone.id,
      phaseKey: milestone.phaseId,
      title: milestone.title,
      description: milestone.description,
      dueOffsetDays: offsetDays(milestone.dueDate, anchorDate),
    })),
    deliverableRequirements: snapshot.deliverableRequirements.map(
      (requirement) =>
        requirement.taskId !== null
          ? {
              ownerType: "task" as const,
              ownerKey: requirement.taskId,
              title: requirement.title,
              description: requirement.description,
            }
          : {
              ownerType: "milestone" as const,
              ownerKey: requirement.milestoneId,
              title: requirement.title,
              description: requirement.description,
            },
    ),
  });
}

export function instantiateTemplate(
  payloadInput: TeamTemplatePayload,
  anchorDate: string,
): {
  phases: Array<z.infer<typeof TemplatePhaseSchema> & {
    startDate: string | null;
    endDate: string | null;
  }>;
  tasks: Array<z.infer<typeof TemplateTaskSchema> & {
    startDate: string | null;
    dueDate: string | null;
  }>;
  dependencies: TeamTemplatePayload["dependencies"];
  milestones: Array<z.infer<typeof TemplateMilestoneSchema> & { dueDate: string }>;
  deliverableRequirements: TeamTemplatePayload["deliverableRequirements"];
} {
  const payload = TeamTemplatePayloadSchema.parse(payloadInput);
  z.iso.date().parse(anchorDate);
  return {
    phases: payload.phases.map((phase) => ({
      ...phase,
      startDate: dateAtOffset(anchorDate, phase.startOffsetDays),
      endDate: dateAtOffset(anchorDate, phase.endOffsetDays),
    })),
    tasks: payload.tasks.map((task) => ({
      ...task,
      startDate: dateAtOffset(anchorDate, task.startOffsetDays),
      dueDate: dateAtOffset(anchorDate, task.dueOffsetDays),
    })),
    dependencies: payload.dependencies,
    milestones: payload.milestones.map((milestone) => ({
      ...milestone,
      dueDate: dateAtOffset(anchorDate, milestone.dueOffsetDays)!,
    })),
    deliverableRequirements: payload.deliverableRequirements,
  };
}

export interface BuiltInTemplate {
  id: "builtin-competition" | "builtin-research";
  name: string;
  source: "built_in";
  payload: TeamTemplatePayload;
}

export const BUILT_IN_TEMPLATES: readonly BuiltInTemplate[] = [
  {
    id: "builtin-competition",
    name: "Competition project",
    source: "built_in",
    payload: TeamTemplatePayloadSchema.parse({
      version: 1,
      anchorSemantics: "relative_days",
      phases: [
        { key: "prepare", name: "Preparation", description: "", position: 0, startOffsetDays: 0, endOffsetDays: 13 },
        { key: "build", name: "Build and iterate", description: "", position: 1, startOffsetDays: 14, endOffsetDays: 41 },
        { key: "submit", name: "Submission", description: "", position: 2, startOffsetDays: 42, endOffsetDays: 49 },
      ],
      tasks: [
        { key: "rules", phaseKey: "prepare", parentKey: null, title: "Analyze competition rules", description: "", position: 0, startOffsetDays: 0, dueOffsetDays: 3 },
        { key: "proposal", phaseKey: "prepare", parentKey: null, title: "Define proposal and division of work", description: "", position: 1, startOffsetDays: 2, dueOffsetDays: 10 },
        { key: "prototype", phaseKey: "build", parentKey: null, title: "Build prototype", description: "", position: 0, startOffsetDays: 14, dueOffsetDays: 34 },
        { key: "materials", phaseKey: "submit", parentKey: null, title: "Finalize submission materials", description: "", position: 0, startOffsetDays: 38, dueOffsetDays: 48 },
      ],
      dependencies: [
        { predecessorTaskKey: "rules", successorTaskKey: "proposal" },
        { predecessorTaskKey: "proposal", successorTaskKey: "prototype" },
        { predecessorTaskKey: "prototype", successorTaskKey: "materials" },
      ],
      milestones: [
        { key: "competition-deadline", phaseKey: "submit", title: "Competition deadline", description: "", dueOffsetDays: 49 },
      ],
      deliverableRequirements: [
        { ownerType: "task", ownerKey: "materials", title: "Submission package", description: "" },
        { ownerType: "milestone", ownerKey: "competition-deadline", title: "Submission receipt", description: "" },
      ],
    }),
  },
  {
    id: "builtin-research",
    name: "Research project",
    source: "built_in",
    payload: TeamTemplatePayloadSchema.parse({
      version: 1,
      anchorSemantics: "relative_days",
      phases: [
        { key: "question", name: "Question and literature", description: "", position: 0, startOffsetDays: 0, endOffsetDays: 20 },
        { key: "study", name: "Experiment or study", description: "", position: 1, startOffsetDays: 21, endOffsetDays: 69 },
        { key: "paper", name: "Analysis and paper", description: "", position: 2, startOffsetDays: 70, endOffsetDays: 104 },
      ],
      tasks: [
        { key: "literature", phaseKey: "question", parentKey: null, title: "Literature review", description: "", position: 0, startOffsetDays: 0, dueOffsetDays: 14 },
        { key: "protocol", phaseKey: "question", parentKey: null, title: "Research protocol", description: "", position: 1, startOffsetDays: 10, dueOffsetDays: 20 },
        { key: "collect", phaseKey: "study", parentKey: null, title: "Collect data", description: "", position: 0, startOffsetDays: 21, dueOffsetDays: 62 },
        { key: "analyze", phaseKey: "paper", parentKey: null, title: "Analyze results", description: "", position: 0, startOffsetDays: 63, dueOffsetDays: 82 },
        { key: "manuscript", phaseKey: "paper", parentKey: null, title: "Write manuscript", description: "", position: 1, startOffsetDays: 78, dueOffsetDays: 103 },
      ],
      dependencies: [
        { predecessorTaskKey: "literature", successorTaskKey: "protocol" },
        { predecessorTaskKey: "protocol", successorTaskKey: "collect" },
        { predecessorTaskKey: "collect", successorTaskKey: "analyze" },
        { predecessorTaskKey: "analyze", successorTaskKey: "manuscript" },
      ],
      milestones: [
        { key: "paper-review", phaseKey: "paper", title: "Internal manuscript review", description: "", dueOffsetDays: 104 },
      ],
      deliverableRequirements: [
        { ownerType: "task", ownerKey: "protocol", title: "Approved protocol", description: "" },
        { ownerType: "task", ownerKey: "manuscript", title: "Manuscript draft", description: "" },
      ],
    }),
  },
];
