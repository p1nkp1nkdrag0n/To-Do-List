import { z } from "zod";

import { IdSchema, IsoDateSchema, IsoDateTimeSchema } from "./contracts.js";

export const CollaborationClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("drag.lock.acquire"), participantId: IdSchema }).strict(),
  z.object({ type: z.literal("drag.lock.heartbeat"), participantId: IdSchema }).strict(),
  z.object({
    type: z.literal("drag.preview"),
    participantId: IdSchema,
    startDate: IsoDateSchema,
    endDate: IsoDateSchema,
  }).strict().refine(({ startDate, endDate }) => startDate <= endDate, {
    message: "startDate must not be after endDate.",
    path: ["endDate"],
  }),
  z.object({ type: z.literal("drag.lock.release"), participantId: IdSchema }).strict(),
]);

export const PresenceUserSchema = z.object({
  userId: IdSchema,
  displayName: z.string().min(1).max(80),
  connectionCount: z.number().int().positive(),
}).strict();

const LockFields = {
  participantId: IdSchema,
  ownerId: IdSchema,
  ownerDisplayName: z.string().min(1).max(80),
};

export const CollaborationServerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("presence"),
    projectId: IdSchema,
    users: z.array(PresenceUserSchema),
  }).strict(),
  z.object({
    type: z.literal("drag.lock.granted"),
    ...LockFields,
    expiresAt: IsoDateTimeSchema,
  }).strict(),
  z.object({
    type: z.literal("drag.lock.denied"),
    ...LockFields,
    expiresAt: IsoDateTimeSchema,
  }).strict(),
  z.object({
    type: z.literal("drag.preview"),
    ...LockFields,
    startDate: IsoDateSchema,
    endDate: IsoDateSchema,
  }).strict(),
  z.object({
    type: z.literal("drag.lock.released"),
    participantId: IdSchema,
    reason: z.enum(["released", "disconnected", "expired"]),
  }).strict(),
  z.object({
    type: z.literal("entity.invalidated"),
    entityType: z.enum(["project", "task", "participant", "resource", "availability"]),
    entityId: IdSchema,
  }).strict(),
]);

export type CollaborationClientMessage = z.infer<typeof CollaborationClientMessageSchema>;
export type CollaborationServerMessage = z.infer<typeof CollaborationServerMessageSchema>;
export type PresenceUser = z.infer<typeof PresenceUserSchema>;
