/**
 * 一次性整理演示环境：
 *   1. 归档「苏客松·会议排班助手」
 *   2. 新建「Demo」项目，成员是 甲乙丙丁（+ 部署者）
 *
 *   npx tsx scripts/reshape-demo.ts
 */
import { loadEnvFile } from "../server/config/dotenv.js";
import { parseConfig } from "../server/config/env.js";
import { openV2Database } from "../server/db/database.js";
import { migrateV2Database } from "../server/db/migrations.js";
import { resolveDependencies } from "../server/http/dependencies.js";
import type { AuthenticatedSession } from "../server/modules/auth/auth-service.js";
import { ProjectService } from "../server/modules/projects/project-service.js";

loadEnvFile();
const config = parseConfig();
const database = openV2Database(config.dbPath);
migrateV2Database(database);
const dependencies = resolveDependencies({
  database,
  sessionSecret: "reshape-demo-secret-not-for-production",
  cookieSecure: false,
  bootstrapCode: "reshape-demo-bootstrap",
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
if (owner === undefined) throw new Error("找不到 owner 账号 qyhsktn");

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

// 1. 归档旧项目
const old = database.get<{ id: string; name: string }>(
  "SELECT id, name FROM projects WHERE name = ? AND archived_at IS NULL",
  ["苏客松·会议排班助手"],
);
if (old !== undefined) {
  database.run(
    "UPDATE projects SET archived_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ?",
    [new Date().toISOString(), new Date().toISOString(), old.id],
  );
  console.log(`- 已归档「${old.name}」`);
}

// 2. 建 Demo 项目
const campMembers = database.all<{ id: string; display_name: string }>(
  `SELECT id, display_name FROM users
    WHERE username IN ('jia','yi','bing','ding') COLLATE NOCASE
    ORDER BY username`,
);
if (campMembers.length !== 4) {
  throw new Error(`甲乙丙丁账号不全（找到 ${campMembers.length} 个），先跑 setup-camp-team.ts`);
}

const existing = database.get<{ id: string }>(
  "SELECT id FROM projects WHERE name = ? AND archived_at IS NULL",
  ["Demo"],
);

let demoId: string;
if (existing === undefined) {
  const created = projects.create(ownerSession, {
    name: "Demo",
    description: "周末露营筹备 · 甲乙丙丁",
    startDate: new Date().toISOString().slice(0, 10),
    endDate: new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10),
    memberUserIds: campMembers.map((row) => row.id),
  });
  demoId = created.project.id;
  console.log(`+ 新建项目「Demo」(${demoId})，成员：${campMembers.map((m) => m.display_name).join("、")}`);
} else {
  demoId = existing.id;
  console.log(`= 复用已有项目「Demo」(${demoId})`);
}

console.log("\n当前项目：");
for (const row of database.all<{ name: string; archived_at: string | null }>(
  "SELECT name, archived_at FROM projects ORDER BY created_at",
)) {
  console.log(` ${row.archived_at === null ? "✓" : "✗"} ${row.name}`);
}
database.close();
