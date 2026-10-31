/**
 * 建第二个演示项目「飞天探微」，并把真实纪要导进去。
 *
 *   npx tsx scripts/create-feitian-project.ts
 *
 * 特点：**负责人不可替换**——只允许延期 / 平移，不允许换人或拆分。
 * 用来验证「AI 在不动负责人的前提下，能不能把排期修好」。
 */
import fs from "node:fs";
import path from "node:path";

import { loadEnvFile } from "../server/config/dotenv.js";
import { parseConfig } from "../server/config/env.js";
import { openV2Database } from "../server/db/database.js";
import { migrateV2Database } from "../server/db/migrations.js";
import { resolveDependencies } from "../server/http/dependencies.js";
import type { AuthenticatedSession } from "../server/modules/auth/auth-service.js";
import { ProjectService } from "../server/modules/projects/project-service.js";
import { clearProjectSchedule } from "../server/meeting/demo-reset.js";
import { MeetingOrchestrator } from "../server/meeting/orchestrator.js";

const PROJECT_NAME = "飞天探微";
const MEMBER_USERNAMES = ["chai.zixiao", "liu.yixin", "wang.xiaoyou", "xu.biao"];
const MINUTES_PATH = path.resolve(process.cwd(), "..", ".tmp", "minutes-4-26.txt");

loadEnvFile();
const config = parseConfig();
const database = openV2Database(config.dbPath);
migrateV2Database(database);
const dependencies = resolveDependencies({
  database,
  sessionSecret: "create-project-secret-not-for-production",
  cookieSecure: false,
  bootstrapCode: "create-project-bootstrap",
});
const projects = new ProjectService(dependencies);

const owner = database.get<{
  id: string;
  username: string;
  display_name: string;
  created_at: string;
  updated_at: string;
  revision: number;
}>(
  `SELECT id, username, display_name, created_at, updated_at, revision
     FROM users WHERE username = 'qyhsktn' COLLATE NOCASE`,
);
if (owner === undefined) throw new Error("找不到 owner 账号（qyhsktn）");

const ownerSession: AuthenticatedSession = {
  sessionId: "script",
  tokenHash: "script",
  teamMember: true,
  user: {
    id: owner.id,
    username: owner.username,
    displayName: owner.display_name,
    createdAt: owner.created_at,
    updatedAt: owner.updated_at,
    revision: owner.revision,
  },
};

const memberIds = MEMBER_USERNAMES.map((username) => {
  const row = database.get<{ id: string }>(
    "SELECT id FROM users WHERE username = ? COLLATE NOCASE",
    [username],
  );
  if (row === undefined) {
    throw new Error(`成员 ${username} 不存在，先跑：npx tsx scripts/setup-feitian-team.ts`);
  }
  return row.id;
});

const existing = database.get<{ id: string }>(
  "SELECT id FROM projects WHERE name = ? AND deleted_at IS NULL LIMIT 1",
  [PROJECT_NAME],
);

let projectId: string;
if (existing === undefined) {
  const created = projects.create(ownerSession, {
    name: PROJECT_NAME,
    description: "真实会议纪要测试项目（负责人固定，只允许延期与平移）",
    startDate: new Date().toISOString().slice(0, 10),
    endDate: new Date(Date.now() + 120 * 86400000).toISOString().slice(0, 10),
    memberUserIds: memberIds,
  });
  projectId = created.project.id;
  console.log(`+ 新建项目 ${PROJECT_NAME}（${projectId}）`);
} else {
  projectId = existing.id;
  console.log(`= 复用项目 ${PROJECT_NAME}（${projectId}）`);
}

const cleared = clearProjectSchedule(dependencies, projectId);
console.log(`- 清空原有排期 ${cleared.removedTasks} 个任务`);

const minutes = fs.readFileSync(MINUTES_PATH, "utf8");
console.log(`纪要：${minutes.length} 字`);

const orchestrator = new MeetingOrchestrator({
  projectId,
  lockOwners: true,
  paceMs: 0,
  onEvent(event) {
    if (event.type === "tool.call") {
      const args = event.tool === "plan_reschedule" ? `  [args: ${event.argumentsSummary}]` : "";
      console.log(`  ${event.tool.padEnd(18)} → ${event.resultSummary}${args}`);
    } else {
      console.log(`  ${event.type.padEnd(18)} ${event.message}`);
    }
  },
});

const result = await orchestrator.runFromMinutes(minutes);
console.log(
  `\n冲突 ${result.conflictsBefore} → ${result.conflictsAfter}，方案 ${result.appliedPlanId ?? "无"}，` +
    `耗时 ${(result.durationMs / 1000).toFixed(1)}s`,
);

console.log("\n最终排期（负责人应与纪要一致）：");
const rows = database.all<{ title: string; due_date: string | null; names: string }>(
  `SELECT tasks.title, tasks.due_date,
          group_concat(users.display_name || ' ' || (task_participants.estimated_minutes / 60) || 'h', ' + ') AS names
     FROM tasks
     JOIN task_participants ON task_participants.task_id = tasks.id
                        AND task_participants.removed_at IS NULL
     JOIN users ON users.id = task_participants.user_id
    WHERE tasks.project_id = ? AND tasks.deleted_at IS NULL
    GROUP BY tasks.id
    ORDER BY tasks.due_date, tasks.title`,
  [projectId],
);
for (const row of rows) {
  console.log(`  ${row.title} | 截止 ${row.due_date ?? "-"} | ${row.names}`);
}
console.log(`\n项目 ID：${projectId}（页面左上角项目切换器可以切过去）`);
database.close();
