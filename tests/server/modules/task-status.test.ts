import { describe, expect, it } from "vitest";

import { aggregateTaskStatus } from "../../../server/modules/schedule/task-status.js";

describe("task status aggregation", () => {
  it("keeps reviewed tasks done until they are explicitly reopened", () => {
    expect(
      aggregateTaskStatus({
        reviewed: true,
        participantStatuses: ["blocked"],
        childStatuses: ["blocked"],
        requiredDeliverablesFulfilled: false,
      }),
    ).toBe("done");
  });

  it("prioritizes blocked responsibility over other active work", () => {
    expect(
      aggregateTaskStatus({
        reviewed: false,
        participantStatuses: ["done", "blocked"],
        childStatuses: ["done"],
        requiredDeliverablesFulfilled: true,
      }),
    ).toBe("blocked");
  });

  it("enters pending review only when all responsibility and deliverables are complete", () => {
    expect(
      aggregateTaskStatus({
        reviewed: false,
        participantStatuses: ["done"],
        childStatuses: ["done"],
        requiredDeliverablesFulfilled: true,
      }),
    ).toBe("pending_review");
    expect(
      aggregateTaskStatus({
        reviewed: false,
        participantStatuses: ["done"],
        childStatuses: ["done"],
        requiredDeliverablesFulfilled: false,
      }),
    ).toBe("in_progress");
  });

  it("requires at least one participant or active child before review", () => {
    expect(
      aggregateTaskStatus({
        reviewed: false,
        participantStatuses: [],
        childStatuses: [],
        requiredDeliverablesFulfilled: true,
      }),
    ).toBe("not_started");
  });

  it("treats partial, pending-review, and completed responsibility as begun work", () => {
    for (const input of [
      { participantStatuses: ["in_progress" as const], childStatuses: [] },
      { participantStatuses: [], childStatuses: ["pending_review" as const] },
      { participantStatuses: ["done" as const], childStatuses: [] },
    ]) {
      expect(
        aggregateTaskStatus({
          reviewed: false,
          ...input,
          requiredDeliverablesFulfilled: false,
        }),
      ).toBe("in_progress");
    }
  });
});
