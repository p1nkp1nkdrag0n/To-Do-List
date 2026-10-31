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
import type { AppliedPlanRecord } from "../../../server/meeting/events.js";
import { undoPlan } from "../../../server/meeting/undo.js";

const openDatabases: V2Database[] = [];

function sessionFor(id: string, username: string, now: Date): AuthenticatedSession {
  const iso = now.toISOString();
  return {
    sessionId: "test-session",
    tokenHash: "test-session",
    teamMember: true,
    user: { id, username, displayName: username, createdAt: iso, updatedAt: iso, revision: 1 },
  };
}

function fixture() {
  const now = new Date("2026-07-17T08:00:00.000Z");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "undo-guard-"));
  const database = openV2Database(path.join(directory, "app.sqlite"));
  openDatabases.push(database);
  migrateV2Database(database, () => now.toISOString());
  const dependencies = resolveDependencies({
    database,
    sessionSecret: "undo-guard-test-secret-32-characters",
    cookieSecure: false,
    bootstrapCode: "undo-guard-bootstrap",
    clock: () => new Date(now.getTime()),
  });
  const projects = new ProjectService(dependencies);
  const schedule = new ScheduleService(dependencies);

  const leaderId = randomUUID();
  const ownerId = randomUUID();
  const otherId = randomUUID();
  for (const [id, username] of [
    [leaderId, "leader"],
    [ownerId, "owner"],
    [otherId, "other"],
  ] as const) {
    database.run(
      `INSERT INTO users (id, username, password_hash, display_name, created_at, updated_at)
       VALUES (?, ?, 'test', ?, ?, ?)`,
      [id, username, username, now.toISOString(), now.toISOString()],
    );
    database.run(
      "INSERT INTO team_members (user_id, joined_at, invited_by) VALUES (?, ?, ?)",
      [id, now.toISOString(), leaderId],
    );
  }
  const lead = sessionFor(leaderId, "leader", now);
  const project = projects.create(lead, {
    name: "撤销保护测试",
    description: "",
    startDate: "2026-07-20",
    endDate: "2026-12-31",
    memberUserIds: [ownerId, otherId],
  });
  const task = schedule.createTask(lead, project.project.id, {
    title: "演示脚本",
    startDate: "2026-07-20",
    dueDate: "2026-07-25",
  }).task;
  const participant = schedule.addParticipant(lead, project.project.id, task.id, {
    userId: ownerId,
    startDate: "2026-07-20",
    endDate: "2026-07-25",
    estimatedMinutes: 600,
  }).participant;

  return { dependencies, schedule, lead, projectId: project.project.id, task, participant, ownerId, otherId };
}

afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()!.close();
});

describe("撤销写后版本保护", () => {
  it("原分工被人工改过：整次撤销拒绝，保留人工修改", () => {
    const f = fixture();
    // 模拟应用后的状态：原分工 120，拆出 480。
    const source = f.schedule.updateParticipant(f.lead, f.projectId, f.participant.id, {
      expectedRevision: f.participant.revision,
      estimatedMinutes: 120,
    }).participant;
    const created = f.schedule.addParticipant(f.lead, f.projectId, f.task.id, {
      userId: f.otherId,
      startDate: "2026-07-20",
      endDate: "2026-07-25",
      estimatedMinutes: 480,
    }).participant;
    const plan: AppliedPlanRecord = {
      id: "plan-1",
      label: "拆分",
      operations: [
        {
          kind: "split",
          participantId: f.participant.id,
          taskId: f.task.id,
          fromUserId: f.ownerId,
          toUserId: f.otherId,
          moveMinutes: 480,
          newParticipantId: "placeholder-1",
        },
      ],
      createdParticipants: [
        {
          placeholderId: "placeholder-1",
          realId: created.id,
          taskId: f.task.id,
          userId: f.otherId,
        },
      ],
      afterRevisions: {
        tasks: { [f.task.id]: f.schedule.listTasks(f.lead, f.projectId)[0]!.revision },
        participants: {
          [source.id]: source.revision,
          [created.id]: created.revision,
        },
      },
    };

    // 人工把原分工再改成 30 分钟。
    f.schedule.updateParticipant(f.lead, f.projectId, source.id, {
      expectedRevision: source.revision,
      estimatedMinutes: 30,
    });

    const result = undoPlan(f.dependencies, f.lead, f.projectId, plan);

    expect(result.reverted).toBe(0);
    expect(result.skipped[0]).toContain("已被人工修改");
    expect(
      f.schedule.listParticipants(f.lead, f.projectId).find((item) => item.id === source.id)
        ?.estimatedMinutes,
    ).toBe(30);
  });

  it("没有人改过：撤销仍按原动作恢复", () => {
    const f = fixture();
    const source = f.schedule.updateParticipant(f.lead, f.projectId, f.participant.id, {
      expectedRevision: f.participant.revision,
      estimatedMinutes: 120,
    }).participant;
    const created = f.schedule.addParticipant(f.lead, f.projectId, f.task.id, {
      userId: f.otherId,
      startDate: "2026-07-20",
      endDate: "2026-07-25",
      estimatedMinutes: 480,
    }).participant;
    const plan: AppliedPlanRecord = {
      id: "plan-2",
      label: "拆分",
      operations: [
        {
          kind: "split",
          participantId: f.participant.id,
          taskId: f.task.id,
          fromUserId: f.ownerId,
          toUserId: f.otherId,
          moveMinutes: 480,
          newParticipantId: "placeholder-1",
        },
      ],
      createdParticipants: [
        {
          placeholderId: "placeholder-1",
          realId: created.id,
          taskId: f.task.id,
          userId: f.otherId,
        },
      ],
      afterRevisions: {
        tasks: { [f.task.id]: f.schedule.listTasks(f.lead, f.projectId)[0]!.revision },
        participants: {
          [source.id]: source.revision,
          [created.id]: created.revision,
        },
      },
    };

    const result = undoPlan(f.dependencies, f.lead, f.projectId, plan);

    expect(result.reverted).toBe(1);
    expect(result.skipped).toEqual([]);
    const participants = f.schedule.listParticipants(f.lead, f.projectId);
    expect(participants).toHaveLength(1);
    expect(participants[0]!.estimatedMinutes).toBe(600);
  });


  it("同一分工连续两次 reassign：撤销内部版本递增，不误判冲突", () => {
    const f = fixture();
    // 模拟 apply：owner → other → owner，最终 revision = 3。
    const first = f.schedule.updateParticipant(f.lead, f.projectId, f.participant.id, {
      expectedRevision: f.participant.revision,
      userId: f.otherId,
    }).participant;
    const second = f.schedule.updateParticipant(f.lead, f.projectId, first.id, {
      expectedRevision: first.revision,
      userId: f.ownerId,
    }).participant;
    const plan: AppliedPlanRecord = {
      id: "plan-3",
      label: "连续换人",
      operations: [
        {
          kind: "reassign",
          participantId: f.participant.id,
          taskId: f.task.id,
          fromUserId: f.ownerId,
          toUserId: f.otherId,
        },
        {
          kind: "reassign",
          participantId: f.participant.id,
          taskId: f.task.id,
          fromUserId: f.otherId,
          toUserId: f.ownerId,
        },
      ],
      afterRevisions: {
        tasks: {},
        participants: { [second.id]: second.revision },
      },
    };

    const result = undoPlan(f.dependencies, f.lead, f.projectId, plan);

    expect(result.reverted).toBe(2);
    expect(result.skipped).toEqual([]);
    expect(
      f.schedule.listParticipants(f.lead, f.projectId).find((item) => item.id === second.id)
        ?.userId,
    ).toBe(f.ownerId);
  });


  it("split → extend(占位 ID) → 撤销：先翻译占位 ID，再按事务内当前版本逆写", () => {
    const f = fixture();
    const source = f.schedule.updateParticipant(f.lead, f.projectId, f.participant.id, {
      expectedRevision: f.participant.revision,
      estimatedMinutes: 120,
    }).participant;
    const created = f.schedule.addParticipant(f.lead, f.projectId, f.task.id, {
      userId: f.otherId,
      startDate: "2026-07-20",
      endDate: "2026-07-25",
      estimatedMinutes: 480,
    }).participant;
    const extended = f.schedule.updateParticipant(f.lead, f.projectId, created.id, {
      expectedRevision: created.revision,
      endDate: "2026-07-28",
    }).participant;
    const plan: AppliedPlanRecord = {
      id: "plan-4",
      label: "拆分后延期",
      operations: [
        {
          kind: "split",
          participantId: f.participant.id,
          taskId: f.task.id,
          fromUserId: f.ownerId,
          toUserId: f.otherId,
          moveMinutes: 480,
          newParticipantId: "placeholder-2",
        },
        {
          kind: "extend",
          participantId: "placeholder-2",
          taskId: f.task.id,
          newEndDate: "2026-07-28",
          previousEndDate: "2026-07-25",
        },
      ],
      createdParticipants: [
        {
          placeholderId: "placeholder-2",
          realId: created.id,
          taskId: f.task.id,
          userId: f.otherId,
        },
      ],
      afterRevisions: {
        tasks: { [f.task.id]: f.schedule.listTasks(f.lead, f.projectId)[0]!.revision },
        participants: {
          [source.id]: source.revision,
          [extended.id]: extended.revision,
        },
      },
    };

    const result = undoPlan(f.dependencies, f.lead, f.projectId, plan);

    expect(result.reverted).toBe(2);
    expect(result.skipped).toEqual([]);
    const participants = f.schedule.listParticipants(f.lead, f.projectId);
    expect(participants).toHaveLength(1);
    expect(participants[0]!.estimatedMinutes).toBe(600);
  });

});
