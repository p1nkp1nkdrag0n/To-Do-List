import { describe, expect, it } from "vitest";

import {
  AddProjectMemberRequestSchema,
  AddTeamMemberRequestSchema,
  ApiErrorPayloadSchema,
  CreateRegistrationInviteRequestSchema,
  CreateProjectRequestSchema,
  ExpectedRevisionRequestSchema,
  IdSchema,
  IsoDateSchema,
  IsoDateTimeSchema,
  LoginRequestSchema,
  PatchProjectRequestSchema,
  ParticipantStatusSchema,
  ProjectInviteRedeemRequestSchema,
  RegisterRequestSchema,
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

  it("normalizes and validates authentication payloads", () => {
    expect(
      RegisterRequestSchema.parse({
        username: "  Graduate.Student  ",
        displayName: "  Zhang San  ",
        password: "password123",
        bootstrapCode: "bootstrap-secret",
      }),
    ).toEqual({
      username: "graduate.student",
      displayName: "Zhang San",
      password: "password123",
      bootstrapCode: "bootstrap-secret",
    });
    expect(
      RegisterRequestSchema.safeParse({
        username: "bad name",
        displayName: "Member",
        password: "short",
      }).success,
    ).toBe(false);
    expect(
      LoginRequestSchema.parse({ username: "  MEMBER  ", password: "password123" }),
    ).toEqual({ username: "member", password: "password123" });
  });

  it("limits registration and login passwords to 72 UTF-8 bytes", () => {
    const register = (password: string) => ({
      username: "member",
      displayName: "Member",
      password,
      bootstrapCode: "bootstrap-secret",
    });
    const login = (password: string) => ({ username: "member", password });
    const seventyTwoAsciiBytes = "a".repeat(72);
    const seventyTwoMultibyteBytes = "密".repeat(24);

    expect(RegisterRequestSchema.safeParse(register(seventyTwoAsciiBytes)).success).toBe(
      true,
    );
    expect(LoginRequestSchema.safeParse(login(seventyTwoAsciiBytes)).success).toBe(
      true,
    );
    expect(
      RegisterRequestSchema.safeParse(register(seventyTwoMultibyteBytes)).success,
    ).toBe(true);
    expect(
      LoginRequestSchema.safeParse(login(seventyTwoMultibyteBytes)).success,
    ).toBe(true);

    expect(RegisterRequestSchema.safeParse(register("a".repeat(73))).success).toBe(
      false,
    );
    expect(LoginRequestSchema.safeParse(login("a".repeat(73))).success).toBe(false);
    expect(
      RegisterRequestSchema.safeParse(register("密".repeat(25))).success,
    ).toBe(false);
    expect(LoginRequestSchema.safeParse(login("密".repeat(25))).success).toBe(
      false,
    );
  });

  it("validates team and project mutation payloads", () => {
    const firstId = "123e4567-e89b-42d3-a456-426614174000";
    const secondId = "123e4567-e89b-42d3-a456-426614174001";

    expect(AddTeamMemberRequestSchema.safeParse({}).success).toBe(false);
    expect(
      AddTeamMemberRequestSchema.safeParse({ userId: firstId, username: "member" })
        .success,
    ).toBe(false);
    expect(AddTeamMemberRequestSchema.parse({ username: " MEMBER " })).toEqual({
      username: "member",
    });
    expect(AddProjectMemberRequestSchema.parse({ userId: firstId })).toEqual({
      userId: firstId,
    });

    expect(
      CreateProjectRequestSchema.parse({
        name: "  Robot Competition  ",
        description: "  Regional final  ",
        startDate: "2026-07-20",
        endDate: "2026-08-20",
        memberUserIds: [firstId, secondId, firstId],
      }),
    ).toEqual({
      name: "Robot Competition",
      description: "Regional final",
      startDate: "2026-07-20",
      endDate: "2026-08-20",
      memberUserIds: [firstId, secondId],
    });
    expect(
      PatchProjectRequestSchema.safeParse({ expectedRevision: 1 }).success,
    ).toBe(false);
    expect(
      PatchProjectRequestSchema.parse({
        expectedRevision: 2,
        description: "Updated",
        startDate: null,
      }),
    ).toEqual({ expectedRevision: 2, description: "Updated", startDate: null });
  });

  it("requires exactly six numeric digits for project invite redemption", () => {
    expect(ProjectInviteRedeemRequestSchema.parse({ code: "012345" })).toEqual({
      code: "012345",
    });
    expect(ProjectInviteRedeemRequestSchema.safeParse({ code: "12345" }).success).toBe(
      false,
    );
    expect(ProjectInviteRedeemRequestSchema.safeParse({ code: "12345a" }).success).toBe(
      false,
    );
  });

  it("requires a strict positive expected revision for invite revocation", () => {
    expect(ExpectedRevisionRequestSchema.parse({ expectedRevision: 2 })).toEqual({
      expectedRevision: 2,
    });
    expect(
      ExpectedRevisionRequestSchema.safeParse({ expectedRevision: 0 }).success,
    ).toBe(false);
    expect(
      ExpectedRevisionRequestSchema.safeParse({
        expectedRevision: 1,
        code: "must-not-be-accepted",
      }).success,
    ).toBe(false);
  });

  it("accepts only an empty registration invite creation payload", () => {
    expect(CreateRegistrationInviteRequestSchema.parse({})).toEqual({});
    expect(
      CreateRegistrationInviteRequestSchema.safeParse({ expiresInHours: 48 })
        .success,
    ).toBe(false);
  });
});
