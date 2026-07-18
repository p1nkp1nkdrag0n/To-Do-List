import { describe, expect, it } from "vitest";

import {
  createsDependencyCycle,
  createsParentCycle,
} from "../../../server/modules/schedule/graph.js";

describe("schedule graph validation", () => {
  it("detects direct and transitive parent cycles", () => {
    const parents = new Map<string, string | null>([
      ["root", null],
      ["middle", "root"],
      ["leaf", "middle"],
    ]);

    expect(createsParentCycle(parents, "root", "root")).toBe(true);
    expect(createsParentCycle(parents, "root", "leaf")).toBe(true);
    expect(createsParentCycle(parents, "leaf", "root")).toBe(false);
    expect(createsParentCycle(parents, "leaf", null)).toBe(false);
  });

  it("detects a dependency edge that would close a directed cycle", () => {
    const edges = [
      { predecessorId: "a", successorId: "b" },
      { predecessorId: "b", successorId: "c" },
    ];

    expect(createsDependencyCycle(edges, "c", "a")).toBe(true);
    expect(createsDependencyCycle(edges, "a", "c")).toBe(false);
    expect(createsDependencyCycle(edges, "a", "a")).toBe(true);
  });

  it("ignores soft-deleted dependencies", () => {
    expect(
      createsDependencyCycle(
        [
          { predecessorId: "a", successorId: "b", deleted: true },
          { predecessorId: "b", successorId: "c" },
        ],
        "c",
        "a",
      ),
    ).toBe(false);
  });
});
