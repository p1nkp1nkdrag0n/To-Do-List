import { describe, expect, it } from "vitest";

import {
  initialCollaborationState,
  reduceCollaborationMessage,
} from "../../src/lib/collaboration-state.js";

describe("collaboration state", () => {
  it("tracks presence, drag locks, previews, release, and invalidation", () => {
    const present = reduceCollaborationMessage(initialCollaborationState, {
      type: "presence",
      projectId: "0f5474c7-f21a-4407-bb91-ddf41ff4a641",
      users: [
        {
          userId: "61c89738-6229-4168-bfd2-b1b1d0263c28",
          displayName: "Lin",
          connectionCount: 2,
        },
      ],
    });
    expect(present.users).toHaveLength(1);

    const locked = reduceCollaborationMessage(present, {
      type: "drag.lock.granted",
      participantId: "4c24676a-0cf4-4990-bdec-4815111898df",
      ownerId: "61c89738-6229-4168-bfd2-b1b1d0263c28",
      ownerDisplayName: "Lin",
      expiresAt: "2026-07-18T08:00:00.000Z",
    });
    expect(locked.locks["4c24676a-0cf4-4990-bdec-4815111898df"]?.ownerDisplayName).toBe("Lin");

    const previewed = reduceCollaborationMessage(locked, {
      type: "drag.preview",
      participantId: "4c24676a-0cf4-4990-bdec-4815111898df",
      ownerId: "61c89738-6229-4168-bfd2-b1b1d0263c28",
      ownerDisplayName: "Lin",
      startDate: "2026-07-21",
      endDate: "2026-07-25",
    });
    expect(previewed.previews["4c24676a-0cf4-4990-bdec-4815111898df"]).toMatchObject({
      startDate: "2026-07-21",
      endDate: "2026-07-25",
    });

    const invalidated = reduceCollaborationMessage(previewed, {
      type: "entity.invalidated",
      entityType: "participant",
      entityId: "4c24676a-0cf4-4990-bdec-4815111898df",
    });
    expect(invalidated.invalidationVersion).toBe(1);

    const released = reduceCollaborationMessage(invalidated, {
      type: "drag.lock.released",
      participantId: "4c24676a-0cf4-4990-bdec-4815111898df",
      reason: "released",
    });
    expect(released.locks).toEqual({});
    expect(released.previews).toEqual({});
  });

  it("records the current owner when a lock request is denied", () => {
    const state = reduceCollaborationMessage(initialCollaborationState, {
      type: "drag.lock.denied",
      participantId: "4c24676a-0cf4-4990-bdec-4815111898df",
      ownerId: "61c89738-6229-4168-bfd2-b1b1d0263c28",
      ownerDisplayName: "Lin",
      expiresAt: "2026-07-18T08:00:00.000Z",
    });

    expect(state.locks["4c24676a-0cf4-4990-bdec-4815111898df"]?.ownerId).toBe(
      "61c89738-6229-4168-bfd2-b1b1d0263c28",
    );
  });
});
