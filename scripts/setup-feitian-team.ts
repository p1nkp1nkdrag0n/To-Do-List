/**
 * 一次性：把「飞天探微」这份真实纪要里的人加进演示项目。
 *
 *   npx tsx scripts/setup-feitian-team.ts
 *
 * 做三件事：
 *  1. 建 4 个成员账号（柴子笑 / 刘伊昕 / 汪筱莜 / 徐彪），邱业恒已存在
 *  2. 拉进团队和项目
 *  3. 给他们配可用时间——**故意配得紧一点**，这样真实纪要吃进去才会出冲突
 */
import { randomUUID } from "node:crypto";

import bcrypt from "bcryptjs";

import { parseConfig } from "../server/config/env.js";
import { openV2Database } from "../server/db/database.js";
import { migrateV2Database } from "../server/db/migrations.js";
import { resolveDependencies } from "../server/http/dependencies.js";
import { AvailabilityService } from "../server/modules/availability/availability-service.js";
import type { AuthenticatedSession } from "../server/modules/auth/auth-service.js";
import { ProjectService } from "../server/modules/projects/project-service.js";

const DEMO_PASSWORD = "demo1234";
const PROJECT_NAME = "苏客松·会议排班助手";

interface Member {
  username: string;
  displayName: string;
  role: string;
  weeklyCapacityMinutes: number;
  slots: Array<{ dayOfWeek: number; startMinute: number; endMinute: number }>;
}

/** 排得很紧：刘伊昕一周只有 6h，柴子笑 9h，汪筱莜 4h，徐彪 3h。 */
const MEMBERS: Member[] = [
  {
    username: "chai.zixiao",
    displayName: "柴子笑",
    role: "文档 / PPT / 统筹",
    weeklyCapacityMinutes: 540,
    slots: [1, 2, 3, 4, 5].map((day) => ({ dayOfWeek: day, startMinute: 1_140, endMinute: 1_260 })),
  },
  {
    username: "liu.yixin",
    displayName: "刘伊昕",
    role: "轨道仿真 / 文档",
    weeklyCapacityMinutes: 360,
    slots: [1, 3, 5].map((day) => ({ dayOfWeek: day, startMinute: 1_140, endMinute: 1_260 })),
  },
  {
    username: "wang.xiaoyou",
    displayName: "汪筱莜",
    role: "软件学习",
    weeklyCapacityMinutes: 240,
    slots: [2, 4].map((day) => ({ dayOfWeek: day, startMinute: 1_140, endMinute: 1_260 })),
  },
  {
    username: "xu.biao",
    displayName: "徐彪",
    role: "进度表",
    weeklyCapacityMinutes: 180,
    slots: [{ dayOfWeek: 6, startMinute: 540, endMinute: 720 }],
  },
];

function sessionFor(row: {
  id: string;
  username: string;
  display_name: string;
  created_at: string;
  updated_at: string;
  revision: number;
}): AuthenticatedSession {
  return {
    sessionId: "setup-script",
    tokenHash: "setup-script",
    teamMember: true,
    user: {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      revision: row.revision,
    },
  };
}

const config = parseConfig();
const database = openV2Database(config.dbPath);
migrateV2Database(database);
const dependencies = resolveDependencies({
  database,
  sessionSecret: "setup-script-secret-not-for-production",
  cookieSecure: false,
  bootstrapCode: "setup-script-bootstrap",
});
const availability = new AvailabilityService(dependencies);
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
if (owner === undefined) throw new Error("找不到 owner 账号");

const project = database.get<{ id: string }>(
  `SELECT id FROM projects WHERE name = ? AND deleted_at IS NULL LIMIT 1`,
  [PROJECT_NAME],
);
if (project === undefined) throw new Error(`找不到项目「${PROJECT_NAME}」`);

const hash = bcrypt.hashSync(DEMO_PASSWORD, 10);
const ownerSession = sessionFor(owner);

for (const member of MEMBERS) {
  let row = database.get<{
    id: string;
    username: string;
    display_name: string;
    created_at: string;
    updated_at: string;
    revision: number;
  }>(
    `SELECT id, username, display_name, created_at, updated_at, revision
       FROM users WHERE username = ? COLLATE NOCASE`,
    [member.username],
  );

  if (row === undefined) {
    const id = randomUUID();
    const iso = new Date().toISOString();
    database.run(
      `INSERT INTO users (id, username, password_hash, display_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, member.username, hash, member.displayName, iso, iso],
    );
    row = database.get(
      `SELECT id, username, display_name, created_at, updated_at, revision
         FROM users WHERE username = ? COLLATE NOCASE`,
      [member.username],
    )!;
    console.log(`+ 新建成员 ${member.displayName}`);
  } else {
    console.log(`= 已存在 ${member.displayName}`);
  }

  database.run(
    `INSERT OR IGNORE INTO team_members (user_id, joined_at, invited_by) VALUES (?, ?, ?)`,
    [row.id, new Date().toISOString(), owner.id],
  );

  const inProject = database.get<{ removed_at: string | null }>(
    "SELECT removed_at FROM project_members WHERE project_id = ? AND user_id = ?",
    [project.id, row.id],
  );
  if (inProject === undefined) {
    projects.addMember(ownerSession, project.id, { userId: row.id });
  }

  const revision =
    database.get<{ availability_revision: number }>(
      "SELECT availability_revision FROM users WHERE id = ?",
      [row.id],
    )?.availability_revision ?? 1;

  availability.replaceDocument(sessionFor(row), {
    expectedRevision: revision,
    profiles: [
      {
        validFrom: new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10),
        validThrough: new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10),
        weeklyCapacityMinutes: member.weeklyCapacityMinutes,
        privateNote: `${member.role}，时间紧`,
        weeklySlots: member.slots,
        exceptions: [],
      },
    ],
  });
  console.log(`  ~ 可用时间：每周 ${(member.weeklyCapacityMinutes / 60).toFixed(1)}h`);
}

console.log("\n完成。现在可以把纪要喂进去：");
console.log("  npx tsx server/meeting/run-minutes-demo.ts ../.tmp/minutes-4-26.txt");
database.close();
