import { z } from "zod";

export const IdSchema = z.uuid();
export const IsoDateSchema = z.iso.date();
export const IsoDateTimeSchema = z.iso.datetime({ offset: true });
export const RevisionSchema = z.number().int().positive();

export const TaskStatusSchema = z.enum([
  "not_started",
  "in_progress",
  "blocked",
  "pending_review",
  "done",
]);

export const ParticipantStatusSchema = z.enum([
  "not_started",
  "in_progress",
  "blocked",
  "done",
]);

export const ResourceKindSchema = z.enum(["markdown", "file"]);

export const RevisionedEntitySchema = z
  .object({
    id: IdSchema,
    revision: RevisionSchema,
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();

export const ApiErrorSchema = z
  .object({
    code: z.string().trim().min(1),
    message: z.string().min(1),
    fieldErrors: z.record(z.string(), z.array(z.string().min(1))).optional(),
    latest: z.unknown().optional(),
  })
  .strict();

export const ApiErrorPayloadSchema = z
  .object({
    error: ApiErrorSchema,
  })
  .strict();

const UsernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.string().min(3).max(32).regex(/^[a-z0-9_.-]+$/));

const DisplayNameSchema = z.string().trim().min(1).max(80);
const PasswordByteLimitSchema = z.string().refine(
  (password) => new TextEncoder().encode(password).byteLength <= 72,
  { message: "Password must be at most 72 UTF-8 bytes." },
);
const PasswordSchema = PasswordByteLimitSchema.pipe(z.string().min(8));
const ProjectNameSchema = z.string().trim().min(1).max(120);
const ProjectDescriptionSchema = z.string().trim().max(10_000);

export const RegisterRequestSchema = z
  .object({
    username: UsernameSchema,
    displayName: DisplayNameSchema,
    password: PasswordSchema,
    bootstrapCode: z.string().min(1).optional(),
    registrationInviteCode: z.string().min(1).optional(),
  })
  .strict();

export const LoginRequestSchema = z
  .object({
    username: UsernameSchema,
    password: PasswordByteLimitSchema.pipe(z.string().min(1)),
  })
  .strict();

export const AddTeamMemberRequestSchema = z
  .object({
    userId: IdSchema.optional(),
    username: UsernameSchema.optional(),
  })
  .strict()
  .refine((value) => Number(value.userId !== undefined) + Number(value.username !== undefined) === 1, {
    message: "Provide exactly one of userId or username.",
  });

export const CreateProjectRequestSchema = z
  .object({
    name: ProjectNameSchema,
    description: ProjectDescriptionSchema.optional(),
    startDate: IsoDateSchema.optional(),
    endDate: IsoDateSchema.optional(),
    memberUserIds: z
      .array(IdSchema)
      .transform((values) => [...new Set(values)]),
  })
  .strict()
  .refine(
    ({ startDate, endDate }) =>
      startDate === undefined || endDate === undefined || startDate <= endDate,
    { message: "startDate must not be after endDate.", path: ["endDate"] },
  );

export const PatchProjectRequestSchema = z
  .object({
    expectedRevision: RevisionSchema,
    name: ProjectNameSchema.optional(),
    description: ProjectDescriptionSchema.optional(),
    startDate: IsoDateSchema.nullable().optional(),
    endDate: IsoDateSchema.nullable().optional(),
  })
  .strict()
  .refine(
    ({ name, description, startDate, endDate }) =>
      name !== undefined ||
      description !== undefined ||
      startDate !== undefined ||
      endDate !== undefined,
    { message: "At least one project field must be provided." },
  );

export const AddProjectMemberRequestSchema = z
  .object({ userId: IdSchema })
  .strict();

export const CreateRegistrationInviteRequestSchema = z.object({}).strict();

export const ExpectedRevisionRequestSchema = z
  .object({ expectedRevision: RevisionSchema })
  .strict();

export const ProjectInviteRedeemRequestSchema = z
  .object({ code: z.string().regex(/^\d{6}$/) })
  .strict();

export type Id = z.infer<typeof IdSchema>;
export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type ParticipantStatus = z.infer<typeof ParticipantStatusSchema>;
export type ResourceKind = z.infer<typeof ResourceKindSchema>;
export type RevisionedEntity = z.infer<typeof RevisionedEntitySchema>;
export type ApiError = z.infer<typeof ApiErrorSchema>;
export type ApiErrorPayload = z.infer<typeof ApiErrorPayloadSchema>;
export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;
export type LoginRequest = z.infer<typeof LoginRequestSchema>;
export type AddTeamMemberRequest = z.infer<typeof AddTeamMemberRequestSchema>;
export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;
export type PatchProjectRequest = z.infer<typeof PatchProjectRequestSchema>;
export type AddProjectMemberRequest = z.infer<typeof AddProjectMemberRequestSchema>;
export type CreateRegistrationInviteRequest = z.infer<
  typeof CreateRegistrationInviteRequestSchema
>;
export type ExpectedRevisionRequest = z.infer<
  typeof ExpectedRevisionRequestSchema
>;
export type ProjectInviteRedeemRequest = z.infer<typeof ProjectInviteRedeemRequestSchema>;
