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

export type Id = z.infer<typeof IdSchema>;
export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type ParticipantStatus = z.infer<typeof ParticipantStatusSchema>;
export type ResourceKind = z.infer<typeof ResourceKindSchema>;
export type RevisionedEntity = z.infer<typeof RevisionedEntitySchema>;
export type ApiError = z.infer<typeof ApiErrorSchema>;
export type ApiErrorPayload = z.infer<typeof ApiErrorPayloadSchema>;
