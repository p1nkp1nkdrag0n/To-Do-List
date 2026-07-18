import { z } from "zod";

const IdSchema = z.uuid();
const IsoDateSchema = z.iso.date();
const RevisionSchema = z.number().int().positive();
const NameSchema = z.string().trim().min(1).max(120);
const TitleSchema = z.string().trim().min(1).max(200);
const DescriptionSchema = z.string().trim().max(20_000);
const PositionSchema = z.number().int().min(0).max(1_000_000);

function hasDefinedField(
  value: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  return fields.some((field) => value[field] !== undefined);
}

function orderedDates(
  startDate: string | null | undefined,
  endDate: string | null | undefined,
): boolean {
  return (
    startDate === undefined ||
    startDate === null ||
    endDate === undefined ||
    endDate === null ||
    startDate <= endDate
  );
}

export const CreatePhaseRequestSchema = z
  .object({
    name: NameSchema,
    description: DescriptionSchema.optional(),
    position: PositionSchema.optional(),
    startDate: IsoDateSchema.nullable().optional(),
    endDate: IsoDateSchema.nullable().optional(),
  })
  .strict()
  .refine(({ startDate, endDate }) => orderedDates(startDate, endDate), {
    message: "startDate must not be after endDate.",
    path: ["endDate"],
  });

export const PatchPhaseRequestSchema = z
  .object({
    expectedRevision: RevisionSchema,
    name: NameSchema.optional(),
    description: DescriptionSchema.optional(),
    position: PositionSchema.optional(),
    startDate: IsoDateSchema.nullable().optional(),
    endDate: IsoDateSchema.nullable().optional(),
  })
  .strict()
  .refine(
    (value) =>
      hasDefinedField(value, [
        "name",
        "description",
        "position",
        "startDate",
        "endDate",
      ]),
    { message: "At least one phase field must be provided." },
  );

export const CreateTaskRequestSchema = z
  .object({
    phaseId: IdSchema.nullable().optional(),
    parentId: IdSchema.nullable().optional(),
    title: TitleSchema,
    description: DescriptionSchema.optional(),
    position: PositionSchema.optional(),
    startDate: IsoDateSchema.nullable().optional(),
    dueDate: IsoDateSchema.nullable().optional(),
  })
  .strict()
  .refine(({ startDate, dueDate }) => orderedDates(startDate, dueDate), {
    message: "startDate must not be after dueDate.",
    path: ["dueDate"],
  });

export const PatchTaskRequestSchema = z
  .object({
    expectedRevision: RevisionSchema,
    phaseId: IdSchema.nullable().optional(),
    parentId: IdSchema.nullable().optional(),
    title: TitleSchema.optional(),
    description: DescriptionSchema.optional(),
    position: PositionSchema.optional(),
    startDate: IsoDateSchema.nullable().optional(),
    dueDate: IsoDateSchema.nullable().optional(),
  })
  .strict()
  .refine(
    (value) =>
      hasDefinedField(value, [
        "phaseId",
        "parentId",
        "title",
        "description",
        "position",
        "startDate",
        "dueDate",
      ]),
    { message: "At least one task field must be provided." },
  );

export const CreateParticipantRequestSchema = z
  .object({
    expectedRevision: RevisionSchema.optional(),
    userId: IdSchema,
    startDate: IsoDateSchema,
    endDate: IsoDateSchema,
    estimatedMinutes: z.number().int().positive().max(10_000_000),
  })
  .strict()
  .refine(({ startDate, endDate }) => startDate <= endDate, {
    message: "startDate must not be after endDate.",
    path: ["endDate"],
  });

export const PatchParticipantRequestSchema = z
  .object({
    expectedRevision: RevisionSchema,
    userId: IdSchema.optional(),
    startDate: IsoDateSchema.optional(),
    endDate: IsoDateSchema.optional(),
    estimatedMinutes: z.number().int().positive().max(10_000_000).optional(),
  })
  .strict()
  .refine(
    (value) =>
      hasDefinedField(value, [
        "userId",
        "startDate",
        "endDate",
        "estimatedMinutes",
      ]),
    { message: "At least one participant field must be provided." },
  );

export const ProgressUpdateRequestSchema = z
  .object({
    participantExpectedRevision: RevisionSchema,
    completionPercent: z.number().int().min(0).max(100),
    summary: z.string().trim().min(1).max(10_000),
    blockers: z.string().trim().max(10_000),
    nextSteps: z.string().trim().max(10_000),
  })
  .strict();

export const CreateDependencyRequestSchema = z
  .object({
    predecessorTaskId: IdSchema,
    expectedRevision: RevisionSchema.optional(),
  })
  .strict();

export const CreateMilestoneRequestSchema = z
  .object({
    phaseId: IdSchema.nullable().optional(),
    title: TitleSchema,
    description: DescriptionSchema.optional(),
    dueDate: IsoDateSchema,
    status: z.enum(["not_started", "in_progress", "blocked"]).optional(),
  })
  .strict();

export const PatchMilestoneRequestSchema = z
  .object({
    expectedRevision: RevisionSchema,
    phaseId: IdSchema.nullable().optional(),
    title: TitleSchema.optional(),
    description: DescriptionSchema.optional(),
    dueDate: IsoDateSchema.optional(),
    status: z.enum(["not_started", "in_progress", "blocked"]).optional(),
  })
  .strict()
  .refine(
    (value) =>
      hasDefinedField(value, ["phaseId", "title", "description", "dueDate", "status"]),
    { message: "At least one milestone field must be provided." },
  );

export const CreateDeliverableRequestSchema = z
  .object({
    title: TitleSchema,
    description: z.string().trim().max(10_000).optional(),
  })
  .strict();

export const PatchDeliverableRequestSchema = z
  .object({
    expectedRevision: RevisionSchema,
    title: TitleSchema.optional(),
    description: z.string().trim().max(10_000).optional(),
  })
  .strict()
  .refine(
    (value) => hasDefinedField(value, ["title", "description"]),
    { message: "At least one deliverable field must be provided." },
  );

export const CreateRecurringRuleRequestSchema = z.discriminatedUnion("frequency", [
  z
    .object({
      sourceTaskId: IdSchema,
      frequency: z.literal("weekly"),
      intervalCount: z.number().int().min(1).max(52).default(1),
      dayOfWeek: z.number().int().min(0).max(6),
      startsOn: IsoDateSchema,
      endsOn: IsoDateSchema.nullable().optional(),
    })
    .strict()
    .refine(
      ({ startsOn, endsOn }) =>
        endsOn === undefined || endsOn === null || startsOn <= endsOn,
      { message: "startsOn must not be after endsOn.", path: ["endsOn"] },
    ),
  z
    .object({
      sourceTaskId: IdSchema,
      frequency: z.literal("monthly"),
      intervalCount: z.number().int().min(1).max(52).default(1),
      dayOfMonth: z.number().int().min(1).max(31),
      startsOn: IsoDateSchema,
      endsOn: IsoDateSchema.nullable().optional(),
    })
    .strict()
    .refine(
      ({ startsOn, endsOn }) =>
        endsOn === undefined || endsOn === null || startsOn <= endsOn,
      { message: "startsOn must not be after endsOn.", path: ["endsOn"] },
    ),
]);

export const PatchRecurringRuleRequestSchema = z
  .object({
    expectedRevision: RevisionSchema,
    frequency: z.enum(["weekly", "monthly"]).optional(),
    intervalCount: z.number().int().min(1).max(52).optional(),
    dayOfWeek: z.number().int().min(0).max(6).nullable().optional(),
    dayOfMonth: z.number().int().min(1).max(31).nullable().optional(),
    startsOn: IsoDateSchema.optional(),
    endsOn: IsoDateSchema.nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) =>
      hasDefinedField(value, [
        "frequency",
        "intervalCount",
        "dayOfWeek",
        "dayOfMonth",
        "startsOn",
        "endsOn",
        "isActive",
      ]),
    { message: "At least one recurring rule field must be provided." },
  );

export const GenerateRecurringRuleRequestSchema = z
  .object({ expectedRevision: RevisionSchema, throughDate: IsoDateSchema })
  .strict();

export const FulfillDeliverableRequestSchema = z
  .object({ expectedRevision: RevisionSchema, resourceId: IdSchema })
  .strict();

export const SaveTeamTemplateRequestSchema = z
  .object({ name: NameSchema, anchorDate: IsoDateSchema })
  .strict();

export const UpdateTeamTemplateRequestSchema = z
  .object({ expectedRevision: RevisionSchema, name: NameSchema.optional() })
  .strict()
  .refine((value) => hasDefinedField(value, ["name"]), {
    message: "At least one template field must be provided.",
  });

export const ApplyTemplateRequestSchema = z
  .object({ anchorDate: IsoDateSchema })
  .strict();

export const ExpectedRevisionRequestSchema = z
  .object({ expectedRevision: RevisionSchema })
  .strict();

export type CreatePhaseRequest = z.infer<typeof CreatePhaseRequestSchema>;
export type PatchPhaseRequest = z.infer<typeof PatchPhaseRequestSchema>;
export type CreateTaskRequest = z.infer<typeof CreateTaskRequestSchema>;
export type PatchTaskRequest = z.infer<typeof PatchTaskRequestSchema>;
export type CreateParticipantRequest = z.infer<typeof CreateParticipantRequestSchema>;
export type PatchParticipantRequest = z.infer<typeof PatchParticipantRequestSchema>;
export type ProgressUpdateRequest = z.infer<typeof ProgressUpdateRequestSchema>;
export type CreateDependencyRequest = z.infer<typeof CreateDependencyRequestSchema>;
export type CreateMilestoneRequest = z.infer<typeof CreateMilestoneRequestSchema>;
export type PatchMilestoneRequest = z.infer<typeof PatchMilestoneRequestSchema>;
export type CreateDeliverableRequest = z.infer<typeof CreateDeliverableRequestSchema>;
export type PatchDeliverableRequest = z.infer<typeof PatchDeliverableRequestSchema>;
export type CreateRecurringRuleRequest = z.infer<typeof CreateRecurringRuleRequestSchema>;
export type PatchRecurringRuleRequest = z.infer<typeof PatchRecurringRuleRequestSchema>;
export type GenerateRecurringRuleRequest = z.infer<typeof GenerateRecurringRuleRequestSchema>;
export type FulfillDeliverableRequest = z.infer<typeof FulfillDeliverableRequestSchema>;
export type SaveTeamTemplateRequest = z.infer<typeof SaveTeamTemplateRequestSchema>;
export type UpdateTeamTemplateRequest = z.infer<typeof UpdateTeamTemplateRequestSchema>;
export type ApplyTemplateRequest = z.infer<typeof ApplyTemplateRequestSchema>;
export type ExpectedRevisionRequest = z.infer<typeof ExpectedRevisionRequestSchema>;
