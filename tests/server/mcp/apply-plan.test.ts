/**
 * 「试算 → 落库」链路的独立单测：`snapshot.ts` + `apply-plan.ts` + 两个新工具。
 *
 * 三条边界：
 *  1. 每个用例一个临时库（`mkdtemp`），绝不碰 `data/v2/app.sqlite`；
 *  2. 算法在内存里试算，落库必须靠 `ScheduleService` 的真实写接口；
 *  3. 协议层用 `InMemoryTransport` 走真 JSON-RPC，而不是直接调函数。
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it } from "vitest";

import { openV2Database } from "../../../server/db/database.js";
import { migrateV2Database } from "../../../server/db/migrations.js";
import { resolveDependencies } from "../../../server/http/dependencies.js";
import { applyPlan } from "../../../server/mcp/apply-plan.js";
import { planReschedules } from "../../../server/mcp/reschedule.js";
import { createMcpRuntime, type McpRuntime } from "../../../server/mcp/runtime.js";
import { loadSchedule } from "../../../server/mcp/snapshot.js";
import { registerTools } from "../../../server/mcp/tools.js";
import { AvailabilityService } from "../../../server/modules/availability/availability-service.js";
import type { AuthenticatedSession } from "../../../server/modules/auth/auth-service.js";
import { ProjectService } from "../../../server/modules/projects/project-service.js";
import { ScheduleService } from "../../../server/modules/schedule/schedule-service.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const PROJECT_NAME = "重排测试项目";
const LEAD = "lead";

interface Fixture {
  dbPath: string;
  projectId: string;
  taskId: string;
  today: string;
  userIds: Record<"lead" | "backend" | "qa", string>;
}

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

function dayOfWeek(date: string): number {
  return new Date(`${date}T00:00:00.000Z`).getUTCDay();
}

function everyDay(startMinute: number, endMinute: number) {
  return Array.from({ length: 7 }, (_, day) => ({ dayOfWeek: day, startMinute, endMinute }));
}

function sessionFor(
  id: string,
  username: string,
  displayName: string,
  now: Date,
): AuthenticatedSession {
  const iso = now.toISOString();
  return {
    sessionId: "test-session",
    tokenHash: "test-session",
    teamMember: true,
    user: { id, username, displayName, createdAt: iso, updatedAt: iso, revision: 1 },
  };
}

function buildFixture(): Fixture {
  const now = new Date();
  const today = todayInShanghai(now);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-mcp-plan-"));
  const dbPath = path.join(directory, "app.sqlite");

  const database = openV2Database(dbPath);
  migrateV2Database(database, () => now.toISOString());

  const dependencies = resolveDependencies({
    database,
    sessionSecret: "mcp-plan-test-session-secret-32-chars",
    cookieSecure: false,
    bootstrapCode: "mcp-plan-test-bootstrap",
    clock: () => new Date(now.getTime()),
  });
  const availabilityService = new AvailabilityService(dependencies);
  const scheduleService = new ScheduleService(dependencies);
  const projectService = new ProjectService(dependencies);

  const members = [
    {
      key: "lead" as const,
      username: LEAD,
      displayName: "邱业恒",
      weeklyCapacityMinutes: 1_680,
      slots: everyDay(1_140, 1_380),
    },
    {
      key: "backend" as const,
      username: "zhang.gong",
      displayName: "张工",
      // 只有今天 2h 有空，任务是 10h → 必然缺 8h
      weeklyCapacityMinutes: 120,
      slots: [{ dayOfWeek: dayOfWeek(today), startMinute: 1_140, endMinute: 1_260 }],
    },
    {
      key: "qa" as const,
      username: "li.gong",
      displayName: "李工",
      weeklyCapacityMinutes: 1_260,
      slots: everyDay(1_140, 1_320),
    },
  ];

  const userIds = {} as Fixture["userIds"];
  for (const member of members) {
    const id = randomUUID();
    userIds[member.key] = id;
    database.run(
      `INSERT INTO users (id, username, password_hash, display_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, member.username, "test-hash", member.displayName, now.toISOString(), now.toISOString()],
    );
    database.run(
      `INSERT INTO team_members (user_id, joined_at, invited_by) VALUES (?, ?, ?)`,
      [id, now.toISOString(), userIds.lead ?? id],
    );
  }

  const leadSession = sessionFor(userIds.lead, LEAD, "邱业恒", now);
  const project = projectService.create(leadSession, {
    name: PROJECT_NAME,
    description: "重排链路测试用",
    startDate: shiftDays(today, -7),
    endDate: shiftDays(today, 60),
    memberUserIds: [userIds.backend, userIds.qa],
  });

  for (const member of members) {
    availabilityService.replaceDocument(
      sessionFor(userIds[member.key], member.username, member.displayName, now),
      {
        expectedRevision: 1,
        profiles: [
          {
            validFrom: shiftDays(today, -7),
            validThrough: shiftDays(today, 60),
            weeklyCapacityMinutes: member.weeklyCapacityMinutes,
            privateNote: "",
            weeklySlots: member.slots,
            exceptions: [],
          },
        ],
      },
    );
  }

  const created = scheduleService.createTask(leadSession, project.project.id, {
    title: "MCP 工具层接口联调",
    startDate: today,
    dueDate: shiftDays(today, 2),
  });
  scheduleService.addParticipant(leadSession, project.project.id, created.task.id, {
    userId: userIds.backend,
    startDate: today,
    endDate: shiftDays(today, 2),
    estimatedMinutes: 600,
  });

  database.close();

  return { dbPath, projectId: project.project.id, taskId: created.task.id, today, userIds };
}

const cleanups: Array<() => void | Promise<void>> = [];

function trackRuntime(runtime: McpRuntime, fixture: Fixture): McpRuntime {
  cleanups.push(() => {
    runtime.close();
    fs.rmSync(path.dirname(fixture.dbPath), { recursive: true, force: true });
  });
  return runtime;
}

async function connect(runtime: McpRuntime): Promise<Client> {
  const server = new McpServer({ name: "mcp-plan-test", version: "0.0.0" });
  registerTools(server, runtime);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "mcp-plan-client", version: "0.0.0" });
  await client.connect(clientTransport);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
});

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.find((entry) => entry.type === "text")?.text ?? "";
}

function payloadOf(result: unknown): Record<string, any> {
  return JSON.parse(textOf(result)) as Record<string, any>;
}

describe("plan → apply 落库", () => {
  it("可行方案落库后冲突清零，且数据库里的分工真的变了", () => {
    const fixture = buildFixture();
    const runtime = trackRuntime(
      createMcpRuntime({ dbPath: fixture.dbPath, username: LEAD }),
      fixture,
    );

    const before = runtime.availability.projectConflicts(fixture.projectId);
    expect(before).toHaveLength(1);
    expect(before[0]!.type).toBe("unallocated_effort");

    const { snapshot, context } = loadSchedule(runtime, fixture.projectId);
    const plans = planReschedules(snapshot, context);
    const plan = plans.find((candidate) => candidate.feasible);
    expect(plan).toBeDefined();
    expect(plan!.before.conflicts).toBe(1);

    const result = applyPlan(runtime, fixture.projectId, plan!);

    expect(result.conflictsBefore).toBe(1);
    expect(result.conflictsAfter).toBe(0);
    expect(result.applied.length).toBeGreaterThan(0);

    const participants = runtime.schedule
      .listParticipants(runtime.auth, fixture.projectId)
      .filter((participant) => participant.taskId === fixture.taskId);
    expect(participants).toHaveLength(2);

    const byUser = new Map(participants.map((participant) => [participant.userId, participant]));
    const backend = byUser.get(fixture.userIds.backend)!;
    const qa = byUser.get(fixture.userIds.qa)!;
    expect(backend.estimatedMinutes).toBe(120);
    expect(qa.estimatedMinutes).toBe(480);
    expect(backend.estimatedMinutes + qa.estimatedMinutes).toBe(600);
  });

  it("动作中途失败时整体回滚，不留下改了一半的数据", () => {
    const fixture = buildFixture();
    const runtime = trackRuntime(
      createMcpRuntime({ dbPath: fixture.dbPath, username: LEAD }),
      fixture,
    );

    const { snapshot, context } = loadSchedule(runtime, fixture.projectId);
    const plan = planReschedules(snapshot, context).find((candidate) => candidate.feasible)!;
    const broken = {
      ...plan,
      operations: [
        { ...(plan.operations[0] as { participantId: string }), participantId: "missing-participant" },
      ],
    } as typeof plan;

    expect(() => applyPlan(runtime, fixture.projectId, broken)).toThrow(/回滚/);

    const participants = runtime.schedule
      .listParticipants(runtime.auth, fixture.projectId)
      .filter((item) => item.taskId === fixture.taskId);
    expect(participants).toHaveLength(1);
    expect(participants[0]!.estimatedMinutes).toBe(600);
  });

  it("试算后有人改了工时（冲突数不变）时拒绝应用，旧数据保持不变", () => {
    const fixture = buildFixture();
    const runtime = trackRuntime(
      createMcpRuntime({ dbPath: fixture.dbPath, username: LEAD }),
      fixture,
    );

    const { snapshot, context } = loadSchedule(runtime, fixture.projectId);
    const plan = planReschedules(snapshot, context).find((candidate) => candidate.feasible);
    expect(plan).toBeDefined();
    expect(typeof plan!.beforeSignature).toBe("string");

    // 模拟人工把工时从 600 改成 300：冲突数仍然是 1，只能靠指纹发现。
    const participant = runtime.schedule
      .listParticipants(runtime.auth, fixture.projectId)
      .find((item) => item.taskId === fixture.taskId)!;
    runtime.schedule.updateParticipant(runtime.auth, fixture.projectId, participant.id, {
      expectedRevision: participant.revision,
      estimatedMinutes: 300,
    });

    expect(() => applyPlan(runtime, fixture.projectId, plan!)).toThrow(/改动过|重新 plan_reschedule/);

    const after = runtime.schedule
      .listParticipants(runtime.auth, fixture.projectId)
      .find((item) => item.id === participant.id)!;
    expect(after.estimatedMinutes).toBe(300);
  });

  it("任务被别人改过（revision +1）时，apply 会重试而不是抛 REVISION_CONFLICT", () => {
    const fixture = buildFixture();
    const runtime = trackRuntime(
      createMcpRuntime({ dbPath: fixture.dbPath, username: LEAD }),
      fixture,
    );

    const { snapshot, context } = loadSchedule(runtime, fixture.projectId);
    const plan = planReschedules(snapshot, context).find((candidate) => candidate.feasible)!;

    // 模拟「网页上有人刚动过这条分工」：值没变，但 revision 前进了。
    const participant = runtime.schedule
      .listParticipants(runtime.auth, fixture.projectId)
      .find((candidate) => candidate.userId === fixture.userIds.backend)!;
    const originalRevision = participant.revision;
    const bumped = runtime.schedule.updateParticipant(
      runtime.auth,
      fixture.projectId,
      participant.id,
      { expectedRevision: originalRevision, endDate: participant.endDate },
    );
    expect(bumped.participant.revision).toBe(originalRevision + 1);

    // 方案里存的是旧 revision；如果不重试，这里必然抛 REVISION_CONFLICT。
    const result = applyPlan(runtime, fixture.projectId, plan);

    expect(result.conflictsAfter).toBe(0);

    const after = runtime.schedule
      .listParticipants(runtime.auth, fixture.projectId)
      .find((candidate) => candidate.id === participant.id)!;
    expect(after.revision).toBeGreaterThan(originalRevision + 1);
  });

  it("方案里的分工已被删除时给出可读错误，而不是崩掉", () => {
    const fixture = buildFixture();
    const runtime = trackRuntime(
      createMcpRuntime({ dbPath: fixture.dbPath, username: LEAD }),
      fixture,
    );

    const { snapshot, context } = loadSchedule(runtime, fixture.projectId);
    const plan = planReschedules(snapshot, context).find((candidate) => candidate.feasible)!;

    const participant = runtime.schedule
      .listParticipants(runtime.auth, fixture.projectId)
      .find((candidate) => candidate.userId === fixture.userIds.backend)!;
    runtime.schedule.deleteParticipant(
      runtime.auth,
      fixture.projectId,
      participant.id,
      participant.revision,
    );

    expect(() => applyPlan(runtime, fixture.projectId, plan)).toThrow(/不存在|重新 plan_reschedule/);
  });
});

describe("工具协议层", () => {
  it("tools/list 至少暴露本轮新增的两个工具（试算 + 落库）", async () => {
    const fixture = buildFixture();
    const runtime = trackRuntime(
      createMcpRuntime({ dbPath: fixture.dbPath, username: LEAD }),
      fixture,
    );
    const client = await connect(runtime);

    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();

    // 这七个是本轮之前就定下的口径；写入类工具（create_task / assign_member /
    // set_dependency）正在同一分支上并行开发，所以这里断言「包含」而不是「等于」，
    // 避免把还在长的工具清单写死。
    for (const required of [
      "apply_plan",
      "check_conflicts",
      "get_availability",
      "get_tasks",
      "list_members",
      "list_projects",
      "plan_reschedule",
    ]) {
      expect(names).toContain(required);
    }
    expect(names.length).toBeGreaterThanOrEqual(7);
    for (const tool of listed.tools) {
      expect(tool.description ?? "").not.toBe("");
    }
  });

  it("plan_reschedule 只试算、不写库", async () => {
    const fixture = buildFixture();
    const runtime = trackRuntime(
      createMcpRuntime({ dbPath: fixture.dbPath, username: LEAD }),
      fixture,
    );
    const client = await connect(runtime);

    const beforeParticipants = runtime.schedule.listParticipants(runtime.auth, fixture.projectId);
    const payload = payloadOf(
      await client.callTool({ name: "plan_reschedule", arguments: {} }),
    );

    expect(payload.plans.length).toBeGreaterThan(0);
    expect(payload.plans.some((plan: any) => plan.feasible)).toBe(true);
    expect(payload.recommendation).toBeTruthy();

    const afterParticipants = runtime.schedule.listParticipants(runtime.auth, fixture.projectId);
    expect(afterParticipants).toHaveLength(beforeParticipants.length);
    expect(runtime.availability.projectConflicts(fixture.projectId)).toHaveLength(1);
  });

  it("先 plan 再 apply：冲突清零", async () => {
    const fixture = buildFixture();
    const runtime = trackRuntime(
      createMcpRuntime({ dbPath: fixture.dbPath, username: LEAD }),
      fixture,
    );
    const client = await connect(runtime);

    await client.callTool({ name: "plan_reschedule", arguments: {} });
    const applied = payloadOf(await client.callTool({ name: "apply_plan", arguments: {} }));

    expect(applied.conflictsAfter).toBe(0);
    expect(applied.summary).toContain("冲突清零");
    expect(applied.planId).toBeTruthy();
  });

  it("没先试算就 apply：返回 isError 并提示先 plan_reschedule", async () => {
    const fixture = buildFixture();
    const runtime = trackRuntime(
      createMcpRuntime({ dbPath: fixture.dbPath, username: LEAD }),
      fixture,
    );
    const client = await connect(runtime);

    const result = (await client.callTool({
      name: "apply_plan",
      arguments: {},
    })) as { isError?: boolean };

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("先调用 plan_reschedule");
  });

  it("planId 不存在时列出可用方案", async () => {
    const fixture = buildFixture();
    const runtime = trackRuntime(
      createMcpRuntime({ dbPath: fixture.dbPath, username: LEAD }),
      fixture,
    );
    const client = await connect(runtime);

    await client.callTool({ name: "plan_reschedule", arguments: {} });
    const result = (await client.callTool({
      name: "apply_plan",
      arguments: { planId: "plan-does-not-exist" },
    })) as { isError?: boolean };

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("找不到方案");
    expect(textOf(result)).toContain("plan-1");
  });

  it("apply 之后方案缓存被清空，重复 apply 会拒绝", async () => {
    const fixture = buildFixture();
    const runtime = trackRuntime(
      createMcpRuntime({ dbPath: fixture.dbPath, username: LEAD }),
      fixture,
    );
    const client = await connect(runtime);

    await client.callTool({ name: "plan_reschedule", arguments: {} });
    await client.callTool({ name: "apply_plan", arguments: {} });

    const second = (await client.callTool({ name: "apply_plan", arguments: {} })) as {
      isError?: boolean;
    };
    expect(second.isError).toBe(true);
    expect(textOf(second)).toContain("先调用 plan_reschedule");
  });
});
