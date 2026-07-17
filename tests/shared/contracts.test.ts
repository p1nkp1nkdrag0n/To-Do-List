import { describe, expect, it } from "vitest";

import {
  ApiErrorPayloadSchema,
  IdSchema,
  IsoDateSchema,
  IsoDateTimeSchema,
  ParticipantStatusSchema,
  ResourceKindSchema,
  RevisionedEntitySchema,
  TaskStatusSchema,
} from "../../shared/contracts.js";

describe("shared contracts", () => {
  it("accepts UUID IDs and real ISO dates", () => {
    expect(IdSchema.parse("123e4567-e89b-42d3-a456-426614174000")).toBe(
      "123e4567-e89b-42d3-a456-426614174000",
    );
    expect(IsoDateSchema.parse("2026-07-17")).toBe("2026-07-17");
    expect(IsoDateSchema.safeParse("2026-02-30").success).toBe(false);
    expect(IsoDateTimeSchema.parse("2026-07-17T08:30:00.000Z")).toBe(
      "2026-07-17T08:30:00.000Z",
    );
    expect(IsoDateTimeSchema.safeParse("2026-07-17T08:30:00").success).toBe(false);
  });

  it("exposes the v2 status and resource-kind values", () => {
    expect(TaskStatusSchema.options).toEqual([
      "not_started",
      "in_progress",
      "blocked",
      "pending_review",
      "done",
    ]);
    expect(ParticipantStatusSchema.options).toEqual([
      "not_started",
      "in_progress",
      "blocked",
      "done",
    ]);
    expect(ResourceKindSchema.options).toEqual(["markdown", "file"]);
  });

  it("validates revisioned entities and standardized API errors", () => {
    const entity = {
      id: "123e4567-e89b-42d3-a456-426614174000",
      revision: 1,
      createdAt: "2026-07-17T08:30:00.000Z",
      updatedAt: "2026-07-17T08:30:00.000Z",
    };
    expect(RevisionedEntitySchema.parse(entity)).toEqual(entity);
    expect(
      RevisionedEntitySchema.safeParse({ ...entity, revision: 0 }).success,
    ).toBe(false);

    const payload = {
      error: {
        code: "REVISION_CONFLICT",
        message: "The entity changed on another client.",
        fieldErrors: { title: ["Title is required."] },
        latest: entity,
      },
    };
    expect(ApiErrorPayloadSchema.parse(payload)).toEqual(payload);
  });
});
