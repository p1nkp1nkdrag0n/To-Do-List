/**
 * 苏客松演示种子脚本 v3
 *
 * 目标：让「冲突引擎」在演示当天必红，且红得可解释。
 *
 *   - 3 名成员：邱业恒（owner）/ 张工（后端）/ 李工（测试）
 *   - 张工下周三请假 → 当周只剩 4h
 *   - T2「MCP 工具层接口联调」需要 10h，落在张工身上 → unallocated_effort（缺 6h）
 *   - T3 开始日早于 T2 结束日 → dependency_inversion
 *
 * 所有日期都按「运行当天」推算，现场 10/31 重跑一次即可对齐，不存在写死日期，
 * 也不会因为日期过期整屏变红。
 *
 * 用法：
 *   npm run seed:demo:v3               # 已存在演示数据时拒绝覆盖
 *   npm run seed:demo:v3 -- --reset    # 清掉本项目任务 + 三名成员可用时间后重建
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
import { ScheduleService } from "../server/modules/schedule/schedule-service.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const DEMO_PASSWORD = "demo1234";

const PROJECT_NAME = "苏客松·会议排班助手";
const OWNER_USERNAME = "qyhsktn";

interface DemoMember {
  key: "owner" | "backend" | "qa";
  username: string;
  displayName: string;
  role: string;
  weeklyCapacityMinutes: number;
  weeklySlots: Array<{ dayOfWeek: number; startMinute: number; endMinute: number }>;
  exceptions?: Array<{
    exceptionDate: string;
    kind: "available" | "unavailable";
    startMinute: number;
    endMinute: number;
    privateNote: string;
  }>;
}

interface DemoTask {
  key: "T1" | "T2" | "T3" | "T4";
  title: string;
  description: string;
  ownerKey: DemoMember["key"];
  startDate: string;
  dueDate: string;
  estimatedMinutes: number;
  predecessor?: DemoTask["key"];
}

interface UserRow extends Record<string, unknown> {
  id: string;
  username: string;
  display_name: string;
  created_at: string;
  updated_at: string;
  revision: number;
  availability_revision: number;
}

function dateAt(milliseconds: number): string {
  return new Date(milliseconds).toISOString().slice(0, 10);
}

function todayInZone(timeZone: string, now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(
    parts.filter(({ type }) => type !== "literal").map(({ type, value }) => [type, value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

function shiftDays(date: string, days: number): string {
  return dateAt(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS);
}

/** 严格晚于今天的下一个周一（今天就是周一则取 7 天后）。 */
function nextMonday(date: string): string {
  const dayOfWeek = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  const offset = dayOfWeek === 1 ? 7 : (8 - dayOfWeek) % 7;
  return shiftDays(date, offset);
}

function parseFlags(argv: string[]) {
  return {
    reset: argv.includes("--reset"),
    force: argv.includes("--force"),
  };
}

function sessionFor(row: UserRow): AuthenticatedSession {
  return {
    sessionId: "seed-script",
    tokenHash: "seed-script",
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

function findUser(database: ReturnType<typeof openV2Database>, username: string): UserRow | undefined {
  return database.get<UserRow>(
    `SELECT id, username, display_name, created_at, updated_at, revision, availability_revision
       FROM users WHERE username = ? COLLATE NOCASE`,
    [username],
  );
}

function printHeader(title: string): void {
  console.log(`\n=== ${title} ===`);
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const config = parseConfig();
  const now = new Date();
  const clock = () => new Date(now.getTime());

  const database = openV2Database(config.dbPath);
  migrateV2Database(database, () => now.toISOString());
  const dependencies = resolveDependencies({
    database,
    sessionSecret: "seed-script-session-secret-not-for-production",
    cookieSecure: false,
    bootstrapCode: "seed-script-bootstrap-code",
    clock,
  });

  const availabilityService = new AvailabilityService(dependencies);
  const scheduleService = new ScheduleService(dependencies);
  const projectService = new ProjectService(dependencies);

  printHeader("数据库");
  console.log(`dbPath = ${config.dbPath}`);
  console.log(`today  = ${todayInZone("Asia/Shanghai", now)}`);

  // ---- 1. 用户与团队成员 ------------------------------------------------
  const ownerRow = findUser(database, OWNER_USERNAME);
  if (ownerRow === undefined) {
    throw new Error(
      `找不到 owner 账号 ${OWNER_USERNAME}，请先在应用里完成首次注册再运行本脚本。`,
    );
  }

  const today = todayInZone("Asia/Shanghai", now);
  const week = nextMonday(today);
  const leaveDate = shiftDays(week, 2); // 下周三

  const members: DemoMember[] = [
    {
      key: "owner",
      username: ownerRow.username,
      displayName: ownerRow.display_name,
      role: "项目负责人 / 前端",
      weeklyCapacityMinutes: 1_680,
      weeklySlots: [
        ...[1, 2, 3, 4, 5].map((dayOfWeek) => ({ dayOfWeek, startMinute: 1_200, endMinute: 1_320 })),
        { dayOfWeek: 6, startMinute: 540, endMinute: 1_080 },
        { dayOfWeek: 0, startMinute: 540, endMinute: 1_080 },
      ],
    },
    {
      key: "backend",
      username: "zhang.gong",
      displayName: "张工",
      role: "后端",
      weeklyCapacityMinutes: 360,
      weeklySlots: [
        { dayOfWeek: 1, startMinute: 1_140, endMinute: 1_260 },
        { dayOfWeek: 3, startMinute: 1_140, endMinute: 1_260 },
        { dayOfWeek: 5, startMinute: 1_140, endMinute: 1_260 },
      ],
      exceptions: [
        {
          exceptionDate: leaveDate,
          kind: "unavailable",
          startMinute: 1_140,
          endMinute: 1_260,
          privateNote: "请假半天",
        },
      ],
    },
    {
      key: "qa",
      username: "li.gong",
      displayName: "李工",
      role: "测试 / 交付",
      weeklyCapacityMinutes: 900,
      weeklySlots: [1, 2, 3, 4, 5].map((dayOfWeek) => ({
        dayOfWeek,
        startMinute: 1_140,
        endMinute: 1_320,
      })),
    },
  ];

  const passwordHash = bcrypt.hashSync(DEMO_PASSWORD, 10);
  const userIds = new Map<DemoMember["key"], string>();

  for (const member of members) {
    const existing = findUser(database, member.username);
    let row = existing;
    if (row === undefined) {
      const id = randomUUID();
      const iso = now.toISOString();
      database.run(
        `INSERT INTO users
           (id, username, password_hash, display_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, member.username, passwordHash, member.displayName, iso, iso],
      );
      row = findUser(database, member.username)!;
      console.log(`+ 新建用户 ${member.displayName} (${member.username})`);
    } else {
      console.log(`= 复用用户 ${member.displayName} (${member.username})`);
    }
    userIds.set(member.key, row.id);

    const membership = database.get<{ user_id: string; removed_at: string | null }>(
      "SELECT user_id, removed_at FROM team_members WHERE user_id = ?",
      [row.id],
    );
    if (membership === undefined) {
      database.run(
        `INSERT INTO team_members (user_id, joined_at, invited_by) VALUES (?, ?, ?)`,
        [row.id, now.toISOString(), ownerRow.id],
      );
    } else if (membership.removed_at !== null) {
      database.run(
        `UPDATE team_members SET removed_at = NULL, removed_by = NULL, revision = revision + 1
          WHERE user_id = ?`,
        [row.id],
      );
    }
  }

  // ---- 2. 项目 ----------------------------------------------------------
  const existingProject = database.get<{ id: string; schedule_revision: number }>(
    `SELECT id, schedule_revision FROM projects
      WHERE name = ? AND deleted_at IS NULL ORDER BY created_at LIMIT 1`,
    [PROJECT_NAME],
  );

  const ownerSession = sessionFor(findUser(database, ownerRow.username)!);
  let projectId: string;

  if (existingProject === undefined) {
    const created = projectService.create(ownerSession, {
      name: PROJECT_NAME,
      description: "会议录音 → 抽取待办 → 自动排期 → 冲突消解 的演示项目",
      startDate: today,
      endDate: shiftDays(today, 60),
      memberUserIds: [...userIds.values()].filter((id) => id !== ownerRow.id),
    });
    projectId = created.project.id;
    console.log(`+ 新建项目 ${PROJECT_NAME}`);
  } else {
    projectId = existingProject.id;
    console.log(`= 复用项目 ${PROJECT_NAME}`);
    for (const member of members) {
      const userId = userIds.get(member.key)!;
      const memberRow = database.get<{ removed_at: string | null }>(
        "SELECT removed_at FROM project_members WHERE project_id = ? AND user_id = ?",
        [projectId, userId],
      );
      if (memberRow === undefined) {
        projectService.addMember(ownerSession, projectId, { userId });
      } else if (memberRow.removed_at !== null) {
        database.run(
          `UPDATE project_members SET removed_at = NULL, removed_by = NULL, revision = revision + 1
            WHERE project_id = ? AND user_id = ?`,
          [projectId, userId],
        );
      }
    }
  }

  // ---- 3. 清理（仅 --reset） -------------------------------------------
  const taskCount = database.get<{ count: number }>(
    "SELECT COUNT(*) AS count FROM tasks WHERE project_id = ?",
    [projectId],
  )!.count;

  if (!flags.reset) {
    if (taskCount > 0) {
      throw new Error(
        `项目里已经有 ${taskCount} 个任务。要重建演示数据请加 --reset（只删本项目任务与三名成员的可用时间）。`,
      );
    }
  } else {
    const before = database.run("DELETE FROM tasks WHERE project_id = ?", [projectId]);
    console.log(`- 已清空本项目任务 ${before.changes} 条（参与人 / 依赖随外键级联删除）`);
    const profileIds = [...userIds.values()].map(() => "?").join(", ");
    const removed = database.run(
      `DELETE FROM availability_profiles WHERE user_id IN (${profileIds})`,
      [...userIds.values()],
    );
    console.log(`- 已清空演示成员可用时间 ${removed.changes} 份`);
  }

  // ---- 4. 可用时间 ------------------------------------------------------
  for (const member of members) {
    const userId = userIds.get(member.key)!;
    const current = database.get<{ availability_revision: number }>(
      "SELECT availability_revision FROM users WHERE id = ?",
      [userId],
    )!;
    availabilityService.replaceDocument(sessionFor(findUser(database, member.username)!), {
      expectedRevision: current.availability_revision,
      profiles: [
        {
          validFrom: shiftDays(today, -7),
          validThrough: shiftDays(today, 90),
          weeklyCapacityMinutes: member.weeklyCapacityMinutes,
          privateNote: `${member.displayName} 的固定可用时间`,
          weeklySlots: member.weeklySlots,
          exceptions:
            member.key === "backend"
              ? member.exceptions!
              : [],
        },
      ],
    });
    console.log(
      `~ ${member.displayName}：每周上限 ${(member.weeklyCapacityMinutes / 60).toFixed(1)}h` +
        (member.key === "backend" ? `，${leaveDate} 请假` : ""),
    );
  }

  // ---- 5. 任务 / 参与人 / 依赖 ------------------------------------------
  const tasks: DemoTask[] = [
    {
      key: "T1",
      title: "会议录音脚本与演示话术定稿",
      description: "60 秒录音台本 + 3 分钟镜头脚本 + 答辩口径",
      ownerKey: "owner",
      startDate: today,
      dueDate: shiftDays(week, -1),
      estimatedMinutes: 240,
    },
    {
      key: "T2",
      title: "MCP 工具层接口联调",
      description: "stdio 真协议接通 Orchestrator，读写工具全部可用",
      ownerKey: "backend",
      startDate: week,
      dueDate: shiftDays(week, 4),
      estimatedMinutes: 600, // 10h，张工当周只有 4h
      predecessor: "T1",
    },
    {
      key: "T3",
      title: "甘特图与冲突面板联调",
      description: "冲突红/绿切换、重排动画、撤销按钮",
      ownerKey: "qa",
      startDate: shiftDays(week, 1),
      dueDate: shiftDays(week, 4),
      estimatedMinutes: 480,
      predecessor: "T2",
    },
    {
      key: "T4",
      title: "全流程彩排与兜底录屏",
      description: "端到端 < 90 秒，不点任何按钮；录一版兜底视频",
      ownerKey: "owner",
      startDate: shiftDays(week, 5),
      dueDate: shiftDays(week, 6),
      estimatedMinutes: 240,
      predecessor: "T3",
    },
  ];

  const taskIds = new Map<DemoTask["key"], string>();
  for (const task of tasks) {
    const created = scheduleService.createTask(ownerSession, projectId, {
      title: task.title,
      description: task.description,
      startDate: task.startDate,
      dueDate: task.dueDate,
    });
    taskIds.set(task.key, created.task.id);
    scheduleService.addParticipant(ownerSession, projectId, created.task.id, {
      userId: userIds.get(task.ownerKey)!,
      startDate: task.startDate,
      endDate: task.dueDate,
      estimatedMinutes: task.estimatedMinutes,
    });
    console.log(
      `+ ${task.key} ${task.title}  ${task.startDate} → ${task.dueDate}  ` +
        `${(task.estimatedMinutes / 60).toFixed(1)}h  @${members.find((m) => m.key === task.ownerKey)!.displayName}`,
    );

    if (task.predecessor !== undefined) {
      scheduleService.createDependency(ownerSession, projectId, created.task.id, {
        predecessorTaskId: taskIds.get(task.predecessor)!,
      });
      console.log(`  ↳ 依赖 ${task.predecessor} → ${task.key}`);
    }
  }

  // ---- 6. 自检：必须恰好 2 条红冲突 ------------------------------------
  const conflicts = availabilityService.projectConflicts(projectId);
  printHeader("冲突自检");
  console.log(JSON.stringify(conflicts, null, 2));

  const hasUnallocated = conflicts.some((c) => c.type === "unallocated_effort");
  const hasInversion = conflicts.some((c) => c.type === "dependency_inversion");
  const unexpected = conflicts.filter(
    (c) => c.type !== "unallocated_effort" && c.type !== "dependency_inversion",
  );

  printHeader("摘要");
  console.log(`projectId = ${projectId}`);
  console.log(`冲突数    = ${conflicts.length}（期望 2）`);
  console.log(`  unallocated_effort : ${hasUnallocated ? "✓" : "✗"}`);
  console.log(`  dependency_inversion: ${hasInversion ? "✓" : "✗"}`);
  if (unexpected.length > 0) {
    console.log(`  ⚠ 意外冲突：${unexpected.map((c) => c.type).join(", ")}`);
  }
  console.log(`演示登录：${members.map((m) => `${m.displayName}=${m.username}`).join(" / ")}`);
  console.log(`新增账号密码：${DEMO_PASSWORD}（owner 账号密码未被修改）`);

  database.close();

  if (conflicts.length !== 2 || !hasUnallocated || !hasInversion || unexpected.length > 0) {
    console.error("\n种子数据不符合预期，请检查上面的冲突明细。");
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error("\n种子脚本失败：", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
