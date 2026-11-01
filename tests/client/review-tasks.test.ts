import { describe, expect, it } from "vitest";

import { createReviewTasks, removeReviewTask, type DraftTask } from "../../src/features/meeting/review-tasks.js";

const draft = (title: string, dependsOnTitle: string | null = null): DraftTask => ({
  title, dependsOnTitle, ownerName: "甲成员", estimatedHours: 2, dueDate: null,
});
const members = [{ userId: "member-a", displayName: "甲成员" }];

describe("meeting review dependency identity", () => {
  it("keeps the original predecessor through another task's temporary duplicate title", () => {
    const tasks = createReviewTasks([draft("甲"), draft("乙"), draft("丙", "甲")], members);
    tasks[1]!.title = "甲";
    tasks[1]!.title = "丁";
    expect(tasks[2]!.predecessorClientTaskIds).toEqual([tasks[0]!.clientTaskId]);
    expect(tasks[2]!.unresolvedDependencies).toEqual([]);
    expect(tasks[0]!.ownerUserId).toBe("member-a");
  });

  it("deleting a temporary namesake preserves the actual predecessor", () => {
    const tasks = createReviewTasks([draft("甲"), draft("乙"), draft("丙", "甲")], members);
    tasks[1]!.title = "甲";
    const remaining = removeReviewTask(tasks, tasks[1]!.clientTaskId);
    expect(remaining[1]!.predecessorClientTaskIds).toEqual([tasks[0]!.clientTaskId]);
  });

  it("renaming a predecessor preserves identity; deleting it clears only its links", () => {
    const tasks = createReviewTasks([draft("甲"), draft("乙"), draft("丙", "甲")], members);
    tasks[2]!.predecessorClientTaskIds.push(tasks[1]!.clientTaskId);
    tasks[0]!.title = "新标题";
    expect(tasks[2]!.predecessorClientTaskIds).toContain(tasks[0]!.clientTaskId);
    const remaining = removeReviewTask(tasks, tasks[0]!.clientTaskId);
    expect(remaining[1]!.predecessorClientTaskIds).toEqual([tasks[1]!.clientTaskId]);
  });

  it.each([
    ["ambiguous", [draft("甲"), draft("甲"), draft("丙", "甲")]],
    ["missing", [draft("甲"), draft("丙", "不存在")]],
    ["self", [draft("甲", "甲")]],
  ] as const)("requires explicit confirmation for %s dependencies", (_label, drafts) => {
    const tasks = createReviewTasks([...drafts], members);
    expect(tasks.at(-1)!.predecessorClientTaskIds).toEqual([]);
    expect(tasks.at(-1)!.unresolvedDependencies).toEqual([drafts.at(-1)!.dependsOnTitle]);
  });

  it("does not bind an ambiguous dependency automatically after deleting one namesake", () => {
    const tasks = createReviewTasks([draft("甲"), draft("甲"), draft("丙", "甲")], members);
    const remaining = removeReviewTask(tasks, tasks[0]!.clientTaskId);
    expect(remaining[1]!.predecessorClientTaskIds).toEqual([]);
    expect(remaining[1]!.unresolvedDependencies).toEqual(["甲"]);
  });

  it("resolves exact trimmed titles but leaves ambiguous owners unassigned", () => {
    const tasks = createReviewTasks([draft(" 甲 "), draft("乙", "甲")], [
      ...members, { userId: "member-b", displayName: "甲成员" },
    ]);
    expect(tasks[1]!.predecessorClientTaskIds).toEqual([tasks[0]!.clientTaskId]);
    expect(tasks[1]!.ownerUserId).toBeNull();
  });
});
