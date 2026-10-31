import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createScheduleFixture,
  type ScheduleFixture,
  type ScheduleTestUser,
} from "./schedule-fixture.js";

describe("meeting confirm version boundary", () => {
  let fixture: ScheduleFixture;
  let leader: ScheduleTestUser;

  beforeEach(async () => {
    fixture = createScheduleFixture();
    leader = await fixture.bootstrap();
  });

  afterEach(() => fixture.close());

  it("草稿响应返回当次生成前的排期版本", async () => {
    const member = await fixture.register("draft-revision-member");
    await fixture.addToTeam(leader, member);
    const project = await fixture.createProject(leader, [member.id]);

    const response = await leader.agent.post("/api/meeting/draft").send({
      projectId: project.id,
      minutes: "测试成员负责整理材料，2 小时。",
    });

    expect(response.status).toBe(200);
    expect(typeof response.body.scheduleRevision).toBe("number");
    expect(response.body.scheduleRevision).toBeGreaterThan(0);
  });

  it("确认清单缺少 expectedScheduleRevision 时直接拒绝，不进入批量写入", async () => {
    const member = await fixture.register("confirm-version-member");
    await fixture.addToTeam(leader, member);
    const project = await fixture.createProject(leader, [member.id]);
    const before = await leader.agent.get(`/api/projects/${project.id}/tasks`);

    const response = await leader.agent.post("/api/meeting/run").send({
      projectId: project.id,
      minutes: "确认清单测试",
      replaceSchedule: true,
      tasks: [
        {
          clientTaskId: "c1",
          title: "不应写入",
          ownerName: "测试成员",
          ownerUserId: member.id,
          estimatedHours: 2,
          dueDate: "2026-11-02",
          dependsOnTitle: null,
          predecessorClientTaskIds: [],
        },
      ],
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("EXPECTED_REVISION_REQUIRED");
    const after = await leader.agent.get(`/api/projects/${project.id}/tasks`);
    expect(after.body.tasks).toEqual(before.body.tasks);
  });
});
