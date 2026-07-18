export interface DependencyEdge {
  predecessorId: string;
  successorId: string;
  deleted?: boolean;
}

export function createsParentCycle(
  parents: ReadonlyMap<string, string | null>,
  taskId: string,
  candidateParentId: string | null,
): boolean {
  const visited = new Set<string>();
  let cursor = candidateParentId;
  while (cursor !== null) {
    if (cursor === taskId || visited.has(cursor)) {
      return true;
    }
    visited.add(cursor);
    cursor = parents.get(cursor) ?? null;
  }
  return false;
}

export function createsDependencyCycle(
  edges: readonly DependencyEdge[],
  predecessorId: string,
  successorId: string,
): boolean {
  if (predecessorId === successorId) {
    return true;
  }

  const successors = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.deleted) {
      continue;
    }
    const current = successors.get(edge.predecessorId) ?? [];
    current.push(edge.successorId);
    successors.set(edge.predecessorId, current);
  }

  const pending = [successorId];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === predecessorId) {
      return true;
    }
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);
    pending.push(...(successors.get(current) ?? []));
  }
  return false;
}
