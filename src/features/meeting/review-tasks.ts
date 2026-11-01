export interface DraftTask {
  title: string;
  ownerName: string;
  estimatedHours: number;
  dueDate: string | null;
  dependsOnTitle?: string | null;
  ownerBasis?: "explicit" | "pronoun" | "unknown";
  ownerConfidence?: number;
}

export interface ReviewTask {
  clientTaskId: string;
  title: string;
  ownerName: string;
  ownerUserId: string | null;
  estimatedHours: number;
  dueDate: string | null;
  predecessorClientTaskIds: string[];
  unresolvedDependencies: string[];
}

export interface RealtimeMember {
  userId: string;
  displayName: string;
}

/** Resolve model-provided titles once; later edits must preserve task identity. */
export function createReviewTasks(drafts: DraftTask[], members: RealtimeMember[]): ReviewTask[] {
  const prefix = `review-${Date.now()}`;
  const tasks = drafts.map((task, index): ReviewTask => {
    const owners = members.filter((member) => member.displayName === task.ownerName);
    return {
      clientTaskId: `${prefix}-${index}`,
      title: task.title,
      ownerName: task.ownerName,
      ownerUserId: owners.length === 1 ? owners[0]!.userId : null,
      estimatedHours: task.estimatedHours,
      dueDate: task.dueDate,
      predecessorClientTaskIds: [],
      unresolvedDependencies: [],
    };
  });
  return tasks.map((task, index) => {
    const title = drafts[index]!.dependsOnTitle?.trim();
    if (!title) return task;
    const matches = tasks.filter((candidate) => candidate.title.trim() === title);
    if (matches.length !== 1 || matches[0]!.clientTaskId === task.clientTaskId) {
      return { ...task, unresolvedDependencies: [title] };
    }
    return { ...task, predecessorClientTaskIds: [matches[0]!.clientTaskId] };
  });
}

export function removeReviewTask(tasks: ReviewTask[], clientTaskId: string): ReviewTask[] {
  return tasks
    .filter((task) => task.clientTaskId !== clientTaskId)
    .map((task) => ({
      ...task,
      predecessorClientTaskIds: task.predecessorClientTaskIds.filter((id) => id !== clientTaskId),
    }));
}
