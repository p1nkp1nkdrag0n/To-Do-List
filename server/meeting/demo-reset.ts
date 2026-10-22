/**
 * 演示用：把一个项目的排期清空（任务 / 分工 / 依赖），可用时间与成员保留。
 *
 * 为什么需要它：会议纪要是「从零建任务」的路径，不清空就会越跑越多。
 * 走的是数据库级联删除，不经过服务层，因为它是一次性的演示重置动作。
 */
import type { V2RuntimeDependencies } from "../http/dependencies.js";

export interface ClearScheduleResult {
  projectId: string;
  removedTasks: number;
}

export function clearProjectSchedule(
  dependencies: V2RuntimeDependencies,
  projectId: string,
): ClearScheduleResult {
  const project = dependencies.database.get<{ id: string }>(
    "SELECT id FROM projects WHERE id = ? AND deleted_at IS NULL",
    [projectId],
  );
  if (project === undefined) {
    throw new Error(`项目 ${projectId} 不存在。`);
  }

  return dependencies.database.transaction(() => {
    const removed = dependencies.database.run("DELETE FROM tasks WHERE project_id = ?", [projectId]);
    return { projectId, removedTasks: Number(removed.changes) };
  });
}
