import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openV2Database, type V2Database } from "../../../server/db/database.js";
import { migrateV2Database } from "../../../server/db/migrations.js";
import { resolveDependencies } from "../../../server/http/dependencies.js";
import type { AuthenticatedSession } from "../../../server/modules/auth/auth-service.js";
import { ProjectService } from "../../../server/modules/projects/project-service.js";
import { ScheduleService } from "../../../server/modules/schedule/schedule-service.js";
import type { CommitMeetingTasksRequest } from "../../../shared/schedule-contracts.js";

const DAY_MS = 24 * 60 * 60 * 1_000;

function dateAt(milliseconds: number): string {
  return new Date(milliseconds).toISOString().slice(0, 10);
}

function shiftDays(date: string, days: number): string {
  return dateAt(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS);
}

function todayInShanghai(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(
    parts.filter(({ type }) => type !== "literal").map(({ type, value }) => [type, value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

function sessionFor(id: string, username: string, displayName: string, now: Date): AuthenticatedSession {
  const iso = now.toISOString();
  return {
    sessionId: "test-session",
    tokenHash: "test-session",
    teamMember: true,
    user: { id, username, displayName, createdAt: iso, updatedAt: iso, revision: 1 },
  };
}

interface Fixture {
  database: V2Database;
  dbPath: string;
  projectId: string;
  lead: AuthenticatedSession;
  ownerId: string;
  otherId: string;
  today: string;
}

const openDatabases: V2Database[] = [];

afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()!.close();
});

function buildFixture(): Fixture {
  const now = new Date();
  const today = todayInShanghai(now);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-meeting-commit-"));
  const dbPath = path.join(directory, "app.sqlite");
  const database = openV2Database(dbPath);
  openDatabases.push(database);
  migrateV2Database(database, () => now.toISOString());

  const dependencies = resolveDependencies({
    database,
    sessionSecret: "meeting-commit-test-secret-32-characters",
    cookieSecure: false,
    bootstrapCode: "meeting-commit-test-bootstrap",
    clock: () => new Date(now.getTime()),
  });
  const projects = new ProjectService(dependencies);
  const schedule = new ScheduleService(dependencies);

  const leadId = randomUUID();
  const ownerId = randomUUID();
  const otherId = randomUUID();
  const users = [
    { id: leadId, username: "lead", name: "邱业恒" },
    { id: ownerId, username: "owner", name: "张工" },
    { id: otherId, username: "other", name: "李工" },
  ];
  for (const [index, user] of users.entries()) {
    database.run(
      `INSERT INTO users (id, username, password_hash, display_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [user.id, user.username, "test-hash", user.name, now.toISOString(), now.toISOString()],
    );
    database.run(
      "INSERT INTO team_members (user_id, joined_at, invited_by) VALUES (?, ?, ?)",
      [user.id, now.toISOString(), leadId],
    );
  }

  const lead = sessionFor(leadId, "lead", "邱业恒", now);
  const project = projects.create(lead, {
    name: "会议提交测试",
    description: "",
    startDate: shiftDays(today, -7),
    endDate: shiftDays(today, 60),
    memberUserIds: [ownerId, otherId],
  });

  return {
    database,
    dbPath,
    projectId: project.project.id,
    lead,
    ownerId,
    otherId,
    today,
  };
}

function scheduleRevision(fixture: Fixture): number {
  return fixture.database.get<{ schedule_revision: number }>(
    "SELECT schedule_revision FROM projects WHERE id = ?",
    [fixture.projectId],
  )!.schedule_revision;
}

function candidate(
  fixture: Fixture,
  overrides: Partial<CommitMeetingTasksRequest["tasks"][number]> = {},
): CommitMeetingTasksRequest["tasks"][number] {
  return {
    clientTaskId: randomUUID(),
    title: "完成演示脚本",
    ownerUserId: fixture.ownerId,
    estimatedMinutes: 120,
    startDate: fixture.today,
    dueDate: shiftDays(fixture.today, 2),
    predecessorClientTaskIds: [],
    ...overrides,
  };
}

function commit(
  fixture: Fixture,
  tasks: CommitMeetingTasksRequest["tasks"],
  replaceSchedule = true,
  expectedScheduleRevision = scheduleRevision(fixture),
) {
  return new ScheduleService(
    resolveDependencies({
      database: fixture.database,
      sessionSecret: "meeting-commit-test-secret-32-characters",
      cookieSecure: false,
      bootstrapCode: "meeting-commit-test-bootstrap",
      clock: () => new Date(),
    }),
  ).commitMeetingTasks(fixture.lead, fixture.projectId, {
    projectId: fixture.projectId,
    expectedScheduleRevision,
    replaceSchedule,
    tasks,
  });
}

function taskSnapshot(fixture: Fixture): Array<Record<string, unknown>> {
  return fixture.database.all(
    "SELECT id, title, start_date, due_date, revision FROM tasks WHERE project_id = ? ORDER BY id",
    [fixture.projectId],
  );
}

describe("commitMeetingTasks", () => {
  it("一次事务替换旧排期，建立任务、分工与依赖", () => {
    const fixture = buildFixture();
    const old = commit(fixture, [candidate(fixture, { title: "旧任务" })]);
    const first = candidate(fixture, { title: "任务 A" });
    const second = candidate(fixture, { title: "任务 B", predecessorClientTaskIds: [first.clientTaskId] });

    const result = commit(fixture, [first, second]);

    expect(result.taskIds).toHaveLength(2);
    expect(fixture.database.all("SELECT id FROM tasks WHERE project_id = ?", [fixture.projectId])).toHaveLength(2);
    expect(fixture.database.all("SELECT id FROM task_participants WHERE project_id = ?", [fixture.projectId])).toHaveLength(2);
    expect(fixture.database.all("SELECT id FROM task_dependencies WHERE project_id = ?", [fixture.projectId])).toHaveLength(1);
    expect(result.taskIds).not.toContain(old.taskIds[0]);
  });

  it("已写一条后第二条分工失败：旧排期与依赖原样保留", () => {
    const fixture = buildFixture();
    commit(fixture, [candidate(fixture, { title: "旧任务" })]);
    const before = taskSnapshot(fixture);
    const revisionBefore = scheduleRevision(fixture);
    const first = candidate(fixture, { title: "新任务 A" });
    const second = candidate(fixture, { title: "新任务 B", estimatedMinutes: -1 });

    expect(() => commit(fixture, [first, second])).toThrow();
    expect(taskSnapshot(fixture)).toEqual(before);
    expect(scheduleRevision(fixture)).toBe(revisionBefore);
  });

  it("依赖成环：整批回滚，不留半份新排期", () => {
    const fixture = buildFixture();
    const before = taskSnapshot(fixture);
    const first = candidate(fixture, { title: "A" });
    const second = candidate(fixture, { title: "B", predecessorClientTaskIds: [first.clientTaskId] });
    first.predecessorClientTaskIds = [second.clientTaskId];

    expect(() => commit(fixture, [first, second])).toThrow(/cycle/i);
    expect(taskSnapshot(fixture)).toEqual(before);
  });

  it("成员改名但 ID 未变：正常提交", () => {
    const fixture = buildFixture();
    fixture.database.run("UPDATE users SET display_name = ? WHERE id = ?", ["张工（改名）", fixture.ownerId]);

    expect(() => commit(fixture, [candidate(fixture)])).not.toThrow();
  });

  it("负责人 ID 已不在项目：整批拒绝，旧排期保留", () => {
    const fixture = buildFixture();
    commit(fixture, [candidate(fixture, { title: "旧任务" })]);
    const before = taskSnapshot(fixture);

    expect(() => commit(fixture, [candidate(fixture, { ownerUserId: randomUUID() })])).toThrow(
      /不是当前项目成员/,
    );
    expect(taskSnapshot(fixture)).toEqual(before);
  });

  it("项目归档：拒绝提交，旧排期保留", () => {
    const fixture = buildFixture();
    const before = taskSnapshot(fixture);
    fixture.database.run("UPDATE projects SET archived_at = ? WHERE id = ?", [
      new Date().toISOString(),
      fixture.projectId,
    ]);

    expect(() => commit(fixture, [candidate(fixture)])).toThrow(/归档/);
    expect(taskSnapshot(fixture)).toEqual(before);
  });

  it("预期排期版本过期：拒绝提交", () => {
    const fixture = buildFixture();
    const stale = scheduleRevision(fixture);
    commit(fixture, [candidate(fixture, { title: "人工修改" })]);

    expect(() => commit(fixture, [candidate(fixture)], true, stale)).toThrow(/重新确认/);
  });

  it("合法输入写到第二条时数据库异常：任务、分工、依赖、活动、版本全部回滚", () => {
    const fixture = buildFixture();
    const oldFirst = candidate(fixture, { title: "旧任务 A" });
    const oldSecond = candidate(fixture, {
      title: "旧任务 B",
      predecessorClientTaskIds: [oldFirst.clientTaskId],
    });
    commit(fixture, [oldFirst, oldSecond]);
    expect(
      fixture.database.all("SELECT id FROM task_dependencies WHERE project_id = ?", [
        fixture.projectId,
      ]),
    ).toHaveLength(1);
    const beforeTasks = fixture.database.all(
      "SELECT id, title FROM tasks WHERE project_id = ? ORDER BY id",
      [fixture.projectId],
    );
    const beforeParticipants = fixture.database.all(
      "SELECT id FROM task_participants WHERE project_id = ? ORDER BY id",
      [fixture.projectId],
    );
    const beforeDependencies = fixture.database.all(
      "SELECT id FROM task_dependencies WHERE project_id = ? ORDER BY id",
      [fixture.projectId],
    );
    const beforeActivities = fixture.database.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM activity_log WHERE project_id = ?",
      [fixture.projectId],
    )!.count;
    const beforeRevision = scheduleRevision(fixture);

    // 合法候选，但数据库在第二条 INSERT 时抛错：证明不是“负工时”这种参数校验。
    fixture.database.exec(
      `CREATE TRIGGER fail_second_task BEFORE INSERT ON tasks
       WHEN NEW.title = '数据库异常任务'
       BEGIN SELECT RAISE(ABORT, 'forced database failure'); END;`,
    );

    expect(() =>
      commit(fixture, [
        candidate(fixture, { title: "正常任务" }),
        candidate(fixture, { title: "数据库异常任务" }),
      ]),
    ).toThrow(/forced database failure/);

    expect(
      fixture.database.all("SELECT id, title FROM tasks WHERE project_id = ? ORDER BY id", [
        fixture.projectId,
      ]),
    ).toEqual(beforeTasks);
    expect(
      fixture.database.all("SELECT id FROM task_participants WHERE project_id = ? ORDER BY id", [
        fixture.projectId,
      ]),
    ).toEqual(beforeParticipants);
    expect(
      fixture.database.all("SELECT id FROM task_dependencies WHERE project_id = ? ORDER BY id", [
        fixture.projectId,
      ]),
    ).toEqual(beforeDependencies);
    expect(
      fixture.database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM activity_log WHERE project_id = ?",
        [fixture.projectId],
      )!.count,
    ).toBe(beforeActivities);
    expect(scheduleRevision(fixture)).toBe(beforeRevision);
  });

  it("另一个连接先提交并推进版本：旧批量请求被拒绝，新修改保留", () => {
    const fixture = buildFixture();
    const staleRevision = scheduleRevision(fixture);
    const otherDatabase = openV2Database(fixture.dbPath);
    openDatabases.push(otherDatabase);

    const otherService = new ScheduleService(
      resolveDependencies({
        database: otherDatabase,
        sessionSecret: "meeting-commit-test-secret-32-characters",
        cookieSecure: false,
        bootstrapCode: "meeting-commit-test-bootstrap",
        clock: () => new Date(),
      }),
    );
    const other = otherService.commitMeetingTasks(fixture.lead, fixture.projectId, {
      projectId: fixture.projectId,
      expectedScheduleRevision: staleRevision,
      replaceSchedule: false,
      tasks: [candidate(fixture, { title: "另一个连接的任务" })],
    });

    expect(() =>
      commit(
        fixture,
        [candidate(fixture, { title: "旧批量任务" })],
        true,
        staleRevision,
      ),
    ).toThrow(/重新确认/);

    const titles = fixture.database
      .all<{ title: string }>("SELECT title FROM tasks WHERE project_id = ?", [fixture.projectId])
      .map((row) => row.title);
    expect(titles).toContain("另一个连接的任务");
    expect(titles).not.toContain("旧批量任务");
    expect(other.taskIds).toHaveLength(1);
  });

});
