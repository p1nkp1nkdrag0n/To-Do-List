import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createScheduleFixture,
  type ScheduleFixture,
  type ScheduleTestUser,
} from "./schedule-fixture.js";

interface Snapshot {
  tasks: Array<Record<string, unknown>>;
  participants: Array<Record<string, unknown>>;
  dependencies: Array<Record<string, unknown>>;
  activities: number;
  revision: number;
}

describe("meeting HTTP → MCP atomic commit", () => {
  let fixture: ScheduleFixture;
  let leader: ScheduleTestUser;
  let projectId: string;
  let tempDir: string;
  const events: Array<{ projectId: string; type: string }> = [];
  const previousEnv = {
    DB_PATH: process.env.DB_PATH,
    MCP_ENTRY: process.env.MCP_ENTRY,
    MEETING_PACE_MS: process.env.MEETING_PACE_MS,
  };

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-http-mcp-"));
    process.env.DB_PATH = path.join(tempDir, "app.sqlite");
    // 强制走 tsx 源码入口，避免本机旧 dist-server 被误用。
    process.env.MCP_ENTRY = "";
    process.env.MEETING_PACE_MS = "0";
    fixture = createScheduleFixture({
      dbPath: process.env.DB_PATH,
      publishMeetingEvent: (eventProjectId, event) => {
        events.push({ projectId: eventProjectId, type: event.type });
      },
    });
    leader = await fixture.bootstrap();
    const project = await fixture.createProject(leader);
    projectId = project.id;
  });

  afterAll(() => {
    fixture.close();
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function snapshot(): Snapshot {
    return {
      tasks: fixture.database.all(
        "SELECT id, title, start_date, due_date, revision FROM tasks WHERE project_id = ? ORDER BY id",
        [projectId],
      ),
      participants: fixture.database.all(
        "SELECT id, task_id, user_id, estimated_minutes, revision FROM task_participants WHERE project_id = ? ORDER BY id",
        [projectId],
      ),
      dependencies: fixture.database.all(
        "SELECT id, predecessor_task_id, successor_task_id FROM task_dependencies WHERE project_id = ? ORDER BY id",
        [projectId],
      ),
      activities: fixture.database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM activity_log WHERE project_id = ?",
        [projectId],
      )!.count,
      revision: fixture.database.get<{ schedule_revision: number }>(
        "SELECT schedule_revision FROM projects WHERE id = ?",
        [projectId],
      )!.schedule_revision,
    };
  }

  async function runMeeting(tasks: Array<Record<string, unknown>>) {
    const revision = fixture.database.get<{ schedule_revision: number }>(
      "SELECT schedule_revision FROM projects WHERE id = ?",
      [projectId],
    )!.schedule_revision;
    return leader.agent.post("/api/meeting/run").send({
      projectId,
      minutes: "HTTP 原子提交测试",
      lockOwners: true,
      replaceSchedule: true,
      expectedScheduleRevision: revision,
      tasks,
    });
  }

  function task(overrides: Record<string, unknown> = {}) {
    return {
      clientTaskId: crypto.randomUUID(),
      title: "合法任务",
      ownerName: "Leader",
      ownerUserId: leader.id,
      estimatedHours: 2,
      dueDate: "2026-07-25",
      predecessorClientTaskIds: [],
      ...overrides,
    };
  }

  it("第二条合法 INSERT 触发数据库异常：任务/分工/依赖/活动/版本全部回滚", async () => {
    const oldFirst = task({ title: "旧任务 A" });
    const oldSecond = task({
      title: "旧任务 B",
      predecessorClientTaskIds: [oldFirst.clientTaskId],
    });
    const old = await runMeeting([oldFirst, oldSecond]);
    expect(old.status).toBe(200);
    const before = snapshot();
    expect(before.dependencies).toHaveLength(1);

    fixture.database.exec(
      `CREATE TRIGGER fail_second_http BEFORE INSERT ON tasks
       WHEN NEW.title = '第二次失败'
       BEGIN SELECT RAISE(ABORT, 'forced http failure'); END;`,
    );

    const eventMark = events.length;
    const response = await runMeeting([
      task({ title: "第一条" }),
      task({ title: "第二次失败" }),
    ]);

    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toContain("forced http failure");
    expect(snapshot()).toEqual(before);
    expect(events.slice(eventMark).some((event) => event.type === "session.finished")).toBe(false);
  });

  it("成员改名但 userId 不变：仍分给同一个人", async () => {
    fixture.database.run("UPDATE users SET display_name = ? WHERE id = ?", [
      "Leader 改名",
      leader.id,
    ]);
    const response = await runMeeting([task({ title: "改名后的任务" })]);
    expect(response.status).toBe(200);

    const participant = fixture.database.get<{ user_id: string }>(
      "SELECT user_id FROM task_participants WHERE project_id = ? ORDER BY rowid DESC LIMIT 1",
      [projectId],
    );
    expect(participant?.user_id).toBe(leader.id);
  });

  it("候选生成后成员退出：提交被拒，旧排期保留", async () => {
    const member = await fixture.register("http-leave-member");
    await fixture.addToTeam(leader, member);
    const project = await leader.agent.post("/api/projects").send({
      name: "退组测试",
      description: "",
      startDate: "2026-07-20",
      endDate: "2026-12-31",
      memberUserIds: [member.id],
    });
    const leaveProjectId = project.body.project.id as string;
    const oldTask = await leader.agent
      .post(`/api/projects/${leaveProjectId}/tasks`)
      .send({ title: "退组前的旧任务" });
    expect(oldTask.status).toBe(201);
    const before = fixture.database.all(
      "SELECT id, title FROM tasks WHERE project_id = ? ORDER BY id",
      [leaveProjectId],
    );
    const revision = fixture.database.get<{ schedule_revision: number }>(
      "SELECT schedule_revision FROM projects WHERE id = ?",
      [leaveProjectId],
    )!.schedule_revision;
    fixture.database.run(
      "UPDATE project_members SET removed_at = ? WHERE project_id = ? AND user_id = ?",
      [new Date().toISOString(), leaveProjectId, member.id],
    );

    const response = await leader.agent.post("/api/meeting/run").send({
      projectId: leaveProjectId,
      minutes: "退组提交",
      replaceSchedule: true,
      expectedScheduleRevision: revision,
      tasks: [
        {
          clientTaskId: "leave-1",
          title: "不应写入",
          ownerName: "退组成员",
          ownerUserId: member.id,
          estimatedHours: 2,
          dueDate: "2026-07-25",
        },
      ],
    });

    expect(response.status).toBe(400);
    expect(
      fixture.database.all("SELECT id, title FROM tasks WHERE project_id = ? ORDER BY id", [
        leaveProjectId,
      ]),
    ).toEqual(before);
  });

  it("版本已推进但成员仍有效：旧候选被拒绝，旧排期保留", async () => {
    await runMeeting([task({ title: "旧排期" })]);
    const currentRevision = fixture.database.get<{ schedule_revision: number }>(
      "SELECT schedule_revision FROM projects WHERE id = ?",
      [projectId],
    )!.schedule_revision;
    const beforeTasks = fixture.database.all(
      "SELECT id, title FROM tasks WHERE project_id = ? ORDER BY id",
      [projectId],
    );
    fixture.database.run(
      "UPDATE projects SET schedule_revision = schedule_revision + 1 WHERE id = ?",
      [projectId],
    );

    const response = await leader.agent.post("/api/meeting/run").send({
      projectId,
      minutes: "旧版本提交",
      lockOwners: true,
      replaceSchedule: true,
      expectedScheduleRevision: currentRevision,
      tasks: [task({ title: "不应写入" })],
    });

    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toContain("重新确认");
    expect(
      fixture.database.all("SELECT id, title FROM tasks WHERE project_id = ? ORDER BY id", [
        projectId,
      ]),
    ).toEqual(beforeTasks);
  });

});
