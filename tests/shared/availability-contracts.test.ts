import { describe, expect, it } from "vitest";

import {
  AvailabilityDocumentSchema,
  ProjectAvailabilitySummarySchema,
  PutAvailabilityRequestSchema,
  ScheduleConflictSchema,
} from "../../shared/availability-contracts.js";

const PROFILE_ID = "00000000-0000-4000-8000-000000000001";
const SECOND_PROFILE_ID = "00000000-0000-4000-8000-000000000002";

function profile(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    validFrom: "2026-07-20",
    validThrough: "2026-12-31",
    weeklyCapacityMinutes: 600,
    privateNote: "Lab work only",
    weeklySlots: [{ dayOfWeek: 1, startMinute: 540, endMinute: 720 }],
    exceptions: [
      {
        exceptionDate: "2026-07-27",
        kind: "unavailable",
        startMinute: 540,
        endMinute: 570,
        privateNote: "Advisor meeting",
      },
    ],
    ...overrides,
  };
}

describe("availability contracts", () => {
  it("parses a whole-document replacement and preserves an optional profile id", () => {
    const parsed = PutAvailabilityRequestSchema.parse({
      expectedRevision: 2,
      profiles: [
        {
          id: PROFILE_ID,
          validFrom: "2026-07-20",
          validThrough: "2026-12-31",
          weeklyCapacityMinutes: 600,
          privateNote: "Lab work only",
          weeklySlots: [
            { dayOfWeek: 1, startMinute: 540, endMinute: 720 },
          ],
          exceptions: [
            {
              exceptionDate: "2026-07-27",
              kind: "unavailable",
              startMinute: 540,
              endMinute: 570,
              privateNote: "Advisor meeting",
            },
          ],
        },
      ],
    });

    expect(parsed.expectedRevision).toBe(2);
    expect(parsed.profiles[0]?.id).toBe(PROFILE_ID);
  });

  it("requires a positive integer document revision", () => {
    for (const expectedRevision of [0, -1, 1.5]) {
      expect(
        PutAvailabilityRequestSchema.safeParse({
          expectedRevision,
          profiles: [],
        }).success,
      ).toBe(false);
    }
  });

  it("rejects unknown fields at every request object level", () => {
    const candidates = [
      {
        expectedRevision: 1,
        profiles: [],
        unexpected: true,
      },
      {
        expectedRevision: 1,
        profiles: [profile({ unexpected: true })],
      },
      {
        expectedRevision: 1,
        profiles: [
          profile({
            weeklySlots: [
              {
                dayOfWeek: 1,
                startMinute: 540,
                endMinute: 570,
                unexpected: true,
              },
            ],
          }),
        ],
      },
      {
        expectedRevision: 1,
        profiles: [
          profile({
            exceptions: [
              {
                exceptionDate: "2026-07-27",
                kind: "available",
                startMinute: 540,
                endMinute: 570,
                privateNote: "",
                unexpected: true,
              },
            ],
          }),
        ],
      },
    ];

    for (const candidate of candidates) {
      expect(PutAvailabilityRequestSchema.safeParse(candidate).success).toBe(
        false,
      );
    }
  });

  it("limits a document to twenty profiles", () => {
    const profiles = Array.from({ length: 21 }, (_, index) => {
      const date = new Date(Date.UTC(2027, 0, 1 + index * 2))
        .toISOString()
        .slice(0, 10);
      return profile({ validFrom: date, validThrough: date, exceptions: [] });
    });

    expect(
      PutAvailabilityRequestSchema.safeParse({ expectedRevision: 1, profiles })
        .success,
    ).toBe(false);
  });

  it("rejects reversed or overlapping profile validity periods", () => {
    const reversed = {
      expectedRevision: 1,
      profiles: [
        profile({ validFrom: "2026-08-01", validThrough: "2026-07-31" }),
      ],
    };
    const overlapping = {
      expectedRevision: 1,
      profiles: [
        profile({ validThrough: "2026-08-31", exceptions: [] }),
        profile({
          validFrom: "2026-08-31",
          validThrough: "2026-12-31",
          exceptions: [],
        }),
      ],
    };
    const adjacent = {
      expectedRevision: 1,
      profiles: [
        profile({ validThrough: "2026-08-31", exceptions: [] }),
        profile({
          validFrom: "2026-09-01",
          validThrough: "2026-12-31",
          exceptions: [],
        }),
      ],
    };

    expect(PutAvailabilityRequestSchema.safeParse(reversed).success).toBe(false);
    expect(PutAvailabilityRequestSchema.safeParse(overlapping).success).toBe(
      false,
    );
    expect(PutAvailabilityRequestSchema.safeParse(adjacent).success).toBe(true);
  });

  it("rejects duplicate preserved profile ids", () => {
    expect(
      PutAvailabilityRequestSchema.safeParse({
        expectedRevision: 1,
        profiles: [
          profile({
            id: SECOND_PROFILE_ID,
            validThrough: "2026-08-31",
            exceptions: [],
          }),
          profile({
            id: SECOND_PROFILE_ID,
            validFrom: "2026-09-01",
            exceptions: [],
          }),
        ],
      }).success,
    ).toBe(false);
  });

  it("enforces half-hour slot boundaries and ordered time ranges", () => {
    expect(
      PutAvailabilityRequestSchema.safeParse({
        expectedRevision: 1,
        profiles: [
          profile({
            weeklySlots: [
              { dayOfWeek: 0, startMinute: 0, endMinute: 1440 },
            ],
          }),
        ],
      }).success,
    ).toBe(true);

    for (const weeklySlot of [
      { dayOfWeek: -1, startMinute: 540, endMinute: 570 },
      { dayOfWeek: 7, startMinute: 540, endMinute: 570 },
      { dayOfWeek: 1, startMinute: 15, endMinute: 570 },
      { dayOfWeek: 1, startMinute: 540, endMinute: 575 },
      { dayOfWeek: 1, startMinute: 570, endMinute: 570 },
      { dayOfWeek: 1, startMinute: 570, endMinute: 540 },
    ]) {
      expect(
        PutAvailabilityRequestSchema.safeParse({
          expectedRevision: 1,
          profiles: [profile({ weeklySlots: [weeklySlot] })],
        }).success,
      ).toBe(false);
    }
  });

  it("rejects overlapping weekly slots on the same day but permits touching slots", () => {
    expect(
      PutAvailabilityRequestSchema.safeParse({
        expectedRevision: 1,
        profiles: [
          profile({
            weeklySlots: [
              { dayOfWeek: 1, startMinute: 540, endMinute: 600 },
              { dayOfWeek: 1, startMinute: 570, endMinute: 630 },
            ],
          }),
        ],
      }).success,
    ).toBe(false);

    expect(
      PutAvailabilityRequestSchema.safeParse({
        expectedRevision: 1,
        profiles: [
          profile({
            weeklySlots: [
              { dayOfWeek: 1, startMinute: 540, endMinute: 600 },
              { dayOfWeek: 1, startMinute: 600, endMinute: 630 },
            ],
          }),
        ],
      }).success,
    ).toBe(true);
  });

  it("requires exception windows on half-hour boundaries inside the profile period", () => {
    for (const exception of [
      {
        exceptionDate: "2026-07-19",
        kind: "available",
        startMinute: 540,
        endMinute: 570,
        privateNote: "",
      },
      {
        exceptionDate: "2027-01-01",
        kind: "unavailable",
        startMinute: 540,
        endMinute: 570,
        privateNote: "",
      },
      {
        exceptionDate: "2026-07-27",
        kind: "available",
        startMinute: 545,
        endMinute: 570,
        privateNote: "",
      },
      {
        exceptionDate: "2026-07-27",
        kind: "unavailable",
        startMinute: 600,
        endMinute: 600,
        privateNote: "",
      },
    ]) {
      expect(
        PutAvailabilityRequestSchema.safeParse({
          expectedRevision: 1,
          profiles: [profile({ exceptions: [exception] })],
        }).success,
      ).toBe(false);
    }
  });

  it("bounds private notes and availability collections", () => {
    const weeklySlots = Array.from({ length: 7 }, (_, dayOfWeek) =>
      Array.from({ length: 48 }, (_unused, halfHour) => ({
        dayOfWeek,
        startMinute: halfHour * 30,
        endMinute: (halfHour + 1) * 30,
      })),
    ).flat();
    const exceptions = Array.from({ length: 1000 }, (_, index) => {
      const block = index % 48;
      const dayOffset = Math.floor(index / 96);
      return {
        exceptionDate: new Date(Date.UTC(2026, 6, 20 + dayOffset))
          .toISOString()
          .slice(0, 10),
        kind: Math.floor(index / 48) % 2 === 0
          ? ("available" as const)
          : ("unavailable" as const),
        startMinute: block * 30,
        endMinute: (block + 1) * 30,
        privateNote: "",
      };
    });

    expect(
      PutAvailabilityRequestSchema.safeParse({
        expectedRevision: 1,
        profiles: [profile({ weeklySlots, exceptions })],
      }).success,
    ).toBe(true);
    expect(
      PutAvailabilityRequestSchema.safeParse({
        expectedRevision: 1,
        profiles: [profile({ privateNote: "x".repeat(2001) })],
      }).success,
    ).toBe(false);
    expect(
      PutAvailabilityRequestSchema.safeParse({
        expectedRevision: 1,
        profiles: [profile({ weeklyCapacityMinutes: 10081 })],
      }).success,
    ).toBe(false);
    expect(
      PutAvailabilityRequestSchema.safeParse({
        expectedRevision: 1,
        profiles: [
          profile({
            weeklySlots: [...weeklySlots, weeklySlots[0]],
            exceptions: [],
          }),
        ],
      }).success,
    ).toBe(false);
    expect(
      PutAvailabilityRequestSchema.safeParse({
        expectedRevision: 1,
        profiles: [profile({ weeklySlots: [], exceptions: [...exceptions, exceptions[0]] })],
      }).success,
    ).toBe(false);
    expect(
      PutAvailabilityRequestSchema.safeParse({
        expectedRevision: 1,
        profiles: [
          profile({
            exceptions: [
              {
                exceptionDate: "2026-07-27",
                kind: "available",
                startMinute: 540,
                endMinute: 570,
                privateNote: "x".repeat(2001),
              },
            ],
          }),
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate exception intervals before they reach SQLite", () => {
    const duplicate = {
      exceptionDate: "2026-07-27",
      kind: "unavailable" as const,
      startMinute: 540,
      endMinute: 570,
      privateNote: "Private reason",
    };
    expect(
      PutAvailabilityRequestSchema.safeParse({
        expectedRevision: 1,
        profiles: [profile({ exceptions: [duplicate, duplicate] })],
      }).success,
    ).toBe(false);
  });

  it("exports schemas for documents, project summaries, and schedule conflicts", async () => {
    const contracts = await import("../../shared/availability-contracts.js");

    expect(contracts).toHaveProperty("AvailabilityDocumentSchema");
    expect(contracts).toHaveProperty("ProjectAvailabilitySummarySchema");
    expect(contracts).toHaveProperty("ScheduleConflictSchema");
  });

  it("parses the full private availability document returned to its owner", () => {
    const document = AvailabilityDocumentSchema.parse({
      revision: 3,
      profiles: [
        {
          id: PROFILE_ID,
          revision: 2,
          ...profile(),
        },
      ],
    });

    expect(document.profiles[0]).toMatchObject({
      id: PROFILE_ID,
      revision: 2,
      privateNote: "Lab work only",
    });
  });

  it("defines a strict project summary that cannot contain private notes", () => {
    const summary = ProjectAvailabilitySummarySchema.parse({
      projectId: PROFILE_ID,
      members: [
        {
          userId: SECOND_PROFILE_ID,
          username: "member",
          displayName: "Member",
          color: "#2563eb",
          profiles: [
            {
              validFrom: "2026-07-20",
              validThrough: "2026-12-31",
              weeklyCapacityMinutes: 600,
              weeklySlots: [
                { dayOfWeek: 1, startMinute: 540, endMinute: 720 },
              ],
              exceptions: [
                {
                  exceptionDate: "2026-07-27",
                  kind: "unavailable",
                  startMinute: 540,
                  endMinute: 570,
                },
              ],
            },
          ],
        },
      ],
    });

    expect(JSON.stringify(summary)).not.toContain("privateNote");

    const withProfileNote = structuredClone(summary) as {
      members: Array<{ profiles: Array<Record<string, unknown>> }>;
    };
    withProfileNote.members[0]!.profiles[0]!.privateNote = "secret";
    expect(
      ProjectAvailabilitySummarySchema.safeParse(withProfileNote).success,
    ).toBe(false);

    const withExceptionNote = structuredClone(summary) as {
      members: Array<{
        profiles: Array<{
          exceptions: Array<Record<string, unknown>>;
        }>;
      }>;
    };
    withExceptionNote.members[0]!.profiles[0]!.exceptions[0]!.privateNote =
      "secret";
    expect(
      ProjectAvailabilitySummarySchema.safeParse(withExceptionNote).success,
    ).toBe(false);
  });

  it("parses only the four strict red schedule conflict variants", () => {
    const participantFields = {
      severity: "red" as const,
      participantId: PROFILE_ID,
      taskId: SECOND_PROFILE_ID,
      userId: "00000000-0000-4000-8000-000000000003",
    };
    const conflicts = [
      {
        type: "unallocated_effort",
        ...participantFields,
        unallocatedMinutes: 30,
      },
      {
        type: "overdue",
        ...participantFields,
        deadline: "2026-07-19",
      },
      {
        type: "missing_availability",
        ...participantFields,
      },
      {
        type: "dependency_inversion",
        severity: "red",
        dependencyId: PROFILE_ID,
        predecessorTaskId: SECOND_PROFILE_ID,
        successorTaskId: "00000000-0000-4000-8000-000000000003",
        predecessorFinish: "2026-07-25",
        successorStart: "2026-07-25",
      },
    ];

    for (const conflict of conflicts) {
      expect(ScheduleConflictSchema.safeParse(conflict).success).toBe(true);
      expect(
        ScheduleConflictSchema.safeParse({
          ...conflict,
          suggestion: "Move it later",
        }).success,
      ).toBe(false);
    }

    expect(
      ScheduleConflictSchema.safeParse({
        ...conflicts[0],
        severity: "yellow",
      }).success,
    ).toBe(false);
    expect(
      ScheduleConflictSchema.safeParse({
        ...participantFields,
        type: "unknown",
      }).success,
    ).toBe(false);
  });
});
