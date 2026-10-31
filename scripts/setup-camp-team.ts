/**
 * 把「甲乙丙丁」四个生活化成员加进主演示项目。
 *
 *   npx tsx scripts/setup-camp-team.ts
 *
 * 目的：示例纪要里写的是甲乙丙丁，如果项目里没有这四个人，
 * 抽取出来的任务会被当成“项目外的人”跳过，示例就演示不了。
 */
import { randomUUID } from "node:crypto";

import bcrypt from "bcryptjs";

import { loadEnvFile } from "../server/config/dotenv.js";
import { parseConfig } from "../server/config/env.js";
import { openV2Database } from "../server/db/database.js";
import { migrateV2Database } from "../server/db/migrations.js";
import { resolveDependencies } from "../server/http/dependencies.js";
import { AvailabilityService } from "../server/modules/availability/availability-service.js";
import type { AuthenticatedSession } from "../server/modules/auth/auth-service.js";
import { ProjectService } from "../server/modules/projects/project-service.js";

const PASSWORD = "demo1234";
const PROJECT_ID = "2d1c39a9-bf13-4310-8130-350f84872cec";

/** 甲最闲、丁最忙，正好能造出「排不下」的冲突。 */
const MEMBERS = [
  { username: "jia", displayName: "甲", capacity: 600, days: [1, 2, 3, 4, 5] },
  { username: "yi01", displayName: "乙", capacity: 480, days: [1, 3, 5] },
  { username: "bing", displayName: "丙", capacity: 360, days: [2, 4] },
  { username: "ding", displayName: "丁", capacity: 240, days: [6] },
];

loadEnvFile();
const config = parseConfig();
const database = openV2Database(config.dbPath);
migrateV2Database(database);
const dependencies = resolveDependencies({
  database,
  sessionSecret: "setup-camp-secret-not-for-production",
  cookieSecure: false,
  bootstrapCode: "setup-camp-bootstrap",
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

const hash = bcrypt.hashSync(PASSWORD, 10);

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
    console.log(`+ 新建成员 ${member.displayName}（${member.username}）`);
  }

  database.run(
    `INSERT OR IGNORE INTO team_members (user_id, joined_at, invited_by) VALUES (?, ?, ?)`,
    [row.id, new Date().toISOString(), owner.id],
  );

  const inProject = database.get<{ removed_at: string | null }>(
    "SELECT removed_at FROM project_members WHERE project_id = ? AND user_id = ?",
    [PROJECT_ID, row.id],
  );
  if (inProject === undefined) {
    projects.addMember(ownerSession, PROJECT_ID, { userId: row.id });
    console.log(`  → 加入演示项目`);
  }

  const revision =
    database.get<{ availability_revision: number }>(
      "SELECT availability_revision FROM users WHERE id = ?",
      [row.id],
    )?.availability_revision ?? 1;

  availability.replaceDocument(
    {
      sessionId: "script",
      tokenHash: "script",
      teamMember: true,
      user: {
        id: row.id,
        username: row.username,
        displayName: row.display_name,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        revision: row.revision,
      },
    },
    {
      expectedRevision: revision,
      profiles: [
        {
          validFrom: new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10),
          validThrough: new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10),
          weeklyCapacityMinutes: member.capacity,
          privateNote: "生活化演示成员",
          weeklySlots: member.days.map((day) => ({
            dayOfWeek: day,
            startMinute: 1_140,
            endMinute: 1_260,
          })),
          exceptions: [],
        },
      ],
    },
  );
  console.log(`  ~ 每周可用 ${(member.capacity / 60).toFixed(1)}h`);
}

console.log("\n完成。现在用「填入示例纪要」就能抽到甲乙丙丁的任务了。");
database.close();
