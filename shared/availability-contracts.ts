import { z } from "zod";

const IdSchema = z.uuid();
const IsoDateSchema = z.iso.date();
const RevisionSchema = z.number().int().positive();
const PrivateNoteSchema = z.string().max(2_000);
const WeeklyCapacitySchema = z.number().int().min(0).max(10_080);

const StartMinuteSchema = z
  .number()
  .int()
  .min(0)
  .max(1439)
  .refine((minute) => minute % 30 === 0, {
    message: "startMinute must be on a 30-minute boundary.",
  });

const EndMinuteSchema = z
  .number()
  .int()
  .min(1)
  .max(1440)
  .refine((minute) => minute % 30 === 0, {
    message: "endMinute must be on a 30-minute boundary.",
  });

export const WeeklyAvailabilitySlotSchema = z
  .object({
    dayOfWeek: z.number().int().min(0).max(6),
    startMinute: StartMinuteSchema,
    endMinute: EndMinuteSchema,
  })
  .strict()
  .refine(({ startMinute, endMinute }) => startMinute < endMinute, {
    message: "startMinute must be before endMinute.",
    path: ["endMinute"],
  });

export const AvailabilityExceptionSchema = z
  .object({
    exceptionDate: IsoDateSchema,
    kind: z.enum(["available", "unavailable"]),
    startMinute: StartMinuteSchema,
    endMinute: EndMinuteSchema,
    privateNote: PrivateNoteSchema,
  })
  .strict()
  .refine(({ startMinute, endMinute }) => startMinute < endMinute, {
    message: "startMinute must be before endMinute.",
    path: ["endMinute"],
  });

export const SanitizedAvailabilityExceptionSchema = z
  .object({
    exceptionDate: IsoDateSchema,
    kind: z.enum(["available", "unavailable"]),
    startMinute: StartMinuteSchema,
    endMinute: EndMinuteSchema,
  })
  .strict()
  .refine(({ startMinute, endMinute }) => startMinute < endMinute, {
    message: "startMinute must be before endMinute.",
    path: ["endMinute"],
  });

type ProfileForValidation = {
  validFrom: string;
  validThrough: string;
  weeklySlots: ReadonlyArray<{
    dayOfWeek: number;
    startMinute: number;
    endMinute: number;
  }>;
  exceptions: ReadonlyArray<{
    exceptionDate: string;
    kind: "available" | "unavailable";
    startMinute: number;
    endMinute: number;
  }>;
};

function validateProfile(
  profile: ProfileForValidation,
  context: z.RefinementCtx,
): void {
  if (profile.validFrom > profile.validThrough) {
    context.addIssue({
      code: "custom",
      message: "validFrom must not be after validThrough.",
      path: ["validThrough"],
    });
  }

  for (let left = 0; left < profile.weeklySlots.length; left += 1) {
    const leftSlot = profile.weeklySlots[left]!;
    for (let right = left + 1; right < profile.weeklySlots.length; right += 1) {
      const rightSlot = profile.weeklySlots[right]!;
      if (
        leftSlot.dayOfWeek === rightSlot.dayOfWeek &&
        leftSlot.startMinute < rightSlot.endMinute &&
        rightSlot.startMinute < leftSlot.endMinute
      ) {
        context.addIssue({
          code: "custom",
          message: "Weekly slots on the same day must not overlap.",
          path: ["weeklySlots", right],
        });
      }
    }
  }

  const exceptionKeys = new Set<string>();
  profile.exceptions.forEach((exception, index) => {
    if (
      exception.exceptionDate < profile.validFrom ||
      exception.exceptionDate > profile.validThrough
    ) {
      context.addIssue({
        code: "custom",
        message: "Exception date must be inside the profile period.",
        path: ["exceptions", index, "exceptionDate"],
      });
    }
    const key = [
      exception.exceptionDate,
      exception.kind,
      exception.startMinute,
      exception.endMinute,
    ].join("\u0000");
    if (exceptionKeys.has(key)) {
      context.addIssue({
        code: "custom",
        message: "Duplicate availability exception interval.",
        path: ["exceptions", index],
      });
    }
    exceptionKeys.add(key);
  });
}

function validateProfilePeriods(
  profiles: ReadonlyArray<{ validFrom: string; validThrough: string }>,
  context: z.RefinementCtx,
): void {
  for (let left = 0; left < profiles.length; left += 1) {
    const leftProfile = profiles[left]!;
    for (let right = left + 1; right < profiles.length; right += 1) {
      const rightProfile = profiles[right]!;
      if (
        leftProfile.validFrom <= rightProfile.validThrough &&
        rightProfile.validFrom <= leftProfile.validThrough
      ) {
        context.addIssue({
          code: "custom",
          message: "Availability profile periods must not overlap.",
          path: ["profiles", right, "validFrom"],
        });
      }
    }
  }
}

const PrivateProfileFields = {
  validFrom: IsoDateSchema,
  validThrough: IsoDateSchema,
  weeklyCapacityMinutes: WeeklyCapacitySchema,
  privateNote: PrivateNoteSchema,
  weeklySlots: z.array(WeeklyAvailabilitySlotSchema).max(336),
  exceptions: z.array(AvailabilityExceptionSchema).max(1_000),
};

export const PutAvailabilityProfileSchema = z
  .object({ id: IdSchema.optional(), ...PrivateProfileFields })
  .strict()
  .superRefine(validateProfile);

export const AvailabilityProfileEntitySchema = z
  .object({ id: IdSchema, revision: RevisionSchema, ...PrivateProfileFields })
  .strict()
  .superRefine(validateProfile);

export const SanitizedAvailabilityProfileSchema = z
  .object({
    validFrom: IsoDateSchema,
    validThrough: IsoDateSchema,
    weeklyCapacityMinutes: WeeklyCapacitySchema,
    weeklySlots: z.array(WeeklyAvailabilitySlotSchema).max(336),
    exceptions: z.array(SanitizedAvailabilityExceptionSchema).max(1_000),
  })
  .strict()
  .superRefine(validateProfile);

export const PutAvailabilityRequestSchema = z
  .object({
    expectedRevision: RevisionSchema,
    profiles: z.array(PutAvailabilityProfileSchema).max(20),
  })
  .strict()
  .superRefine(({ profiles }, context) => {
    const ids = new Set<string>();
    profiles.forEach((profile, index) => {
      if (profile.id === undefined) return;
      if (ids.has(profile.id)) {
        context.addIssue({
          code: "custom",
          message: "Profile ids must be unique within a document.",
          path: ["profiles", index, "id"],
        });
      }
      ids.add(profile.id);
    });
    validateProfilePeriods(profiles, context);
  });

export const AvailabilityDocumentSchema = z
  .object({
    revision: RevisionSchema,
    profiles: z.array(AvailabilityProfileEntitySchema).max(20),
  })
  .strict()
  .superRefine(({ profiles }, context) => {
    const ids = new Set<string>();
    profiles.forEach((profile, index) => {
      if (ids.has(profile.id)) {
        context.addIssue({
          code: "custom",
          message: "Profile ids must be unique within a document.",
          path: ["profiles", index, "id"],
        });
      }
      ids.add(profile.id);
    });
    validateProfilePeriods(profiles, context);
  });

export const ProjectAvailabilityMemberSummarySchema = z
  .object({
    userId: IdSchema,
    username: z.string().min(3).max(32).regex(/^[a-z0-9_.-]+$/),
    displayName: z.string().trim().min(1).max(80),
    color: z.string().regex(/^#[0-9a-f]{6}$/i),
    profiles: z.array(SanitizedAvailabilityProfileSchema).max(20),
  })
  .strict()
  .superRefine(({ profiles }, context) => validateProfilePeriods(profiles, context));

export const ProjectAvailabilitySummarySchema = z
  .object({
    projectId: IdSchema,
    members: z.array(ProjectAvailabilityMemberSummarySchema),
  })
  .strict();

const ParticipantConflictFields = {
  severity: z.literal("red"),
  participantId: IdSchema,
  taskId: IdSchema,
  userId: IdSchema,
};

export const ScheduleConflictSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("unallocated_effort"),
      ...ParticipantConflictFields,
      unallocatedMinutes: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      type: z.literal("overdue"),
      ...ParticipantConflictFields,
      deadline: IsoDateSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("missing_availability"),
      ...ParticipantConflictFields,
    })
    .strict(),
  z
    .object({
      type: z.literal("dependency_inversion"),
      severity: z.literal("red"),
      dependencyId: IdSchema,
      predecessorTaskId: IdSchema,
      successorTaskId: IdSchema,
      predecessorFinish: IsoDateSchema,
      successorStart: IsoDateSchema,
    })
    .strict(),
]);

export type WeeklyAvailabilitySlot = z.infer<
  typeof WeeklyAvailabilitySlotSchema
>;
export type AvailabilityException = z.infer<
  typeof AvailabilityExceptionSchema
>;
export type SanitizedAvailabilityException = z.infer<
  typeof SanitizedAvailabilityExceptionSchema
>;
export type PutAvailabilityRequest = z.infer<
  typeof PutAvailabilityRequestSchema
>;
export type AvailabilityProfileEntity = z.infer<
  typeof AvailabilityProfileEntitySchema
>;
export type SanitizedAvailabilityProfile = z.infer<
  typeof SanitizedAvailabilityProfileSchema
>;
export type AvailabilityDocument = z.infer<typeof AvailabilityDocumentSchema>;
export type ProjectAvailabilityMemberSummary = z.infer<
  typeof ProjectAvailabilityMemberSummarySchema
>;
export type ProjectAvailabilitySummary = z.infer<
  typeof ProjectAvailabilitySummarySchema
>;
export type ScheduleConflict = z.infer<typeof ScheduleConflictSchema>;
